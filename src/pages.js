// Server-rendered pages: your pages at /, the example gallery at /gallery, history,
// the API docs, the review shell, and the side-by-side diff. Browser behaviour lives in public/*.js; shared styles in public/style.css.
import { MAX_BODY_BYTES, RELEASE_URL, REPO_URL, RESERVED_SLUGS, VERSION } from './config.js';
import { barList, columnChart, tile } from './charts.js';
import { HIT, escapeHtml as esc, groupedOpcodes, markHits } from './text.js';

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

/** On every page the server draws itself (never on uploaded pages): which version is running, and where it lives. */
export const footer = () => `<footer class="site-foot"><a href="${RELEASE_URL}">HTML Server v${esc(VERSION)}</a>
  · <a href="${REPO_URL}">Source on GitHub</a> · <a href="/api">API</a></footer>`;

const shell = (title, body, { scripts = [], bodyAttrs = '' } = {}) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title><link rel="stylesheet" href="/_static/style.css"></head>
<body ${bodyAttrs}>${body}${footer()}${scripts.map((s) => `<script src="/_static/${s}" type="module"></script>`).join('')}</body></html>`;

const day = (t) => new Date(t * 1000).toLocaleDateString('en-CA');
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : w.endsWith('ch') ? 'es' : 's'}`;

// GitHub's mark (Octicons, MIT), linking to the release that's running.
const GITHUB_MARK = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>';

/** The bar at the top of the server's own pages. */
export function siteNav(active) {
  const item = (href, label, key) => `<a href="${href}"${key === active ? ' class="on" aria-current="page"' : ''}>${label}</a>`;
  return `<header class="site"><a class="brand" href="/">HTML Server</a>
<nav>${item('/', 'Pages', 'pages')}${item('/graph', 'Graph', 'graph')}${item('/stats', 'Stats', 'stats')}${item('/gallery', 'Gallery', 'gallery')}${item('/api', 'API', 'api')}</nav>
<a class="gh" href="${RELEASE_URL}" title="HTML Server v${esc(VERSION)} on GitHub">${GITHUB_MARK}<span>v${esc(VERSION)}</span></a></header>`;
}

const PIN = '<svg class="pin" viewBox="0 0 16 16" aria-hidden="true"><path d="M9.8 1.5 14.5 6.2l-1.4.4-2.5 2.5.3 3.3-1.4 1.4-2.7-2.7-3.5 3.5-.7-.7 3.5-3.5L3.4 7.7l1.4-1.4 3.3.3 2.5-2.5z"/></svg>';

/**
 * The cards for a result set. Each card leads with a live, scaled-down preview of the
 * page (?preview=1: not counted as a view, no sidebar), loaded only when it scrolls
 * into view; the frame needs no sandbox attribute, the page itself is served with a
 * sandbox CSP header. Tags sit as small chips beside the title; a checkbox (shown in
 * select mode) is how pages are picked for bulk tagging and pinning.
 */
export function galleryCards(items, q, { base = '/' } = {}) {
  return items.map((i) => {
    const hits = i[HIT];
    const title = hits?.title ? markHits(esc(hits.title)) : esc(i.title);
    const snippet = hits?.snippet ? markHits(esc(hits.snippet)) : esc(i.description);
    const S = encodeURIComponent(i.slug);
    const tags = i.tags ?? (i.category ? [i.category] : []);
    const chip = (t) => `<a class="tag" href="${base}?category=${encodeURIComponent(t)}">${esc(categoryLabel(t))}</a>`;
    const meta = i.example
      ? `example page · ${esc(i.slug)}`
      : `${esc(i.slug)} · ${esc(i.owner)} · v${i.latest_version} · ${day(i.updated_at)} · ${plural(i.views, 'view')}${i.visibility === 'private' ? ' · private' : ''}
    · <a href="/review/${S}">review</a> · <a href="/history/${S}">history</a>`;
    return `<article class="card${i.pinned ? ' pinned' : ''}" data-slug="${esc(i.slug)}">
  ${i.example ? '' : `<label class="pick"><input type="checkbox" value="${esc(i.slug)}" aria-label="Select ${esc(i.title)}"></label>`}
  <a class="thumb" href="${esc(i.url)}" tabindex="-1" aria-hidden="true"><iframe src="${esc(i.url)}?preview=1" loading="lazy"
    scrolling="no" title="" tabindex="-1"></iframe></a>
  <div class="head"><h2>${i.pinned ? PIN : ''}<a href="${esc(i.url)}">${title}</a></h2>
  ${tags.length ? `<span class="tags">${tags.slice(0, 3).map(chip).join('')}${tags.length > 3 ? `<span class="more">+${tags.length - 3}</span>` : ''}</span>` : ''}</div>
  ${snippet ? `<p class="desc">${snippet}</p>` : ''}
  <p class="meta">${meta}</p>
</article>`;
  }).join('\n');
}

/**
 * The results area: on your pages with no search, a "Featured" section of pinned
 * pages above "All pages"; otherwise one list. Also what live search swaps in.
 */
export function resultsBody(items, q, { base = '/' } = {}) {
  if (!items.length) return `<p class="empty">${q ? 'No matches.' : 'Nothing here yet.'}</p>`;
  const pinned = !q && base === '/' ? items.filter((i) => i.pinned) : [];
  if (!pinned.length) return `<div class="cards">${galleryCards(items, q, { base })}</div>`;
  return `<h2 class="section-title">${PIN}Featured</h2><div class="cards">${galleryCards(pinned, q, { base })}</div>
<h2 class="section-title">All pages</h2><div class="cards">${galleryCards(items.filter((i) => !i.pinned), q, { base })}</div>`;
}

export const VIEWS = ['grid', 'list'];

/** "18 pages · 2 featured", or "13 example pages": the line above the cards. */
function totalLabel(total, items, section) {
  if (section === 'gallery') return plural(total, 'example page');
  const featured = items.filter((i) => i.pinned).length;
  return `${plural(total, 'page')}${featured ? ` · ${featured} featured` : ''}`;
}

/**
 * A browsable set of pages: your pages at / ("pages"), or the bundled examples at
 * /gallery ("gallery"). Category chips, search, grid/list and previews.
 */
export function galleryPage(items, { q = '', category = '', categories = [], view = 'grid', section = 'pages', total = items.length }) {
  const base = section === 'gallery' ? '/gallery' : '/';
  // Links keep the other settings, so the page works fully without JS.
  const link = (over) => {
    const p = new URLSearchParams(Object.entries({ q, category, view, ...over }).filter(([k, v]) => v && !(k === 'view' && v === 'grid')));
    return `${base}${p.size ? `?${p}` : ''}`;
  };
  const chip = (value, label, count) => `<a class="chip${value === category ? ' on' : ''}" data-category="${esc(value)}"
    href="${esc(link({ category: value, q: '' }))}">${esc(label)}${count != null ? ` <span>${count}</span>` : ''}</a>`;
  const toggle = (v, label, icon) => `<a class="vt${v === view ? ' on' : ''}" data-view="${v}" href="${esc(link({ view: v }))}"
    aria-label="${label}" aria-pressed="${v === view}" title="${label}">${icon}</a>`;
  const grid = '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="1" y="1" width="6" height="6" rx="1.5"/><rect x="9" y="1" width="6" height="6" rx="1.5"/><rect x="1" y="9" width="6" height="6" rx="1.5"/><rect x="9" y="9" width="6" height="6" rx="1.5"/></svg>';
  const list = '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="1" y="2" width="14" height="2.5" rx="1.2"/><rect x="1" y="6.75" width="14" height="2.5" rx="1.2"/><rect x="1" y="11.5" width="14" height="2.5" rx="1.2"/></svg>';
  const intro = section === 'gallery'
    ? '<p class="intro">Example pages that ship with HTML Server: what single-file HTML can do, from explainers and diagrams to small tools. Open one, or use it as a starting point for your own.</p>'
    : '';
  return shell(section === 'gallery' ? 'Gallery · HTML Server' : 'HTML Server', `${siteNav(section)}<main class="wrap">
${intro}<form id="search" role="search" data-base="${base}"><input id="q" name="q" value="${esc(q)}" placeholder="${section === 'gallery' ? 'Search examples' : 'Search pages'}" autocomplete="off" autofocus>
${category ? `<input type="hidden" name="category" value="${esc(category)}">` : ''}
${view !== 'grid' ? `<input type="hidden" name="view" value="${esc(view)}">` : ''}</form>
<div class="bar2"><nav class="chips" aria-label="Categories">${chip('', 'All')}${categories.map((c) => chip(c.category, categoryLabel(c.category), c.count)).join('')}</nav>
<div class="tools">${section === 'pages' ? '<button type="button" id="select" class="select-btn">Select</button>' : ''}
<div class="views" role="group" aria-label="Layout">${toggle('grid', 'Grid view', grid)}${toggle('list', 'List view', list)}</div></div></div>
<p id="count" class="meta" data-total="${esc(totalLabel(total, items, section))}">${q ? plural(items.length, 'match') : esc(totalLabel(total, items, section))}</p>
<section id="results" class="${view}">${resultsBody(items, q, { base })}</section>
${section === 'pages' ? `<div id="bulk" class="bulk" hidden role="region" aria-label="Selected pages">
  <span id="bulk-count">0 selected</span>
  <input id="bulk-tag" placeholder="tag, e.g. trips" autocomplete="off" aria-label="Tag">
  <button type="button" data-act="add">Add tag</button><button type="button" data-act="remove">Remove tag</button>
  <button type="button" data-act="pin">Feature</button><button type="button" data-act="unpin">Unfeature</button>
  <button type="button" data-act="done" class="ghost">Done</button>
  <p id="bulk-msg" class="bulk-msg"></p>
</div>` : ''}</main>`, { scripts: ['gallery.js'] });
}

/**
 * Pages and the links between them, drawn by public/graph.js. The data is embedded
 * (it's the same as /api/graph), so the page draws without a second request.
 */
export function graphPage(data) {
  const cats = [...new Set(data.nodes.map((n) => n.category).filter(Boolean))].sort();
  const json = JSON.stringify({ ...data, labels: Object.fromEntries(cats.map((c) => [c, categoryLabel(c)])) })
    .replace(/</g, '\\u003c');
  const linked = new Set(data.edges.flatMap((e) => [e.source, e.target])).size;
  const focus = data.focus != null ? data.nodes.find((n) => n.id === data.focus) : null;
  const intro = focus
    ? `<p class="intro">Pages linked to or from <a href="${esc(focus.url)}">${esc(focus.title)}</a> (ringed).
<a href="/graph">See all pages</a> · <a href="/history/${encodeURIComponent(focus.slug)}">History</a></p>`
    : `<p class="intro">Your pages, and the links between them. A dot is a page, sized by how many links it has; a line is
a link from one page to another (<code>/pages/x</code>, <code>/x</code> or a relative <code>x.html</code>). Hover to see a
page's neighbours, click to open it, drag a dot or the background, scroll to zoom: labels appear as you zoom in.</p>`;
  return shell(focus ? `Graph: ${focus.title} · HTML Server` : 'Graph · HTML Server', `${siteNav('graph')}<main class="wrap graph-wrap">
${intro}
<p class="meta">${plural(data.nodes.length, 'page')} · ${plural(data.edges.length, 'link')} · ${plural(linked, 'page')} with links</p>
<div id="graph" class="graph" role="img" aria-label="Graph of pages and links"></div>
<div id="legend" class="legend"></div>
<script id="graph-data" type="application/json">${json}</script></main>`, { scripts: ['graph.js'] });
}

/** /stats: headline numbers, then views and uploads over time, top pages, tags, recent changes. */
export function statsPage(s) {
  const t = s.totals;
  const kb = (n) => (n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);
  const md = (d) => new Date(`${d}T12:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const when = (ts) => { const d = new Date(ts * 1000); return `${d.toLocaleDateString('en-CA')} ${d.toTimeString().slice(0, 5)}`; };
  const recent = s.recent.length ? `<ol class="activity">${s.recent.map((r) => `<li><a href="${esc(r.url)}">${esc(r.title)}</a>
  <span class="meta">v${r.n} · ${esc(r.author)} · ${esc(when(r.created_at))}${r.note ? ` · ${esc(r.note)}` : ''}</span></li>`).join('')}</ol>`
    : '<p class="empty">Nothing yet.</p>';
  return shell('Stats · HTML Server', `${siteNav('stats')}<main class="wrap stats">
<h1>Stats</h1>
<section class="tiles">
${tile(t.pages, 'pages', t.featured ? `${t.featured} featured` : '')}
${tile(t.versions, 'versions', `${(t.versions / Math.max(t.pages, 1)).toFixed(1)} per page`)}
${tile(t.views_recent, 'views, 30 days', `${plural(t.visitor_days_recent, 'visitor-day')}`)}
${tile(t.views, 'views, all time')}
${tile(t.tags, 'tags')}
${tile(t.comments, 'comments')}
${tile(t.authors, t.authors === 1 ? 'author' : 'authors')}
${tile(kb(t.bytes), 'of HTML', 'latest versions')}
</section>
<div class="charts">
${columnChart(s.views_by_day.map((d) => ({ label: d.day, short: md(d.day), value: d.views, tip: `${md(d.day)}: ${d.views} view${d.views === 1 ? '' : 's'}` })),
    { title: 'Views per day, last 30 days', unit: 'views' })}
${columnChart(s.uploads_by_week.map((w) => ({ label: `Week of ${w.week}`, short: md(w.week), value: w.versions,
    tip: `Week of ${md(w.week)}: ${w.versions} version${w.versions === 1 ? '' : 's'} uploaded` })),
    { title: 'Versions uploaded per week, last 12 weeks', unit: 'versions' })}
${barList(s.most_viewed.map((p) => ({ label: p.title, value: p.views, href: p.url })), { title: 'Most viewed', unit: 'views', empty: 'No views yet.' })}
${barList(s.most_edited.map((p) => ({ label: p.title, value: p.versions, href: p.url })), { title: 'Most edited', unit: 'versions', empty: 'No page has a second version yet.' })}
${barList(s.tags.slice(0, 12).map((x) => ({ label: categoryLabel(x.tag), value: x.count, href: `/?category=${encodeURIComponent(x.tag)}` })), { title: 'Pages per tag', unit: 'pages', empty: 'No tags yet.' })}
<figure class="chart"><figcaption>Recent uploads</figcaption>${recent}</figure>
</div>
<p class="meta">Counts cover the pages you can see. Views exclude previews, bots and command-line tools. Data as JSON: <a href="/api/stats">/api/stats</a>.</p>
<div id="tip" class="tip" role="tooltip" hidden></div>
</main>`, { scripts: ['stats.js'] });
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
  return shell(`History: ${a.title} · HTML Server`, `${siteNav()}<main class="wrap history">
<p class="meta"><a href="/pages/${S}">${esc(a.title)}</a> · <a href="/graph?page=${S}">Graph</a></p>
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
  return shell('Review', `<header class="bar"><h1><a href="/">HTML Server</a> / <span id="title"></span></h1>
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
  return shell('API · HTML Server', `${siteNav('api')}<main class="wrap docs"><h1>API</h1>
<p class="lead">The HTTP API of this server, running <a href="${RELEASE_URL}">HTML Server v${esc(VERSION)}</a>
(<a href="${RELEASE_URL}">release notes</a>). Source, changelog and every release:
<a href="${REPO_URL}">${esc(REPO_URL.replace('https://', ''))}</a>. Install the command-line client with
<code>npm install -g github:lawwu/html-server#v${esc(VERSION)}</code>.</p>
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
