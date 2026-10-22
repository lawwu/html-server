// /graph, modelled on Quartz's graph view. Pages are dots, links between pages are
// arrows, and (like Quartz's showTags) each tag is a small node joined to its pages,
// so pages that share a tag cluster even when they don't link to each other.
// A live force simulation, no libraries: pages repel, links and tags pull, dots never
// overlap (collision), and anything left unconnected settles on an outer ring
// (Quartz's enableRadial) instead of drifting. Labels never overlap: busier nodes keep
// theirs, hover shows the rest. Drag dots or the background, scroll to zoom, toggle
// tags, fit to view, go full screen.
const data = JSON.parse(document.getElementById('graph-data').textContent);
const box = document.getElementById('graph');
const NS = 'http://www.w3.org/2000/svg';
const FORCES = {
  repel: 2200, // pairwise push, falls off with distance squared
  link: { distance: 95, strength: 0.05 }, // page → page links
  tag: { distance: 55, strength: 0.03 }, // page — tag
  collide: 6, // extra space around every dot
  center: 0.004, // gentle pull to the middle for connected nodes
  ring: 0.09, // pull of unconnected nodes onto the outer ring
  damping: 0.8,
};
const LABEL = { charWidth: 6.1, maxChars: 30, pad: 3, font: 11 };

// Category colours: the validated 8-slot reference palette, in its fixed order,
// stepped for dark mode; the largest categories take the slots, the rest fold into
// "Other". Labels and hover titles mean identity never rests on colour alone.
const DARK = matchMedia('(prefers-color-scheme: dark)').matches;
const PALETTE = DARK
  ? ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767']
  : ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6', '#e34948'];
const OTHER = DARK ? '#7c7a75' : '#a3a09a';
const catCount = (c) => data.nodes.filter((n) => n.category === c).length;
const cats = Object.keys(data.labels).sort((a, b) => catCount(b) - catCount(a) || a.localeCompare(b)).slice(0, PALETTE.length);
const color = (c) => (cats.includes(c) ? PALETTE[cats.indexOf(c)] : OTHER);

if (!data.nodes.length) box.innerHTML = '<p class="empty">No pages yet.</p>';
else start();

function el(tag, attrs, parent) {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs || {})) e.setAttribute(k, v);
  if (parent) parent.append(e);
  return e;
}

function start() {
  // --- model ----------------------------------------------------------------------
  const pages = data.nodes.map((n) => ({ ...n, kind: 'page', x: 0, y: 0, vx: 0, vy: 0 }));
  const byId = new Map(pages.map((n) => [n.id, n]));
  const links = data.edges.map((e) => ({ s: byId.get(e.source), t: byId.get(e.target), kind: 'link' }));
  const tagNodes = [...new Set(pages.flatMap((p) => p.tags))].sort().map((t) => ({
    id: `#${t}`, tag: t, kind: 'tag', title: `#${t}`, url: `/?category=${encodeURIComponent(t)}`, x: 0, y: 0, vx: 0, vy: 0,
  }));
  const byTag = new Map(tagNodes.map((n) => [n.tag, n]));
  const tagEdges = pages.flatMap((p) => p.tags.map((t) => ({ s: p, t: byTag.get(t), kind: 'tag' })));
  const focusNode = data.focus != null ? byId.get(data.focus) : null;
  let showTags = loadPref('tags', true);

  const all = () => (showTags ? [...pages, ...tagNodes] : pages);
  const edges = () => (showTags ? [...links, ...tagEdges] : links);
  const degree = (n) => edges().filter((e) => e.s === n || e.t === n).length;
  const radius = (n) => (n.kind === 'tag' ? 3.5 : 5 + Math.sqrt(n.links_in + n.links_out + (showTags ? n.tags.length * 0.5 : 0)) * 2.6);

  // Spread the start: golden-angle spiral, deterministic.
  [...pages, ...tagNodes].forEach((n, i) => { const a = i * 2.39996, r = 16 * Math.sqrt(i + 1); n.x = Math.cos(a) * r; n.y = Math.sin(a) * r; });
  if (focusNode) { focusNode.x = 0; focusNode.y = 0; }

  // --- drawing ----------------------------------------------------------------------
  const svg = el('svg', { class: 'graph-svg' });
  el('defs', {}, svg).innerHTML = '<marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7"'
    + ' orient="auto-start-reverse" markerUnits="userSpaceOnUse"><path d="M0,1 L9,5 L0,9 z" fill="context-stroke"/></marker>';
  const world = el('g', {}, svg);
  const gEdges = el('g', { class: 'edges' }, world);
  const gNodes = el('g', { class: 'nodes' }, world);
  box.append(svg);

  for (const e of [...links, ...tagEdges]) e.line = el('line', { class: e.kind, ...(e.kind === 'link' ? { 'marker-end': 'url(#arrow)' } : {}) }, gEdges);
  for (const n of [...pages, ...tagNodes]) {
    n.g = el('a', { href: n.url, class: `node ${n.kind}${n === focusNode ? ' current' : ''}` }, gNodes);
    el('title', {}, n.g).textContent = n.kind === 'tag'
      ? `#${n.tag} · ${tagEdges.filter((e) => e.t === n).length} pages`
      : `${n.title}\n${n.slug} · ${n.links_in} in · ${n.links_out} out · ${n.views} views${n.tags.length ? `\n#${n.tags.join(' #')}` : ''}`;
    n.dot = el('circle', { fill: n.kind === 'tag' ? 'var(--card)' : color(n.category) }, n.g);
    n.label = el('text', { 'text-anchor': 'middle' }, n.g);
    n.text = n.title.length > LABEL.maxChars ? `${n.title.slice(0, LABEL.maxChars - 1)}…` : n.title;
    n.label.textContent = n.text;
  }
  const applyVisibility = () => {
    for (const n of tagNodes) n.g.style.display = showTags ? '' : 'none';
    for (const e of tagEdges) e.line.style.display = showTags ? '' : 'none';
    for (const n of [...pages, ...tagNodes]) { const r = radius(n); n.dot.setAttribute('r', r); n.label.setAttribute('dy', r + 12); }
  };
  applyVisibility();

  // --- view ----------------------------------------------------------------------
  let view = { x: 0, y: 0, k: 1 };
  const size = () => ({ w: box.clientWidth, h: box.clientHeight });
  const applyView = () => {
    const { w, h } = size();
    world.setAttribute('transform', `translate(${w / 2 + view.x} ${h / 2 + view.y}) scale(${view.k})`);
    svg.style.setProperty('--k', view.k); // text and strokes keep their on-screen size
    labelsDirty = true;
  };
  const toScreen = (n) => { const { w, h } = size(); return { x: w / 2 + view.x + n.x * view.k, y: h / 2 + view.y + n.y * view.k }; };
  const toWorld = (cx, cy) => {
    const r = svg.getBoundingClientRect(), { w, h } = size();
    return { x: (cx - r.left - w / 2 - view.x) / view.k, y: (cy - r.top - h / 2 - view.y) / view.k };
  };
  function fit() {
    const ns = all(), { w, h } = size();
    const xs = ns.map((n) => n.x), ys = ns.map((n) => n.y);
    const spanX = Math.max(...xs) - Math.min(...xs) + 160, spanY = Math.max(...ys) - Math.min(...ys) + 120;
    view.k = Math.max(0.25, Math.min(1.8, w / spanX, h / spanY));
    view.x = -((Math.max(...xs) + Math.min(...xs)) / 2) * view.k;
    view.y = -((Math.max(...ys) + Math.min(...ys)) / 2) * view.k;
    applyView();
  }

  // --- labels: busiest first; skip any that would overlap one already placed ------
  let labelsDirty = true;
  function placeLabels() {
    labelsDirty = false;
    const placed = [];
    const order = all().sort((a, b) => (b === focusNode) - (a === focusNode) || (a.kind === 'tag') - (b.kind === 'tag')
      || degree(b) - degree(a) || a.title.localeCompare(b.title));
    for (const n of order) {
      const p = toScreen(n), wdt = n.text.length * LABEL.charWidth * (n.kind === 'tag' ? 0.9 : 1), top = p.y + radius(n) * view.k + 2;
      const r = { l: p.x - wdt / 2 - LABEL.pad, r: p.x + wdt / 2 + LABEL.pad, t: top, b: top + LABEL.font + LABEL.pad };
      const clash = placed.some((q) => r.l < q.r && r.r > q.l && r.t < q.b && r.b > q.t);
      n.g.classList.toggle('quiet', clash);
      if (!clash) placed.push(r);
    }
  }

  // --- highlight: a node and its neighbours, or a category ------------------------
  const highlight = (set, edgeTest = () => false) => {
    svg.classList.toggle('focused', !!set);
    for (const m of [...pages, ...tagNodes]) m.g.classList.toggle('on', !!set && set.has(m));
    for (const e of [...links, ...tagEdges]) e.line.classList.toggle('on', !!set && edgeTest(e));
  };
  const neighbourhood = (n) => {
    const set = new Set([n]);
    for (const e of edges()) { if (e.s === n) set.add(e.t); if (e.t === n) set.add(e.s); }
    return set;
  };
  let activeCat = null;
  const catSet = (c) => new Set(pages.filter((n) => (c === '*other' ? !cats.includes(n.category) : n.category === c)));
  const hover = (n) => (n ? highlight(neighbourhood(n), (e) => e.s === n || e.t === n) : highlight(activeCat ? catSet(activeCat) : null));
  for (const n of [...pages, ...tagNodes]) {
    n.g.addEventListener('pointerenter', () => { if (!dragging) hover(n); });
    n.g.addEventListener('pointerleave', () => { if (!dragging) hover(null); });
    n.g.addEventListener('focus', () => hover(n));
    n.g.addEventListener('blur', () => hover(null));
  }

  // --- dragging and zooming --------------------------------------------------------
  let dragging = null;
  const nodeOf = (target) => { const a = target.closest?.('a.node'); return a && [...pages, ...tagNodes].find((m) => m.g === a); };
  svg.addEventListener('pointerdown', (e) => {
    const n = nodeOf(e.target);
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
      return applyView();
    }
    if (Math.hypot(e.clientX - dragging.sx, e.clientY - dragging.sy) > 4) dragging.moved = true;
    Object.assign(dragging.node, toWorld(e.clientX, e.clientY), { vx: 0, vy: 0 });
    heat = Math.max(heat, 0.4);
  });
  svg.addEventListener('pointerup', (e) => {
    if (!dragging) return;
    const d = dragging;
    dragging = null;
    if (d.node) { d.node.fixed = false; if (!d.moved) location.href = d.node.url; }
    if (!nodeOf(e.target)) hover(null);
  });
  svg.addEventListener('click', (e) => { if (nodeOf(e.target)) e.preventDefault(); }); // handled on pointerup
  svg.addEventListener('wheel', (e) => {
    e.preventDefault();
    const r = svg.getBoundingClientRect(), { w, h } = size();
    const k = Math.max(0.2, Math.min(6, view.k * Math.exp(-e.deltaY * 0.0015)));
    const px = e.clientX - r.left - w / 2, py = e.clientY - r.top - h / 2;
    view = { x: px - ((px - view.x) * k) / view.k, y: py - ((py - view.y) * k) / view.k, k };
    applyView();
  }, { passive: false });

  // --- simulation ------------------------------------------------------------------
  let heat = 1;
  function tick() {
    const ns = all(), es = edges();
    const connected = new Set(es.flatMap((e) => [e.s, e.t]));
    if (focusNode) connected.add(focusNode);
    // The ring sits just outside the connected cluster.
    let ringR = 0;
    for (const n of ns) if (connected.has(n)) ringR = Math.max(ringR, Math.hypot(n.x, n.y));
    ringR = Math.max(ringR + 55, 150);
    for (let i = 0; i < ns.length; i++) {
      const a = ns[i];
      for (let j = i + 1; j < ns.length; j++) {
        const b = ns[j];
        let dx = a.x - b.x, dy = a.y - b.y, d2 = dx * dx + dy * dy;
        if (d2 < 0.01) { dx = Math.random() - 0.5; dy = Math.random() - 0.5; d2 = 0.5; }
        const d = Math.sqrt(d2);
        let f = FORCES.repel / d2;
        const min = radius(a) + radius(b) + FORCES.collide; // collision: never overlap
        if (d < min) f += (min - d) * 0.5;
        a.vx += (dx / d) * f; a.vy += (dy / d) * f; b.vx -= (dx / d) * f; b.vy -= (dy / d) * f;
      }
    }
    for (const e of es) {
      const { distance, strength } = FORCES[e.kind];
      const dx = e.t.x - e.s.x, dy = e.t.y - e.s.y, d = Math.max(Math.hypot(dx, dy), 1), f = (d - distance) * strength;
      e.s.vx += (dx / d) * f; e.s.vy += (dy / d) * f; e.t.vx -= (dx / d) * f; e.t.vy -= (dy / d) * f;
    }
    for (const n of ns) {
      if (n.fixed) continue;
      if (connected.has(n)) { n.vx -= n.x * FORCES.center; n.vy -= n.y * FORCES.center; } else {
        const d = Math.max(Math.hypot(n.x, n.y), 1), f = (ringR - d) * FORCES.ring;
        n.vx += (n.x / d) * f; n.vy += (n.y / d) * f;
      }
      n.vx *= FORCES.damping; n.vy *= FORCES.damping;
      n.x += Math.max(-24, Math.min(24, n.vx)) * heat;
      n.y += Math.max(-24, Math.min(24, n.vy)) * heat;
    }
    heat = Math.max(heat * 0.986, 0);
  }
  function render() {
    for (const e of [...links, ...tagEdges]) {
      if (e.kind === 'tag' && !showTags) continue;
      const { s, t } = e, d = Math.max(Math.hypot(t.x - s.x, t.y - s.y), 1), r = radius(t) + (e.kind === 'link' ? 2 : 0);
      e.line.setAttribute('x1', s.x); e.line.setAttribute('y1', s.y);
      e.line.setAttribute('x2', t.x - ((t.x - s.x) / d) * r); e.line.setAttribute('y2', t.y - ((t.y - s.y) / d) * r);
    }
    for (const n of all()) n.g.setAttribute('transform', `translate(${n.x} ${n.y})`);
    labelsDirty = true;
  }
  for (let i = 0; i < 220; i++) tick();
  fit();
  render();
  (function frame() {
    if (heat > 0.008) { tick(); render(); }
    if (labelsDirty) placeLabels();
    requestAnimationFrame(frame);
  })();
  addEventListener('resize', applyView);

  // --- toolbar: tags, fit, full screen --------------------------------------------
  const bar = document.getElementById('graph-tools');
  bar.innerHTML = `<label><input type="checkbox" id="g-tags"${showTags ? ' checked' : ''}> Tags</label>
    <button type="button" id="g-fit">Fit</button><button type="button" id="g-full">Full screen</button>`;
  document.getElementById('g-tags').addEventListener('change', (e) => {
    showTags = e.target.checked;
    savePref('tags', showTags);
    applyVisibility();
    heat = 1;
    for (let i = 0; i < 120; i++) tick();
    fit();
    render();
  });
  document.getElementById('g-fit').addEventListener('click', fit);
  const wrap = document.getElementById('graph-frame');
  document.getElementById('g-full').addEventListener('click', () => (document.fullscreenElement ? document.exitFullscreen() : wrap.requestFullscreen?.()));
  document.addEventListener('fullscreenchange', () => {
    document.getElementById('g-full').textContent = document.fullscreenElement ? 'Exit full screen' : 'Full screen';
    setTimeout(fit, 50);
  });

  // Legend: categories; click to light up a category's pages.
  const legend = document.getElementById('legend');
  const hasOther = pages.some((n) => !cats.includes(n.category));
  legend.innerHTML = [...cats, ...(hasOther ? ['*other'] : [])]
    .map((c) => `<button type="button" data-cat="${c}"><i style="background:${color(c)}"></i>${c === '*other' ? 'Other' : data.labels[c]}</button>`).join('')
    + (tagNodes.length ? '<span class="legend-note"><i class="ring"></i>tag</span>' : '');
  legend.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    activeCat = activeCat === b.dataset.cat ? null : b.dataset.cat;
    for (const x of legend.querySelectorAll('button')) x.classList.toggle('on', x.dataset.cat === activeCat);
    highlight(activeCat != null ? catSet(activeCat) : null);
  });
}

function loadPref(k, d) { try { const v = localStorage.getItem(`graph_${k}`); return v == null ? d : v === '1'; } catch { return d; } }
function savePref(k, v) { try { localStorage.setItem(`graph_${k}`, v ? '1' : '0'); } catch { /* not remembered */ } }
