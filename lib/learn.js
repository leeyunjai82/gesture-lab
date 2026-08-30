// ═══════════════════════════════════════════════════════════
// 학습실 — 예시 모으기 → 배우기 → 결과 → 저장
// ═══════════════════════════════════════════════════════════

import { loadLandmarker, drawResult, accentColor, accentRgba } from './landmarker.js';
import { extract, observeRows, faceSignals, FEATURE_DIMS, SOURCE_LABELS } from './features.js';
import { trainModel } from './trainer.js';
import { Store } from './store.js';

const $ = id => document.getElementById(id);
const T = s => (typeof GL_T === 'function' ? GL_T(s) : s);

let source = 'hand';
let lm = null;                 // 현재 랜드마커
let lmLoading = false;
let stream = null;
let classes = [];              // [{ name, vecs: [Float32Array], thumbs: [dataURL] }]
let selected = -1;
let capturing = false, lastCap = 0;
let lastResult = null, lastVec = null;
let trained = null;            // { model, accuracy, confusion, history, classes }
let training = false;
let lastNums = 0;

// ── 알림 ──
let toastTimer = null;
function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('on'), 2200);
}

// ── 단계 표시 ──
function steps() {
  const has = classes.length > 0;
  const shot = classes.some(c => c.vecs.length > 0);
  const done = !!trained;
  const saved = done && trained.saved;
  const st = [has, shot, done, saved];
  [1, 2, 3, 4].forEach((n, i) => {
    const el = $('s' + n);
    el.classList.toggle('done', st[i]);
    el.classList.toggle('on', !st[i] && (i === 0 || st[i - 1]));
  });
}

function progress(label, pct, ratio) {
  $('prgLabel').textContent = label;
  $('prgPct').textContent = pct == null ? '' : pct;
  if (ratio != null) $('prgFill').style.width = Math.round(ratio * 100) + '%';
}

// ── 랜드마커 ──
async function useSource(next) {
  if (lmLoading) return;
  lmLoading = true;
  $('engine').textContent = T('준비 중…');
  const old = lm;
  lm = null;
  if (old) old.close();        // 전환 시 이전 모델 정리 (메모리 누수 방지)
  try {
    lm = await loadLandmarker(next);
    source = next;
    $('engine').textContent = T('준비 완료');
    progress(T('준비 완료'), '');
  } catch (e) {
    console.error(e);
    $('engine').textContent = T('불러오지 못했어요');
    progress(T('불러오지 못했어요. 새로고침해 주세요'), '', 0);
  }
  lmLoading = false;
  refreshUI();
}

function pickSource(next) {
  if (next === source) return;
  const hasData = classes.some(c => c.vecs.length > 0);
  if (hasData && !confirm(T('보는 것을 바꾸면 모은 예시가 지워져요. 바꿀까요?'))) {
    renderSrc(); return;
  }
  classes.forEach(c => { c.vecs = []; c.thumbs = []; });
  clearTrained();
  renderClasses(); renderSrc(next);
  useSource(next).then(() => { renderSrc(); refreshUI(); steps(); });
}

function renderSrc(pending) {
  const cur = pending || source;
  document.querySelectorAll('.srcpick .db').forEach(b => {
    b.classList.toggle('on', b.dataset.src === cur);
  });
}

// ── 카메라 ──
async function listCams() {
  const sel = $('camSel');
  try {
    const devs = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'videoinput');
    const cur = sel.value;
    sel.innerHTML = '';
    devs.forEach((d, i) => {
      const o = document.createElement('option');
      o.value = d.deviceId;
      const full = d.label || (T('카메라') + ' ' + (i + 1));
      const cut = full.replace(/\s*\([0-9a-f]{4}:[0-9a-f]{4}\)\s*$/i, '').trim();
      o.textContent = cut.length > 22 ? cut.slice(0, 21) + '…' : cut;
      o.title = full;
      sel.appendChild(o);
    });
    if (cur && devs.some(d => d.deviceId === cur)) sel.value = cur;
  } catch (e) { /* 무시 */ }
}

async function camOn() {
  if (stream) return true;
  try {
    const want = { width: { ideal: 640 }, height: { ideal: 480 } };
    if ($('camSel').value) want.deviceId = { exact: $('camSel').value };
    stream = await navigator.mediaDevices.getUserMedia({ video: want, audio: false });
    $('camVid').srcObject = stream;
    await $('camVid').play();
    syncAspect();
    $('camVid').addEventListener('loadedmetadata', syncAspect);
    $('camOff').style.display = 'none';
    $('camBtn').innerHTML = '<i class="fa-solid fa-video-slash"></i> ' + T('카메라 끄기');
    await listCams();
    refreshUI();
    return true;
  } catch (e) {
    toast(T('카메라가 안 보여요. 연결을 확인해 주세요'));
    return false;
  }
}

function camStop() {
  stopCap();
  if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; }
  $('camVid').srcObject = null;
  $('camOff').style.display = '';
  $('camBtn').innerHTML = '<i class="fa-solid fa-video"></i> ' + T('카메라 켜기');
  lastResult = null; lastVec = null;
  renderNums(null);
  refreshUI();
}

function camReady() { return !!(stream && $('camVid').videoWidth); }

// 카메라 박스를 실제 영상 비율에 맞춘다.
// 폰 카메라는 4:3 이 아닐 수 있는데, 박스 비율이 다르면 영상은 contain 으로
// 줄어들고 캔버스는 박스에 늘어나 오버레이 좌표가 틀어진다.
function syncAspect() {
  const v = $('camVid');
  if (v.videoWidth) $('camBox').style.aspectRatio = v.videoWidth + ' / ' + v.videoHeight;
}

// ── 감지 루프 ──
function loop() {
  requestAnimationFrame(loop);
  // 배우는 동안은 감지를 쉰다 — 랜드마커가 프레임을 잡고 있으면
  // epoch 사이의 tf.nextFrame() 이 느려져 학습이 오래 걸린다.
  if (training) return;
  if (!camReady() || !lm) return;
  const video = $('camVid');
  let result = null;
  try { result = lm.detect(video, performance.now()); } catch (e) { return; }
  lastResult = result;
  lastVec = extract(source, result);

  // 오버레이
  const cv = $('ovCv');
  if (cv.width !== video.videoWidth || cv.height !== video.videoHeight) {
    cv.width = video.videoWidth; cv.height = video.videoHeight;
    syncAspect();               // 회전 등으로 영상 비율이 바뀌면 같이 맞춘다
  }
  const ctx = cv.getContext('2d');
  ctx.clearRect(0, 0, cv.width, cv.height);
  if (lastVec) drawResult(ctx, source, result);

  // 좌표 관찰 (5Hz 로 충분하다)
  const now = performance.now();
  if (now - lastNums > 200) { lastNums = now; renderNums(result); }

  // 수집 (버튼을 누르고 있는 동안 초당 10장)
  if (capturing && lastVec && selected >= 0 && now - lastCap > 100) {
    lastCap = now;
    addSample(lastVec);
  }
}

// ── 좌표 관찰 패널 ──
function renderNums(result) {
  const rows = lastVec ? observeRows(source, result) : null;
  $('numsState').textContent = rows ? T('보여요') : T('안 보여요');
  $('numsState').style.color = rows ? 'var(--acc-ink)' : 'var(--ink3)';

  // 얼굴일 때는 내장 신호(거리·방향)도 함께 보여준다
  const sig = $('faceSigLine');
  if (source === 'face' && rows && result) {
    const video = $('camVid');
    const s = faceSignals(result, video.videoWidth, video.videoHeight);
    if (s && s.distCm != null) {
      const parts = [T('약 Ncm').replace('N', s.distCm)];
      if (s.yaw === 'left') parts.push(T('왼쪽 보기'));
      else if (s.yaw === 'right') parts.push(T('오른쪽 보기'));
      if (s.pitch === 'up') parts.push(T('위 보기'));
      else if (s.pitch === 'down') parts.push(T('아래 보기'));
      sig.textContent = parts.join(' · ');
      sig.style.display = '';
    } else sig.style.display = 'none';
  } else sig.style.display = 'none';
  const tbl = $('numsTable');
  const empty = $('numsEmpty');
  if (!rows) {
    tbl.style.display = 'none';
    empty.style.display = '';
    empty.textContent = camReady() ? T('아직 안 보여요. 카메라 앞에 서 보세요') : T('카메라를 켜면 숫자가 나와요');
    return;
  }
  empty.style.display = 'none';
  tbl.style.display = '';
  const isFace = source === 'face';
  let html = isFace
    ? '<tr><th>' + T('이름') + '</th><th>' + T('값') + '</th></tr>'
    : '<tr><th>' + T('점') + '</th><th>x</th><th>y</th><th>z</th></tr>';
  rows.forEach(r => {
    html += '<tr><td>' + r.label + '</td>' +
      r.values.map(v => '<td>' + v.toFixed(3) + '</td>').join('') + '</tr>';
  });
  tbl.innerHTML = html;
}

// ── 종류(클래스) ──
function addClass() {
  const name = $('clsName').value.trim();
  if (!name) return;
  if (classes.some(c => c.name === name)) { toast(T('같은 이름이 이미 있어요')); return; }
  if (classes.length >= 6) { toast(T('종류는 6개까지 만들 수 있어요')); return; }
  classes.push({ name, vecs: [], thumbs: [] });
  $('clsName').value = '';
  selected = classes.length - 1;
  clearTrained();
  renderClasses(); refreshUI(); steps();
}

function delClass(i) {
  classes.splice(i, 1);
  if (selected >= classes.length) selected = classes.length - 1;
  clearTrained();
  renderClasses(); refreshUI(); steps();
}

function delSample(ci, si) {
  const c = classes[ci];
  if (!c || !c.vecs[si]) return;
  c.vecs.splice(si, 1);
  c.thumbs.splice(si, 1);
  renderClasses(); refreshUI(); steps();
}

function renderClasses() {
  const box = $('clsList');
  box.innerHTML = '';
  classes.forEach((c, i) => {
    const el = document.createElement('div');
    el.className = 'cls' + (i === selected ? ' on' : '');
    el.addEventListener('click', ev => {
      if (ev.target.closest('.del')) return;
      selected = i; renderClasses(); refreshUI();
    });
    const top = document.createElement('div');
    top.className = 'top';
    const nm = document.createElement('span'); nm.className = 'nm'; nm.textContent = c.name;
    const ct = document.createElement('span'); ct.className = 'ct'; ct.textContent = c.vecs.length + T('장');
    const del = document.createElement('button');
    del.className = 'del'; del.innerHTML = '<i class="fa-solid fa-xmark"></i>';
    del.title = T('지우기');
    del.addEventListener('click', () => delClass(i));
    top.appendChild(nm); top.appendChild(ct); top.appendChild(del);
    el.appendChild(top);

    if (c.thumbs.length) {
      const th = document.createElement('div'); th.className = 'thumbs';
      c.thumbs.forEach((src, si) => {
        const im = document.createElement('img');
        im.src = src;
        im.title = T('누르면 이 예시를 지워요');
        im.addEventListener('click', ev => { ev.stopPropagation(); delSample(i, si); });
        th.appendChild(im);
      });
      el.appendChild(th);
    }
    box.appendChild(el);
  });
  $('clsHint').style.display = classes.length ? 'none' : '';
}

// ── 예시 수집 ──
// 저장하는 것은 벡터뿐이다. 썸네일은 화면 표시용으로만 메모리에 둔다.
function thumb() {
  const video = $('camVid');
  const cv = document.createElement('canvas');
  cv.width = 96; cv.height = 96;
  const ctx = cv.getContext('2d');
  ctx.translate(96, 0); ctx.scale(-1, 1);   // 화면과 같게 좌우 반전
  // 영상 비율이 어떻든 찌그러지지 않게 가운데를 정사각형으로 잘라 찍는다
  const s = Math.min(video.videoWidth, video.videoHeight) || 1;
  const sx = (video.videoWidth - s) / 2, sy = (video.videoHeight - s) / 2;
  ctx.drawImage(video, sx, sy, s, s, 0, 0, 96, 96);
  return cv.toDataURL('image/jpeg', 0.7);
}

function addSample(vec) {
  const c = classes[selected];
  if (!c || c.vecs.length >= 200) return;
  c.vecs.push(Float32Array.from(vec));
  c.thumbs.push(thumb());
  clearTrained();
  renderClasses(); refreshUI(); steps();
}

function startCap() {
  if (selected < 0 || !camReady() || capturing) return;
  capturing = true; lastCap = 0;
}
function stopCap() { capturing = false; }

// ── 배우기 ──
function clearTrained() {
  if (trained) { trained.model.dispose(); trained = null; }
  $('resultSec').style.display = 'none';
  $('chartBox').style.display = 'none';
  refreshUI(); steps();
}

async function train() {
  const usable = classes.filter(c => c.vecs.length > 0);
  if (usable.length < 2) { toast(T('종류 2개에 예시가 있어야 해요')); return; }
  if (training) return;
  training = true;
  refreshUI();

  const dim = FEATURE_DIMS[source];
  const vecs = [], labels = [];
  usable.forEach((c, i) => c.vecs.forEach(v => { vecs.push(v); labels.push(i); }));

  $('chartBox').style.display = '';
  const hist = [];
  try {
    const t0 = performance.now();
    const out = await trainModel(vecs, labels, usable.length, dim, (ep, total, rec) => {
      hist.push(rec);
      progress(T('배우는 중') + ' ' + ep + '/' + total,
        T('맞힌 비율') + ' ' + Math.round((rec.acc || 0) * 100) + '%', ep / total);
      drawChart(hist);
    });
    console.log('train took', Math.round(performance.now() - t0), 'ms');
    trained = Object.assign(out, { classes: usable.map(c => c.name), saved: false });
    progress(T('다 배웠어요'), T('맞힌 비율') + ' ' + Math.round(out.accuracy * 100) + '%', 1);
    showResult(out, usable);
    if (out.accuracy < 0.85) toast(T('아직 헷갈려 해요. 예시를 더 모아 볼까요?'));
    else toast(T('잘 배웠어요! 이제 시험해 보세요'));
  } catch (e) {
    console.error(e);
    progress(T('배우다가 멈췄어요. 다시 해 보세요'), '', 0);
  }
  training = false;
  refreshUI(); steps();
}

function showResult(out, usable) {
  $('resultSec').style.display = '';
  $('accBig').textContent = Math.round(out.accuracy * 100) + '%';
  $('accWord').textContent = T('맞힌 비율');

  // 헷갈린 표 (혼동 행렬)
  const names = usable.map(c => c.name);
  let html = '<table><tr><th></th>' + names.map(n => '<th title="' + esc(n) + '">' + esc(n) + '</th>').join('') + '</tr>';
  out.confusion.forEach((row, i) => {
    const total = row.reduce((a, b) => a + b, 0) || 1;
    html += '<tr><th title="' + esc(names[i]) + '">' + esc(names[i]) + '</th>';
    row.forEach((v, j) => {
      const ratio = v / total;
      const bg = accentRgba((ratio * 0.75).toFixed(3));
      html += '<td class="' + (i === j ? 'diag' : '') + '" style="background:' + bg + '">' + (v || '') + '</td>';
    });
    html += '</tr>';
  });
  html += '</table>';
  $('cmWrap').innerHTML = html;
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
}

// ── 학습 그래프 ──
function drawChart(hist) {
  const cv = $('chart');
  const W = cv.clientWidth || 280, H = cv.clientHeight || 110;
  if (cv.width !== W * 2) { cv.width = W * 2; cv.height = H * 2; }
  const ctx = cv.getContext('2d');
  ctx.setTransform(2, 0, 0, 2, 0, 0);
  ctx.clearRect(0, 0, W, H);
  if (!hist.length) return;
  const pad = 6;
  const maxLoss = Math.max(0.001, ...hist.map(h => h.loss || 0));
  const px = i => pad + (W - 2 * pad) * (hist.length === 1 ? 1 : i / (hist.length - 1));
  const line = (get, color) => {
    ctx.beginPath();
    hist.forEach((h, i) => {
      const y = pad + (H - 2 * pad) * (1 - Math.max(0, Math.min(1, get(h))));
      i ? ctx.lineTo(px(i), y) : ctx.moveTo(px(i), y);
    });
    ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.stroke();
  };
  const warn = (getComputedStyle(document.documentElement).getPropertyValue('--warn') || '').trim() || '#E2574C';
  line(h => (h.loss || 0) / maxLoss, warn);
  line(h => h.acc || 0, accentColor());
}

// ── 저장 ──
async function saveModel() {
  if (!trained) return;
  const name = $('mdlName').value.trim();
  if (!name) { toast(T('모델 이름을 적어 주세요')); return; }
  try {
    const exists = await Store.meta(name);
    if (exists && !confirm(T('같은 이름이 있어요. 바꿔 쓸까요?'))) return;
    // 예시(벡터+썸네일)도 함께 저장한다 — 다음에 이어서 모으고 다시 배울 수 있다.
    // 다 합쳐도 수 MB 이내라 IndexedDB·zip 양쪽 모두 부담 없다.
    const usable = classes.filter(c => c.vecs.length > 0);
    await Store.save(name, trained.model, {
      source,
      featureDim: FEATURE_DIMS[source],
      classes: trained.classes,
      sampleCount: usable.map(c => c.vecs.length),
      accuracy: trained.accuracy,
      examples: usable.map(c => ({
        name: c.name,
        vecs: c.vecs.map(v => Array.from(v)),
        thumbs: c.thumbs.slice(),
      })),
      createdAt: new Date().toISOString(),
      version: 2,
    });
    trained.saved = true;
    toast(T('저장했어요') + ': ' + name);
  } catch (e) {
    console.error(e);
    toast(T('저장하지 못했어요'));
  }
  steps();
}

// ── 버튼 상태 ──
function refreshUI() {
  $('capBtn').disabled = !(camReady() && lm && selected >= 0);
  $('selInfo').textContent = selected >= 0
    ? T('고른 종류') + ': ' + classes[selected].name
    : T('종류를 골라 주세요');
  $('selInfo').classList.toggle('on', selected >= 0);
  const shot = classes.filter(c => c.vecs.length > 0).length;
  $('trainBtn').disabled = training || shot < 2;
  $('mdlSave').disabled = !trained;
}

// ── 이벤트 연결 ──
document.querySelectorAll('.srcpick .db').forEach(b => {
  b.addEventListener('click', () => pickSource(b.dataset.src));
});
$('clsAdd').addEventListener('click', addClass);
$('clsName').addEventListener('keydown', e => { if (e.key === 'Enter') addClass(); });
$('camBtn').addEventListener('click', () => (stream ? camStop() : camOn()));
$('camSel').addEventListener('change', () => { if (stream) { camStop(); camOn(); } });
const cap = $('capBtn');
cap.addEventListener('pointerdown', e => { cap.setPointerCapture(e.pointerId); startCap(); });
cap.addEventListener('pointerup', stopCap);
cap.addEventListener('pointercancel', stopCap);
cap.addEventListener('contextmenu', e => e.preventDefault());
$('trainBtn').addEventListener('click', train);
$('mdlSave').addEventListener('click', saveModel);

// ── 이어서 배우기 (?load=모델이름) ──
// 보관함에서 넘어오면 저장해 둔 예시를 다시 채워 이어서 모으고 배울 수 있다.
async function restoreWork(name) {
  try {
    const meta = await Store.meta(name);
    if (!meta || !meta.examples || !meta.examples.length) {
      toast(T('이어 할 예시가 없어요'));
      return;
    }
    if (meta.source && meta.source !== source) {
      source = meta.source;
      renderSrc();
      await useSource(meta.source);
    }
    classes = meta.examples.map(e => ({
      name: e.name,
      vecs: (e.vecs || []).map(v => Float32Array.from(v)),
      thumbs: (e.thumbs || []).slice(),
    }));
    selected = 0;
    $('mdlName').value = meta.name;
    renderClasses(); refreshUI(); steps();
    toast(T('이어서 시작해요') + ': ' + name);
  } catch (e) {
    console.error(e);
    toast(T('모델을 불러오지 못했어요'));
  }
}

// ── 시작 ──
const loadName = new URLSearchParams(location.search).get('load');
if (loadName) {
  // 소스는 restoreWork 가 맞춘다 — 기본(손)을 먼저 올렸다가 바꾸지 않는다
  Store.meta(loadName).then(meta => {
    if (meta && meta.source) source = meta.source;
    renderSrc();
    return useSource(source);
  }).then(() => restoreWork(loadName));
} else {
  useSource(source);
}
navigator.mediaDevices && listCams();
loop();
steps();
refreshUI();
