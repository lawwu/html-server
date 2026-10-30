// The review page: the artifact full width on top, its comments underneath.
// The commenting token lives in this origin's localStorage; artifacts can't read
// it because they render sandboxed (opaque origin).
import { openMove } from './move.js';
const SLUG = document.body.dataset.slug;
const S = encodeURIComponent(SLUG); // for the API
const P = SLUG.split('/').map(encodeURIComponent).join('/'); // for links: research/report.html
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const when = (t) => new Date(t * 1000).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
const kb = (n) => (n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`);

let token = '';
try { token = localStorage.getItem('artifact_token') || ''; } catch { /* storage blocked: guest */ }
let meta, cur, showingDiff = false, diffAsked = '';

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
// `html` is shown sandboxed, as the server serves it: no scripts, and no way to this
// page's token.
function setFrame({ url, html }) {
  const f = document.createElement('iframe');
  f.id = 'frame';
  f.title = 'Page';
  if (html != null) {
    f.setAttribute('sandbox', '');
    f.srcdoc = html;
  } else f.src = url;
  $('frame').replaceWith(f);
}
function showPage() { showingDiff = false; $('changes').textContent = 'Show changes'; setFrame({ url: `${meta.share_url}?v=${cur}` }); }
/**
 * What changed between two versions (by default, into the one on show). The changes page is
 * fetched with the saved token, so a private page's show too; a frame pointed at it would
 * go without one.
 */
async function showDiff({ from = cur - 1, to = cur, source = false } = {}) {
  showingDiff = true;
  $('changes').textContent = 'Show page';
  const ask = diffAsked = `${from}-${to}-${source}`;
  const say = (msg) => `<p style="font:14px/1.5 system-ui,sans-serif;padding:1rem">${esc(msg)}</p>`;
  let html;
  try {
    const r = await fetch(`/review/${P}/changes?from=${from}&to=${to}${source ? '&of=source' : ''}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
    html = r.ok ? await r.text() : say((await r.json().catch(() => null))?.error || r.statusText);
  } catch (e) { html = say(e.message); }
  if (showingDiff && diffAsked === ask) setFrame({ html }); // unless the page or other changes were asked for since
}

/** Every version, newest first, as on the History page; here, with the saved token, a private page's too. */
function showHistory() {
  const vs = meta.versions.slice().reverse();
  const opts = (sel) => vs.map((v) => `<option value="${v.n}"${v.n === sel ? ' selected' : ''}>v${v.n}</option>`).join('');
  const rows = vs.map((v) => `<tr><td class="vn"><button data-view="${v.n}">v${v.n}</button>${v.n === meta.latest_version ? ' <span class="meta">current</span>' : ''}</td>
    <td class="nw">${esc(when(v.created_at))}</td><td class="nw">${esc(v.author)}</td><td>${esc(v.note)}</td><td class="num">${kb(v.size)}</td>
    <td class="acts">${v.n > 1 ? `<button data-diff="${v.n}">changes</button>` : '<span class="meta">first</span>'}</td></tr>`).join('');
  $('history').innerHTML = `<h2>History</h2>
<p class="meta">${esc(meta.slug)} · ${vs.length} version${vs.length === 1 ? '' : 's'} · owned by ${esc(meta.owner)}</p>
${vs.length > 1 ? `<form class="compare">Compare <select name="from" aria-label="From version">${opts(meta.latest_version - 1)}</select>
  with <select name="to" aria-label="To version">${opts(meta.latest_version)}</select>
  <label><input type="checkbox" name="source"> HTML source</label> <button>Show changes</button></form>` : ''}
<div class="scroll"><table class="versions"><thead><tr><th>Version</th><th>Uploaded</th><th>By</th><th>Note</th><th class="num">Size</th><th></th></tr></thead>
<tbody>${rows}</tbody></table></div>
${meta.moves?.length ? `<h3>Moves</h3><ul>${meta.moves.map((m) => `<li>${esc(when(m.created_at))}: ${esc(m.old_path)} → ${esc(m.new_path)}</li>`).join('')}</ul>` : ''}`;
}

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
  $('move-page').hidden = !meta.can_move;
  $('move-page').onclick = () => openMove([meta.slug], (out) => { location.href = `/review/${out[0].slug.split('/').map(encodeURIComponent).join('/')}`; });
  if (meta.can_move && new URLSearchParams(location.search).get('move')) $('move-page').click();
  $('restore').hidden = cur === meta.latest_version || !meta.can_edit;
  if (!$('history').hidden) showHistory();
  $('changes').disabled = cur === 1;
  $('open').href = `${meta.url}${cur === meta.latest_version ? '' : `?v=${cur}`}`;
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
$('hist').onclick = () => {
  const h = $('history');
  h.hidden = !h.hidden;
  $('hist').setAttribute('aria-expanded', String(!h.hidden));
  if (!h.hidden && meta) { showHistory(); h.scrollIntoView({ block: 'nearest' }); }
};
$('history').onclick = async (e) => {
  const { view, diff } = e.target.dataset;
  if (view) await load(Number(view));
  if (diff) { await load(Number(diff)); showDiff(); }
};
$('history').onsubmit = (e) => {
  e.preventDefault();
  const f = e.target.elements;
  showDiff({ from: Number(f.from.value), to: Number(f.to.value), source: f.source.checked });
};
$('restore').onclick = () => act(async () => {
  if (!confirm(`Make v${cur} the current version? This adds a new version; nothing is deleted.`)) return;
  // By the page's exact name: the URL may say /review/plan for plan.html, and writes never guess.
  const m = await api(`/api/artifacts/${encodeURIComponent(meta.slug)}/versions/${cur}/restore`, { method: 'POST' });
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
