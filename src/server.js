// The HTTP server: the route table (which also generates the /api docs page) and
// its handlers. The command line (serve, create-user, put, ls, ...) is src/cli.js.
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import {
  MAX_BODY_BYTES, RENDER_CSP, TOC_MIN_HEADINGS, renderCsp,
} from './config.js';
import { ACTIVE, TRASHED } from './lifecycle.js';
import { VIEWS, diffPage, docsPage, galleryPage, graphPage, historyPage, resultsBody, reviewPage, statsPage } from './pages.js';
import { exampleCategories, exampleHtml, findExamples } from './examples.js';
import { Store } from './store.js';
import { ApiError, unifiedDiff } from './text.js';

const SLUG = '(?<slug>[A-Za-z0-9][\\w.-]*)';
const CID = '(?<cid>\\d+)';

// [method, path regex, handler, who may call it, what it does]. The /api docs page
// renders from this table, so documenting a route means filling in its row; rows
// with no description stay off the page. The bare /<slug> page route matches last.
export const ROUTES = [
  ['GET', '/', 'gallery', 'anyone', 'Your pages: browse, filter by `?category=`, search (`?q=`, titles rank first); `?view=list` for the list layout'],
  ['GET', '/stats', 'stats', 'anyone*', 'Totals, views and uploads over time, most viewed and edited pages, tags, recent uploads'],
  ['GET', '/api/stats', 'statsData', 'anyone*', 'The same numbers as JSON'],
  ['GET', '/graph', 'graph', 'anyone*',
    'Your pages and the links between them, as an interactive graph. `?page=<name>` (and `&depth=2`) for one page\'s neighbourhood'],
  ['GET', '/api/graph', 'graphData', 'anyone*',
    'The graph as JSON: `nodes` (pages, with links in and out) and `edges` (`source` → `target` page ids); same `?page=` and `?depth=`'],
  ['GET', '/gallery/?', 'examples', 'anyone', 'The example pages that ship with HTML Server, with the same filters and search'],
  ['GET', '/gallery/(?<file>[A-Za-z0-9][\\w.-]*\\.html)', 'example', 'anyone', 'One example page'],
  ['GET', '/api/?', 'docs', 'anyone', 'This page'],
  ['GET', '/_static/(?<file>[\\w.-]+)', 'static', 'anyone', null],
  ['GET', `/pages/${SLUG}`, 'render', 'anyone*',
    'The page itself, e.g. `/pages/trip-plan` or `/pages/trip-plan.html` (`.html` optional). `?v=n` for an old version'],
  ['GET', `/${SLUG}`, 'render', 'anyone*', 'Short alias for `/pages/<slug>`, e.g. `/trip-plan.html`'],
  ['GET', '/v/(?<share>[\\w-]+)', 'renderShare', 'anyone with the link',
    'A page by its `share_url`; works for private pages. `?v=n` for an old version'],
  ['GET', `/review/${SLUG}`, 'review', 'anyone*',
    'Review page in a browser: the page with its comments underneath, a version picker, changes and restore'],
  ['GET', `/history/${SLUG}`, 'history', 'anyone*',
    'Every version of a page with its date, author and note; view any version, or compare any two'],
  ['GET', `/review/${SLUG}/changes`, 'reviewChanges', 'anyone*',
    'Side-by-side changes page. `?from=1&to=3` (default: previous vs latest), `?of=source` for HTML'],
  ['GET', '/api/artifacts/?', 'list', 'anyone*',
    'List newest first. `?q=` search, `?category=`, `?owner=`, `?limit=`, `?state=trashed` (your own trash, token required)'],
  ['GET', '/api/categories', 'categories', 'anyone', 'Tags in use, with counts, as `{category, count}` (older name)'],
  ['GET', '/api/tags', 'tags', 'anyone*', 'Tags in use on pages you can see, with counts'],
  ['POST', '/api/tags', 'tagPages', 'token',
    'Tag many pages at once: body `{"pages": ["a.html", "b"], "add": ["trips"], "remove": ["draft"]}`.'
    + ' Each page needs edit rights; the result reports each page\'s tags or its error'],
  ['POST', `/api/artifacts/${SLUG}/pin`, 'pin', 'owner or admin', 'Feature a page: pin it to the top of the home page'],
  ['DELETE', `/api/artifacts/${SLUG}/pin`, 'unpin', 'owner or admin', 'Unpin a featured page'],
  ['PUT', `/api/artifacts/${SLUG}`, 'put', 'token',
    'Upload a page, or add a version (yours, or anyone\'s public page under open editing). `?note=` / `X-Note`,'
    + ' `X-Title`, `X-Visibility: private`; `?base=n` refuses if the page has moved past version n'],
  ['PUT', '/api/artifacts/?', 'putNoName', 'token', null],
  ['POST', `/api/artifacts/${SLUG}`, 'put', 'token', 'Same as PUT'],
  ['GET', `/api/artifacts/${SLUG}`, 'describe', 'anyone*', 'Metadata and version history'],
  ['GET', `/api/artifacts/${SLUG}/versions/(?<n>\\d+)`, 'raw', 'anyone*', 'Raw HTML source of version n'],
  ['GET', `/api/artifacts/${SLUG}/diff`, 'diff', 'anyone*',
    'What changed, as a unified diff. `?from=1&to=3` (default: previous vs latest), `?of=source` for HTML instead of visible text'],
  ['POST', `/api/artifacts/${SLUG}/versions/(?<n>\\d+)/restore`, 'restoreVersion', 'owner',
    'Make version n current again. Adds a new version copied from n, so nothing is lost'],
  ['POST', `/api/artifacts/${SLUG}/visibility`, 'visibility', 'owner', '`?to=public` or `?to=private`'],
  ['DELETE', `/api/artifacts/${SLUG}`, 'delete', 'owner',
    'Move to trash. `?purge=1` deletes permanently, and only works on something already trashed'],
  ['POST', `/api/artifacts/${SLUG}/restore`, 'restore', 'owner', 'Take out of the trash'],
  ['GET', `/api/artifacts/${SLUG}/comments`, 'comments', 'anyone*', 'Comments, oldest first. `?version=n` for one version'],
  ['POST', `/api/artifacts/${SLUG}/comments`, 'addComment', 'token',
    'Comment: body `{"body": "..."}`, optionally `"version": n` (default latest) or `"parent": id` to reply'],
  ['POST', `/api/comments/${CID}/resolve`, 'resolveComment', 'author or page owner', 'Resolve a comment; `?undo=1` reopens it'],
  ['DELETE', `/api/comments/${CID}`, 'deleteComment', 'author or page owner', 'Delete a comment and its replies'],
  ['GET', `/api/artifacts/${SLUG}/views`, 'views', 'owner',
    'Page views: total, visitors, per day for the last 30 days, per version, and by link (URL or share link)'],
  ['GET', '/api/me', 'me', 'token', 'Who the token belongs to'],
  ['GET', '/api/users', 'listUsers', 'admin', 'List users'],
  ['POST', '/api/users', 'createUser', 'admin',
    'Create a user: body `{"name": "bob"}`, add `"admin": true` for an admin. Returns the token once'],
  ['POST', '/api/me/token', 'rotateOwnToken', 'token',
    'Replace your own token, e.g. if it leaked. Returns the new one once; the old one stops working'],
  ['POST', '/api/users/(?<name>[^/]+)/token', 'resetToken', 'admin',
    'Issue a new token for a user who lost theirs. Their pages are untouched; the old token stops working'],
  ['DELETE', '/api/users/(?<name>[^/]+)', 'deleteUser', 'admin', 'Delete a user and all of their pages'],
].map(([method, path, handler, who, doc]) => ({ method, path, handler, who, doc, re: new RegExp(`^${path}$`) }))
  .sort((a, b) => (a.handler === 'render') - (b.handler === 'render'));

const STATIC_DIR = new URL('../public/', import.meta.url);
const TOC_SCRIPT = readFileSync(new URL('toc.js', STATIC_DIR), 'utf8');
const VERSION_BADGE_SCRIPT = readFileSync(new URL('version-badge.js', STATIC_DIR), 'utf8');

/** Insert a script just before the page's last </body> (or at the end). Display-time only. */
function injectScript(html, attrs, code) {
  // A </script> inside the script would end it early; ours have none, but be safe.
  const tag = `<script ${attrs}>${code.replace(/<\/script/gi, '<\\/script')}</script>`;
  const at = html.search(/<\/body\s*>(?![\s\S]*<\/body\s*>)/i);
  return at === -1 ? html + tag : html.slice(0, at) + tag + html.slice(at);
}

/** Add the contents sidebar to a page with enough headings (see TOC_MIN_HEADINGS). */
export function withToc(doc) {
  const html = doc.toString('utf8');
  if ((html.match(/<h[23][\s>]/gi) || []).length < TOC_MIN_HEADINGS) return doc;
  if (/<meta\b[^>]*name\s*=\s*["']?toc["']?[^>]*content\s*=\s*["']?off/i.test(html)) return doc;
  return Buffer.from(injectScript(html, 'data-artifact-toc-script', TOC_SCRIPT));
}

/** On an old version, a small badge: "v2 of 6", with links to the current version and the history. */
export function withVersionBadge(doc, { n, latest, current, history }) {
  const a = (k, v) => (v == null ? '' : ` data-${k}="${String(v).replace(/[&"<>]/g, (c) => `&#${c.charCodeAt(0)};`)}"`);
  const attrs = `data-artifact-version-badge${a('n', n)}${a('latest', latest)}${a('current', current)}${a('history', history)}`;
  return Buffer.from(injectScript(doc.toString('utf8'), attrs, VERSION_BADGE_SCRIPT));
}

const STATIC_TYPES = { css: 'text/css; charset=utf-8', js: 'text/javascript; charset=utf-8', svg: 'image/svg+xml' };

class Ctx {
  constructor(store, req, res, url, csp = RENDER_CSP) {
    Object.assign(this, { store, req, res, url, query: url.searchParams, csp });
  }

  send(status, type, body, headers = {}) {
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
    this.res.writeHead(status, { 'Content-Type': type, 'Content-Length': buf.length, ...headers });
    this.res.end(buf);
  }

  json(status, obj) { this.send(status, 'application/json', JSON.stringify(obj, null, 2) + '\n'); }
  html(body) { this.send(200, 'text/html; charset=utf-8', body); }
  text(body) { this.send(200, 'text/plain; charset=utf-8', body); }

  /** An artifact (or anything showing its content): sandboxed so its scripts can't reach the API. */
  page(body) {
    this.send(200, 'text/html; charset=utf-8', body, { 'Content-Security-Policy': this.csp, 'X-Content-Type-Options': 'nosniff' });
  }

  /** ?page=<name>[&depth=n]: a local graph around one page (depth 1-3, default 1). */
  graphScope() {
    const depth = this.int('depth');
    if (depth != null && (depth < 1 || depth > 3)) throw new ApiError(400, 'depth must be 1, 2 or 3');
    return { focus: this.query.get('page') || undefined, depth: depth ?? 1 };
  }

  /** A gallery listing, or with ?fragment just its cards (what live search swaps in). */
  listing(items, opts) {
    const base = opts.section === 'gallery' ? '/gallery' : '/';
    if (this.query.get('fragment')) return this.html(resultsBody(items, opts.q, { base }));
    const view = VIEWS.includes(this.query.get('view')) ? this.query.get('view') : 'grid';
    this.html(galleryPage(items, { ...opts, view }));
  }

  /** ?preview=1: a gallery-card thumbnail. Not a view, and no sidebar or badge drawn over it. */
  preview() { return !!this.query.get('preview'); }

  /** What we add to a page at display time: the contents sidebar, and on an old version a badge. */
  decorate({ body, n, latest }, links) {
    if (this.preview()) return body;
    let doc = this.query.get('toc') === '0' ? body : withToc(body);
    if (n < latest) doc = withVersionBadge(doc, { n, latest, ...links });
    return doc;
  }

  int(name) {
    const v = this.query.get(name);
    if (v == null || v === '') return null;
    if (!/^\d+$/.test(v)) throw new ApiError(400, `${name} must be a number`);
    return Number(v);
  }

  async body() {
    const chunks = [];
    let size = 0;
    for await (const c of this.req) {
      size += c.length;
      if (size > MAX_BODY_BYTES) throw new ApiError(413, `body over ${MAX_BODY_BYTES} bytes`);
      chunks.push(c);
    }
    return Buffer.concat(chunks);
  }

  async jsonBody() {
    let data;
    try { data = JSON.parse((await this.body()).toString('utf8') || '{}'); } catch { throw new ApiError(400, 'body must be JSON'); }
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new ApiError(400, 'body must be a JSON object');
    return data;
  }

  user({ admin = false } = {}) {
    const auth = this.req.headers.authorization || '';
    if (!auth.startsWith('Bearer ')) throw new ApiError(401, 'missing bearer token');
    const u = this.store.userForToken(auth.slice(7).trim());
    if (!u) throw new ApiError(401, 'bad token');
    if (admin && !u.is_admin) throw new ApiError(403, 'admin only');
    return u;
  }

  /** Reads are open: no token means anonymous; a bad token is still an error. */
  viewerId() { return this.req.headers.authorization ? this.user().id : null; }
  visit() { return [this.req.socket.remoteAddress, this.req.headers['user-agent'] || '']; }
}

const handlers = {
  // --- reads, open to everyone subject to visibility ---
  gallery(c) {
    const q = (c.query.get('q') || '').trim();
    const category = c.query.get('category') || '';
    const items = c.store.list(null, { q: q || undefined, category: category || undefined, limit: 500 });
    c.listing(items, { q, category, categories: c.store.categories(null), section: 'pages', total: category ? items.length : c.store.countPages(null) });
  },
  stats(c) { c.html(statsPage(c.store.stats(c.viewerId()))); },
  statsData(c) { c.json(200, c.store.stats(c.viewerId())); },
  graph(c) { c.html(graphPage(c.store.graph(c.viewerId(), c.graphScope()))); },
  graphData(c) { c.json(200, c.store.graph(c.viewerId(), c.graphScope())); },
  examples(c) {
    const q = (c.query.get('q') || '').trim();
    const category = c.query.get('category') || '';
    const found = findExamples({ q, category });
    c.listing(found, { q, category, categories: exampleCategories(), section: 'gallery', total: q ? findExamples({ category }).length : found.length });
  },
  example(c, { file }) {
    const body = exampleHtml(file);
    if (!body) throw new ApiError(404, 'no such example');
    c.page(c.preview() || c.query.get('toc') === '0' ? body : withToc(body));
  },
  docs(c) { c.html(docsPage(`http://${c.req.headers.host || 'localhost'}`, ROUTES)); },
  static(c, { file }) {
    const type = STATIC_TYPES[file.split('.').pop()];
    if (!type) throw new ApiError(404, 'not found');
    let body;
    try { body = readFileSync(new URL(file, STATIC_DIR)); } catch { throw new ApiError(404, 'not found'); }
    c.send(200, type, body, { 'Cache-Control': 'no-cache' });
  },
  render(c, { slug }) {
    const r = c.store.render(slug, c.int('v'), c.viewerId(), c.preview() ? null : c.visit());
    const S = encodeURIComponent(r.slug);
    c.page(c.decorate(r, { current: `/pages/${S}`, history: `/history/${S}` }));
  },
  renderShare(c, { share }) {
    // A share link may be a private page, whose history needs a sign-in: no history link.
    const r = c.store.renderShare(share, c.int('v'), c.preview() ? null : c.visit());
    c.page(c.decorate(r, { current: `/v/${encodeURIComponent(share)}` }));
  },
  // Always the shell: the script loads the page with the viewer's saved token, so
  // private pages work and missing ones show "not found" in place.
  review(c, { slug }) { c.html(reviewPage(slug)); },
  history(c, { slug }) { c.html(historyPage(c.store.describe(slug, c.viewerId()))); },
  reviewChanges(c, { slug }) {
    const [from, to, a, b] = c.store.diff(slug, c.viewerId(), c.int('from'), c.int('to'), c.query.get('of') || 'text');
    c.page(diffPage(from, to, a, b, { back: c.query.get('back') ? `/history/${encodeURIComponent(slug)}` : null }));
  },
  list(c) {
    const viewer = c.viewerId();
    const state = c.query.get('state') || ACTIVE;
    if (![ACTIVE, TRASHED].includes(state)) throw new ApiError(400, 'state must be active or trashed');
    if (state === TRASHED && viewer == null) throw new ApiError(401, 'trash is visible to its owner only');
    c.json(200, c.store.list(viewer, {
      q: c.query.get('q') || undefined,
      state,
      limit: Math.min(c.int('limit') ?? 50, 500),
      owner: c.query.get('owner') || undefined,
      category: c.query.get('category') || undefined,
    }));
  },
  categories(c) { c.json(200, c.store.categories(c.viewerId())); },
  tags(c) { c.json(200, c.store.tags(c.viewerId())); },
  async tagPages(c) {
    const u = c.user();
    const { pages, add = [], remove = [] } = await c.jsonBody();
    const list = (v, name) => {
      if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) throw new ApiError(400, `${name} must be a list of strings`);
      return v;
    };
    c.json(200, { results: c.store.tagPages(u.id, list(pages ?? [], 'pages'), { add: list(add, 'add'), remove: list(remove, 'remove') }) });
  },
  pin(c, { slug }) { c.json(200, c.store.pin(c.user(), slug, true)); },
  unpin(c, { slug }) { c.json(200, c.store.pin(c.user(), slug, false)); },
  describe(c, { slug }) { c.json(200, c.store.describe(slug, c.viewerId())); },
  raw(c, { slug, n }) { c.text(c.store.versionHtml(slug, Number(n), c.viewerId())); },
  diff(c, { slug }) {
    const [from, to, a, b] = c.store.diff(slug, c.viewerId(), c.int('from'), c.int('to'), c.query.get('of') || 'text');
    c.text(unifiedDiff(a, b, `v${from}`, `v${to}`));
  },
  comments(c, { slug }) { c.json(200, c.store.comments(slug, c.viewerId(), c.int('version'))); },

  // --- users ---
  me(c) { const u = c.user(); c.json(200, { name: u.name, is_admin: !!u.is_admin }); },
  listUsers(c) { c.user({ admin: true }); c.json(200, c.store.listUsers()); },
  async createUser(c) {
    c.user({ admin: true });
    const data = await c.jsonBody();
    const name = c.store.normalizeUsername(data.name);
    const token = c.store.createUser(name, !!data.admin);
    c.json(201, { name, token, note: 'shown once; store it' });
  },
  rotateOwnToken(c) {
    const u = c.user();
    c.json(200, { name: u.name, token: c.store.resetToken(u.name), note: 'shown once; the old token no longer works' });
  },
  resetToken(c, { name }) {
    c.user({ admin: true });
    c.json(200, { name, token: c.store.resetToken(name), note: 'shown once; the old token no longer works' });
  },
  deleteUser(c, { name }) {
    if (name.toLowerCase() === c.user({ admin: true }).name) throw new ApiError(400, 'refusing to delete yourself');
    c.store.deleteUser(name);
    c.json(200, { deleted: name });
  },

  // --- writes, owner only ---
  async put(c, { slug }) {
    const u = c.user();
    const doc = await c.body();
    if (!doc.length) throw new ApiError(400, 'empty body; send HTML with -T file.html or --data-binary @file.html');
    const h = c.req.headers;
    const res = c.store.putVersion(u.id, slug, doc, {
      title: c.query.get('title') || h['x-title'],
      note: c.query.get('note') || h['x-note'] || '',
      visibility: c.query.get('visibility') || h['x-visibility'],
      base: c.int('base') ?? (h['x-base'] && /^\d+$/.test(h['x-base']) ? Number(h['x-base']) : null),
    });
    c.json(res.latest_version === 1 ? 201 : 200, res);
  },
  putNoName() {
    // curl -T only appends the file name when the URL ends in "/", so a query
    // string there (?note=...) silently drops it. Say so.
    throw new ApiError(400, "no file name in the URL; with curl -T end the URL in '/' and pass"
      + ' options as headers (X-Note, X-Title, X-Visibility)');
  },
  restoreVersion(c, { slug, n }) { c.json(200, c.store.restoreVersion(c.user().id, slug, Number(n))); },
  visibility(c, { slug }) { c.json(200, c.store.setVisibility(c.user().id, slug, c.query.get('to') || '')); },
  restore(c, { slug }) { c.json(200, c.store.apply(c.user().id, slug, 'restore')); },
  delete(c, { slug }) {
    const purge = ['1', 'true'].includes(c.query.get('purge'));
    c.json(200, c.store.apply(c.user().id, slug, purge ? 'purge' : 'trash'));
  },
  async addComment(c, { slug }) {
    const u = c.user();
    const data = await c.jsonBody();
    for (const k of ['version', 'parent']) {
      if (data[k] != null && !Number.isInteger(data[k])) throw new ApiError(400, 'version and parent must be numbers');
    }
    c.json(201, c.store.addComment(u.id, slug, data.body, data.version, data.parent));
  },
  resolveComment(c, { cid }) {
    const undo = ['1', 'true'].includes(c.query.get('undo'));
    c.json(200, c.store.resolveComment(c.user().id, Number(cid), !undo));
  },
  deleteComment(c, { cid }) { c.store.deleteComment(c.user().id, Number(cid)); c.json(200, { deleted: Number(cid) }); },
  views(c, { slug }) { c.json(200, c.store.views(c.user().id, slug)); },
};

/**
 * `sandboxAllow`: extra sandbox permissions for this server's rendered pages, on top of
 * the default (see renderCsp in config.js). Checked here, so a typo fails at startup.
 */
export function makeServer(store, { sandboxAllow = [] } = {}) {
  const csp = renderCsp(sandboxAllow);
  return createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const c = new Ctx(store, req, res, url, csp);
    try {
      let path = url.pathname;
      try { path = decodeURIComponent(path); } catch { throw new ApiError(400, 'bad URL encoding'); }
      for (const r of ROUTES) {
        const m = r.method === req.method && r.re.exec(path);
        if (m) return await handlers[r.handler](c, m.groups || {});
      }
      throw new ApiError(404, 'no route');
    } catch (e) {
      if (!e.status) console.error(e);
      if (!res.headersSent) c.json(e.status || 500, { error: e.status ? e.message : 'internal error' });
    } finally {
      process.stderr.write(`${req.method} ${url.pathname}\n`); // never log tokens or query strings
    }
  });
}
