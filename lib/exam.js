// ═══════════════════════════════════════════════════════════
// 시험실 — 하나 시험하기(단일) / 묶어서 시험하기(조합)
// ═══════════════════════════════════════════════════════════
//  · 확신도 임계값: 최대 확률이 임계값 미만이면 "모르겠어요"
//  · 미검출: 랜드마크가 없으면 "안 보여요" (규칙표 조건으로도 쓸 수 있다)
//  · 조합 모드: 랜드마커를 라운드로빈으로 프레임마다 하나씩만 돌린다.
//    마지막 결과는 캐시하고, 규칙 판정은 매 프레임 한다.
//  · 모델은 절대 합치지 않는다 — 소스별 독립 모델 + 규칙표 조합.

import { loadLandmarker, drawResult } from './landmarker.js';
import { extract, computeSignals, sigMatch, BUILTIN_SIGS } from './features.js';
import { predictProbs } from './trainer.js';
import { Store } from './store.js';

const $ = id => document.getElementById(id);
const T = s => (typeof GL_T === 'function' ? GL_T(s) : s);
const SRC_KO = { hand: '손', face: '얼굴', pose: '포즈' };
const SOURCES = ['hand', 'face', 'pose'];

let mode = 'single';
let allMeta = [];
let threshold = 0.7;

// 소스별 상태
let slots = { hand: null, face: null, pose: null };   // { name, model, meta }
let singleName = null;
const lms = { hand: null, face: null, pose: null };
const lmPending = { hand: null, face: null, pose: null };
const results = { hand: null, face: null, pose: null }; // { state:'none'|'idk'|'ok', label, prob, probs }
const lastRaw = { hand: null, face: null, pose: null };
// 학습 없이 읽는 내장 신호 상태 (손가락 개수·거리·방향·입/웃음·손 들기)
const sigStates = { hand: null, face: null, pose: null };

let stream = null;
let rr = 0;
let lastUi = 0;
let rules = [];               // { name, op:'AND'|'OR', conds:{hand:'',face:'',pose:''} }

// ── 순서 놀이 상태 ──
// 순서도처럼 단계를 위에서 아래로 통과한다. 동작을 잠깐 유지해야 통과 —
// 지나가다 스친 것과 일부러 만든 동작을 구분하기 위해서다.
const SEQ_HOLD_MS = 800;      // 이만큼 유지하면 통과
const SEQ_COOLDOWN = 700;     // 통과 직후 잠깐 쉼 (같은 동작 연속 단계 대비)
const SEQ_MAX = 8;
let seqSteps = [];            // [{ src, cls }]  cls 는 'c:종류이름' 또는 's:신호토큰'
let seqPos = 0, seqHold = 0, seqCool = 0, seqDone = false, seqLastTick = 0;

let toastTimer = null;
function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('on'), 2200);
}

// ── 랜드마커 관리 (전환 시 close 로 정리) ──
function ensureLm(src) {
  if (lms[src]) return Promise.resolve(lms[src]);
  if (lmPending[src]) return lmPending[src];
  $('engine').textContent = T('준비 중…');
  lmPending[src] = loadLandmarker(src).then(l => {
    lms[src] = l; lmPending[src] = null;
    $('engine').textContent = T('준비 완료');
    return l;
  }).catch(e => {
    lmPending[src] = null;
    $('engine').textContent = T('불러오지 못했어요');
    console.error(e);
  });
  return lmPending[src];
}

function releaseExcept(keep) {
  SOURCES.forEach(src => {
    if (!keep.includes(src) && lms[src]) {
      lms[src].close();
      lms[src] = null;
      results[src] = null;
      lastRaw[src] = null;
    }
  });
}

function activeSources() {
  if (mode === 'single') {
    const s = slots.hand || slots.face || slots.pose;
    return s ? [s.meta.source] : [];
  }
  return SOURCES.filter(src => slots[src]);   // 조합·순서 놀이 공통
}

// 규칙·단계가 조건으로 참조하는 소스들 (모델이 없어도 신호만으로 참조 가능)
function usedSources() {
  const used = new Set();
  if (mode === 'combo') {
    rules.forEach(r => SOURCES.forEach(src => { if (r.conds[src]) used.add(src); }));
  } else if (mode === 'seq') {
    seqSteps.forEach(s => used.add(s.src));
  }
  return used;
}

// 실제로 돌릴 랜드마커 — 모델 슬롯 + 조건이 참조하는 소스
function detectSources() {
  if (mode === 'single') return activeSources();
  const used = usedSources();
  activeSources().forEach(src => used.add(src));
  return SOURCES.filter(src => used.has(src));
}

function syncLms() {
  const det = detectSources();
  det.forEach(src => ensureLm(src));
  releaseExcept(det);
  SOURCES.forEach(src => { if (!det.includes(src)) sigStates[src] = null; });
}

// ── 모델 고르기 ──
async function setSlot(src, name) {
  if (slots[src]) { slots[src].model.dispose(); slots[src] = null; }
  results[src] = null; lastRaw[src] = null;
  if (name) {
    try {
      const rec = await Store.load(name);
      if (rec && rec.meta.source === src) {
        slots[src] = { name, model: rec.model, meta: rec.meta };
        await ensureLm(src);
      } else if (rec) rec.model.dispose();
    } catch (e) {
      console.error(e);
      toast(T('모델을 불러오지 못했어요'));
    }
  }
  releaseExcept(detectSources());
}

async function pickSingle(name) {
  singleName = name;
  // 단일 모드는 슬롯 하나만 쓴다 — 전부 비우고 해당 소스에만 넣는다
  for (const src of SOURCES) if (slots[src]) { slots[src].model.dispose(); slots[src] = null; results[src] = null; lastRaw[src] = null; }
  const meta = allMeta.find(m => m.name === name);
  if (meta) await setSlot(meta.source, name);
  renderSingleList();
  renderBars(true);
}

// ── 목록 UI ──
function renderSingleList() {
  const box = $('mdlList');
  box.innerHTML = '';
  $('mdlEmpty').style.display = allMeta.length ? 'none' : '';
  allMeta.forEach(m => {
    const el = document.createElement('div');
    el.className = 'mradio' + (m.name === singleName ? ' on' : '');
    const nm = document.createElement('span'); nm.className = 'nm'; nm.textContent = m.name;
    const mt = document.createElement('span'); mt.className = 'mt';
    mt.textContent = T(SRC_KO[m.source] || m.source) + ' · ' + (m.classes || []).length + T('가지');
    el.appendChild(nm); el.appendChild(mt);
    el.addEventListener('click', () => pickSingle(m.name));
    box.appendChild(el);
  });
}

function renderComboSelects() {
  const ids = { hand: 'slotHand', face: 'slotFace', pose: 'slotPose' };
  SOURCES.forEach(src => {
    const sel = $(ids[src]);
    const cur = slots[src] ? slots[src].name : '';
    sel.innerHTML = '';
    const none = document.createElement('option');
    none.value = ''; none.textContent = T('사용 안 해요');
    sel.appendChild(none);
    allMeta.filter(m => m.source === src).forEach(m => {
      const o = document.createElement('option');
      o.value = m.name; o.textContent = m.name;
      sel.appendChild(o);
    });
    sel.value = cur;
  });
}

// ── 감지 루프 ──
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
  if (stream) return;
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
  } catch (e) {
    toast(T('카메라가 안 보여요. 연결을 확인해 주세요'));
  }
}

function camStop() {
  if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; }
  $('camVid').srcObject = null;
  $('camOff').style.display = '';
  $('camBtn').innerHTML = '<i class="fa-solid fa-video"></i> ' + T('카메라 켜기');
  SOURCES.forEach(s => { results[s] = null; lastRaw[s] = null; sigStates[s] = null; });
}

// 내장 신호 상태를 화면 문구로 (소스별)
function sigText(src, s) {
  if (!s || !s.shown) return T('안 보여요');
  const parts = [];
  if (src === 'hand') {
    parts.push(T('손가락 N개').replace('N', s.fingers));
  } else if (src === 'face') {
    if (s.distCm != null) parts.push(T('약 Ncm').replace('N', s.distCm));
    if (s.yaw === 'left') parts.push(T('왼쪽 보기'));
    else if (s.yaw === 'right') parts.push(T('오른쪽 보기'));
    if (s.pitch === 'up') parts.push(T('위 보기'));
    else if (s.pitch === 'down') parts.push(T('아래 보기'));
    if (s.mouth) parts.push(T('입 벌리기'));
    if (s.smile) parts.push(T('웃기'));
  } else if (src === 'pose') {
    if (s.handsUp >= 2) parts.push(T('두 손 들기'));
    else if (s.handsUp >= 1) parts.push(T('한 손 들기'));
  }
  return parts.length ? parts.join(' · ') : T('보여요');
}

function camReady() { return !!(stream && $('camVid').videoWidth); }

// 카메라 박스를 실제 영상 비율에 맞춘다 (학습실과 동일 — 폰 카메라 비율 대응)
function syncAspect() {
  const v = $('camVid');
  if (v.videoWidth) $('camBox').style.aspectRatio = v.videoWidth + ' / ' + v.videoHeight;
}

function classify(src, vec) {
  const slot = slots[src];
  if (!slot) return null;
  if (!vec) return { state: 'none' };
  const probs = predictProbs(slot.model, vec);
  let top = 0;
  for (let i = 1; i < probs.length; i++) if (probs[i] > probs[top]) top = i;
  const prob = probs[top];
  if (prob < threshold) return { state: 'idk', prob, probs };
  return { state: 'ok', label: slot.meta.classes[top], prob, probs };
}

function loop() {
  requestAnimationFrame(loop);
  const det = detectSources();
  const now = performance.now();

  if (camReady() && det.length) {
    // 라운드로빈: 이번 프레임에는 랜드마커 하나만 돌린다
    const src = det[rr % det.length];
    rr++;
    const l = lms[src];
    const video = $('camVid');
    if (l) {
      let raw = null;
      try { raw = l.detect(video, now); } catch (e) { /* 무시 */ }
      lastRaw[src] = raw;
      sigStates[src] = computeSignals(src, raw, video.videoWidth, video.videoHeight);
      if (slots[src]) results[src] = classify(src, raw ? extract(src, raw) : null);
    }

    // 오버레이 — 각 소스의 마지막 결과를 함께 그린다
    const cv = $('ovCv');
    if (cv.width !== video.videoWidth || cv.height !== video.videoHeight) {
      cv.width = video.videoWidth; cv.height = video.videoHeight;
      syncAspect();             // 회전 등으로 영상 비율이 바뀌면 같이 맞춘다
    }
    const ctx = cv.getContext('2d');
    ctx.clearRect(0, 0, cv.width, cv.height);
    det.forEach(s => { if (lastRaw[s]) drawResult(ctx, s, lastRaw[s]); });
  }

  if (now - lastUi > 120) { lastUi = now; renderLive(); }
}

// ── 실시간 표시 ──
function renderLive() {
  if (mode === 'single') { renderBars(); renderSingleAnswer(); }
  else if (mode === 'combo') { renderSrcStates(); evalRules(); }
  else { renderSrcStates(); tickSeq(); }
}

function stateWord(st) {
  if (!st) return { txt: T('기다리는 중'), cls: 'none' };
  if (st.state === 'none') return { txt: T('안 보여요'), cls: 'none' };
  if (st.state === 'idk') return { txt: T('모르겠어요'), cls: 'idk' };
  return { txt: st.label, cls: 'ok' };
}

function renderSingleAnswer() {
  const el = $('answer');
  const slot = slots.hand || slots.face || slots.pose;
  el.classList.remove('sure', 'idk');
  if (!slot) { el.textContent = T('모델을 골라 주세요'); el.classList.add('idk'); return; }
  if (!camReady()) { el.textContent = T('카메라를 켜 주세요'); el.classList.add('idk'); return; }
  const st = results[slot.meta.source];
  const w = stateWord(st);
  el.textContent = w.txt;
  if (w.cls === 'ok') el.classList.add('sure');
  else el.classList.add('idk');
}

function renderBars(reset) {
  const box = $('bars');
  const slot = slots.hand || slots.face || slots.pose;
  if (!slot) { box.innerHTML = ''; $('barsHint').style.display = 'none'; return; }
  const labels = slot.meta.classes || [];
  $('barsHint').style.display = '';
  if (reset || box.children.length !== labels.length) {
    box.innerHTML = '';
    labels.forEach(n => {
      const d = document.createElement('div'); d.className = 'bar';
      d.innerHTML = '<div class="bl"><span></span><span></span></div><div class="bt"><div class="bf"></div></div>';
      d.querySelector('.bl span').textContent = n;
      box.appendChild(d);
    });
  }
  const st = results[slot.meta.source];
  const probs = st && st.probs ? st.probs : null;
  let top = -1;
  if (probs) { top = 0; for (let i = 1; i < probs.length; i++) if (probs[i] > probs[top]) top = i; }
  labels.forEach((n, i) => {
    const d = box.children[i];
    if (!d) return;
    const p = probs ? probs[i] : 0;
    d.classList.toggle('top', i === top && st.state === 'ok');
    d.querySelectorAll('.bl span')[1].textContent = Math.round(p * 100) + '%';
    d.querySelector('.bf').style.width = (p * 100) + '%';
  });
}

function renderSrcStates() {
  const box = $('srcStates');
  const keys = detectSources();
  box.style.display = keys.length ? '' : 'none';
  if (box.dataset.keys !== keys.join()) {
    box.dataset.keys = keys.join();
    box.innerHTML = '';
    keys.forEach(src => {
      const d = document.createElement('div');
      d.className = 'srcstate'; d.dataset.src = src;
      d.innerHTML = '<span class="sn"></span><span class="sv"></span><span class="sp2"></span>';
      d.querySelector('.sn').textContent = T(SRC_KO[src]);
      box.appendChild(d);
    });
  }
  keys.forEach(src => {
    const d = box.querySelector('[data-src="' + src + '"]');
    if (!d) return;
    const sv = d.querySelector('.sv');
    if (slots[src]) {
      // 모델이 있는 소스: 배운 종류로 답한다
      const st = results[src];
      const w = stateWord(st);
      sv.textContent = w.txt;
      sv.className = 'sv' + (w.cls !== 'ok' ? ' ' + w.cls : '');
      d.querySelector('.sp2').textContent = st && st.prob != null ? Math.round(st.prob * 100) + '%' : '';
    } else {
      // 신호만 쓰는 소스: 내장 신호를 보여준다
      const s = sigStates[src];
      sv.textContent = sigText(src, s);
      sv.className = 'sv' + (s && s.shown ? '' : ' none');
      d.querySelector('.sp2').textContent = '';
    }
  });
}

// ── 규칙표 ──
function newRule() {
  return { name: '', op: 'AND', conds: { hand: '', face: '', pose: '' } };
}

// 소스 하나가 조건으로 고를 수 있는 것들:
// 배운 종류('c:이름') + 학습 없이 되는 신호('s:토큰')
function condOptions(src) {
  const learned = slots[src]
    ? (slots[src].meta.classes || []).map(c => ['c:' + c, c])
    : [];
  const sigs = BUILTIN_SIGS[src].map(([v, ko]) => ['s:' + v, T(ko)]);
  return { learned, sigs };
}

// 슬롯이 바뀌면 사라진 모델의 종류를 조건에서 지운다
function sanitizeConds() {
  const valid = src => {
    const cls = slots[src] ? (slots[src].meta.classes || []) : [];
    return v => !v.startsWith('c:') || cls.includes(v.slice(2));
  };
  rules.forEach(r => SOURCES.forEach(src => {
    if (r.conds[src] && !valid(src)(r.conds[src])) r.conds[src] = '';
  }));
  seqSteps = seqSteps.filter(s => valid(s.src)(s.cls));
}

function renderRules() {
  const box = $('ruleList');
  box.innerHTML = '';
  rules.forEach((rule, ri) => {
    const el = document.createElement('div');
    el.className = 'rule'; el.dataset.ri = ri;

    const rtop = document.createElement('div'); rtop.className = 'rtop';
    const nameInp = document.createElement('input');
    nameInp.className = 'inp'; nameInp.maxLength = 20;
    nameInp.placeholder = T('동작 이름 (예: 인사)');
    nameInp.value = rule.name;
    nameInp.addEventListener('input', () => { rule.name = nameInp.value; });
    const del = document.createElement('button');
    del.className = 'del'; del.innerHTML = '<i class="fa-solid fa-xmark"></i>';
    del.title = T('지우기');
    del.addEventListener('click', () => { rules.splice(ri, 1); renderRules(); syncLms(); });
    rtop.appendChild(nameInp); rtop.appendChild(del);
    el.appendChild(rtop);

    const conds = document.createElement('div'); conds.className = 'conds';
    SOURCES.forEach(src => {
      const rc = document.createElement('div'); rc.className = 'rcond';
      const sn = document.createElement('span'); sn.className = 'sn';
      sn.textContent = T(SRC_KO[src]);
      const sel = document.createElement('select'); sel.className = 'inp';

      const none = document.createElement('option');
      none.value = ''; none.textContent = T('상관없어요');
      sel.appendChild(none);
      const { learned, sigs } = condOptions(src);
      const addGroup = (label, items) => {
        if (!items.length) return;
        const g = document.createElement('optgroup');
        g.label = label;
        items.forEach(([v, txt]) => {
          const o = document.createElement('option');
          o.value = v; o.textContent = txt;
          g.appendChild(o);
        });
        sel.appendChild(g);
      };
      addGroup(T('배운 것'), learned);
      addGroup(T('그냥 되는 것'), sigs);

      sel.value = rule.conds[src] || '';
      if (sel.value !== (rule.conds[src] || '')) { rule.conds[src] = ''; sel.value = ''; }
      sel.addEventListener('change', () => {
        rule.conds[src] = sel.value;
        syncLms();               // 조건이 참조하는 랜드마커를 준비/정리한다
      });
      rc.appendChild(sn); rc.appendChild(sel);
      conds.appendChild(rc);
    });
    el.appendChild(conds);

    const op = document.createElement('div'); op.className = 'op';
    const lb = document.createElement('span'); lb.className = 'lb2';
    lb.textContent = T('묶는 방법');
    op.appendChild(lb);
    [['AND', T('모두 맞으면')], ['OR', T('하나만 맞아도')]].forEach(([v, txt]) => {
      const b = document.createElement('button');
      b.textContent = txt;
      b.classList.toggle('on', rule.op === v);
      b.addEventListener('click', () => {
        rule.op = v;
        op.querySelectorAll('button').forEach(x => x.classList.remove('on'));
        b.classList.add('on');
      });
      op.appendChild(b);
    });
    el.appendChild(op);

    box.appendChild(el);
  });
}

function condMatch(src, want) {
  if (want.startsWith('s:')) return sigMatch(src, want.slice(2), sigStates[src]);
  if (want.startsWith('c:')) {
    const st = results[src];
    return !!st && st.state === 'ok' && st.label === want.slice(2);
  }
  return false;
}

function evalRules() {
  const el = $('answer');
  el.classList.remove('sure', 'idk');
  if (!rules.length) { el.textContent = T('규칙을 더해 보세요'); el.classList.add('idk'); markFired(-1); return; }
  if (!detectSources().length) { el.textContent = T('규칙에 조건을 골라 주세요'); el.classList.add('idk'); markFired(-1); return; }
  if (!camReady()) { el.textContent = T('카메라를 켜 주세요'); el.classList.add('idk'); markFired(-1); return; }

  let fired = -1;
  for (let i = 0; i < rules.length; i++) {
    const r = rules[i];
    const conds = SOURCES.filter(src => r.conds[src] !== '');
    if (!conds.length) continue;
    const ok = r.op === 'OR'
      ? conds.some(src => condMatch(src, r.conds[src]))
      : conds.every(src => condMatch(src, r.conds[src]));
    if (ok) { fired = i; break; }
  }
  if (fired >= 0) {
    el.textContent = rules[fired].name || T('이름 없는 동작');
    el.classList.add('sure');
  } else {
    el.textContent = T('맞는 규칙이 없어요');
    el.classList.add('idk');
  }
  markFired(fired);
}

function markFired(ri) {
  document.querySelectorAll('#ruleList .rule').forEach(el => {
    el.classList.toggle('fired', Number(el.dataset.ri) === ri);
  });
}

// ── 순서 놀이 ──
function seqRun(clearSteps) {
  seqPos = 0; seqHold = 0; seqCool = 0; seqDone = false; seqLastTick = 0;
  if (clearSteps) seqSteps = [];
}

// 고를 수 있는 단계 조건: 소스마다 [배운 종류] + [학습 없이 되는 신호]
// 모델을 하나도 만들지 않아도 신호만으로 순서도를 만들 수 있다.
function seqOptions() {
  const opts = [];
  SOURCES.forEach(src => {
    const { learned, sigs } = condOptions(src);
    learned.forEach(([v, txt]) => opts.push([src + '|' + v, T(SRC_KO[src]) + ': ' + txt]));
    sigs.forEach(([v, txt]) => opts.push([src + '|' + v, T(SRC_KO[src]) + ': ' + txt]));
  });
  return opts;
}

function seqCondMet(step) {
  return condMatch(step.src, step.cls);
}

function renderSeqFlow() {
  const box = $('seqFlow');
  box.innerHTML = '';
  const opts = seqOptions();

  const start = document.createElement('div');
  start.className = 'seq-node';
  start.textContent = T('시작');
  box.appendChild(start);

  seqSteps.forEach((step, i) => {
    const arrow = document.createElement('div');
    arrow.className = 'seq-arrow';
    box.appendChild(arrow);

    const el = document.createElement('div');
    el.className = 'seq-step';
    el.dataset.i = i;

    const top = document.createElement('div');
    top.className = 'top';
    const idx = document.createElement('span');
    idx.className = 'sq-idx';
    idx.textContent = i + 1;
    top.appendChild(idx);

    const sel = document.createElement('select');
    sel.className = 'inp';
    opts.forEach(([v, txt]) => {
      const o = document.createElement('option');
      o.value = v; o.textContent = txt;
      sel.appendChild(o);
    });
    const applyVal = v => {
      const k = v.indexOf('|');
      step.src = v.slice(0, k); step.cls = v.slice(k + 1);
    };
    const cur = step.src + '|' + step.cls;
    sel.value = opts.some(([v]) => v === cur) ? cur : (opts[0] ? opts[0][0] : '');
    if (sel.value && sel.value !== cur) applyVal(sel.value);
    sel.addEventListener('change', () => {
      applyVal(sel.value);
      seqRun(false);            // 단계를 고치면 처음부터 다시
      syncLms();
    });
    top.appendChild(sel);

    const del = document.createElement('button');
    del.className = 'del';
    del.innerHTML = '<i class="fa-solid fa-xmark"></i>';
    del.title = T('지우기');
    del.addEventListener('click', () => {
      seqSteps.splice(i, 1);
      seqRun(false);
      renderSeqFlow();
      syncLms();
    });
    top.appendChild(del);
    el.appendChild(top);

    const track = document.createElement('div');
    track.className = 'sq-track';
    track.innerHTML = '<div class="sq-fill"></div>';
    el.appendChild(track);

    box.appendChild(el);
  });

  const arrow2 = document.createElement('div');
  arrow2.className = 'seq-arrow';
  box.appendChild(arrow2);
  const goal = document.createElement('div');
  goal.className = 'seq-node goal';
  goal.id = 'seqGoal';
  goal.textContent = T('성공!');
  box.appendChild(goal);

  updateSeqFlow();
}

function updateSeqFlow() {
  document.querySelectorAll('#seqFlow .seq-step').forEach(el => {
    const i = Number(el.dataset.i);
    el.classList.toggle('done', seqDone || i < seqPos);
    el.classList.toggle('cur', !seqDone && i === seqPos);
    const fill = el.querySelector('.sq-fill');
    if (fill) {
      const w = (seqDone || i < seqPos) ? 100 : (i === seqPos ? Math.round(seqHold / SEQ_HOLD_MS * 100) : 0);
      fill.style.width = w + '%';
    }
  });
  const goal = $('seqGoal');
  if (goal) goal.classList.toggle('done', seqDone);
}

function tickSeq() {
  const el = $('answer');
  el.classList.remove('sure', 'idk');
  const now = performance.now();
  const dt = seqLastTick ? Math.min(400, now - seqLastTick) : 0;
  seqLastTick = now;

  let msg = null, sure = false;
  if (!seqSteps.length) msg = T('단계를 더해 보세요');
  else if (seqDone) { msg = T('성공! 참 잘했어요'); sure = true; }
  else if (!camReady()) msg = T('카메라를 켜 주세요');
  else {
    const step = seqSteps[seqPos];
    if (now >= seqCool && seqCondMet(step)) {
      seqHold += dt;
      if (seqHold >= SEQ_HOLD_MS) {
        seqHold = 0; seqPos++; seqCool = now + SEQ_COOLDOWN;
        if (seqPos >= seqSteps.length) { seqDone = true; toast(T('성공! 참 잘했어요')); }
      }
    } else {
      seqHold = Math.max(0, seqHold - dt * 2);   // 벗어나면 서서히 줄어든다
    }
    if (seqDone) { msg = T('성공! 참 잘했어요'); sure = true; }
    else msg = T('N번 동작을 해 보세요').replace('N', seqPos + 1);
  }
  el.textContent = msg;
  el.classList.add(sure ? 'sure' : 'idk');
  updateSeqFlow();
}

// ── 모드 전환 ──
async function setMode(next) {
  if (mode === next) return;
  mode = next;
  const single = next === 'single';
  $('modeSingle').classList.toggle('on', next === 'single');
  $('modeCombo').classList.toggle('on', next === 'combo');
  $('modeSeq').classList.toggle('on', next === 'seq');
  $('modeHint').textContent = next === 'single' ? T('배운 모델 1개를 시험해요')
    : next === 'combo' ? T('모델을 묶어 규칙을 만들어요')
    : T('동작을 순서대로 이어 봐요');
  $('sglPick').style.display = single ? '' : 'none';
  $('cmbPick').style.display = single ? 'none' : '';
  $('sglOut').style.display = single ? '' : 'none';
  $('cmbOut').style.display = next === 'combo' ? '' : 'none';
  $('seqOut').style.display = next === 'seq' ? '' : 'none';
  $('srcStates').style.display = 'none';

  // 슬롯을 모두 비운다 (모델·랜드마커 정리)
  for (const src of SOURCES) await setSlot(src, null);
  singleName = null;
  seqRun(true);
  sanitizeConds();
  if (single) renderSingleList();
  else {
    renderComboSelects();
    if (next === 'combo') renderRules();
    else renderSeqFlow();
  }
  syncLms();
  renderBars(true);
  renderLive();
}

// ── 이벤트 ──
$('modeSingle').addEventListener('click', () => setMode('single'));
$('modeCombo').addEventListener('click', () => setMode('combo'));
$('modeSeq').addEventListener('click', () => setMode('seq'));
$('seqAdd').addEventListener('click', () => {
  const opts = seqOptions();
  if (seqSteps.length >= SEQ_MAX) { toast(T('단계는 8개까지예요')); return; }
  const v = opts[0][0], k = v.indexOf('|');
  seqSteps.push({ src: v.slice(0, k), cls: v.slice(k + 1) });
  seqRun(false);
  renderSeqFlow();
  syncLms();
});
$('seqReset').addEventListener('click', () => { seqRun(false); updateSeqFlow(); });
$('camBtn').addEventListener('click', () => (stream ? camStop() : camOn()));
$('camSel').addEventListener('change', () => { if (stream) { camStop(); camOn(); } });
$('thrSlider').addEventListener('input', () => {
  threshold = Number($('thrSlider').value) / 100;
  $('thrVal').textContent = $('thrSlider').value + '%';
});
$('ruleAdd').addEventListener('click', () => {
  rules.push(newRule());       // 얼굴 신호만으로도 규칙을 만들 수 있다
  renderRules();
});
[['slotHand', 'hand'], ['slotFace', 'face'], ['slotPose', 'pose']].forEach(([id, src]) => {
  $(id).addEventListener('change', async e => {
    await setSlot(src, e.target.value || null);
    // 사라진 모델의 종류를 조건에서 정리한다 (신호 조건은 그대로 유지)
    sanitizeConds();
    if (mode === 'seq') { seqRun(false); renderSeqFlow(); }
    else renderRules();
    syncLms();
  });
});

// ── 시작 ──
(async function init() {
  try { allMeta = await Store.list(); } catch (e) { console.error(e); }
  renderSingleList();
  renderComboSelects();
  $('engine').textContent = T('준비 완료');
  navigator.mediaDevices && listCams();
  loop();
})();
