// Server-rendered pages: the gallery at /, the API docs, the review shell, and the
// side-by-side diff. Browser behaviour lives in public/*.js; shared styles in public/style.css.
import { MAX_BODY_BYTES, RESERVED_SLUGS } from './config.js';
import { escapeHtml as esc, groupedOpcodes } from './text.js';

const CATEGORY_LABELS = {
  featured: 'Featured',
  'explain-diff': 'Explain a diff',
  architecture: 'Architecture',
  'data-science': 'Data science',
  'machine-learning': 'Machine learning',
  'data-viz': 'Data visualization',
  'code-review': 'Code review',
  editor: 'Editors',
  prototype: 'Prototypes',
};
export const categoryLabel = (c) => CATEGORY_LABELS[c] || c.replace(/-/g, ' ').replace(/^./, (x) => x.toUpperCase());

const shell = (title, body, { scripts = [], bodyAttrs = '' } = {}) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title><link rel="stylesheet" href="/_static/style.css"></head>
<body ${bodyAttrs}>${body}${scripts.map((s) => `<script src="/_static/${s}" type="module"></script>`).join('')}</body></html>`;

const day = (t) => new Date(t * 1000).toLocaleDateString('en-CA');
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

/** The cards for a result set: also served alone as the live-search fragment. */
export function galleryCards(items, q) {
  if (!items.length) return `<p class="empty">${q ? 'No matches.' : 'Nothing here yet.'}</p>`;
  return items.map((i) => {
    const snippet = i.snippet ? esc(i.snippet).replace(/\[/g, '<mark>').replace(/\]/g, '</mark>') : esc(i.description);
    return `<article class="card">
  ${i.category ? `<a class="tag" href="/?category=${encodeURIComponent(i.category)}">${esc(categoryLabel(i.category))}</a>` : ''}
  <h2><a href="${esc(i.url)}">${esc(i.title)}</a></h2>
  ${snippet ? `<p class="desc">${snippet}</p>` : ''}
  <p class="meta">${esc(i.slug)} · ${esc(i.owner)} · v${i.latest_version} · ${day(i.updated_at)} · ${plural(i.views, 'view')}${i.visibility === 'private' ? ' · private' : ''}
    · <a href="/review/${encodeURIComponent(i.slug)}">review</a> · <a href="/history/${encodeURIComponent(i.slug)}">history</a></p>
</article>`;
  }).join('\n');
}

export const VIEWS = ['grid', 'list'];

export function galleryPage(items, { q = '', category = '', categories = [], view = 'grid' }) {
  // Links keep the other settings, so the page works fully without JS.
  const link = (over) => {
    const p = new URLSearchParams(Object.entries({ q, category, view, ...over }).filter(([k, v]) => v && !(k === 'view' && v === 'grid')));
    return `/${p.size ? `?${p}` : ''}`;
  };
  const chip = (value, label, count) => `<a class="chip${value === category ? ' on' : ''}" data-category="${esc(value)}"
    href="${esc(link({ category: value, q: '' }))}">${esc(label)}${count != null ? ` <span>${count}</span>` : ''}</a>`;
  const toggle = (v, label, icon) => `<a class="vt${v === view ? ' on' : ''}" data-view="${v}" href="${esc(link({ view: v }))}"
    aria-label="${label}" aria-pressed="${v === view}" title="${label}">${icon}</a>`;
  const grid = '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="1" y="1" width="6" height="6" rx="1.5"/><rect x="9" y="1" width="6" height="6" rx="1.5"/><rect x="1" y="9" width="6" height="6" rx="1.5"/><rect x="9" y="9" width="6" height="6" rx="1.5"/></svg>';
  const list = '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="1" y="2" width="14" height="2.5" rx="1.2"/><rect x="1" y="6.75" width="14" height="2.5" rx="1.2"/><rect x="1" y="11.5" width="14" height="2.5" rx="1.2"/></svg>';
  return shell('Artifacts', `<main class="wrap">
<header class="top"><h1>Artifacts</h1><nav><a href="/api">API</a></nav></header>
<form id="search" role="search"><input id="q" name="q" value="${esc(q)}" placeholder="Search — typos are fine" autocomplete="off" autofocus>
${category ? `<input type="hidden" name="category" value="${esc(category)}">` : ''}
${view !== 'grid' ? `<input type="hidden" name="view" value="${esc(view)}">` : ''}</form>
<div class="bar2"><nav class="chips" aria-label="Categories">${chip('', 'All')}${categories.map((c) => chip(c.category, categoryLabel(c.category), c.count)).join('')}</nav>
<div class="views" role="group" aria-label="Layout">${toggle('grid', 'Grid view', grid)}${toggle('list', 'List view', list)}</div></div>
<p id="count" class="meta"></p>
<section id="results" class="${view}">${galleryCards(items, q)}</section></main>`, { scripts: ['gallery.js'] });
}

/** Every version, newest first: view it, see what it changed, or compare any two. */
export function historyPage(a) {
  const S = encodeURIComponent(a.slug);
  const when = (t) => { // "2026-10-20 07:12": short, sortable, never wraps
    const d = new Date(t * 1000);
    return `${d.toLocaleDateString('en-CA')} ${d.toTimeString().slice(0, 5)}`;
  };
  const kb = (n) => (n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`);
  const rows = a.versions.slice().reverse().map((v) => `<tr>
  <td class="vn"><a href="/pages/${S}?v=${v.n}">v${v.n}</a>${v.n === a.latest_version ? ' <span class="cur">current</span>' : ''}</td>
  <td class="nw">${esc(when(v.created_at))}</td><td class="nw">${esc(v.author)}</td><td>${esc(v.note)}</td><td class="num">${kb(v.size)}</td>
  <td class="acts">${v.n > 1 ? `<a href="/review/${S}/changes?from=${v.n - 1}&amp;to=${v.n}&amp;back=1">changes</a>` : '<span class="meta">first</span>'}
    · <a href="/review/${S}?v=${v.n}">review</a></td></tr>`).join('');
  const opts = (sel) => a.versions.slice().reverse()
    .map((v) => `<option value="${v.n}"${v.n === sel ? ' selected' : ''}>v${v.n}</option>`).join('');
  return shell(`History: ${a.title}`, `<main class="wrap history">
<p class="meta"><a href="/">Artifacts</a> / <a href="/pages/${S}">${esc(a.title)}</a></p>
<h1>History</h1>
<p class="meta">${esc(a.slug)} · ${a.versions.length} version${a.versions.length === 1 ? '' : 's'} · owned by ${esc(a.owner)}</p>
${a.versions.length > 1 ? `<form class="compare" action="/review/${S}/changes" method="get">
  Compare <select name="from" aria-label="From version">${opts(a.latest_version - 1)}</select>
  with <select name="to" aria-label="To version">${opts(a.latest_version)}</select>
  <label><input type="checkbox" name="of" value="source"> HTML source</label> <input type="hidden" name="back" value="1">
  <button>Show changes</button></form>` : ''}
<div class="scroll"><table class="versions"><thead><tr><th>Version</th><th>Uploaded</th><th>By</th><th>Note</th><th class="num">Size</th><th></th></tr></thead>
<tbody>${rows}</tbody></table></div></main>`);
}

export function reviewPage(slug) {
  return shell('Review', `<header class="bar"><h1><a href="/">Artifacts</a> / <span id="title"></span></h1>
<select id="ver" aria-label="Version"></select>
<button id="changes">Show changes</button><button id="restore" hidden>Make this version current</button>
<a id="open" target="_blank">Open page</a> <a id="hist">History</a> <a id="jump" href="#comments">Comments</a></header>
<div class="review"><div id="frame-slot"><iframe id="frame" title="Page"></iframe></div><aside id="comments">
<h2 id="ctitle">Comments</h2><p id="who" class="meta"></p>
<details id="signin"><summary>Sign in to comment</summary>
<p class="meta">Paste your token (ask the admin for one). It is saved in this browser only.</p>
<input id="tok" type="password" autocomplete="off"> <p><button id="save">Save</button></p></details>
<form id="new"><textarea id="body" placeholder="Comment on this version"></textarea>
<p><button>Post</button> <span id="err" class="err"></span></p></form>
<div id="list"></div></aside></div>`, { scripts: ['review.js'], bodyAttrs: `data-slug="${esc(slug)}"` });
}

/** Side-by-side changes. Served sandboxed (it shows page content), so styles are inline. */
/** `back`: when opened full-page from History (not framed in the review page), link back to it. */
export function diffPage(fromN, toN, a, b, { back } = {}) {
  const groups = groupedOpcodes(a, b);
  const cell = (n, text, cls) => (n == null ? '<td class="n"></td><td class="x"></td>'
    : `<td class="n">${n}</td><td class="${cls}">${esc(text)}</td>`);
  let rows = '';
  groups.forEach((g, gi) => {
    if (gi) rows += '<tr class="gap"><td colspan="4">⋯</td></tr>';
    for (const [t, i1, i2, j1, j2] of g) {
      const len = Math.max(i2 - i1, j2 - j1);
      for (let k = 0; k < len; k++) {
        const ai = i1 + k < i2 ? i1 + k : null, bj = j1 + k < j2 ? j1 + k : null;
        const cls = t === 'equal' ? 'eq' : null;
        rows += `<tr>${cell(ai == null ? null : ai + 1, a[ai], cls || 'del')}${cell(bj == null ? null : bj + 1, b[bj], cls || 'ins')}</tr>`;
      }
    }
  });
  const body = groups.length
    ? `<table><colgroup><col class="cn"><col><col class="cn"><col></colgroup><thead><tr><th colspan="2">v${fromN}</th><th colspan="2">v${toN}</th></tr></thead><tbody>${rows}</tbody></table>`
    : `<p class="same">No differences between v${fromN} and v${toN}.</p>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>v${fromN} → v${toN}</title><style>
:root{--bg:#fff;--fg:#1d1d1f;--mute:#8a8a8e;--line:#e4e4e7;--del:#fde8e8;--ins:#e3f6e8;--deltx:#9b1c1c;--instx:#14532d}
@media(prefers-color-scheme:dark){:root{--bg:#141416;--fg:#e8e8ea;--mute:#7c7c82;--line:#2c2c30;--del:#3a1d1f;--ins:#16301f;--deltx:#fca5a5;--instx:#86efac}}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 ui-sans-serif,system-ui,sans-serif}
table{width:100%;border-collapse:collapse;table-layout:fixed}th{position:sticky;top:0;background:var(--bg);text-align:left;
padding:.5rem .75rem;border-bottom:1px solid var(--line);font-weight:600}td{vertical-align:top;padding:.2rem .5rem;
white-space:pre-wrap;overflow-wrap:anywhere}col.cn{width:2.75rem}td.n{color:var(--mute);text-align:right;font:12px ui-monospace,monospace;user-select:none}
td.del{background:var(--del);color:var(--deltx)}td.ins{background:var(--ins);color:var(--instx)}
.gap td{text-align:center;color:var(--mute);padding:.4rem}
.back{display:block;padding:.6rem .75rem;border-bottom:1px solid var(--line);color:inherit;font-size:13px}.same{padding:1.5rem;color:var(--mute)}
</style></head><body>${back ? `<a class="back" href="${esc(back)}" target="_top">← History</a>` : ''}${body}</body></html>`;
}

export function docsPage(base, routes) {
  const md = (text) => esc(text).replace(/`([^`]+)`/g, '<code>$1</code>');
  const display = (pattern) => pattern.replace(/\(\?<(\w+)>[^)]*\)/g, '<$1>').replace(/\/\?/g, '/').replace(/\(\?:|\)\?/g, '') || '/';
  const rows = routes.filter((r) => r.doc).map((r) =>
    `<tr><td><b>${r.method}</b></td><td><code>${esc(display(r.path))}</code></td><td>${esc(r.who)}</td><td>${md(r.doc)}</td></tr>`).join('');
  return shell('Artifacts API', `<main class="wrap docs"><p><a href="/">← Artifacts</a></p><h1>API</h1>
<h2>Quickstart</h2>
<pre>A=${esc(base)}
H="Authorization: Bearer $HTML_SERVER_TOKEN"

# upload, or add a version (the URL must end in / so curl appends the file name)
curl -T trip-plan.html -H "$H" -H "X-Note: first draft" $A/api/artifacts/

# or with the html-server CLI (it finds your token in ~/.html-server/token)
html-server put trip-plan.html "first draft"

# view it, search, trash, then delete for good
open $A/pages/trip-plan
curl "$A/api/artifacts?q=shelling"
curl -X DELETE -H "$H" $A/api/artifacts/trip-plan.html
curl -X DELETE -H "$H" "$A/api/artifacts/trip-plan.html?purge=1"</pre>
<h2>Rules</h2><ul>
<li><b>The URL is the file name</b>: <code>trip-plan.html</code> is served at <code>/pages/trip-plan.html</code>, and <code>/pages/trip-plan</code> works too. Names are shared across the whole server: the first user to upload a name owns it.</li>
<li><b>Everything is public</b> unless uploaded with <code>X-Visibility: private</code>. <b>anyone*</b> below means
anyone for public pages, and only the owner (by token) for private or trashed ones.</li>
<li><b>Gallery:</b> a page's <code>&lt;meta name="description"&gt;</code> and <code>&lt;meta name="category"&gt;</code>
become its card text and category on <a href="/">the home page</a>.</li>
<li><b>Editing:</b> by default only a page's owner adds versions. On a server with open editing
(<code>html-server config editing open</code>), anyone signed in can add or restore versions of public pages; only the
owner trashes, deletes or changes visibility. Every version records who uploaded it, and <code>?base=n</code> refuses an
upload if the page has moved past version n. Each page's versions are listed at <code>/history/&lt;name&gt;</code>.</li>
<li><b>Lifecycle:</b> active → trashed → purged, or trashed → active again. A trashed page can't take new
versions, and only trashed pages can be purged; anything else returns 409 with the allowed actions.</li>
<li>Pages run in a sandbox: their JavaScript works, but it can't use browser storage or call this API.</li>
<li>Errors are JSON: <code>{"error": "..."}</code>. Max ${MAX_BODY_BYTES / (1024 * 1024)} MB per upload.
Reserved names: ${esc([...RESERVED_SLUGS].sort().join(', '))}.</li></ul>
<h2>Endpoints</h2><div class="scroll"><table class="routes">${rows}</table></div></main>`);
}
