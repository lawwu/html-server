// /graph: pages as dots, links as arrows, in the spirit of Quartz's graph view.
// A live force simulation (no libraries) lays out pages that have links; pages
// with none sit in a tidy row underneath, so they don't clutter the picture.
// Labels are on, but a label that would overlap a busier page's label is hidden
// (hover shows it). Drag a dot to move it, drag the background to pan, scroll to
// zoom; hover a page to light up its neighbours, click a legend entry to light up a
// category, click a page to open it.
const data = JSON.parse(document.getElementById('graph-data').textContent);
const box = document.getElementById('graph');
const NS = 'http://www.w3.org/2000/svg';
const FORCES = { repel: 4200, linkDistance: 115, spring: 0.035, center: 0.008, damping: 0.82 };
const LABEL = { font: 11, charWidth: 6.1, maxChars: 30, pad: 3 }; // for overlap checks, in screen pixels

// Category colours: the validated 8-slot reference palette (dataviz skill), in its
// fixed order, stepped for dark mode. The largest categories take the slots in order;
// past eight, categories fold into grey "Other", never a generated ninth hue. Labels
// and hover titles mean identity never rests on colour alone.
const DARK = matchMedia('(prefers-color-scheme: dark)').matches;
const PALETTE = DARK
  ? ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767']
  : ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6', '#e34948'];
const OTHER = DARK ? '#7c7a75' : '#a3a09a';
const catCount = (c) => data.nodes.filter((n) => n.category === c).length;
const cats = Object.keys(data.labels).sort((a, b) => catCount(b) - catCount(a) || a.localeCompare(b)).slice(0, PALETTE.length);
const color = (c) => (cats.includes(c) ? PALETTE[cats.indexOf(c)] : OTHER);
const degree = (n) => n.links_in + n.links_out;
const radius = (n) => 5 + Math.sqrt(degree(n)) * 3;

if (!data.nodes.length) box.innerHTML = '<p class="empty">No pages yet.</p>';
else start();

function el(tag, attrs, parent) {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs || {})) e.setAttribute(k, v);
  if (parent) parent.append(e);
  return e;
}

function start() {
  const nodes = data.nodes.map((n) => ({ ...n, x: 0, y: 0, vx: 0, vy: 0, fixed: false }));
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const edges = data.edges.map((e) => ({ s: byId.get(e.source), t: byId.get(e.target) }));
  const focusNode = data.focus != null ? byId.get(data.focus) : null;
  const linked = nodes.filter((n) => degree(n) > 0 || n === focusNode);
  const loose = nodes.filter((n) => !linked.includes(n));

  // Linked pages start on a golden-angle spiral (even and deterministic).
  linked.forEach((n, i) => { const a = i * 2.39996, r = 14 * Math.sqrt(i + 1); n.x = Math.cos(a) * r; n.y = Math.sin(a) * r; });
  if (focusNode) { focusNode.x = 0; focusNode.y = 0; }

  const svg = el('svg', { class: 'graph-svg' });
  el('defs', {}, svg).innerHTML = '<marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7"'
    + ' orient="auto-start-reverse" markerUnits="userSpaceOnUse"><path d="M0,1 L9,5 L0,9 z" fill="context-stroke"/></marker>';
  const world = el('g', {}, svg);
  const gEdges = el('g', { class: 'edges' }, world);
  const gLoose = el('g', { class: 'loose' }, world);
  const gNodes = el('g', { class: 'nodes' }, world);
  box.append(svg);

  const lines = edges.map((e) => ({ ...e, line: el('line', { 'marker-end': 'url(#arrow)' }, gEdges) }));
  for (const n of nodes) {
    n.g = el('a', { href: n.url, class: `node${n === focusNode ? ' current' : ''}` }, gNodes);
    el('title', {}, n.g).textContent = `${n.title}\n${n.slug} · ${n.links_in} in · ${n.links_out} out · ${n.views} views`;
    el('circle', { r: radius(n), fill: color(n.category) }, n.g);
    n.label = el('text', { 'text-anchor': 'middle', dy: radius(n) + 12 }, n.g);
    n.text = n.title.length > LABEL.maxChars ? `${n.title.slice(0, LABEL.maxChars - 1)}…` : n.title;
    n.label.textContent = n.text;
  }

  // --- view ----------------------------------------------------------------------
  let view = { x: 0, y: 0, k: 1 };
  const size = () => ({ w: box.clientWidth, h: box.clientHeight });
  const toScreen = (n) => { const { w, h } = size(); return { x: w / 2 + view.x + n.x * view.k, y: h / 2 + view.y + n.y * view.k }; };
  const toWorld = (cx, cy) => {
    const r = svg.getBoundingClientRect(), { w, h } = size();
    return { x: (cx - r.left - w / 2 - view.x) / view.k, y: (cy - r.top - h / 2 - view.y) / view.k };
  };
  const applyView = () => {
    const { w, h } = size();
    world.setAttribute('transform', `translate(${w / 2 + view.x} ${h / 2 + view.y}) scale(${view.k})`);
    svg.style.setProperty('--k', view.k); // keeps text and strokes the same size on screen
    labelsDirty = true;
  };

  // --- labels: busiest pages first; skip any label that would overlap one already placed
  let labelsDirty = true;
  function placeLabels() {
    labelsDirty = false;
    const placed = [];
    const order = [...nodes].sort((a, b) => (b === focusNode) - (a === focusNode) || degree(b) - degree(a) || a.title.localeCompare(b.title));
    for (const n of order) {
      const p = toScreen(n), wdt = n.text.length * LABEL.charWidth, top = p.y + radius(n) * view.k + 2;
      const r = { l: p.x - wdt / 2 - LABEL.pad, r: p.x + wdt / 2 + LABEL.pad, t: top, b: top + LABEL.font + LABEL.pad };
      const clash = placed.some((q) => r.l < q.r && r.r > q.l && r.t < q.b && r.b > q.t);
      n.g.classList.toggle('quiet', clash);
      if (!clash) placed.push(r);
    }
  }

  // --- highlight: a page and its neighbours, or a whole category ------------------
  const neighbours = new Map(nodes.map((n) => [n, new Set([n])]));
  for (const { s, t } of edges) { neighbours.get(s).add(t); neighbours.get(t).add(s); }
  const highlight = (set, edgeTest = () => false) => {
    svg.classList.toggle('focused', !!set);
    for (const m of nodes) m.g.classList.toggle('on', !!set && set.has(m));
    for (const l of lines) l.line.classList.toggle('on', !!set && edgeTest(l));
  };
  const hover = (n) => (n ? highlight(neighbours.get(n), (l) => l.s === n || l.t === n) : highlight(activeCat ? catSet(activeCat) : null));
  for (const n of nodes) {
    n.g.addEventListener('pointerenter', () => { if (!dragging) hover(n); });
    n.g.addEventListener('pointerleave', () => { if (!dragging) hover(null); });
    n.g.addEventListener('focus', () => hover(n));
    n.g.addEventListener('blur', () => hover(null));
  }
  let activeCat = null;
  const catSet = (c) => new Set(nodes.filter((n) => (c === '*other' ? !cats.includes(n.category) : n.category === c)));

  // --- dragging and zooming ----------------------------------------------------------
  let dragging = null;
  svg.addEventListener('pointerdown', (e) => {
    const a = e.target.closest('a.node');
    const n = a && nodes.find((m) => m.g === a);
    dragging = n ? { node: n, moved: false, sx: e.clientX, sy: e.clientY } : { pan: true, sx: e.clientX, sy: e.clientY, vx: view.x, vy: view.y };
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
    if (linked.includes(dragging.node)) heat = Math.max(heat, 0.5); else render();
  });
  svg.addEventListener('pointerup', (e) => {
    if (!dragging) return;
    const d = dragging;
    dragging = null;
    if (d.node) {
      if (linked.includes(d.node)) d.node.fixed = false;
      if (!d.moved) location.href = d.node.url; // a click, not a drag: open the page
    }
    if (!e.target.closest?.('a.node')) hover(null);
  });
  svg.addEventListener('click', (e) => { if (e.target.closest('a.node')) e.preventDefault(); });
  svg.addEventListener('wheel', (e) => {
    e.preventDefault();
    const r = svg.getBoundingClientRect(), { w, h } = size();
    const k = Math.max(0.2, Math.min(6, view.k * Math.exp(-e.deltaY * 0.0015)));
    const px = e.clientX - r.left - w / 2, py = e.clientY - r.top - h / 2; // zoom around the pointer
    view = { x: px - ((px - view.x) * k) / view.k, y: py - ((py - view.y) * k) / view.k, k };
    applyView();
  }, { passive: false });

  // --- simulation (linked pages only) ------------------------------------------------
  let heat = 1;
  function tick() {
    const { repel, linkDistance, spring, center, damping } = FORCES;
    for (let i = 0; i < linked.length; i++) {
      for (let j = i + 1; j < linked.length; j++) {
        const a = linked[i], b = linked[j];
        let dx = a.x - b.x, dy = a.y - b.y, d2 = dx * dx + dy * dy;
        if (d2 < 0.01) { dx = Math.random() - 0.5; dy = Math.random() - 0.5; d2 = 0.5; }
        const f = repel / d2, d = Math.sqrt(d2);
        a.vx += (dx / d) * f; a.vy += (dy / d) * f; b.vx -= (dx / d) * f; b.vy -= (dy / d) * f;
      }
    }
    for (const { s, t } of edges) {
      const dx = t.x - s.x, dy = t.y - s.y, d = Math.max(Math.hypot(dx, dy), 1), f = (d - linkDistance) * spring;
      s.vx += (dx / d) * f; s.vy += (dy / d) * f; t.vx -= (dx / d) * f; t.vy -= (dy / d) * f;
    }
    for (const n of linked) {
      if (n.fixed) continue;
      n.vx = (n.vx - n.x * center) * damping;
      n.vy = (n.vy - n.y * center) * damping;
      n.x += Math.max(-20, Math.min(20, n.vx)) * heat;
      n.y += Math.max(-20, Math.min(20, n.vy)) * heat;
    }
    heat = Math.max(heat * 0.985, 0);
  }

  // Unlinked pages: a grid underneath the cluster, under a "Not linked" heading.
  let looseTitle = null;
  function arrangeLoose() {
    if (!loose.length) return;
    const ys = linked.length ? linked.map((n) => n.y) : [0], xs = linked.length ? linked.map((n) => n.x) : [0];
    const span = Math.max(420, Math.max(...xs) - Math.min(...xs));
    const COL = 210, ROW = 64; // wide enough that most titles fit side by side
    const cols = Math.max(2, Math.floor(span / COL)), top = Math.max(...ys) + 110, left = (Math.min(...xs) + Math.max(...xs)) / 2 - ((cols - 1) * COL) / 2;
    loose.forEach((n, i) => { n.x = left + (i % cols) * COL; n.y = top + Math.floor(i / cols) * ROW; });
    if (!looseTitle) looseTitle = el('text', { class: 'loose-title', 'text-anchor': 'middle' }, gLoose);
    looseTitle.setAttribute('x', left + ((Math.min(cols, loose.length) - 1) * COL) / 2);
    looseTitle.setAttribute('y', top - 32);
    looseTitle.textContent = `Not linked (${loose.length})`;
  }

  function render() {
    for (const { s, t, line } of lines) {
      // End at the target's edge so the arrowhead shows.
      const d = Math.max(Math.hypot(t.x - s.x, t.y - s.y), 1), r = radius(t) + 2;
      line.setAttribute('x1', s.x); line.setAttribute('y1', s.y);
      line.setAttribute('x2', t.x - ((t.x - s.x) / d) * r); line.setAttribute('y2', t.y - ((t.y - s.y) / d) * r);
    }
    for (const n of nodes) n.g.setAttribute('transform', `translate(${n.x} ${n.y})`);
    labelsDirty = true;
  }

  // Settle, fit everything (cluster and the unlinked row) to the box, then keep animating while warm.
  for (let i = 0; i < 160; i++) tick();
  arrangeLoose();
  const xs = nodes.map((n) => n.x), ys = nodes.map((n) => n.y), { w, h } = size();
  const spanX = Math.max(...xs) - Math.min(...xs) + 180, spanY = Math.max(...ys) - Math.min(...ys) + 140;
  view.k = Math.max(0.3, Math.min(1.8, w / spanX, h / spanY));
  view.x = -((Math.max(...xs) + Math.min(...xs)) / 2) * view.k;
  view.y = -((Math.max(...ys) + Math.min(...ys)) / 2) * view.k;
  applyView();
  render();
  let frames = 0;
  (function frame() {
    if (heat > 0.01) { tick(); if (++frames % 20 === 0) arrangeLoose(); render(); }
    if (labelsDirty) placeLabels();
    requestAnimationFrame(frame);
  })();
  addEventListener('resize', applyView);

  // Legend: click a category to light up its pages; click again to clear.
  const legend = document.getElementById('legend');
  const hasOther = nodes.some((n) => !cats.includes(n.category));
  legend.innerHTML = [...cats, ...(hasOther ? ['*other'] : [])]
    .map((c) => `<button type="button" data-cat="${c}"><i style="background:${color(c)}"></i>${c === '*other' ? 'Other' : data.labels[c]}</button>`).join('');
  legend.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    activeCat = activeCat === b.dataset.cat ? null : b.dataset.cat;
    for (const x of legend.querySelectorAll('button')) x.classList.toggle('on', x.dataset.cat === activeCat);
    highlight(activeCat != null ? catSet(activeCat) : null);
  });
}
