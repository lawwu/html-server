// The gallery: live search (re-fetch the server-rendered cards as you type), sorting
// (the same, re-fetched in the new order) and the grid/list toggle (the same cards,
// styled per layout). Without JS the forms and the links still work.
//
// Each card leads with a live preview, and a preview put back into the document loads
// its page again, so new results never replace the cards on show: those stay where
// they are, take the new highlights, and are reordered (CSS order) or hidden.
const box = document.getElementById('q');
const results = document.getElementById('results');
const count = document.getElementById('count');
const toggles = [...document.querySelectorAll('.vt')];
const url = new URLSearchParams(location.search);
const category = url.get('category') || '';
const BASE = box.form.dataset.base || '/'; // "/" for your pages, "/gallery" for the examples
const PREF = 'artifact_gallery_view';
const SORT_PREF = 'artifact_gallery_sort';
const sortSel = document.getElementById('sort'); // your pages only, not the examples
let ctl, timer;
// The chosen sort; '' means the default (best match while searching, else recently updated).
let sort = url.get('sort') || '';
const sortFor = (q) => (sort === 'relevance' && !q ? '' : sort); // best match means nothing without a query

const pref = () => { try { return localStorage.getItem(PREF); } catch { return null; } };
// A view in the URL wins (it's a shared link); otherwise use this browser's last choice.
let view = [url.get('view'), pref()].find((v) => v === 'grid' || v === 'list') || 'grid';

/** The URL for the current state; grid is the default, so it stays implicit. */
function stateParams(q = box.value.trim()) {
  const p = new URLSearchParams();
  if (q) p.set('q', q);
  if (category) p.set('category', category);
  if (view !== 'grid') p.set('view', view);
  if (sortFor(q)) p.set('sort', sortFor(q));
  return p;
}

/** Show the order in effect, and offer "Best match" only while searching. */
function syncSort(q = box.value.trim()) {
  if (!sortSel) return;
  const best = sortSel.querySelector('option[value="relevance"]');
  best.hidden = best.disabled = !q;
  sortSel.value = sortFor(q) || (q ? 'relevance' : 'updated');
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

/** Where the cards for a query come from: just the results area of the page. */
function fragmentUrl(q = box.value.trim()) {
  const p = new URLSearchParams({ fragment: '1' });
  if (q) p.set('q', q);
  if (category) p.set('category', category);
  if (sortFor(q)) p.set('sort', sortFor(q));
  return `${BASE}?${p}`;
}

// Results already fetched on this visit, so going back to an earlier query (backspace) is instant.
const cache = new Map();
let cached = 0;
function remember(key, html) {
  cache.delete(key);
  cache.set(key, html);
  cached += html.length;
  for (const [k, h] of cache) { // oldest first
    if (cached <= 4e6 || k === key) break;
    cache.delete(k);
    cached -= h.length;
  }
}

/** Lay out a results fragment over the cards on show; returns how many cards it has. */
function show(html) {
  const next = document.createElement('template');
  next.innerHTML = html;
  let grid = results.querySelector('.cards');
  if (!grid) results.prepend(grid = Object.assign(document.createElement('div'), { className: 'cards' }));
  const key = (el) => el.dataset.slug || el.dataset.section || '';
  const shown = new Map([...grid.children].map((el) => [key(el), el]));
  const parts = (card) => [...card.children].filter((el) => !el.matches('.thumb, .pick')); // all but the preview and the checkbox
  const seen = new Set();
  [...(next.content.querySelector('.cards')?.children ?? [])].forEach((el, i) => {
    let cur = shown.get(key(el));
    if (!cur) grid.append(cur = el);
    else if (el.matches('.card')) {
      cur.classList.toggle('pinned', el.classList.contains('pinned'));
      const [now, then] = [parts(cur), parts(el)];
      if (now.map((n) => n.outerHTML).join('') !== then.map((n) => n.outerHTML).join('')) { now.forEach((n) => n.remove()); cur.append(...then); }
    }
    cur.hidden = false;
    if (cur.style.order !== String(i)) cur.style.order = i;
    seen.add(cur);
  });
  for (const el of grid.children) if (!seen.has(el)) el.hidden = true;
  results.querySelector(':scope > .empty')?.remove();
  const empty = next.content.querySelector('.empty');
  if (empty) results.append(empty);
  return next.content.querySelectorAll('.card').length;
}

/** Show the cards for what's typed; `fresh` after a change to the pages themselves. */
async function search({ fresh = false } = {}) {
  const q = box.value.trim();
  syncSort(q);
  syncUrl();
  ctl?.abort();
  if (fresh) { cache.clear(); cached = 0; }
  const key = fragmentUrl(q);
  let html = cache.get(key);
  if (html == null) {
    ctl = new AbortController();
    try {
      const r = await fetch(key, { signal: ctl.signal });
      html = r.ok ? await r.text() : '<p class="empty">Search failed.</p>';
      if (r.ok) remember(key, html);
    } catch (e) {
      if (e.name !== 'AbortError') throw e;
      return;
    }
  }
  const n = show(html);
  count.textContent = q ? `${n} match${n === 1 ? '' : 'es'}` : count.dataset.total; // back to "18 pages" when cleared
}

remember(fragmentUrl(), results.innerHTML); // what's on show now
// Cached results show at once; otherwise wait for a pause in typing, but only a short one.
box.addEventListener('input', () => { clearTimeout(timer); if (cache.has(fragmentUrl())) search(); else timer = setTimeout(search, 60); });
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
  if (sortFor(q)) p.set('sort', sortFor(q));
  location.href = p.size ? `${BASE}?${p}` : BASE;
}));

if (view !== results.className) setView(view);

// Sorting: re-fetch the cards in the new order, and remember the choice in this browser.
sortSel?.addEventListener('change', () => {
  const q = box.value.trim();
  sort = sortSel.value === (q ? 'relevance' : 'updated') ? '' : sortSel.value;
  try { localStorage.setItem(SORT_PREF, sort); } catch { /* not remembered */ }
  search();
});
sortSel?.form.addEventListener('submit', (e) => e.preventDefault());
// A sort in the URL wins (it's a shared link); otherwise this browser's last choice.
if (sortSel && !url.get('sort')) {
  let saved = null;
  try { saved = localStorage.getItem(SORT_PREF); } catch { /* none */ }
  if (saved && saved !== 'relevance' && [...sortSel.options].some((o) => o.value === saved)) { sort = saved; search(); }
}

// --- select mode: tag, untag, feature or unfeature many pages at once ---------------
// Uses the same saved sign-in as the review page (this site's localStorage only).
const selectBtn = document.getElementById('select');
const bulk = document.getElementById('bulk');
if (selectBtn && bulk) {
  const picked = new Set();
  const msg = document.getElementById('bulk-msg');
  const tagBox = document.getElementById('bulk-tag');
  let token = '';
  try { token = localStorage.getItem('artifact_token') || ''; } catch { /* storage blocked */ }

  const say = (text, isError = false) => { msg.textContent = text; msg.classList.toggle('err', isError); };
  const sync = () => {
    document.getElementById('bulk-count').textContent = `${picked.size} selected`;
    for (const card of results.querySelectorAll('.card[data-slug]')) {
      const on = picked.has(card.dataset.slug);
      card.classList.toggle('picked', on);
      const box = card.querySelector('.pick input');
      if (box) box.checked = on;
    }
  };
  const setSelecting = (on) => {
    document.body.classList.toggle('selecting', on);
    bulk.hidden = !on;
    selectBtn.textContent = on ? 'Selecting…' : 'Select';
    if (!on) { picked.clear(); say(''); }
    sync();
  };
  selectBtn.addEventListener('click', () => setSelecting(!document.body.classList.contains('selecting')));
  // Delegated, because live search adds cards; the selection survives it.
  results.addEventListener('change', (e) => {
    const box = e.target.closest('.pick input');
    if (!box) return;
    box.checked ? picked.add(box.value) : picked.delete(box.value);
    sync();
  });
  new MutationObserver(sync).observe(results, { childList: true, subtree: true });

  async function call(method, path, body) {
    const r = await fetch(path, {
      method, body: body && JSON.stringify(body),
      headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    });
    const data = await r.json().catch(() => null);
    if (!r.ok) throw Object.assign(new Error(data?.error || r.statusText), { status: r.status });
    return data;
  }

  function askToken() {
    say('');
    const wrap = document.createElement('span');
    wrap.className = 'bulk-msg';
    wrap.innerHTML = 'Sign in to change pages: <input type="password" placeholder="paste your token" aria-label="Token"> <button type="button">Save</button>';
    msg.replaceChildren(wrap);
    const [input, save] = [wrap.querySelector('input'), wrap.querySelector('button')];
    input.focus();
    save.onclick = () => {
      token = input.value.trim();
      try { localStorage.setItem('artifact_token', token); } catch { /* this visit only */ }
      say(token ? 'Signed in. Try again.' : '');
    };
  }

  bulk.addEventListener('click', async (e) => {
    const act = e.target.dataset?.act;
    if (!act) return;
    if (act === 'done') return setSelecting(false);
    if (!picked.size) return say('Tick some pages first.', true);
    if (!token) return askToken();
    const pages = [...picked];
    try {
      let failures = [];
      if (act === 'add' || act === 'remove') {
        const tag = tagBox.value.trim();
        if (!tag) { tagBox.focus(); return say('Type a tag first.', true); }
        const { results: out } = await call('POST', '/api/tags', { pages, [act]: [tag] });
        failures = out.filter((r) => r.error).map((r) => `${r.slug}: ${r.error}`);
        say(`${act === 'add' ? 'Tagged' : 'Untagged'} ${out.length - failures.length} of ${out.length}.`);
      } else {
        for (const slug of pages) {
          try { await call(act === 'pin' ? 'POST' : 'DELETE', `/api/artifacts/${encodeURIComponent(slug)}/pin`); } catch (err) {
            if (err.status === 401) throw err;
            failures.push(`${slug}: ${err.message}`);
          }
        }
        say(`${act === 'pin' ? 'Featured' : 'Unfeatured'} ${pages.length - failures.length} of ${pages.length}.`);
      }
      if (failures.length) say(`${msg.textContent} Not changed: ${failures.join('; ')}`, true);
      await search({ fresh: true }); // redraw with the new tags or featured order
    } catch (err) {
      if (err.status === 401) { token = ''; return askToken(); }
      say(err.message, true);
    }
  });
}
