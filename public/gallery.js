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
    count.textContent = q ? `${n} match${n === 1 ? '' : 'es'}` : count.dataset.total; // back to "18 pages" when cleared
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
  // Delegated, because live search replaces the cards; the selection survives it.
  results.addEventListener('change', (e) => {
    const box = e.target.closest('.pick input');
    if (!box) return;
    box.checked ? picked.add(box.value) : picked.delete(box.value);
    sync();
  });
  new MutationObserver(sync).observe(results, { childList: true });

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
      await search(); // redraw with the new tags or featured order
    } catch (err) {
      if (err.status === 401) { token = ''; return askToken(); }
      say(err.message, true);
    }
  });
}
