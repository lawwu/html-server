// Quartz's graph view, for notes and framed pages: the "Graph View" box is a live local
// graph (this page and the pages linked to or from it), and its expand button opens the
// global graph over the page. The site's graph is embedded (<script id="site-graph">),
// so this works in a sandboxed note with no requests. No libraries: a small force
// simulation (pages repel, links pull, a gentle pull to the middle), drag a dot or the
// background, scroll to zoom, hover to see a page's neighbours, click to open it.
// /graph remains the full page, with tags, colours and the legend.
const raw = JSON.parse(document.getElementById('site-graph')?.textContent || 'null');
const NS = 'http://www.w3.org/2000/svg';
const FORCES = {
  local: { repel: 900, link: 55, strength: 0.08, center: 0.02 },
  global: { repel: 1500, link: 50, strength: 0.06, center: 0.006 },
};
const go = (url) => { try { window.top.location.href = url; } catch { location.href = url; } };

function el(tag, attrs, parent) {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  parent?.append(e);
  return e;
}

/** Draw `nodes`/`edges` into `box` and run the simulation until it settles. Returns a stop function. */
function mount(box, nodes, edges, { current, global }) {
  const F = global ? FORCES.global : FORCES.local;
  let w = box.clientWidth || 280, h = box.clientHeight || 250;
  const svg = el('svg', { class: 'live-graph', viewBox: `0 0 ${w} ${h}`, role: 'img', 'aria-label': global ? 'All pages and the links between them' : 'Pages linked to or from this one' });
  const view = el('g', {}, svg);
  const gEdges = el('g', { class: 'edges' }, view);
  const gNodes = el('g', { class: 'nodes' }, view);
  box.querySelector('svg')?.remove();
  box.append(svg);

  const ns = nodes.map((n, i) => {
    const a = (i / nodes.length) * Math.PI * 2;
    const r = n.id === current ? 0 : Math.min(w, h) * (global ? 0.35 : 0.3) * (0.6 + 0.4 * ((i * 7919) % 97) / 97);
    return { ...n, x: w / 2 + Math.cos(a) * r, y: h / 2 + Math.sin(a) * r, vx: 0, vy: 0, deg: 0 };
  });
  const byId = new Map(ns.map((n) => [n.id, n]));
  const es = edges.map(([s, t]) => ({ s: byId.get(s), t: byId.get(t) })).filter((e) => e.s && e.t && e.s !== e.t);
  for (const e of es) { e.s.deg++; e.t.deg++; }
  const near = new Map(ns.map((n) => [n, new Set([n])]));
  for (const e of es) { near.get(e.s).add(e.t); near.get(e.t).add(e.s); }

  for (const e of es) e.line = el('line', {}, gEdges);
  for (const n of ns) {
    n.g = el('g', { class: `node${n.id === current ? ' current' : ''}`, tabindex: '0', role: 'link', 'aria-label': n.title }, gNodes);
    n.r = (global ? 2.2 : 3) + Math.sqrt(n.deg) * (global ? 0.9 : 1.1);
    n.c = el('circle', { r: n.r.toFixed(1) }, n.g);
    n.label = el('text', { dy: (n.r + 9).toFixed(1) }, n.g);
    n.label.textContent = n.title.length > 28 ? `${n.title.slice(0, 27)}…` : n.title;
    n.g.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') go(n.url); });
    n.g.addEventListener('pointerenter', () => { if (!drag) hover(n); });
    n.g.addEventListener('pointerleave', () => { if (!drag) hover(null); });
  }

  // --- view: pan and zoom ------------------------------------------------------------
  let k = 1, tx = 0, ty = 0;
  const apply = () => {
    view.setAttribute('transform', `translate(${tx} ${ty}) scale(${k})`);
    svg.style.setProperty('--k', k);
    svg.classList.toggle('zoomed', k > (global ? 1.8 : 1.3));
  };
  const toLocal = (ev) => {
    const r = svg.getBoundingClientRect();
    return [((ev.clientX - r.left) * (w / r.width) - tx) / k, ((ev.clientY - r.top) * (h / r.height) - ty) / k];
  };
  svg.addEventListener('wheel', (ev) => {
    ev.preventDefault();
    const [x, y] = toLocal(ev);
    const k2 = Math.min(6, Math.max(0.25, k * Math.exp(-ev.deltaY * 0.0015)));
    tx -= x * (k2 - k); ty -= y * (k2 - k); k = k2;
    apply();
  }, { passive: false });

  // --- drag a node, or pan; a click without movement opens the page ------------------
  let drag = null;
  svg.addEventListener('pointerdown', (ev) => {
    const n = ns.find((m) => m.g.contains(ev.target));
    drag = { n, x0: ev.clientX, y0: ev.clientY, tx, ty, moved: false };
    svg.setPointerCapture(ev.pointerId);
    if (n) { n.fixed = true; heat(0.4); }
  });
  svg.addEventListener('pointermove', (ev) => {
    if (!drag) return;
    if (Math.hypot(ev.clientX - drag.x0, ev.clientY - drag.y0) > 4) drag.moved = true;
    if (drag.n) { [drag.n.x, drag.n.y] = toLocal(ev); drag.n.vx = drag.n.vy = 0; heat(0.3); } else {
      const r = svg.getBoundingClientRect();
      tx = drag.tx + (ev.clientX - drag.x0) * (w / r.width);
      ty = drag.ty + (ev.clientY - drag.y0) * (h / r.height);
      apply();
    }
  });
  svg.addEventListener('pointerup', () => {
    if (drag?.n) { drag.n.fixed = false; if (!drag.moved) go(drag.n.url); }
    drag = null;
  });

  function hover(n) {
    svg.classList.toggle('hovering', !!n);
    const set = n ? near.get(n) : null;
    for (const m of ns) m.g.classList.toggle('on', !!set?.has(m));
    for (const e of es) e.line.classList.toggle('on', !!n && (e.s === n || e.t === n));
  }

  // --- simulation ------------------------------------------------------------------------
  let alpha = 1, raf = 0;
  const heat = (a) => { alpha = Math.max(alpha, a); if (!raf) raf = requestAnimationFrame(frame); };
  function tick() {
    for (let i = 0; i < ns.length; i++) {
      const a = ns[i];
      for (let j = i + 1; j < ns.length; j++) {
        const b = ns[j];
        let dx = a.x - b.x, dy = a.y - b.y, d2 = dx * dx + dy * dy;
        if (d2 < 0.01) { dx = Math.random() - 0.5; dy = Math.random() - 0.5; d2 = 0.5; }
        if (d2 > 90000) continue;
        const f = (F.repel * alpha) / d2, d = Math.sqrt(d2);
        a.vx += (dx / d) * f; a.vy += (dy / d) * f; b.vx -= (dx / d) * f; b.vy -= (dy / d) * f;
      }
    }
    for (const e of es) {
      const dx = e.t.x - e.s.x, dy = e.t.y - e.s.y, d = Math.hypot(dx, dy) || 1;
      const f = (d - F.link) * F.strength * alpha;
      e.s.vx += (dx / d) * f; e.s.vy += (dy / d) * f; e.t.vx -= (dx / d) * f; e.t.vy -= (dy / d) * f;
    }
    for (const n of ns) {
      if (n.id === current && !global) { n.vx += (w / 2 - n.x) * 0.1; n.vy += (h / 2 - n.y) * 0.1; }
      n.vx += (w / 2 - n.x) * F.center * alpha; n.vy += (h / 2 - n.y) * F.center * alpha;
      if (n.fixed) { n.vx = n.vy = 0; continue; }
      n.vx *= 0.6; n.vy *= 0.6;
      n.x += Math.max(-20, Math.min(20, n.vx)); n.y += Math.max(-20, Math.min(20, n.vy));
    }
    alpha *= 0.985;
  }
  function draw() {
    for (const e of es) {
      e.line.setAttribute('x1', e.s.x.toFixed(1)); e.line.setAttribute('y1', e.s.y.toFixed(1));
      e.line.setAttribute('x2', e.t.x.toFixed(1)); e.line.setAttribute('y2', e.t.y.toFixed(1));
    }
    for (const n of ns) n.g.setAttribute('transform', `translate(${n.x.toFixed(1)} ${n.y.toFixed(1)})`);
  }
  // Once, when the layout first settles: zoom so the graph fills the box (never past 2x).
  let fitted = false;
  function fit() {
    fitted = true;
    if (!ns.length) return;
    const xs = ns.map((n) => n.x), ys = ns.map((n) => n.y), pad = 24;
    const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
    const k2 = Math.min(2, (w - pad * 2) / Math.max(x1 - x0, 1), (h - pad * 2) / Math.max(y1 - y0, 1));
    const from = { k, tx, ty }, to = { k: k2, tx: w / 2 - ((x0 + x1) / 2) * k2, ty: h / 2 - ((y0 + y1) / 2) * k2 };
    const t0 = performance.now();
    (function step(now) {
      const p = Math.min(1, (now - t0) / 400), e = 1 - (1 - p) ** 3;
      k = from.k + (to.k - from.k) * e; tx = from.tx + (to.tx - from.tx) * e; ty = from.ty + (to.ty - from.ty) * e;
      apply();
      if (p < 1) requestAnimationFrame(step);
    })(t0);
  }
  function frame() {
    tick(); tick();
    draw();
    raf = alpha > 0.02 ? requestAnimationFrame(frame) : 0;
    if (!raf && !fitted) fit();
  }
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) { for (let i = 0; i < 400; i++) tick(); draw(); fit(); } else heat(1);
  apply();

  const resize = new ResizeObserver(() => {
    const w2 = box.clientWidth, h2 = box.clientHeight;
    if (!w2 || !h2 || (w2 === w && h2 === h)) return;
    for (const n of ns) { n.x += (w2 - w) / 2; n.y += (h2 - h) / 2; }
    w = w2; h = h2;
    svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    draw();
  });
  resize.observe(box);
  return () => { cancelAnimationFrame(raf); resize.disconnect(); };
}

if (raw) {
  const nodes = raw.nodes.map(([id, title, url]) => ({ id, title, url }));
  const current = raw.current;
  const box = document.querySelector('.graph-box');
  if (box) {
    // Local: this page and its neighbours (Quartz's depth 1), links among them.
    const keep = new Set([current]);
    for (const [s, t] of raw.edges) { if (s === current) keep.add(t); if (t === current) keep.add(s); }
    mount(box, nodes.filter((n) => keep.has(n.id)), raw.edges.filter(([s, t]) => keep.has(s) && keep.has(t)), { current, global: false });
  }

  // Global: the expand button opens every page over the current one.
  let overlay = null, stop = null;
  const close = () => { if (!overlay || overlay.hidden) return; overlay.hidden = true; stop?.(); document.documentElement.classList.remove('searching'); };
  document.querySelector('.graph-expand')?.addEventListener('click', (ev) => {
    ev.preventDefault();
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.className = 'graph-overlay';
      overlay.innerHTML = '<div class="graph-panel" role="dialog" aria-modal="true" aria-label="Graph of all pages">'
        + '<div class="graph-panel-bar"><span>Graph of all pages</span><a href="/graph" target="_top">Open the graph page</a>'
        + '<button type="button" class="icon-btn" aria-label="Close">✕</button></div><div class="graph-stage"></div></div>';
      document.body.append(overlay);
      overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });
      overlay.querySelector('button').addEventListener('click', close);
      addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
    }
    overlay.hidden = false;
    document.documentElement.classList.add('searching'); // no page scroll underneath
    stop = mount(overlay.querySelector('.graph-stage'), nodes, raw.edges, { current, global: true });
  });
}
