import { encodePath } from './paths.js';
// Server-rendered pages: your pages at /, the example gallery at /gallery, history,
// the API docs, the review shell, and the side-by-side diff. Browser behaviour lives in public/*.js; shared styles in public/style.css.
import { MAX_BODY_BYTES, RELEASE_URL, REPO_URL, RESERVED_SLUGS, SEARCH_SORT, SORTS, VERSION } from './config.js';
import { fileBytes, fileText } from './files.js';
import { barList, columnChart, heroTile, sparkline, stackedColumnChart } from './charts.js';
import { HIT, escapeHtml as esc, groupedOpcodes, markHits } from './text.js';
import { renderMarkdown } from './markdown.js';
import { usage } from './usage.js';

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

// The docs site on GitHub Pages (scripts/build-site.js) is drawn by these same templates,
// with no server behind it. setStaticSite(true) leaves out what needs one: search, page
// versions, history and comments, the Pages, Graph and Stats sections, and the gallery's
// search, filters and layouts. The build makes the remaining links relative.
let STATIC_SITE = false;
export const setStaticSite = (on) => { STATIC_SITE = !!on; };

/** On every page the server draws itself (never on uploaded pages): which version is running, and where it lives. */
export const footer = () => `<footer class="site-foot"><a href="${RELEASE_URL}">HTML Server v${esc(VERSION)}</a>
  · <a href="${REPO_URL}">Source on GitHub</a> · <a href="/docs">Docs</a></footer>`;

// Light or dark: the viewer's choice if they made one, else the system's. The switch saves it
// in this site's storage and in a cookie; notes are sandboxed and can't read storage, so the
// server stamps the cookie's choice onto them (notePage's `theme`).
// Runs in <head> so the page never flashes the wrong theme.
export const THEME_HEAD = `<script>try{const t=localStorage.getItem('theme');if(t)document.documentElement.dataset.theme=t}catch{}</script>`;
const THEME_TOGGLE = `<script>document.querySelectorAll('[data-theme-toggle]').forEach((b)=>b.addEventListener('click',()=>{
const r=document.documentElement,dark=(r.dataset.theme||(matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'))==='dark';
r.dataset.theme=dark?'light':'dark';try{localStorage.setItem('theme',r.dataset.theme)}catch{}
try{document.cookie='theme='+r.dataset.theme+'; path=/; max-age=31536000; samesite=lax'}catch{}}));
if(matchMedia('(max-width: 800px)').matches)document.querySelectorAll('details.explorer').forEach((d)=>d.removeAttribute('open'));</script>`;

// Search (⌘K) and hover previews: inlined, since a sandboxed note may not load scripts.
// Modules, so each keeps its own scope.
const inlineScript = (f) => `<script type="module">${fileText(`public/${f}`).replace(/<\/script/gi, '<\\/script')}</script>`;
let SCRIPTS = null;
const inlined = () => (SCRIPTS ??= { search: inlineScript('search.js'), popover: inlineScript('popover.js'), graph: inlineScript('minigraph.js'),
  copy: inlineScript('copy.js') });

/** A page's source, carried in the page for its "copy source" button (public/copy.js). JSON, so any text survives. */
const sourceData = (text) => `<script id="page-source" type="application/json">${JSON.stringify(text).replace(/</g, '\\u003c')}</script>`;
const COPY_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>';
const copyButton = (label = 'Copy markdown') => `<button type="button" class="copy-source" data-copy-source="page-source">${COPY_ICON}<span>${label}</span></button>`;

/**
 * Every page the server draws itself, in Quartz's frame: the sidebar on the left
 * (from siteNav), the page in the middle, an optional sidebar on the right, the footer.
 * `frame: false` (the review page) is just the body.
 */
const shell = (title, body, { scripts = [], bodyAttrs = '', frame = true } = {}) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>${THEME_HEAD}<link rel="stylesheet" href="/_static/style.css"><link rel="stylesheet" href="/_static/note.css"></head>
<body ${bodyAttrs}>${frame ? `<div class="page">${body}${footer()}</div>` : body + footer()}${THEME_TOGGLE}${frame && !STATIC_SITE ? inlined().search : ''}${scripts.map((s) => `<script src="/_static/${s}" type="module"></script>`).join('')}</body></html>`;

const day = (t) => new Date(t * 1000).toLocaleDateString('en-CA');
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : w.endsWith('ch') ? 'es' : 's'}`;

// GitHub's mark (Octicons, MIT), linking to the release that's running.
const GITHUB_MARK = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>';

const ICONS = {
  search: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>',
  sun: '<svg class="sun" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4.5"/><path d="M12 2v2.5M12 19.5V22M2 12h2.5M19.5 12H22M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M4.9 19.1l1.8-1.8M17.3 6.7l1.8-1.8"/></svg>',
  moon: '<svg class="moon" viewBox="0 0 24 24" aria-hidden="true"><path d="M20.5 14.5A8.5 8.5 0 0 1 9.5 3.5a8.5 8.5 0 1 0 11 11z"/></svg>',
  chevron: '<svg class="chev" viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg>',
  expand: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 4h6v6M10 20H4v-6M20 4l-7 7M4 20l7-7"/></svg>',
};

/**
 * The left sidebar on every page the server draws, laid out like Quartz's: the site
 * title, search and the light/dark switch, the site's sections, then (on notes and the
 * home page) the explorer. Links use target="_top" so they work from a framed note too.
 */
export function siteNav(active, { explorer = null, current = null, search = !STATIC_SITE } = {}) {
  const item = (href, label, key) => `<li><a href="${href}" target="_top"${key === active ? ' class="on" aria-current="page"' : ''}>${label}</a></li>`;
  const live = STATIC_SITE ? '' : item('/', 'Pages', 'pages') + item('/graph', 'Graph', 'graph') + item('/stats', 'Stats', 'stats');
  const toggle = `<button type="button" class="icon-btn" data-theme-toggle aria-label="Switch light or dark">${ICONS.sun}${ICONS.moon}</button>`;
  return `<aside class="sidebar left">
<div class="side-top"><h2 class="page-title"><a href="/" target="_top">HTML Server</a></h2>
<a class="gh" href="${RELEASE_URL}" target="_top" title="HTML Server v${esc(VERSION)} on GitHub">${GITHUB_MARK}<span>v${esc(VERSION)}</span></a>${search ? '' : toggle}</div>
${search ? `<div class="side-row"><form class="side-search" action="/" method="get" target="_top" role="search">${ICONS.search}<input name="q" placeholder="Search" aria-label="Search pages (⌘K)" autocomplete="off"><kbd>⌘K</kbd></form>${toggle}</div>` : ''}
<nav class="side-nav" aria-label="Site"><ul>${live}${item('/gallery', 'Gallery', 'gallery')}${item('/docs', 'Docs', 'docs')}</ul></nav>
${explorer ? explorerNav(explorer, current) : ''}
</aside>`;
}

/**
 * Quartz's explorer: folders (from where synced notes live, see `path`) above loose
 * pages, each sorted by title; the folder holding the current page starts open. A
 * folder's index note is the folder's own link.
 */
export function explorerNav(items, current) {
  const root = { folders: new Map(), files: [], index: null };
  for (const it of items) {
    const parts = it.path ? it.path.split('/') : [it.slug];
    let node = root;
    for (const dir of parts.slice(0, -1)) {
      if (!node.folders.has(dir)) node.folders.set(dir, { folders: new Map(), files: [], index: null });
      node = node.folders.get(dir);
    }
    if (!it.slug.includes('/') && parts.length > 1 && /^index\.(md|markdown)$/i.test(parts.at(-1))) node.index = it;
    else node.files.push(it);
  }
  const holds = (node) => node.index?.slug === current || node.files.some((f) => f.slug === current) || [...node.folders.values()].some(holds);
  const link = (it, label) => `<a href="${esc(it.url)}" target="_top"${it.slug === current ? ' class="on" aria-current="page"' : ''}>${esc(label)}</a>`;
  const render = (node, prefix = '') => {
    const folders = [...node.folders].sort(([a], [b]) => a.localeCompare(b)).map(([name, f]) => `<li class="folder"><details${holds(f) ? ' open' : ''}>
<summary>${ICONS.chevron}${items.some((it) => it.slug.startsWith(`${prefix}${name}/`)) ? `<a href="/${encodePath(prefix + name)}/" target="_top">${esc(f.index?.title || name)}</a>` : f.index ? link(f.index, f.index.title || name) : `<span>${esc(name)}</span>`}</summary><ul>${render(f, prefix + name + '/')}</ul></details></li>`).join('');
    const files = node.files.slice().sort((a, b) => a.title.localeCompare(b.title)).map((f) => `<li>${link(f, f.title)}</li>`).join('');
    return folders + files;
  };
  return `<details class="explorer" open><summary><span>Explorer</span>${ICONS.chevron}</summary><ul class="tree">${render(root)}</ul></details>`;
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
    const chip = (t) => (STATIC_SITE ? `<span class="tag">${esc(categoryLabel(t))}</span>`
      : `<a class="tag" href="${base}?category=${encodeURIComponent(t)}">${esc(categoryLabel(t))}</a>`);
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
 * pages above "All pages"; otherwise one list. Also what live search swaps in. One
 * grid either way, its section titles spanning it, so live search can show, hide and
 * reorder the cards without moving them (a preview moved in the document reloads).
 */
export function resultsBody(items, q, { base = '/' } = {}) {
  if (!items.length) return `<p class="empty">${q ? 'No matches.' : 'Nothing here yet.'}</p>`;
  const pinned = !q && base === '/' ? items.filter((i) => i.pinned) : [];
  if (!pinned.length) return `<div class="cards">${galleryCards(items, q, { base })}</div>`;
  return `<div class="cards"><h2 class="section-title" data-section="featured">${PIN}Featured</h2>${galleryCards(pinned, q, { base })}
<h2 class="section-title" data-section="all">All pages</h2>${galleryCards(items.filter((i) => !i.pinned), q, { base })}</div>`;
}

export const VIEWS = ['grid', 'list'];

/** "18 pages · 2 featured", or "13 example pages": the line above the cards. */
function totalLabel(total, items, section) {
  if (section === 'gallery') return plural(total, 'example page');
  const featured = items.filter((i) => i.pinned).length;
  return `${plural(total, 'page')}${featured ? ` · ${featured} featured` : ''}`;
}

/**
 * The Sort menu on the home page: recently updated (the default), newest, most viewed,
 * title; while searching, best match comes first and is the default. Featured pages stay
 * on top whatever the order. A plain GET form, so it works without JS (public/gallery.js
 * re-sorts in place).
 */
function sortControl({ q, category, view, sort, base = '/', recursive = false }) {
  const current = sort || (q ? SEARCH_SORT : 'updated');
  const options = [[SEARCH_SORT, 'Best match'], ...Object.entries(SORTS)].map(([v, label]) => {
    const off = v === SEARCH_SORT && !q; // only while searching
    return `<option value="${v}"${v === current ? ' selected' : ''}${off ? ' hidden disabled' : ''}>${esc(label)}</option>`;
  }).join('');
  const keep = Object.entries({ q, category, recursive: recursive ? '1' : '', view: view === 'grid' ? '' : view }).filter(([, v]) => v)
    .map(([k, v]) => `<input type="hidden" name="${k}" value="${esc(v)}">`).join('');
  return `<form class="sort" method="get" action="${esc(base)}">${keep}<label><span>Sort</span><select id="sort" name="sort">${options}</select></label>`
    + '<noscript><button>Go</button></noscript></form>';
}

/**
 * A browsable set of pages: your pages at / ("pages"), or the bundled examples at
 * /gallery ("gallery"). Category chips, search, sorting (your pages), grid/list and previews.
 */
export function galleryPage(items, { q = '', category = '', categories = [], view = 'grid', section = 'pages', total = items.length,
  explorer = null, sort = '', base: customBase, folder = '', folders = [], recursive = false }) {
  const base = customBase || (section === 'gallery' ? '/gallery' : '/');
  // Links keep the other settings, so the page works fully without JS.
  const link = (over) => {
    const p = new URLSearchParams(Object.entries({ q, category, view, sort, recursive: recursive ? '1' : '', ...over }).filter(([k, v]) => v && !(k === 'view' && v === 'grid')));
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
  // Search, filters, sorting and layouts ask the server for the cards again.
  const controls = STATIC_SITE ? '' : `<form id="search" role="search" data-base="${base}"><input id="q" name="q" value="${esc(q)}" placeholder="${folder ? 'Search this folder' : section === 'gallery' ? 'Search examples' : 'Search pages'}" autocomplete="off" autofocus>
${recursive ? '<input type="hidden" name="recursive" value="1">' : ''}
${category ? `<input type="hidden" name="category" value="${esc(category)}">` : ''}
${view !== 'grid' ? `<input type="hidden" name="view" value="${esc(view)}">` : ''}
${sort ? `<input type="hidden" name="sort" value="${esc(sort)}">` : ''}</form>
<div class="bar2"><nav class="chips" aria-label="Categories">${chip('', 'All')}${categories.map((c) => chip(c.category, categoryLabel(c.category), c.count)).join('')}</nav>
<div class="tools">${section === 'pages' ? sortControl({ q, category, view, sort, base, recursive }) + '<button type="button" id="select" class="select-btn">Select</button>' : ''}
<div class="views" role="group" aria-label="Layout">${toggle('grid', 'Grid view', grid)}${toggle('list', 'List view', list)}</div></div></div>`;
  return shell(folder ? `${folder} · HTML Server` : section === 'gallery' ? 'Gallery · HTML Server' : 'HTML Server', `${siteNav(section, { explorer, search: false })}<main class="wrap">
${folder ? `<nav class="breadcrumbs" aria-label="Breadcrumbs">${crumbs(folder + '/_', folder.split('/').at(-1), explorer || [], true)}</nav><h1>${esc(folder.split('/').at(-1))}</h1>
${folders.length ? `<nav class="folder-list" aria-label="Subfolders">${folders.map((f) => `<a href="/${encodePath(f.path)}/">▸ ${esc(f.name)}</a>`).join('')}</nav>` : ''}
<p><a href="${esc(link({ recursive: recursive ? '' : '1' }))}">${recursive ? 'Show direct contents' : 'Include subfolders'}</a>${q ? ' · Search includes subfolders' : ''}</p>` : ''}
${intro}${controls}
<p id="count" class="meta" data-total="${esc(totalLabel(total, items, section))}">${q ? plural(items.length, 'match') : esc(totalLabel(total, items, section))}</p>
<section id="results" class="${view}">${resultsBody(items, q, { base })}</section>
${section === 'pages' ? `<div id="bulk" class="bulk" hidden role="region" aria-label="Selected pages">
  <span id="bulk-count">0 selected</span>
  <input id="bulk-tag" placeholder="tag, e.g. trips" autocomplete="off" aria-label="Tag">
  <button type="button" data-act="add">Add tag</button><button type="button" data-act="remove">Remove tag</button>
  <button type="button" data-act="pin">Feature</button><button type="button" data-act="unpin">Unfeature</button>
  <button type="button" data-act="move">Move…</button>
  <button type="button" data-act="done" class="ghost">Done</button>
  <p id="bulk-msg" class="bulk-msg"></p>
</div>` : ''}</main>`, { scripts: STATIC_SITE ? [] : ['gallery.js'] });
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
a link from one page to another (<code>/pages/x</code>, <code>/x</code> or a relative <code>x.html</code>); a small ring is a
tag, joined to the pages that carry it. Hover to see a node's neighbours, click to open it, drag dots or the background,
scroll to zoom.</p>`;
  return shell(focus ? `Graph: ${focus.title} · HTML Server` : 'Graph · HTML Server', `${siteNav('graph')}<main class="wrap graph-wrap">
${intro}
<p class="meta">${plural(data.nodes.length, 'page')} · ${plural(data.edges.length, 'link')} · ${plural(linked, 'page')} with links</p>
<div id="graph-frame" class="graph-frame"><div id="graph-tools" class="graph-tools"></div>
<div id="graph" class="graph" role="img" aria-label="Graph of pages, tags and links"></div></div>
<div id="legend" class="legend"></div>
<script id="graph-data" type="application/json">${json}</script></main>`, { scripts: ['graph.js'] });
}

/** /stats: headline numbers, then views and uploads over time, top pages, tags, recent changes; for admins, API usage. */
export function statsPage(s) {
  const t = s.totals;
  const kb = (n) => (n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);
  const md = (d) => new Date(`${d}T12:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const ago = (ts) => {
    const m = Math.round((Date.now() / 1000 - ts) / 60);
    return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago`
      : new Date(ts * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  };
  const change = (now, before) => (before ? Math.round(((now - before) / before) * 100) : null);
  const viewsTotal = s.views_by_day.reduce((n, d) => n + d.views, 0);
  const uploadsTotal = s.uploads_by_week.reduce((n, w) => n + w.versions, 0);
  const recent = s.recent.length ? `<ol class="timeline">${s.recent.map((r) => `<li><span class="when">${esc(ago(r.created_at))}</span>
  <a href="${esc(r.url)}">${esc(r.title)}</a><span class="meta">v${r.n} · ${esc(r.author)}${r.note ? ` · ${esc(r.note)}` : ''}</span></li>`).join('')}</ol>`
    : '<p class="empty">Nothing yet.</p>';
  const minor = [[t.tags, 'tags'], [t.comments, 'comments'], [t.authors, t.authors === 1 ? 'author' : 'authors'], [kb(t.bytes), 'of pages']];
  return shell('Stats · HTML Server', `${siteNav('stats')}<main class="wrap stats">
<header class="stats-head"><h1>Stats</h1>
<p class="lede">Across the ${plural(t.pages, 'page')} you can see${t.featured ? `, ${t.featured} featured` : ''}. Views leave out previews, bots and command-line tools.</p></header>
<section class="hero" aria-label="Headline numbers">
${heroTile(t.views_recent, 'Views, last 30 days', { delta: change(t.views_recent, t.views_previous),
    spark: sparkline(s.views_by_day.map((d) => d.views), { label: 'Views per day, last 30 days' }) })}
${heroTile(t.pages, 'Pages', { sub: t.featured ? `${t.featured} featured` : 'none featured yet' })}
${heroTile(t.versions, 'Versions', { sub: `${(t.versions / Math.max(t.pages, 1)).toFixed(1)} per page` })}
${heroTile(t.visitor_days_recent, 'Visitor-days, 30 days', { sub: `${fmtNum(t.views)} views all time` })}
</section>
<ul class="minor" aria-label="More counts">${minor.map(([v, l]) => `<li><b>${typeof v === 'number' ? fmtNum(v) : esc(v)}</b> ${esc(l)}</li>`).join('')}</ul>

<h2 class="section-label">Activity</h2>
<div class="charts two-one">
${columnChart(s.views_by_day.map((d) => ({ label: d.day, short: md(d.day), value: d.views, tip: `${md(d.day)}: ${d.views} view${d.views === 1 ? '' : 's'}` })),
    { title: 'Views per day', unit: 'views', headline: `${fmtNum(viewsTotal)} in 30 days`, caption: 'Views per day, last 30 days' })}
${columnChart(s.uploads_by_week.map((w) => ({ label: `Week of ${w.week}`, short: md(w.week), value: w.versions,
    tip: `Week of ${md(w.week)}: ${w.versions} version${w.versions === 1 ? '' : 's'} uploaded` })),
    { title: 'Uploads per week', unit: 'versions', headline: `${fmtNum(uploadsTotal)} in 12 weeks`, caption: 'Versions uploaded per week, last 12 weeks', width: 300, height: 196 })}
</div>

<h2 class="section-label">Pages</h2>
<div class="charts three">
${barList(s.most_viewed.map((p) => ({ label: p.title, value: p.views, href: p.url })), { title: 'Most viewed', unit: 'views', empty: 'No views yet.' })}
${barList(s.most_edited.map((p) => ({ label: p.title, value: p.versions, href: p.url })), { title: 'Most edited', unit: 'versions', empty: 'No page has a second version yet.' })}
${barList(s.tags.slice(0, 10).map((x) => ({ label: categoryLabel(x.tag), value: x.count, href: `/?category=${encodeURIComponent(x.tag)}` })), { title: 'Pages per tag', unit: 'pages', empty: 'No tags yet.' })}
</div>
<figure class="chart recent"><figcaption><span>Recent uploads</span></figcaption>${recent}</figure>

<section id="usage" class="usage-slot" aria-labelledby="usage-title">
<h2 class="section-label" id="usage-title">API &amp; MCP usage <span class="badge">Admins</span></h2>
<div id="usage-body"><p class="meta">Who's calling the API: MCP tools, the CLI, browsers and scripts. Only admins see this.</p>
<form id="usage-signin" class="usage-signin" hidden><label>Admin token <input id="usage-token" type="password" autocomplete="off" placeholder="ak_…"></label>
<button>Show usage</button> <span id="usage-msg" class="meta"></span></form></div>
</section>

<p class="meta foot-note">Data as JSON: <a href="/api/stats">/api/stats</a> · API usage, for admins: <a href="/api/stats/usage">/api/stats/usage</a>.</p>
<div id="tip" class="tip" role="tooltip" hidden></div>
</main>`, { scripts: ['stats.js'] });
}

const fmtNum = (n) => Number(n || 0).toLocaleString('en-US');
const USAGE_SERIES = [{ key: 'mcp', label: 'MCP' }, { key: 'cli', label: 'CLI' }, { key: 'browser', label: 'Browser' }, { key: 'http', label: 'Other HTTP' }];

/**
 * The API usage section of /stats, for admins (loaded by public/stats.js with the
 * saved token): calls by kind of client, per day, the most used MCP tools and CLI
 * commands, and the busiest routes with their errors.
 */
const USAGE_RANGES = [[30, '30 days'], [90, '90 days'], [365, '1 year'], ['all', 'All time']];

export function usageSection(u) {
  const t = u.totals;
  const range = u.days == null ? 'all time' : u.days === 365 ? 'the last year' : `the last ${u.days} days`;
  const md = (d) => new Date(`${d}T12:00`).toLocaleDateString('en-US', u.unit === 'month' ? { month: 'short', year: 'numeric' } : { month: 'short', day: 'numeric' });
  const periodName = (p) => (u.unit === 'day' ? md(p) : u.unit === 'week' ? `Week of ${md(p)}` : md(p));
  const share = (n) => (t.calls ? `${Math.round((n / t.calls) * 100)}% of calls` : '');
  const totals = u.series.map((d) => USAGE_SERIES.reduce((n, s) => n + d[s.key], 0));
  const picker = `<nav class="range-picker" aria-label="Period">${USAGE_RANGES.map(([v, label]) => {
    const on = (u.days ?? 'all') === v;
    return `<a href="?days=${v}#usage" data-days="${v}"${on ? ' class="on" aria-current="true"' : ''}>${label}</a>`;
  }).join('')}</nav>`;
  const routes = u.routes.length ? `<div class="scroll"><table class="routes-table"><thead><tr><th>Route</th><th class="num">Calls</th><th class="num">Errors</th></tr></thead>
<tbody>${u.routes.map((r) => `<tr><td><code>${esc(r.method)} ${esc(r.route)}</code></td><td class="num">${fmtNum(r.calls)}</td>`
    + `<td class="num">${r.errors ? `<span class="err-count">${fmtNum(r.errors)}</span>` : '0'}</td></tr>`).join('')}</tbody></table></div>`
    : '<p class="empty">No API calls yet.</p>';
  return `${picker}<section class="hero" aria-label="API usage numbers">
${heroTile(t.calls, u.days == null ? 'API calls, all time' : `API calls, ${USAGE_RANGES.find(([v]) => v === u.days)?.[1] ?? `${u.days} days`}`,
    { sub: `${plural(t.users, 'signed-in user')}${u.days == null || u.days > u.retention_days ? ` in the last ${u.retention_days} days` : ''}`,
      spark: sparkline(totals, { label: `API calls per ${u.unit}` }) })}
${heroTile(t.mcp, 'MCP tool calls', { sub: share(t.mcp) })}
${heroTile(t.cli, 'CLI calls', { sub: share(t.cli) })}
${heroTile(t.calls ? `${((t.errors / t.calls) * 100).toFixed(1)}%` : '0%', 'Errors (4xx/5xx)', { sub: `${fmtNum(t.errors)} calls${t.server_errors ? `, ${fmtNum(t.server_errors)} server errors` : ''}` })}
</section>
<div class="charts">
${stackedColumnChart(u.series.map((d) => ({ label: periodName(d.period), short: md(d.period), values: d })), USAGE_SERIES,
    { title: `API calls per ${u.unit}, by client`, unit: 'calls', headline: `${fmtNum(t.calls)} in ${range}`, caption: `API calls per ${u.unit}, ${range}, by client` })}
</div>
<div class="charts">
${barList(u.mcp_tools.map((r) => ({ label: r.name, value: r.calls })), { title: 'Most used MCP tools', unit: 'calls', empty: 'No MCP calls yet.' })}
${barList(u.cli_commands.map((r) => ({ label: r.name, value: r.calls })), { title: 'Most used CLI commands', unit: 'calls', empty: 'No CLI calls yet.' })}
</div>
<figure class="chart"><figcaption><span>Busiest routes</span><b>errors are 4xx/5xx answers</b></figcaption>${routes}</figure>
<p class="meta">Every <code>/api</code> request: who called (the MCP tool or CLI command; browsers and other HTTP clients by kind), the route's pattern and the status, never query strings, request bodies or tokens. Each request's details are kept ${u.retention_days} days, then folded into daily totals that are kept for good. MCP calls that fail on your machine before reaching the server aren't counted.</p>`;
}

// Notes are served sandboxed (like every page), and a sandboxed page may not be allowed
// to load stylesheets or fonts, so the site's styles are inlined into each note, with the
// main typefaces as data: URIs (the rarer italic and mono bold keep their URLs). Read once;
// responses are gzipped, which takes back most of the base64.
const INLINE_FONTS = new Set(['schibsted-grotesk.woff2', 'source-sans-3.woff2', 'ibm-plex-mono-400.woff2']);
let NOTE_CSS = null;
const noteCss = () => (NOTE_CSS ??= ['style.css', 'note.css']
  .map((f) => fileText(`public/${f}`)).join('\n')
  .replace(/url\(\/_static\/fonts\/([\w.-]+)\)/g, (m, f) => (INLINE_FONTS.has(f)
    ? `url(data:font/woff2;base64,${fileBytes(`public/fonts/${f}`).toString('base64')})` : m))
  .replace(/<\/style/gi, '<\\/style'));

/**
 * A Markdown note as a page of the site, laid out like a Quartz page: the sidebar and
 * explorer on the left; breadcrumbs, title, date, reading time and tags above the note;
 * on the right a local graph, the contents and backlinks. Notes are served sandboxed
 * (like every page), and a sandboxed page may not load stylesheets, so the site's
 * styles are inlined. `chrome: false` (gallery-card previews) is just the note. Links
 * that leave the note use target="_top", so they work inside the review page's frame too.
 */
export function notePage({ slug, title, tags = [], html, backlinks = [], updated, version, latest, description, chrome = true,
  explorer = [], path = '', graph = null, theme = null, previews = {}, source = null, copyLabel, extra = '' }) {
  const S = encodePath(slug);
  const day = updated ? new Date(updated * 1000).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' }) : '';
  const words = html.replace(/<[^>]+>/g, ' ').split(/\s+/).filter(Boolean).length;
  const top = (s) => s.replace(/<a (?![^>]*target=)/g, '<a target="_top" '); // site links break out of any frame
  const versions = STATIC_SITE ? '' : `
  · v${version}${latest && version < latest ? ` of ${latest}` : ''} · <a href="/history/${S}" target="_top">history</a> · <a href="/review/${S}" target="_top">comments</a>`;
  const tag = (t) => (STATIC_SITE ? `<span class="tag-link">${esc(t)}</span>` : `<a class="tag-link" href="/?category=${encodeURIComponent(t)}" target="_top">${esc(t)}</a>`);
  const head = `<nav class="breadcrumbs" aria-label="Breadcrumbs">${crumbs(path, title, explorer)}</nav>
<h1 class="article-title">${esc(title)}</h1>
<p class="content-meta">${day ? `${esc(day)}, ` : ''}${Math.max(1, Math.round(words / 200))} min read${extra ? ` · ${esc(extra)}` : ''}${versions}</p>
${source != null ? `<p class="page-actions">${copyButton(copyLabel)} ${STATIC_SITE ? '' : `<a href="/review/${S}?move=1" target="_top">Move…</a>`}</p>` : ''}
${tags.length ? `<ul class="note-tags">${tags.map((t) => `<li>${tag(t)}</li>`).join('')}</ul>` : ''}`;
  const toc = [...html.matchAll(/<h([23]) id="([^"]+)">([\s\S]*?)<\/h\1>/g)]
    .map(([, d, id, inner]) => `<li class="d${d}"><a href="#${esc(id)}">${inner.replace(/<[^>]+>/g, '')}</a></li>`);
  const right = `<aside class="sidebar right">
${graph ? localGraph(graph, slug) : ''}
${toc.length > 1 ? `<details class="toc" open><summary><h3>Table of Contents</h3>${ICONS.chevron}</summary><ul>${toc.join('')}</ul></details>` : ''}
${backlinksSection(backlinks)}
</aside>`;
  const main = `<main class="center note">${chrome ? head : `<h1 class="article-title">${esc(title)}</h1>`}<article class="content">${html}</article></main>`;
  return `<!doctype html><html lang="en"${theme === 'dark' || theme === 'light' ? ` data-theme="${theme}"` : ''}><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · HTML Server</title>${description ? `<meta name="description" content="${esc(description)}">` : ''}
${THEME_HEAD}<style>${noteCss()}</style></head>
<body class="note-body">${chrome ? `<div class="page">${siteNav('pages', { explorer, current: slug })}${main}${right}${top(footer())}</div>${THEME_TOGGLE}
${previewData(previews)}${source != null ? sourceData(source) + inlined().copy : ''}${STATIC_SITE ? '' : inlined().search}${inlined().popover}` : main}</body></html>`;
}

const backlinksSection = (backlinks) => `<section class="backlinks"><h3>Backlinks</h3>${backlinks.length
  ? `<ul>${backlinks.map((b) => `<li><a href="${esc(b.url)}" target="_top">${esc(b.title)}</a></li>`).join('')}</ul>`
  : '<p class="none">No backlinks found</p>'}</section>`;

const previewData = (previews) => `<script id="page-previews" type="application/json">${JSON.stringify(previews).replace(/</g, '\\u003c')}</script>`;

/**
 * An HTML page in the site's frame (what a browser tab gets at /pages/<name>.html): the
 * sidebar, a title bar with the page's tags and links, then the page itself in an iframe,
 * sized to the window so its own scrolling, sticky headers and full-height layouts work.
 * Below it, its local graph and backlinks. ?raw=1 is the page alone.
 */
export function htmlFramePage({ page, n, backlinks, explorer, graph, previews = {} }) {
  const S = encodePath(page.slug);
  const old = n !== page.latest_version;
  const src = `/pages/${S}${old ? `?v=${n}` : ''}`;
  const embed = `/pages/${S}?${old ? `v=${n}&` : ''}embed=1`;
  const day = new Date(page.updated_at * 1000).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
  return shell(`${page.title} · HTML Server`, `${siteNav('pages', { explorer, current: page.slug })}<main class="center framed">
<header class="frame-head"><div class="frame-title">
<nav class="breadcrumbs" aria-label="Breadcrumbs">${crumbs(page.slug, page.title, explorer)}</nav>
<h1 class="article-title">${esc(page.title)}</h1>
<p class="content-meta">${old ? '' : `${esc(day)} · `}v${n}${old ? ` of ${page.latest_version}` : ''} · ${plural(page.views ?? 0, 'view')}
  · <a href="/history/${S}">history</a> · <a href="/review/${S}${old ? `?v=${n}` : ''}">comments</a>
  · <a href="${src}${old ? '&amp;' : '?'}raw=1">full page ↗</a></p>
<p class="page-actions"><button type="button" class="copy-source" data-src="/api/artifacts/${S}/versions/${n}">${COPY_ICON}<span>Copy HTML</span></button> <a href="/review/${S}?move=1">Move…</a></p>
</div>${page.tags.length ? `<ul class="note-tags">${page.tags.map((t) => `<li><a class="tag-link" href="/?category=${encodeURIComponent(t)}">${esc(t)}</a></li>`).join('')}</ul>` : ''}</header>
<iframe class="page-frame auto" src="${esc(embed)}" title="${esc(page.title)}"></iframe>
<div class="frame-foot">${graph ? localGraph(graph, page.slug) : ''}${backlinksSection(backlinks)}</div>
</main>${previewData(previews)}${inlined().popover}${inlined().copy}${FRAME_SIZE}`);
}

// The frame's half of the sizing (the page's half is public/embed-size.js): with native
// responsive iframes the browser sizes it; otherwise take the height the page reports.
// Either way, a page that asks for window height gets it.
const FRAME_SIZE = `<script>(()=>{const f=document.querySelector('.page-frame');if(!f)return;
const native=CSS.supports('frame-sizing','content-height');
addEventListener('message',(e)=>{if(e.source!==f.contentWindow||e.data?.htmlServer!=='size')return;
if(e.data.mode==='window'){f.classList.remove('auto');f.style.height='';return}
if(!native&&f.classList.contains('auto')&&e.data.height>=40)f.style.height=Math.min(e.data.height,100000)+'px'})})()</script>`;

/** Home › folder › note, from where the note lives; a folder with an index note links to it. */
function crumbs(path, title, explorer, folderPage = false) {
  const parts = path ? path.split('/').slice(0, -1) : [];
  const isIndex = /(^|\/)index\.(md|markdown)$/i.test(path);
  const byPath = new Map(explorer.map((e) => [e.path.toLowerCase(), e]));
  const out = ['<a href="/" target="_top">Home</a>'];
  parts.forEach((dir, i) => {
    if ((isIndex || folderPage) && i === parts.length - 1) return; // a folder's own index note: the folder is the page itself
    const idx = byPath.get(`${parts.slice(0, i + 1).join('/')}/index.md`.toLowerCase());
    const dirPath = parts.slice(0, i + 1).join('/');
    if (explorer.some((e) => e.slug.startsWith(dirPath + '/'))) { out.push(`<a href="/${encodePath(dirPath)}/" target="_top">${esc(dir)}</a>`); return; }
    out.push(idx ? `<a href="${esc(idx.url)}" target="_top">${esc(idx.title)}</a>` : `<span>${esc(dir)}</span>`);
  });
  out.push(`<span aria-current="page">${esc(title)}</span>`);
  return out.join('<span class="sep" aria-hidden="true">❯</span>');
}

/**
 * The "Graph View" box: this page and the pages linked to or from it. Drawn here as a
 * static picture, which public/minigraph.js (inlined, with the site's graph as data)
 * turns into Quartz's live local graph, and whose expand button opens the global one.
 */
export function localGraph(data, slug) {
  const W = 280, H = 190, cx = W / 2, cy = H / 2;
  const me = data.nodes.find((n) => n.slug === slug);
  if (!me) return '';
  const near = new Set(data.edges.flatMap((e) => (e.source === me.id ? [e.target] : e.target === me.id ? [e.source] : [])));
  const others = data.nodes.filter((n) => near.has(n.id)).sort((a, b) => a.title.localeCompare(b.title)).slice(0, 30);
  const pos = new Map([[me.id, [cx, cy]]]);
  // One ring, or two when crowded (alternating, so neighbours' labels don't collide).
  const two = others.length > 10;
  others.forEach((n, i) => {
    const a = (i / others.length) * Math.PI * 2 - Math.PI / 2;
    const r = two ? (i % 2 ? 78 : 50) : 62;
    pos.set(n.id, [cx + Math.cos(a) * r * 1.35, cy + Math.sin(a) * r]);
  });
  const edges = data.edges.filter((e) => pos.has(e.source) && pos.has(e.target)).map((e) => {
    const [x1, y1] = pos.get(e.source), [x2, y2] = pos.get(e.target);
    return `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}"/>`;
  }).join('');
  const short = (t) => (t.length > 22 ? `${t.slice(0, 21)}…` : t);
  const node = (n) => {
    const [x, y] = pos.get(n.id);
    return `<a href="${esc(n.url)}" target="_top" class="${n === me ? 'me' : ''}"><title>${esc(n.title)}</title>
<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${n === me ? 5.5 : 4}"/><text x="${x.toFixed(1)}" y="${(y + 13).toFixed(1)}">${esc(short(n.title))}</text></a>`;
  };
  // The full graph is a page of the server's (the overlay the button opens links to it too).
  const expand = STATIC_SITE ? '' : `<a class="graph-expand" href="/graph?page=${encodeURIComponent(slug)}" target="_top" aria-label="Open the full graph" title="Open the full graph">${ICONS.expand}</a>`;
  return `<section class="graph-view"><h3>Graph View</h3><div class="graph-box${two ? ' crowded' : ''}">
${expand}
<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Pages linked to or from this one"><g class="edges">${edges}</g><g class="nodes">${others.map(node).join('')}${node(me)}</g></svg>
</div></section>
<script id="site-graph" type="application/json">${JSON.stringify({ current: me.id, nodes: data.nodes.map((n) => [n.id, n.title, n.url]),
    edges: data.edges.map((e) => [e.source, e.target]) }).replace(/</g, '\\u003c')}</script>${inlined().graph}`;
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
<tbody>${rows}</tbody></table></div>${a.moves?.length ? `<h2>Moves</h2><ul>${a.moves.map((m) => `<li>${esc(when(m.created_at))}: ${esc(m.old_path)} → ${esc(m.new_path)}</li>`).join('')}</ul>` : ''}</main>`);
}

export function reviewPage(slug) {
  return shell('Review', `<header class="bar"><h1><a href="/">HTML Server</a> / <span id="title"></span></h1>
<select id="ver" aria-label="Version"></select>
<button id="move-page" hidden>Move…</button>
<button id="changes">Show changes</button><button id="restore" hidden>Make this version current</button>
<a id="open" target="_blank">Open page</a> <a id="hist">History</a> <a id="jump" href="#comments">Comments</a></header>
<div class="review"><div id="frame-slot"><iframe id="frame" title="Page"></iframe></div><aside id="comments">
<h2 id="ctitle">Comments</h2><p id="who" class="meta"></p>
<details id="signin"><summary>Sign in to comment</summary>
<p class="meta">Paste your token (ask the admin for one). It is saved in this browser only.</p>
<input id="tok" type="password" autocomplete="off"> <p><button id="save">Save</button></p></details>
<form id="new"><textarea id="body" placeholder="Comment on this version"></textarea>
<p><button>Post</button> <span id="err" class="err"></span></p></form>
<div id="list"></div></aside></div>`, { scripts: ['review.js'], bodyAttrs: `data-slug="${esc(slug)}"`, frame: false });
}

/** Side-by-side changes. Served sandboxed (it shows page content), so styles are inline. */
/** `back`: when opened full-page from History (not framed in the review page), link back to it. */
export function diffPage(fromN, toN, a, b, { back } = {}) {
  let groups, tooMany = null;
  try { groups = groupedOpcodes(a, b); } catch (e) {
    if (e.status !== 422) throw e;
    [groups, tooMany] = [[], e.message]; // versions too far apart: say so in place of the table
  }
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
    : `<p class="same">${tooMany ? `${esc(tooMany[0].toUpperCase() + tooMany.slice(1))}.` : `No differences between v${fromN} and v${toN}.`}</p>`;
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

/**
 * The docs, as Markdown: how to use HTML Server from the command line, from AI apps over
 * MCP, and over HTTP. Built from the same sources the code uses (the CLI's usage text,
 * the MCP tools, the ROUTES table), so it can't drift. Served as is at /docs.md (for
 * agents, and for anyone who wants the source) and rendered at /docs (and /api).
 */
export function docsMarkdown(base, routes, { tools = [] } = {}) {
  const display = (pattern) => pattern.replace(/\(\?<(\w+)>[^)]*\)/g, '<$1>').replace(/\/\?/g, '/').replace(/\(\?:|\)\?/g, '') || '/';
  const cell = (t) => t.replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const rows = routes.filter((r) => r.doc).map((r) => `| ${r.method} | \`${display(r.path)}\` | ${cell(r.who)} | ${cell(r.doc)} |`).join('\n');
  const cli = usage({ backupDir: '~/.html-server/backups', homeDir: '~/.html-server' }).split('\n').slice(2).join('\n');
  const toolRows = tools.map((t) => `| \`${t.name}\` | ${cell(t.title || '')} | ${cell(t.description.split(/(?<=\.)\s/)[0])} |`).join('\n');
  return `# Docs

[HTML Server v${VERSION}](${RELEASE_URL}) hosts, versions, searches and links HTML pages and Markdown notes.
There are three ways in: the **command line**, **AI apps over MCP**, and the **HTTP API**. Source, changelog
and every release: [${REPO_URL.replace('https://', '')}](${REPO_URL}). This page is Markdown: [/docs.md](/docs.md).

## Command line

Install it, sign in once, and publish:

\`\`\`sh
npm install -g github:lawwu/html-server#v${VERSION}
html-server login --url ${base}      # asks for your token, checks it, saves it
html-server put trip-plan.html "first draft"
\`\`\`

Every command (\`html-server help COMMAND\` shows one):

\`\`\`text
${cli}
\`\`\`

## MCP: Claude and other AI apps

\`html-server mcp\` runs HTML Server as an MCP server, so Claude Code, Claude Desktop, Cursor and other MCP
clients can publish and manage pages. The app starts it; it uses the server and token the CLI is signed in to.

\`\`\`sh
claude mcp add html-server -- html-server mcp
\`\`\`

Other apps take the same command in their MCP settings:

\`\`\`json
{ "mcpServers": { "html-server": { "command": "html-server", "args": ["mcp"] } } }
\`\`\`

**Pages published over MCP are private** unless the call says \`public: true\`, so a model can't put something
in the public gallery by accident.

| Tool | | What it does |
| --- | --- | --- |
${toolRows}

## HTTP API

### Quickstart

\`\`\`sh
A=${base}
H="Authorization: Bearer $HTML_SERVER_TOKEN"

# upload, or add a version (the URL must end in / so curl appends the file name)
curl -T trip-plan.html -H "$H" -H "X-Note: first draft" $A/api/artifacts/

# a Markdown note works the same way
curl -T weekly-review.md -H "$H" $A/api/artifacts/

# view it, search, trash, then delete for good
open $A/pages/trip-plan
curl "$A/api/search?q=shelling"
curl -X DELETE -H "$H" $A/api/artifacts/trip-plan.html
curl -X DELETE -H "$H" "$A/api/artifacts/trip-plan.html?purge=1"
\`\`\`

### Rules

- **Folders:** publish with \`--folder research\` or \`--name research/report.html\`. Nested URLs open at \`/research/report.html\`; \`/research/\` lists the folder. Use \`mv FROM TO\` or **Move…** to organize pages without losing versions or old links. Use \`sync DIR --migrate-paths\` to migrate old flat sync addresses explicitly.
- **The URL is the file name:** \`trip-plan.html\` is served at \`/pages/trip-plan.html\`, and \`/pages/trip-plan\`
  works too. Names are shared across the whole server: the first user to upload a name owns it.
- **HTML pages, Markdown notes and notebooks:** a \`.md\` upload is a note, rendered in the site's layout, with
  \`[[wikilinks]]\`, frontmatter tags and backlinks; an \`.ipynb\` is a Jupyter notebook, shown with its saved
  outputs. Images and PDFs that notes embed are assets (\`/api/assets\`).
- **Everything is public** unless uploaded with \`X-Visibility: private\`. **anyone\*** below means anyone for
  public pages, and only the owner (by token) for private or trashed ones.
- **In a browser tab** an HTML page sits in the site's frame (sidebar, title bar, graph, backlinks), sized to
  the page. Iframes, curl and other clients get the page itself, as does \`?raw=1\`.
- **Gallery:** a page's \`<meta name="description">\` and \`<meta name="category">\` become its card text and
  category on [the home page](/).
- **Editing:** by default only a page's owner adds versions. On a server with open editing
  (\`html-server config editing open\`), anyone signed in can add or restore versions of public pages; only the
  owner trashes, deletes or changes visibility. Every version records who uploaded it, and \`?base=n\` refuses an
  upload if the page has moved past version n. Each page's versions are listed at \`/history/<name>\`.
- **Lifecycle:** active → trashed → purged, or trashed → active again. A trashed page can't take new versions,
  and only trashed pages can be purged; anything else returns 409 with the allowed actions.
- **Pages run in a sandbox:** their JavaScript works, but it can't use browser storage or call this API. Links
  they open in a new tab load as ordinary tabs. \`html-server serve --sandbox-allow PERMISSION\` adds permissions.
- **Errors** are JSON: \`{"error": "..."}\`. Max ${+(MAX_BODY_BYTES / (1024 * 1024)).toFixed(1)} MB per upload. Reserved
  names: ${[...RESERVED_SLUGS].sort().map((x) => `\`${x}\``).join(', ')}.

### Endpoints

| Method | Path | Who | What |
| --- | --- | --- | --- |
${rows}
`;
}

/**
 * A Markdown document the server itself publishes (the API docs), in the site's note
 * layout: the sidebar, the document, its contents on the right, and a copy-source button.
 */
export function markdownPage({ title, md, active, sourceUrl }) {
  const html = renderMarkdown(md, { title });
  const toc = [...html.matchAll(/<h([23]) id="([^"]+)">([\s\S]*?)<\/h\1>/g)]
    .map(([, d, id, inner]) => `<li class="d${d}"><a href="#${esc(id)}">${inner.replace(/<[^>]+>/g, '')}</a></li>`);
  return shell(`${title} · HTML Server`, `${siteNav(active)}<main class="center note doc">
<h1 class="article-title">${esc(title)}</h1>
<p class="content-meta">HTML Server v${esc(VERSION)} · <a href="${esc(sourceUrl)}">Markdown</a></p>
<p class="page-actions">${copyButton()}</p>
<article class="content">${html}</article></main>
<aside class="sidebar right">${toc.length > 1 ? `<details class="toc" open><summary><h3>Table of Contents</h3>${ICONS.chevron}</summary><ul>${toc.join('')}</ul></details>` : ''}</aside>
${sourceData(md)}${inlined().copy}`);
}
