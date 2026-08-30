// ═══════════════════════════════════════════════════════════
// 시험실 — 하나 시험하기(단일) / 묶어서 시험하기(조합)
// ═══════════════════════════════════════════════════════════
//  · 확신도 임계값: 최대 확률이 임계값 미만이면 "모르겠어요"
//  · 미검출: 랜드마크가 없으면 "안 보여요" (규칙표 조건으로도 쓸 수 있다)
//  · 조합 모드: 랜드마커를 라운드로빈으로 프레임마다 하나씩만 돌린다.
//    마지막 결과는 캐시하고, 규칙 판정은 매 프레임 한다.
//  · 모델은 절대 합치지 않는다 — 소스별 독립 모델 + 규칙표 조합.

import { loadLandmarker, drawResult } from './landmarker.js';
import { extract } from './features.js';
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

let stream = null;
let rr = 0;
let lastUi = 0;
let rules = [];               // { name, op:'AND'|'OR', conds:{hand:'',face:'',pose:''} }

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
  return SOURCES.filter(src => slots[src]);
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
  releaseExcept(activeSources());
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
  SOURCES.forEach(s => { results[s] = null; lastRaw[s] = null; });
}

function camReady() { return !!(stream && $('camVid').videoWidth); }

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
  const active = activeSources();
  const now = performance.now();

  if (camReady() && active.length) {
    // 라운드로빈: 이번 프레임에는 랜드마커 하나만 돌린다
    const src = active[rr % active.length];
    rr++;
    const l = lms[src];
    if (l) {
      let raw = null;
      try { raw = l.detect($('camVid'), now); } catch (e) { /* 무시 */ }
      lastRaw[src] = raw;
      results[src] = classify(src, raw ? extract(src, raw) : null);
    }

    // 오버레이 — 각 소스의 마지막 결과를 함께 그린다
    const cv = $('ovCv'), video = $('camVid');
    if (cv.width !== video.videoWidth) { cv.width = video.videoWidth; cv.height = video.videoHeight; }
    const ctx = cv.getContext('2d');
    ctx.clearRect(0, 0, cv.width, cv.height);
    active.forEach(s => { if (lastRaw[s]) drawResult(ctx, s, lastRaw[s]); });
  }

  if (now - lastUi > 120) { lastUi = now; renderLive(); }
}

// ── 실시간 표시 ──
function renderLive() {
  if (mode === 'single') { renderBars(); renderSingleAnswer(); }
  else { renderSrcStates(); evalRules(); }
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
  const active = activeSources();
  box.style.display = active.length ? '' : 'none';
  if (box.children.length !== active.length || box.dataset.keys !== active.join()) {
    box.dataset.keys = active.join();
    box.innerHTML = '';
    active.forEach(src => {
      const d = document.createElement('div');
      d.className = 'srcstate'; d.dataset.src = src;
      d.innerHTML = '<span class="sn"></span><span class="sv"></span><span class="sp2"></span>';
      d.querySelector('.sn').textContent = T(SRC_KO[src]);
      box.appendChild(d);
    });
  }
  active.forEach(src => {
    const d = box.querySelector('[data-src="' + src + '"]');
    if (!d) return;
    const st = results[src];
    const w = stateWord(st);
    const sv = d.querySelector('.sv');
    sv.textContent = w.txt;
    sv.className = 'sv' + (w.cls !== 'ok' ? ' ' + w.cls : '');
    d.querySelector('.sp2').textContent = st && st.prob != null ? Math.round(st.prob * 100) + '%' : '';
  });
}

// ── 규칙표 ──
function newRule() {
  return { name: '', op: 'AND', conds: { hand: '', face: '', pose: '' } };
}

function renderRules() {
  const box = $('ruleList');
  box.innerHTML = '';
  const active = SOURCES.filter(src => slots[src]);
  rules.forEach((rule, ri) => {
    const el = document.createElement('div');
    el.className = 'rule'; el.dataset.ri = ri;

    const rtop = document.createElement('div'); rtop.className = 'rtop';
    const nameInp = document.createElement('input');
    nameInp.className = 'inp'; nameInp.maxLength = 20;
    nameInp.placeholder = T('동작 이름 (예: 발사!)');
    nameInp.value = rule.name;
    nameInp.addEventListener('input', () => { rule.name = nameInp.value; });
    const del = document.createElement('button');
    del.className = 'del'; del.innerHTML = '<i class="fa-solid fa-xmark"></i>';
    del.title = T('지우기');
    del.addEventListener('click', () => { rules.splice(ri, 1); renderRules(); });
    rtop.appendChild(nameInp); rtop.appendChild(del);
    el.appendChild(rtop);

    const conds = document.createElement('div'); conds.className = 'conds';
    active.forEach(src => {
      const rc = document.createElement('div'); rc.className = 'rcond';
      const sn = document.createElement('span'); sn.className = 'sn';
      sn.textContent = T(SRC_KO[src]);
      const sel = document.createElement('select'); sel.className = 'inp';
      const opts = [
        ['', T('상관없어요')],
        ['__none__', T('안 보여요')],
      ].concat((slots[src].meta.classes || []).map(c => [c, c]));
      opts.forEach(([v, txt]) => {
        const o = document.createElement('option');
        o.value = v; o.textContent = txt;
        sel.appendChild(o);
      });
      sel.value = opts.some(([v]) => v === rule.conds[src]) ? rule.conds[src] : '';
      sel.addEventListener('change', () => { rule.conds[src] = sel.value; });
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
  const st = results[src];
  if (want === '__none__') return !!st && st.state === 'none';
  return !!st && st.state === 'ok' && st.label === want;
}

function evalRules() {
  const el = $('answer');
  const active = SOURCES.filter(src => slots[src]);
  el.classList.remove('sure', 'idk');
  if (!active.length) { el.textContent = T('모델을 골라 주세요'); el.classList.add('idk'); markFired(-1); return; }
  if (!camReady()) { el.textContent = T('카메라를 켜 주세요'); el.classList.add('idk'); markFired(-1); return; }
  if (!rules.length) { el.textContent = T('규칙을 더해 보세요'); el.classList.add('idk'); markFired(-1); return; }

  let fired = -1;
  for (let i = 0; i < rules.length; i++) {
    const r = rules[i];
    const conds = active.filter(src => r.conds[src] !== '');
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

// ── 모드 전환 ──
async function setMode(next) {
  if (mode === next) return;
  mode = next;
  const single = next === 'single';
  $('modeSingle').classList.toggle('on', single);
  $('modeCombo').classList.toggle('on', !single);
  $('modeHint').textContent = single ? T('배운 모델 1개를 시험해요') : T('모델을 묶어 규칙을 만들어요');
  $('sglPick').style.display = single ? '' : 'none';
  $('cmbPick').style.display = single ? 'none' : '';
  $('sglOut').style.display = single ? '' : 'none';
  $('cmbOut').style.display = single ? 'none' : '';
  $('srcStates').style.display = 'none';

  // 슬롯을 모두 비운다 (모델·랜드마커 정리)
  for (const src of SOURCES) await setSlot(src, null);
  singleName = null;
  if (single) renderSingleList();
  else { renderComboSelects(); renderRules(); }
  renderBars(true);
  renderLive();
}

// ── 이벤트 ──
$('modeSingle').addEventListener('click', () => setMode('single'));
$('modeCombo').addEventListener('click', () => setMode('combo'));
$('camBtn').addEventListener('click', () => (stream ? camStop() : camOn()));
$('camSel').addEventListener('change', () => { if (stream) { camStop(); camOn(); } });
$('thrSlider').addEventListener('input', () => {
  threshold = Number($('thrSlider').value) / 100;
  $('thrVal').textContent = $('thrSlider').value + '%';
});
$('ruleAdd').addEventListener('click', () => {
  if (!SOURCES.some(src => slots[src])) { toast(T('먼저 모델을 골라 주세요')); return; }
  rules.push(newRule());
  renderRules();
});
[['slotHand', 'hand'], ['slotFace', 'face'], ['slotPose', 'pose']].forEach(([id, src]) => {
  $(id).addEventListener('change', async e => {
    await setSlot(src, e.target.value || null);
    renderRules();
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
