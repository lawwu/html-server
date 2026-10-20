#!/usr/bin/env node
// Artifact server: store, version, search, review and render HTML artifacts over curl.
//
//   node src/server.js create-user alice --admin   # prints the token once
//   node src/server.js serve [--port 8765] [--host 127.0.0.1] [--db path]
//
// See README.md for the model; the API reference is served at /api.
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  DEFAULT_DB, DEFAULT_HOST, DEFAULT_PORT, MAX_BODY_BYTES, RENDER_CSP, TOC_MIN_HEADINGS,
} from './config.js';
import { ACTIVE, TRASHED } from './lifecycle.js';
import { VIEWS, diffPage, docsPage, galleryCards, galleryPage, reviewPage } from './pages.js';
import { Store } from './store.js';
import { ApiError, unifiedDiff } from './text.js';

const SLUG = '(?<slug>[A-Za-z0-9][\\w.-]*)';
const CID = '(?<cid>\\d+)';

// [method, path regex, handler, who may call it, what it does]. The /api docs page
// renders from this table, so documenting a route means filling in its row; rows
// with no description stay off the page. The bare /<slug> page route matches last.
export const ROUTES = [
  ['GET', '/', 'gallery', 'anyone', 'The gallery: browse, filter by `?category=`, search (`?q=`) public pages; `?view=list` for the list layout'],
  ['GET', '/api/?', 'docs', 'anyone', 'This page'],
  ['GET', '/_static/(?<file>[\\w.-]+)', 'static', 'anyone', null],
  ['GET', `/${SLUG}`, 'render', 'anyone*', 'The page itself, e.g. `/trip-plan.html` (`.html` optional). `?v=n` for an old version'],
  ['GET', '/v/(?<share>[\\w-]+)', 'renderShare', 'anyone with the link',
    'A page by its `share_url`; works for private pages. `?v=n` for an old version'],
  ['GET', `/review/${SLUG}`, 'review', 'anyone*',
    'Review page in a browser: the page with its comments underneath, a version picker, changes and restore'],
  ['GET', `/review/${SLUG}/changes`, 'reviewChanges', 'anyone*',
    'Side-by-side changes page. `?from=1&to=3` (default: previous vs latest), `?of=source` for HTML'],
  ['GET', '/api/artifacts/?', 'list', 'anyone*',
    'List newest first. `?q=` search, `?category=`, `?owner=`, `?limit=`, `?state=trashed` (your own trash, token required)'],
  ['GET', '/api/categories', 'categories', 'anyone', 'Gallery categories in use, with counts'],
  ['PUT', `/api/artifacts/${SLUG}`, 'put', 'token',
    'Upload a page, or add a version if you own the name. Headers: `X-Note`, `X-Title`, `X-Visibility: private`'],
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
  ['DELETE', '/api/users/(?<name>[\\w-]+)', 'deleteUser', 'admin', 'Delete a user and all of their pages'],
].map(([method, path, handler, who, doc]) => ({ method, path, handler, who, doc, re: new RegExp(`^${path}$`) }))
  .sort((a, b) => (a.handler === 'render') - (b.handler === 'render'));

const STATIC_DIR = new URL('../public/', import.meta.url);
const TOC_SCRIPT = readFileSync(new URL('toc.js', STATIC_DIR), 'utf8');

/** Add the contents sidebar to a page with enough headings (see TOC_MIN_HEADINGS). */
export function withToc(doc) {
  const html = doc.toString('utf8');
  if ((html.match(/<h[23][\s>]/gi) || []).length < TOC_MIN_HEADINGS) return doc;
  if (/<meta\b[^>]*name\s*=\s*["']?toc["']?[^>]*content\s*=\s*["']?off/i.test(html)) return doc;
  // A </script> inside the script would end it early; toc.js has none, but be safe.
  const tag = `<script data-artifact-toc-script>${TOC_SCRIPT.replace(/<\/script/gi, '<\\/script')}</script>`;
  const at = html.search(/<\/body\s*>(?![\s\S]*<\/body\s*>)/i);
  return Buffer.from(at === -1 ? html + tag : html.slice(0, at) + tag + html.slice(at));
}

const STATIC_TYPES = { css: 'text/css; charset=utf-8', js: 'text/javascript; charset=utf-8', svg: 'image/svg+xml' };

class Ctx {
  constructor(store, req, res, url) {
    Object.assign(this, { store, req, res, url, query: url.searchParams });
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
    this.send(200, 'text/html; charset=utf-8', body, { 'Content-Security-Policy': RENDER_CSP, 'X-Content-Type-Options': 'nosniff' });
  }

  maybeToc(doc) { return this.query.get('toc') === '0' ? doc : withToc(doc); }

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
    if (c.query.get('fragment')) return c.html(galleryCards(items, q)); // live search swaps this in
    const view = VIEWS.includes(c.query.get('view')) ? c.query.get('view') : 'grid';
    c.html(galleryPage(items, { q, category, categories: c.store.categories(null), view }));
  },
  docs(c) { c.html(docsPage(`http://${c.req.headers.host || 'localhost'}`, ROUTES)); },
  static(c, { file }) {
    const type = STATIC_TYPES[file.split('.').pop()];
    if (!type) throw new ApiError(404, 'not found');
    let body;
    try { body = readFileSync(new URL(file, STATIC_DIR)); } catch { throw new ApiError(404, 'not found'); }
    c.send(200, type, body, { 'Cache-Control': 'no-cache' });
  },
  render(c, { slug }) { c.page(c.maybeToc(c.store.render(slug, c.int('v'), c.viewerId(), c.visit()))); },
  renderShare(c, { share }) { c.page(c.maybeToc(c.store.renderShare(share, c.int('v'), c.visit()))); },
  // Always the shell: the script loads the page with the viewer's saved token, so
  // private pages work and missing ones show "not found" in place.
  review(c, { slug }) { c.html(reviewPage(slug)); },
  reviewChanges(c, { slug }) {
    const [from, to, a, b] = c.store.diff(slug, c.viewerId(), c.int('from'), c.int('to'), c.query.get('of') || 'text');
    c.page(diffPage(from, to, a, b));
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
    const token = c.store.createUser(data.name, !!data.admin);
    c.json(201, { name: data.name, token, note: 'shown once; store it' });
  },
  deleteUser(c, { name }) {
    if (name === c.user({ admin: true }).name) throw new ApiError(400, 'refusing to delete yourself');
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

export function makeServer(store) {
  return createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const c = new Ctx(store, req, res, url);
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

function main(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      db: { type: 'string', default: DEFAULT_DB },
      host: { type: 'string', default: DEFAULT_HOST },
      port: { type: 'string', default: String(DEFAULT_PORT) },
      admin: { type: 'boolean', default: false },
    },
  });
  const [cmd, name] = positionals;
  const store = new Store(values.db);
  if (cmd === 'create-user') {
    if (!name) throw new Error('usage: create-user NAME [--admin]');
    console.log(store.createUser(name, values.admin));
    return;
  }
  if (cmd !== 'serve') {
    console.error('usage: server.js serve [--port N] [--host H] [--db PATH] | create-user NAME [--admin]');
    process.exit(2);
  }
  const server = makeServer(store);
  server.listen(Number(values.port), values.host, () =>
    console.error(`artifact server on http://${values.host}:${values.port}  (db: ${values.db})`));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main(process.argv.slice(2));
