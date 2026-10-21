// /graph: pages as dots, links as lines, in the spirit of Quartz's graph view.
// A live force simulation (no libraries): pages repel, links pull their ends
// together, a weak pull keeps everything near the middle. Drag a dot to move it
// (the rest follow), drag the background to pan, scroll to zoom. Labels fade in as
// you zoom in, and always show for the hovered page and its neighbours.
const data = JSON.parse(document.getElementById('graph-data').textContent);
const box = document.getElementById('graph');
const NS = 'http://www.w3.org/2000/svg';
const FORCES = { repel: 2600, linkDistance: 70, spring: 0.04, center: 0.01, damping: 0.82 };
// Labels fade in as you zoom past the starting view (from 1.15x to 1.8x of it), like
// Quartz's opacityScale. Busy pages (HUB_LINKS or more links) are always labelled.
const LABEL_FADE = [1.15, 1.8];
const HUB_LINKS = 3;

// One colour per category, readable on light and dark; uncategorised in grey.
const PALETTE = ['#c2410c', '#2563eb', '#059669', '#9333ea', '#db2777', '#0891b2', '#ca8a04', '#4f46e5', '#65a30d', '#e11d48'];
const cats = Object.keys(data.labels);
const color = (c) => (c ? PALETTE[cats.indexOf(c) % PALETTE.length] : '#8a8580');
const radius = (n) => 3.5 + Math.sqrt(n.links_in + n.links_out) * 2.2; // all links, in and out

if (!data.nodes.length) box.innerHTML = '<p class="empty">No pages yet.</p>';
else start();

function el(tag, attrs, parent) {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs || {})) e.setAttribute(k, v);
  if (parent) parent.append(e);
  return e;
}

function start() {
  const nodes = data.nodes.map((n, i) => {
    const a = i * 2.39996; // golden-angle spiral: an even, deterministic start
    const r = 12 * Math.sqrt(i + 1);
    return { ...n, x: Math.cos(a) * r, y: Math.sin(a) * r, vx: 0, vy: 0, fixed: false };
  });
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const edges = data.edges.map((e) => ({ s: byId.get(e.source), t: byId.get(e.target) }));
  const focusNode = data.focus != null ? byId.get(data.focus) : null;
  if (focusNode) { focusNode.x = 0; focusNode.y = 0; }

  const svg = el('svg', { class: 'graph-svg' });
  const world = el('g', {}, svg);
  const gEdges = el('g', { class: 'edges' }, world);
  const gNodes = el('g', { class: 'nodes' }, world);
  box.append(svg);

  const lines = edges.map((e) => ({ ...e, line: el('line', {}, gEdges) }));
  for (const n of nodes) {
    const hub = n.links_in + n.links_out >= HUB_LINKS;
    n.g = el('a', { href: n.url, class: `node${n === focusNode ? ' current' : ''}${hub ? ' hub' : ''}` }, gNodes);
    el('title', {}, n.g).textContent = `${n.title}\n${n.slug} · ${n.links_in} in · ${n.links_out} out · ${n.views} views`;
    n.dot = el('circle', { r: radius(n), fill: color(n.category) }, n.g);
    n.label = el('text', { 'text-anchor': 'middle', dy: radius(n) + 11 }, n.g);
    n.label.textContent = n.title.length > 34 ? `${n.title.slice(0, 32)}…` : n.title;
  }

  // --- view: pan and zoom ---------------------------------------------------------
  let view = { x: 0, y: 0, k: 1 };
  let fit = 1; // the zoom that fits everything; label fading is relative to it
  const size = () => ({ w: box.clientWidth, h: box.clientHeight });
  const applyView = () => {
    const { w, h } = size();
    world.setAttribute('transform', `translate(${w / 2 + view.x} ${h / 2 + view.y}) scale(${view.k})`);
    // Labels fade in with zoom (like Quartz's opacityScale).
    const [from, to] = LABEL_FADE, rel = view.k / fit;
    svg.style.setProperty('--label-opacity', Math.max(0, Math.min(1, (rel - from) / (to - from))));
  };
  const toWorld = (cx, cy) => {
    const r = svg.getBoundingClientRect(), { w, h } = size();
    return { x: (cx - r.left - w / 2 - view.x) / view.k, y: (cy - r.top - h / 2 - view.y) / view.k };
  };

  // --- hover: a page and its neighbours ---------------------------------------
  const neighbours = new Map(nodes.map((n) => [n, new Set([n])]));
  for (const { s, t } of edges) { neighbours.get(s).add(t); neighbours.get(t).add(s); }
  let hovered = null;
  const highlight = (n) => {
    hovered = n;
    svg.classList.toggle('focused', !!n);
    const near = n ? neighbours.get(n) : new Set();
    for (const m of nodes) m.g.classList.toggle('on', near.has(m));
    for (const l of lines) l.line.classList.toggle('on', !!n && (l.s === n || l.t === n));
  };
  for (const n of nodes) {
    n.g.addEventListener('pointerenter', () => { if (!dragging) highlight(n); });
    n.g.addEventListener('pointerleave', () => { if (!dragging) highlight(null); });
    n.g.addEventListener('focus', () => highlight(n));
    n.g.addEventListener('blur', () => highlight(null));
  }

  // --- dragging: a dot moves that page; the background pans -------------------
  let dragging = null;
  svg.addEventListener('pointerdown', (e) => {
    const a = e.target.closest('a.node');
    const n = a && nodes.find((m) => m.g === a);
    dragging = n
      ? { node: n, moved: false, sx: e.clientX, sy: e.clientY }
      : { pan: true, sx: e.clientX, sy: e.clientY, vx: view.x, vy: view.y };
    if (n) n.fixed = true;
    svg.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  svg.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    if (dragging.pan) {
      view.x = dragging.vx + e.clientX - dragging.sx;
      view.y = dragging.vy + e.clientY - dragging.sy;
      applyView();
      return;
    }
    if (Math.hypot(e.clientX - dragging.sx, e.clientY - dragging.sy) > 4) dragging.moved = true;
    const p = toWorld(e.clientX, e.clientY);
    Object.assign(dragging.node, { x: p.x, y: p.y, vx: 0, vy: 0 });
    heat = Math.max(heat, 0.5); // wake the simulation so neighbours follow
  });
  svg.addEventListener('pointerup', (e) => {
    if (!dragging) return;
    const d = dragging;
    dragging = null;
    if (d.node) {
      d.node.fixed = false;
      if (!d.moved) location.href = d.node.url; // a click, not a drag: open the page
    }
    if (!e.target.closest?.('a.node')) highlight(null);
  });
  // Clicks are handled on pointerup, so the link's own navigation never double-fires.
  svg.addEventListener('click', (e) => { if (e.target.closest('a.node')) e.preventDefault(); });
  svg.addEventListener('wheel', (e) => {
    e.preventDefault();
    const r = svg.getBoundingClientRect(), { w, h } = size();
    const z = Math.exp(-e.deltaY * 0.0015), k = Math.max(0.2, Math.min(6, view.k * z));
    const px = e.clientX - r.left - w / 2, py = e.clientY - r.top - h / 2; // zoom around the pointer
    view = { x: px - ((px - view.x) * k) / view.k, y: py - ((py - view.y) * k) / view.k, k };
    applyView();
  }, { passive: false });

  // --- simulation ------------------------------------------------------------------
  let heat = 1; // cools to rest; dragging reheats it
  function tick() {
    const { repel, linkDistance, spring, center, damping } = FORCES;
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i], b = nodes[j];
        let dx = a.x - b.x, dy = a.y - b.y;
        let d2 = dx * dx + dy * dy;
        if (d2 < 0.01) { dx = Math.random() - 0.5; dy = Math.random() - 0.5; d2 = 0.5; }
        const f = repel / d2, d = Math.sqrt(d2);
        a.vx += (dx / d) * f; a.vy += (dy / d) * f;
        b.vx -= (dx / d) * f; b.vy -= (dy / d) * f;
      }
    }
    for (const { s, t } of edges) {
      const dx = t.x - s.x, dy = t.y - s.y, d = Math.max(Math.hypot(dx, dy), 1);
      const f = (d - linkDistance) * spring;
      s.vx += (dx / d) * f; s.vy += (dy / d) * f;
      t.vx -= (dx / d) * f; t.vy -= (dy / d) * f;
    }
    for (const n of nodes) {
      if (n.fixed) continue;
      n.vx = (n.vx - n.x * center) * damping;
      n.vy = (n.vy - n.y * center) * damping;
      n.x += Math.max(-20, Math.min(20, n.vx)) * heat;
      n.y += Math.max(-20, Math.min(20, n.vy)) * heat;
    }
    heat = Math.max(heat * 0.985, 0);
  }
  function render() {
    for (const { s, t, line } of lines) {
      line.setAttribute('x1', s.x); line.setAttribute('y1', s.y);
      line.setAttribute('x2', t.x); line.setAttribute('y2', t.y);
    }
    for (const n of nodes) n.g.setAttribute('transform', `translate(${n.x} ${n.y})`);
  }
  // Fit the first settled layout to the box, then keep animating while it's warm.
  for (let i = 0; i < 120; i++) tick();
  const xs = nodes.map((n) => n.x), ys = nodes.map((n) => n.y), { w, h } = size();
  const spanX = Math.max(...xs) - Math.min(...xs) + 120, spanY = Math.max(...ys) - Math.min(...ys) + 120;
  view.k = fit = Math.max(0.3, Math.min(2.2, w / spanX, h / spanY));
  view.x = -((Math.max(...xs) + Math.min(...xs)) / 2) * view.k;
  view.y = -((Math.max(...ys) + Math.min(...ys)) / 2) * view.k;
  applyView();
  render();
  (function frame() {
    if (heat > 0.01) { tick(); render(); }
    requestAnimationFrame(frame);
  })();
  addEventListener('resize', applyView);

  document.getElementById('legend').innerHTML = [...cats, ...(nodes.some((n) => !n.category) ? [''] : [])]
    .map((c) => `<span><i style="background:${color(c)}"></i>${c ? data.labels[c] : 'No category'}</span>`).join('');
}
