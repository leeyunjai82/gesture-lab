// ═══════════════════════════════════════════════════════════
// 특징 벡터 — 원본 좌표를 그대로 쓰지 않고 정규화해서 학습에 넣는다
// ═══════════════════════════════════════════════════════════
//  손   worldLandmarks 21점. 손목(0)을 원점으로 평행이동한 뒤
//       손목~중지MCP(9) 거리로 스케일 정규화 → 63차원
//  얼굴 blendshape 52개 값 그대로 (이미 0~1) → 52차원
//       478점 좌표는 쓰지 않는다 — blendshape 가 표정 입력으로 훨씬 낫다
//  포즈 worldLandmarks 상반신 0~24번만. 양 어깨(11,12) 중점을 원점으로,
//       어깨 너비로 스케일 정규화 → 75차원
//
// z 값은 상대값이다. 절대 깊이로 쓰지 말 것.

export const FEATURE_DIMS = { hand: 63, face: 52, pose: 75 };

// 화면에 쓸 소스 이름 (i18n 사전에 있는 한국어 원문)
export const SOURCE_LABELS = { hand: '손', face: '얼굴', pose: '포즈' };

// 감지 결과 → Float32Array 또는 null(미검출)
export function extract(source, result) {
  if (!result) return null;
  if (source === 'hand') return handVec(result);
  if (source === 'face') return faceVec(result);
  if (source === 'pose') return poseVec(result);
  return null;
}

function handVec(r) {
  const lm = r.worldLandmarks && r.worldLandmarks[0];
  if (!lm || lm.length < 21) return null;
  const w = lm[0];                       // 손목
  const m = lm[9];                       // 중지 MCP
  const s = dist(w, m) || 1e-6;
  const v = new Float32Array(63);
  for (let i = 0; i < 21; i++) {
    v[i * 3] = (lm[i].x - w.x) / s;
    v[i * 3 + 1] = (lm[i].y - w.y) / s;
    v[i * 3 + 2] = (lm[i].z - w.z) / s;
  }
  return v;
}

function faceVec(r) {
  const bs = r.faceBlendshapes && r.faceBlendshapes[0];
  if (!bs || !bs.categories || bs.categories.length < 52) return null;
  const v = new Float32Array(52);
  for (let i = 0; i < 52; i++) v[i] = bs.categories[i].score;
  return v;
}

function poseVec(r) {
  const lm = r.worldLandmarks && r.worldLandmarks[0];
  if (!lm || lm.length < 25) return null;
  const L = lm[11], R = lm[12];          // 양 어깨
  const cx = (L.x + R.x) / 2, cy = (L.y + R.y) / 2, cz = (L.z + R.z) / 2;
  const s = dist(L, R) || 1e-6;
  const v = new Float32Array(75);
  for (let i = 0; i < 25; i++) {
    v[i * 3] = (lm[i].x - cx) / s;
    v[i * 3 + 1] = (lm[i].y - cy) / s;
    v[i * 3 + 2] = (lm[i].z - cz) / s;
  }
  return v;
}

function dist(a, b) {
  const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

// ── 좌표 관찰 패널용 ──
// "AI는 픽셀이 아니라 숫자를 본다" 를 보여주는 표의 행 데이터.
// [{ label, values: [..] }] 형태로 돌려준다.
export function observeRows(source, result) {
  if (source === 'face') {
    const bs = result && result.faceBlendshapes && result.faceBlendshapes[0];
    if (!bs || !bs.categories) return null;
    return bs.categories.map(c => ({ label: c.categoryName, values: [c.score] }));
  }
  const lm = result && result.landmarks && result.landmarks[0]
    ? result.landmarks[0]
    : (result && result.faceLandmarks && result.faceLandmarks[0]);
  if (!lm) return null;
  const n = source === 'pose' ? 25 : lm.length;
  const rows = [];
  for (let i = 0; i < n; i++) rows.push({ label: String(i), values: [lm[i].x, lm[i].y, lm[i].z] });
  return rows;
}
