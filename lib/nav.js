// ═══════════════════════════════════════════════════════════
// 헤더 / 탭 네비게이션 — 파이보 랩과 같은 구조를 그대로 쓴다
// ═══════════════════════════════════════════════════════════
// 각 페이지의 <header data-tab="..."> 를 파이보 랩 index.html 의
// 헤더 마크업(h1 + .navlink)과 같은 구조로 채운다.
// 클래스 이름·DOM 구조를 바꾸지 말 것 — css/ui.css 가 그대로 입혀진다.

(function () {
  const TABS = [
    { href: 'index.html', label: '학습실' },
    { href: 'test.html', label: '시험실' },
    { href: 'storage.html', label: '보관함' },
  ];

  const header = document.querySelector('header[data-tab]');
  if (!header) return;
  const cur = header.getAttribute('data-tab');

  const h1 = document.createElement('h1');
  const logo = document.createElement('img');
  logo.src = 'assets/img/pibo-logo.png';
  logo.alt = '';
  h1.appendChild(logo);
  h1.appendChild(document.createTextNode('제스처 랩'));
  header.appendChild(h1);

  TABS.forEach(function (t) {
    let el;
    if (t.href === cur) {
      el = document.createElement('span');
      el.className = 'navlink on';
    } else {
      el = document.createElement('a');
      el.className = 'navlink';
      el.href = t.href;
    }
    el.textContent = t.label;
    header.appendChild(el);
  });

  const sp = document.createElement('span');
  sp.style.flex = '1';
  header.appendChild(sp);

  const engine = document.createElement('span');
  engine.id = 'engine';
  engine.style.cssText = 'font-size:11px;color:var(--ink3,#96A5AE);font-weight:600';
  engine.textContent = '준비 중…';
  header.appendChild(engine);
})();
