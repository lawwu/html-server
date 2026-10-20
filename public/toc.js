// Injected into rendered artifacts: a table of contents built from h2/h3 headings.
// Runs inside the page's sandbox and draws into a shadow root, so the page's CSS
// and ours can't touch each other. Placement: pinned in the left margin when the
// page leaves room for it, otherwise a "Contents" button that opens a panel.
// Opt out per page with <meta name="toc" content="off">.
(() => {
  const MIN_HEADINGS = 3;
  const SIDE_MIN_VIEWPORT = 1100; // px wide before pinning in the margin is considered
  const SIDE_MIN_MARGIN = 230; //    px of free space left of the content needed to pin it

  if (document.querySelector('meta[name="toc"][content="off" i], nav.toc, [data-artifact-toc]')) return;
  const heads = [...document.querySelectorAll('h2, h3')].filter((h) => h.textContent.trim() && h.getClientRects().length);
  if (heads.length < MIN_HEADINGS) return;

  // Give every heading an id so it can be linked to.
  const used = new Set([...document.querySelectorAll('[id]')].map((e) => e.id));
  const slug = (s) => s.toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '').slice(0, 60);
  for (const h of heads) {
    if (h.id) continue;
    const base = slug(h.textContent) || 'section';
    let id = base;
    for (let i = 2; used.has(id); i++) id = `${base}-${i}`;
    h.id = id;
    used.add(id);
  }

  // Match the page's own background, not the OS theme: an artifact may be dark on a light system.
  const bg = (() => {
    for (const el of [document.body, document.documentElement]) {
      const c = getComputedStyle(el).backgroundColor;
      const m = c.match(/[\d.]+/g);
      if (m && (m.length < 4 || Number(m[3]) > 0)) return m.slice(0, 3).map(Number);
    }
    return [255, 255, 255];
  })();
  const dark = (0.2126 * bg[0] + 0.7152 * bg[1] + 0.0722 * bg[2]) / 255 < 0.5;
  const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

  const host = document.createElement('div');
  host.setAttribute('data-artifact-toc', '');
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `<style>
    :host { all: initial; }
    * { box-sizing: border-box; }
    .panel { font: 13px/1.45 ui-sans-serif, system-ui, -apple-system, sans-serif; color: ${dark ? '#d6d3ce' : '#3a3733'};
      position: fixed; z-index: 2147483000; overflow: auto; }
    .t { font-size: 11px; font-weight: 600; letter-spacing: .06em; text-transform: uppercase; opacity: .6; margin: 0 0 .6rem; }
    ol { list-style: none; margin: 0; padding: 0; }
    a { display: block; color: inherit; text-decoration: none; padding: .22rem .6rem; border-left: 2px solid transparent; opacity: .72; }
    a:hover { opacity: 1; }
    a.h3 { padding-left: 1.4rem; font-size: 12.5px; }
    a.on { opacity: 1; font-weight: 600; border-left-color: currentColor; }
    .side { top: 2.5rem; left: 1.25rem; max-height: calc(100vh - 5rem); }
    .drawer { right: 1rem; bottom: 4.25rem; width: min(20rem, calc(100vw - 2rem)); max-height: 60vh; padding: .9rem .4rem .9rem .6rem;
      border-radius: 12px; background: ${dark ? 'rgba(30,29,27,.97)' : 'rgba(255,255,255,.97)'};
      box-shadow: 0 10px 40px rgba(0,0,0,${dark ? '.55' : '.18'}); border: 1px solid ${dark ? '#3a3835' : '#e6e2db'}; }
    .drawer[hidden] { display: none; }
    button { all: unset; cursor: pointer; position: fixed; z-index: 2147483001; right: 1rem; bottom: 1rem;
      font: 600 13px ui-sans-serif, system-ui, sans-serif; padding: .55rem .9rem; border-radius: 999px;
      color: ${dark ? '#151413' : '#fff'}; background: ${dark ? '#ebe7e1' : '#1f1d1a'}; box-shadow: 0 4px 16px rgba(0,0,0,.25); }
    button[hidden] { display: none; }
  </style>
  <nav class="panel" aria-label="Contents"><p class="t">Contents</p><ol>${heads.map((h) =>
    `<li><a href="#${encodeURIComponent(h.id)}" class="${h.tagName.toLowerCase()}">${esc(h.textContent.trim())}</a></li>`).join('')}</ol></nav>
  <button type="button" aria-expanded="false">Contents</button>`;
  document.body.append(host);

  const nav = root.querySelector('nav');
  const btn = root.querySelector('button');
  const links = [...root.querySelectorAll('a')];

  function layout() {
    // Free space = left edge of the leftmost heading; pin there only if it fits.
    const margin = Math.min(...heads.map((h) => h.getBoundingClientRect().left));
    const side = innerWidth >= SIDE_MIN_VIEWPORT && margin >= SIDE_MIN_MARGIN;
    nav.className = `panel ${side ? 'side' : 'drawer'}`;
    nav.style.width = side ? `${Math.min(margin - 40, 260)}px` : '';
    nav.hidden = !side;
    btn.hidden = side;
    btn.setAttribute('aria-expanded', 'false');
  }

  function spy() {
    // The current section is the last heading above 30% of the viewport.
    const line = innerHeight * 0.3;
    let cur = 0;
    heads.forEach((h, i) => { if (h.getBoundingClientRect().top <= line) cur = i; });
    links.forEach((a, i) => a.classList.toggle('on', i === cur));
  }

  links.forEach((a, i) => a.addEventListener('click', (e) => {
    e.preventDefault();
    heads[i].scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
    if (nav.classList.contains('drawer')) { nav.hidden = true; btn.setAttribute('aria-expanded', 'false'); }
  }));
  btn.addEventListener('click', () => {
    nav.hidden = !nav.hidden;
    btn.setAttribute('aria-expanded', String(!nav.hidden));
  });
  addEventListener('keydown', (e) => { if (e.key === 'Escape' && nav.classList.contains('drawer')) nav.hidden = true; });
  addEventListener('resize', layout);
  addEventListener('scroll', spy, { passive: true });
  layout();
  spy();
})();
