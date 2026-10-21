// The gallery: live search (re-fetch the server-rendered cards as you type) and
// the grid/list toggle (the same cards, styled per layout). Without JS the form
// and the links still work, so the page works either way.
const box = document.getElementById('q');
const results = document.getElementById('results');
const count = document.getElementById('count');
const toggles = [...document.querySelectorAll('.vt')];
const url = new URLSearchParams(location.search);
const category = url.get('category') || '';
const BASE = box.form.dataset.base || '/'; // "/" for your pages, "/gallery" for the examples
const PREF = 'artifact_gallery_view';
let ctl, timer;

const pref = () => { try { return localStorage.getItem(PREF); } catch { return null; } };
// A view in the URL wins (it's a shared link); otherwise use this browser's last choice.
let view = [url.get('view'), pref()].find((v) => v === 'grid' || v === 'list') || 'grid';

/** The URL for the current state; grid is the default, so it stays implicit. */
function stateParams(q = box.value.trim()) {
  const p = new URLSearchParams();
  if (q) p.set('q', q);
  if (category) p.set('category', category);
  if (view !== 'grid') p.set('view', view);
  return p;
}
const syncUrl = () => { const p = stateParams(); history.replaceState(null, '', p.size ? `${BASE}?${p}` : BASE); };

function setView(v) {
  view = v;
  results.className = v;
  for (const t of toggles) {
    const on = t.dataset.view === v;
    t.classList.toggle('on', on);
    t.setAttribute('aria-pressed', String(on));
  }
  try { localStorage.setItem(PREF, v); } catch { /* not remembered */ }
  syncUrl();
}

async function search() {
  const q = box.value.trim();
  syncUrl();
  ctl?.abort();
  ctl = new AbortController();
  try {
    const p = new URLSearchParams({ fragment: '1' });
    if (q) p.set('q', q);
    if (category) p.set('category', category);
    const r = await fetch(`${BASE}?${p}`, { signal: ctl.signal });
    results.innerHTML = r.ok ? await r.text() : '<p class="empty">Search failed.</p>';
    const n = results.querySelectorAll('.card').length;
    count.textContent = q ? `${n} match${n === 1 ? '' : 'es'}` : '';
  } catch (e) {
    if (e.name !== 'AbortError') throw e;
  }
}

box.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(search, 120); });
box.form.addEventListener('submit', (e) => { e.preventDefault(); search(); });
for (const t of toggles) t.addEventListener('click', (e) => { e.preventDefault(); setView(t.dataset.view); });
// Keep the typed query and the layout when switching category.
document.querySelectorAll('.chip').forEach((chip) => chip.addEventListener('click', (e) => {
  e.preventDefault();
  const p = new URLSearchParams();
  const q = box.value.trim();
  if (q) p.set('q', q);
  if (chip.dataset.category) p.set('category', chip.dataset.category);
  if (view !== 'grid') p.set('view', view);
  location.href = p.size ? `${BASE}?${p}` : BASE;
}));

if (view !== results.className) setView(view);
