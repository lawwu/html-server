// The review page: the artifact full width on top, its comments underneath.
// The commenting token lives in this origin's localStorage; artifacts can't read
// it because they render sandboxed (opaque origin).
const SLUG = document.body.dataset.slug;
const S = encodeURIComponent(SLUG);
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const when = (t) => new Date(t * 1000).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });

let token = '';
try { token = localStorage.getItem('artifact_token') || ''; } catch { /* storage blocked: guest */ }
let meta, cur, showingDiff = false;

async function api(path, opts = {}) {
  const headers = { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(opts.body ? { 'Content-Type': 'application/json' } : {}) };
  const r = await fetch(path, { ...opts, headers });
  const data = r.headers.get('Content-Type')?.includes('json') ? await r.json() : null;
  if (!r.ok) throw new Error(data?.error || r.statusText);
  return data;
}

async function whoami() {
  if (!token) { $('who').textContent = 'Reading as a guest.'; return; }
  try {
    const me = await api('/api/me');
    $('who').textContent = `Signed in as ${me.name}`;
    $('signin').hidden = true;
  } catch { $('who').textContent = 'Saved token was rejected.'; }
}

// Swap in a new iframe rather than changing src: re-pointing a frame adds
// Back-button entries, and some embedded browsers block re-navigating a frame.
function setFrame(url) {
  const f = document.createElement('iframe');
  f.id = 'frame';
  f.title = 'Page';
  f.src = url;
  $('frame').replaceWith(f);
}
function showPage() { showingDiff = false; $('changes').textContent = 'Show changes'; setFrame(`${meta.share_url}?v=${cur}`); }
function showDiff() { showingDiff = true; $('changes').textContent = 'Show page'; setFrame(`/review/${S}/changes?from=${cur - 1}&to=${cur}`); }

async function load(n) {
  try { meta = await api(`/api/artifacts/${S}`); } catch (e) {
    document.querySelector('.review').innerHTML = `<p style="padding:1rem">${esc(e.message)}</p>`;
    return;
  }
  cur = Math.min(n || meta.latest_version, meta.latest_version);
  document.title = `Review: ${meta.title}`;
  $('title').textContent = meta.title;
  $('ver').innerHTML = meta.versions.slice().reverse().map((v) =>
    `<option value=${v.n} ${v.n === cur ? 'selected' : ''}>v${v.n}${v.n === meta.latest_version ? ' (current)' : ''} · ${esc(v.author)}${v.note ? ` · ${esc(v.note)}` : ''}</option>`).join('');
  $('restore').hidden = cur === meta.latest_version || !meta.can_edit;
  $('hist').href = `/history/${S}`;
  $('changes').disabled = cur === 1;
  $('open').href = `/pages/${S}${cur === meta.latest_version ? '' : `?v=${cur}`}`;
  history.replaceState(null, '', `?v=${cur}`);
  showPage();
  loadComments();
}

function card(c, replies = []) {
  const acts = `<div class="acts">${c.parent ? '' : `<button data-reply=${c.id}>Reply</button><button data-resolve=${c.id} data-undo=${c.resolved_at ? 1 : 0}>${c.resolved_at ? 'Reopen' : 'Resolve'}</button>`}<button data-del=${c.id}>Delete</button></div>`;
  return `<div class="${c.parent ? 'r' : 'c'}${c.resolved_at ? ' done' : ''}"><div class="meta">${esc(c.author)} · ${when(c.created_at)}${c.resolved_at ? ' · resolved' : ''}</div>
    <div class="b">${esc(c.body)}</div>${token ? acts : ''}${replies.map((r) => card(r)).join('')}
    ${c.parent ? '' : `<form data-replyform=${c.id} hidden><textarea placeholder="Reply"></textarea><button>Reply</button></form>`}</div>`;
}

async function loadComments() {
  const all = await api(`/api/artifacts/${S}/comments?version=${cur}`);
  const top = all.filter((c) => !c.parent);
  const open = top.filter((c) => !c.resolved_at).length;
  const label = `Comments on v${cur}${top.length ? ` (${top.length}${open < top.length ? `, ${open} open` : ''})` : ''}`;
  $('ctitle').textContent = label;
  $('jump').textContent = top.length ? `Comments (${top.length})` : 'Comments';
  $('list').innerHTML = top.length
    ? top.map((c) => card(c, all.filter((r) => r.parent === c.id))).join('')
    : '<p class="meta">No comments on this version yet.</p>';
}

async function act(fn) {
  $('err').textContent = '';
  try { await fn(); await loadComments(); } catch (e) { $('err').textContent = e.message; }
}

$('ver').onchange = (e) => load(Number(e.target.value));
$('changes').onclick = () => (showingDiff ? showPage() : showDiff());
$('restore').onclick = () => act(async () => {
  if (!confirm(`Make v${cur} the current version? This adds a new version; nothing is deleted.`)) return;
  const m = await api(`/api/artifacts/${S}/versions/${cur}/restore`, { method: 'POST' });
  await load(m.latest_version);
});
$('save').onclick = () => {
  token = $('tok').value.trim();
  try { localStorage.setItem('artifact_token', token); } catch { /* this session only */ }
  whoami();
  load(cur);
};
$('new').onsubmit = (e) => {
  e.preventDefault();
  act(async () => {
    if (!token) throw new Error('Sign in to comment.');
    await api(`/api/artifacts/${S}/comments`, { method: 'POST', body: JSON.stringify({ body: $('body').value, version: cur }) });
    $('body').value = '';
  });
};
$('list').onclick = (e) => {
  const d = e.target.dataset;
  if (d.reply) {
    const f = document.querySelector(`[data-replyform="${d.reply}"]`);
    f.hidden = !f.hidden;
    f.querySelector('textarea').focus();
  }
  if (d.resolve) act(() => api(`/api/comments/${d.resolve}/resolve${d.undo === '1' ? '?undo=1' : ''}`, { method: 'POST' }));
  if (d.del && confirm(e.target.closest('.r') ? 'Delete this reply?' : 'Delete this comment and its replies?')) {
    act(() => api(`/api/comments/${d.del}`, { method: 'DELETE' }));
  }
};
$('list').onsubmit = (e) => {
  e.preventDefault();
  const f = e.target;
  act(() => api(`/api/artifacts/${S}/comments`, {
    method: 'POST', body: JSON.stringify({ body: f.querySelector('textarea').value, parent: Number(f.dataset.replyform) }),
  }));
};

whoami();
load(Number(new URLSearchParams(location.search).get('v')) || 0);
