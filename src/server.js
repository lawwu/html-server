// The HTTP server: the route table (which also generates the /api docs page) and
// its handlers. The command line (serve, create-user, put, ls, ...) is src/cli.js.
import { createServer } from 'node:http';
import { gzipSync } from 'node:zlib';
import { fileBytes, fileText } from './files.js';
import {
  MAX_BODY_BYTES, MAX_INLINE_BYTES, RENDER_CSP, TOC_MIN_HEADINGS, renderCsp,
} from './config.js';
import { ACTIVE, TRASHED } from './lifecycle.js';
import { VIEWS, diffPage, docsMarkdown, galleryPage, graphPage, historyPage, htmlFramePage, markdownPage, notePage, resultsBody, reviewPage, statsPage } from './pages.js';
import { exampleCategories, exampleHtml, findExamples } from './examples.js';
import { renderMarkdown } from './markdown.js';
import { isNote, isNotebook, parseNotebook, renderNotebook } from './notebook.js';
import { Store, pageMeta, summary } from './store.js';
import { TOOLS as MCP_TOOLS } from './mcp.js';
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
  ['GET', '/docs/?', 'docs', 'anyone', 'This page: using HTML Server from the command line, MCP and HTTP'],
  ['GET', '/api/?', 'docs', 'anyone', 'The same page'],
  ['GET', '/docs\\.md', 'docsSource', 'anyone', 'This page as Markdown'],
  ['GET', '/api/docs\\.md', 'docsSource', 'anyone', null],
  ['GET', '/_static/(?<file>[\\w.-]+)', 'static', 'anyone', null],
  ['GET', '/_static/fonts/(?<font>[\\w.-]+\\.woff2)', 'font', 'anyone', null],
  ['GET', `/pages/${SLUG}`, 'render', 'anyone*',
    'The page itself, e.g. `/pages/trip-plan` or `/pages/trip-plan.html` (`.html` optional). `?v=n` for an old version.'
    + ' A note always renders in the site layout; an HTML page opened in a browser tab gets the site\'s frame, everything'
    + ' else (iframes, curl, `?raw=1`) the page alone. `?embed=1`: the page as the frame shows it, sized to fit'],
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
  ['GET', '/api/search', 'search', 'anyone*',
    'Search pages: `?q=` (required; typo-tolerant, titles rank first), `&tag=`, `&limit=` (default 20). Results carry'
    + ' `title_highlight` and `snippet` with matched words in [brackets]. Answers cross-origin requests (sandboxed'
    + ' notes search with it), which carry no token: public pages only'],
  ['GET', `/assets/${SLUG}`, 'assetFile', 'anyone', 'An image or PDF that notes embed'],
  ['GET', '/api/assets', 'assets', 'anyone', 'Every asset (images, PDFs) with its size and sha256'],
  ['PUT', `/api/assets/${SLUG}`, 'putAsset', 'token', 'Upload or replace an asset (png, jpg, gif, webp, avif, svg, pdf; up to 10 MB). Notes embed it by file name'],
  ['DELETE', `/api/assets/${SLUG}`, 'deleteAsset', 'owner', 'Delete an asset'],
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
  ['GET', `/api/artifacts/${SLUG}/versions/(?<n>\\d+)`, 'raw', 'anyone*', 'The source of version n as text: HTML, or a note\'s Markdown'],
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

const TOC_SCRIPT = fileText('public/toc.js');
const VERSION_BADGE_SCRIPT = fileText('public/version-badge.js');
const EMBED_SIZE_SCRIPT = fileText('public/embed-size.js').replace(/^(\/\/.*\n)+/, ''); // without its header comment

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

/**
 * An HTML page inside the site's frame (?embed=1): opt it in to responsive iframes
 * (Chrome's frame-sizing: content-height; the meta tag has to be in the page as served,
 * it can't be added later) and add the script that keeps the frame sized everywhere else
 * (public/embed-size.js). A page that says <meta name="html-server-frame" content="window">
 * isn't opted in: it stays at window height.
 */
export function withEmbedSizing(doc) {
  let html = doc.toString('utf8');
  if (!/<meta\b[^>]*name\s*=\s*["']?html-server-frame["']?[^>]*content\s*=\s*["']?window/i.test(html)) {
    const meta = '<meta name="responsive-embedded-sizing" content="allow-origins=*">';
    const head = html.search(/<head\b[^>]*>/i);
    html = head === -1 ? meta + html : html.replace(/<head\b[^>]*>/i, (m) => m + meta);
  }
  return Buffer.from(injectScript(html, 'data-html-server-embed', EMBED_SIZE_SCRIPT));
}

/** On an old version, a small badge: "v2 of 6", with links to the current version and the history. */
export function withVersionBadge(doc, { n, latest, current, history }) {
  const a = (k, v) => (v == null ? '' : ` data-${k}="${String(v).replace(/[&"<>]/g, (c) => `&#${c.charCodeAt(0)};`)}"`);
  const attrs = `data-artifact-version-badge${a('n', n)}${a('latest', latest)}${a('current', current)}${a('history', history)}`;
  return Buffer.from(injectScript(doc.toString('utf8'), attrs, VERSION_BADGE_SCRIPT));
}

const PREVIEW_NOTES = 40; // notes linked from one page that get a rendered preview
const PREVIEW_HTML_CHARS = 6000; // how much of each (the card shows the start)
const COMPRESSIBLE = /^(text\/|application\/json|image\/svg)/;
const STATIC_TYPES = { css: 'text/css; charset=utf-8', js: 'text/javascript; charset=utf-8', svg: 'image/svg+xml' };

class Ctx {
  constructor(store, req, res, url, csp = RENDER_CSP) {
    Object.assign(this, { store, req, res, url, query: url.searchParams, csp });
  }

  send(status, type, body, headers = {}) {
    let buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
    // Text goes gzipped to clients that take it: notes carry their styles and fonts inline.
    if (buf.length > 1024 && COMPRESSIBLE.test(type) && /\bgzip\b/.test(this.req.headers['accept-encoding'] || '')) {
      buf = gzipSync(buf);
      headers = { ...headers, 'Content-Encoding': 'gzip', Vary: 'Accept-Encoding' };
    }
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
    this.html(galleryPage(items, { ...opts, view, explorer: opts.section === 'pages' ? this.store.explorer(null) : null }));
  }

  /**
   * A Markdown note as a page: wikilinks resolved against pages this viewer can see
   * (missing ones shown as such), and "Linked from" backlinks. Title and tags come from
   * the version being shown, so an old version reads as it did.
   */
  note(page, source, n) {
    const viewer = this.viewerId();
    const text = source.toString('utf8');
    const meta = pageMeta(page.slug, text);
    const nb = isNotebook(page.slug) ? parseNotebook(text) : null;
    const html = nb ? renderNotebook(nb, { ...this.resolvers(viewer), title: meta.title })
      : renderMarkdown(text, { ...this.resolvers(viewer), title: meta.title });
    const backlinks = this.store.backlinks(page, viewer);
    const linked = [...html.matchAll(/href="\/pages\/([^"?#]+)/g)].map((m) => decodeURIComponent(m[1])).concat(backlinks.map((b) => b.slug));
    return Buffer.from(notePage({
      slug: page.slug, chrome: !this.preview(), latest: page.latest_version,
      title: meta.title, description: meta.description, tags: meta.tags, version: n,
      updated: n === page.latest_version ? page.updated_at : null,
      html, backlinks, previews: this.preview() ? {} : this.previews(linked, viewer), source: text,
      copyLabel: nb ? 'Copy notebook' : 'Copy markdown',
      extra: nb ? [nb.kernel, `${nb.cells.filter((c) => c.type === 'code').length} code cells`].filter(Boolean).join(' · ') : '',
      theme: (this.req.headers.cookie || '').match(/(?:^|;\s*)theme=(dark|light)/)?.[1],
      path: page.path, explorer: this.preview() ? [] : this.store.explorer(viewer),
      graph: this.preview() ? null : this.store.graph(viewer),
    }));
  }

  /**
   * How a note finds what it links to: `resolve` turns a wikilink name into a page this
   * viewer can see (or null: drawn as "not written yet"); `asset` finds an image or PDF.
   * Images go in as data: URIs (a sandboxed note may not load files) unless big, or
   * `inline` is off (hover previews, which link to them instead).
   */
  resolvers(viewer, { inline = true } = {}) {
    return {
      resolve: (name) => {
        try { const a = this.store.readable(name, viewer); return { exists: true, url: `/pages/${a.slug}` }; } catch { return null; }
      },
      asset: (name) => {
        const a = this.store.asset(name);
        if (!a) return null;
        const url = `/assets/${encodeURIComponent(a.name)}`;
        const small = inline && a.mime.startsWith('image/') && a.size <= MAX_INLINE_BYTES;
        return { mime: a.mime, url, src: small ? `data:${a.mime};base64,${Buffer.from(a.data).toString('base64')}` : url };
      },
    };
  }

  /**
   * Hover previews for the pages a page links to: title, tags and opening text for every
   * page, and for notes the start of the note itself, rendered (Quartz shows the page).
   * The browser cleans that HTML before showing it (public/popover.js).
   */
  previews(slugs, viewer) {
    const out = this.store.previews(slugs, viewer);
    for (const slug of Object.keys(out).filter(isNote).slice(0, PREVIEW_NOTES)) {
      try {
        const a = this.store.readable(slug, viewer);
        const text = this.store.version(a, a.latest_version).toString('utf8');
        const opts = { ...this.resolvers(viewer, { inline: false }), title: out[slug].title };
        let html = isNotebook(slug) ? renderNotebook(parseNotebook(text), opts) : renderMarkdown(text, opts);
        if (html.length > PREVIEW_HTML_CHARS) html = html.slice(0, html.lastIndexOf('>', PREVIEW_HTML_CHARS) + 1);
        out[slug].html = html;
      } catch { /* text preview only */ }
    }
    return out;
  }

  /**
   * An HTML page opened directly in a browser tab gets the site's frame around it (see
   * frame). Everything else gets the page itself: the frame's own iframe, gallery
   * previews and the review page (all iframe loads), curl and other clients (which send
   * no Sec-Fetch-Dest), and ?raw=1.
   */
  wantsFrame() {
    return this.req.headers['sec-fetch-dest'] === 'document' && !this.query.get('raw') && !this.query.get('embed') && !this.preview();
  }

  /**
   * The frame: the sidebar and explorer, the page's title, tags and links, the page
   * itself in an iframe (where it stays sandboxed and keeps its own design), then its
   * local graph and backlinks. The view is counted when the iframe loads the page.
   */
  frame(a) {
    const viewer = this.viewerId();
    const n = this.int('v') ?? a.latest_version;
    this.store.version(a, n); // 404 for a version that doesn't exist
    const backlinks = this.store.backlinks(a, viewer);
    this.html(htmlFramePage({
      page: summary(a, viewer), n, backlinks,
      explorer: this.store.explorer(viewer), graph: this.store.graph(viewer),
      previews: this.previews(backlinks.map((b) => b.slug), viewer),
    }));
  }

  /** ?preview=1: a gallery-card thumbnail. Not a view, and no sidebar or badge drawn over it. */
  preview() { return !!this.query.get('preview'); }

  /** What we add to a page at display time: the contents sidebar, and on an old version a badge. */
  decorate({ body, n, latest, page }, links) {
    const note = page && isNote(page.slug);
    if (note) body = this.note(page, body, n);
    if (this.preview()) return body;
    // In the site's frame the title bar shows the version, and a floating contents box
    // would be pinned to the top of a frame as tall as the page: just size it.
    if (!note && this.query.get('embed')) return withEmbedSizing(body);
    // Notes carry their contents in the right sidebar already.
    let doc = note || this.query.get('toc') === '0' ? body : withToc(body);
    if (n < latest) doc = withVersionBadge(doc, { n, latest, ...links });
    return doc;
  }

  /** The docs page's Markdown: CLI, MCP and API (pages.js docsMarkdown). */
  docs() { return docsMarkdown(this.origin(), ROUTES, { tools: MCP_TOOLS }); }

  /** This server as the client reached it, for examples in the docs. */
  origin() { return `http://${this.req.headers.host || 'localhost'}`; }

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
      if (size > MAX_BODY_BYTES) throw new ApiError(413, `too big: this server takes up to ${+(MAX_BODY_BYTES / 1024 / 1024).toFixed(1)} MB per upload`);
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
  docs(c) { c.html(markdownPage({ title: 'Docs', md: c.docs(), active: 'docs', sourceUrl: '/docs.md' })); },
  docsSource(c) { c.send(200, 'text/markdown; charset=utf-8', c.docs()); },
  font(c, { font }) {
    let body;
    try { body = fileBytes(`public/fonts/${font}`); } catch { throw new ApiError(404, 'not found'); }
    c.send(200, 'font/woff2', body, { 'Cache-Control': 'public, max-age=604800' });
  },
  static(c, { file }) {
    const type = STATIC_TYPES[file.split('.').pop()];
    if (!type) throw new ApiError(404, 'not found');
    let body;
    try { body = fileBytes(`public/${file}`); } catch { throw new ApiError(404, 'not found'); }
    c.send(200, type, body, { 'Cache-Control': 'no-cache' });
  },
  render(c, { slug }) {
    if (c.wantsFrame()) {
      const a = c.store.readable(slug, c.viewerId());
      if (a.state === 'active' && !isNote(a.slug)) return c.frame(a);
    }
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
      source: c.query.get('source') || undefined,
    }));
  },
  categories(c) { c.json(200, c.store.categories(c.viewerId())); },
  assetFile(c, { slug }) {
    const a = c.store.asset(slug);
    if (!a) throw new ApiError(404, 'no such asset');
    // SVG can carry script: serve it (and everything) sandboxed and unsniffed.
    c.send(200, a.mime, Buffer.from(a.data), { 'Content-Security-Policy': c.csp, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-cache' });
  },
  assets(c) { c.json(200, c.store.listAssets()); },
  async putAsset(c, { slug }) { const u = c.user(); c.json(200, c.store.putAsset(u.id, slug, await c.body())); },
  deleteAsset(c, { slug }) { c.store.deleteAsset(c.user().id, slug); c.json(200, { deleted: slug }); },
  search(c) {
    const q = (c.query.get('q') || '').trim();
    if (!q) throw new ApiError(400, 'search needs ?q=');
    const tag = c.query.get('tag') || undefined;
    const results = c.store.list(c.viewerId(), { q, category: tag, limit: Math.min(c.int('limit') ?? 20, 200) });
    // Readable from sandboxed notes (their origin is opaque), whose ⌘K search calls this.
    // Anonymous there, so only public pages; a token can't ride along cross-origin.
    c.send(200, 'application/json', JSON.stringify({ query: q, tag: tag ?? null, count: results.length, results }, null, 2) + '\n',
      { 'Access-Control-Allow-Origin': '*' });
  },
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
      source: c.query.get('source') ?? undefined, // set by `sync`, so `--prune` only touches its own pages
      nameKey: c.query.get('name') ?? undefined, //  set by `sync`: the note's bare file name, for [[wikilinks]]
      path: c.query.get('path') ?? undefined, //     set by `sync`: where the note lives in its folder, for the explorer
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
  return createServer((req, res) => handleRequest(store, req, res, { csp }));
}

/**
 * One request, Node-style (`req`: method, url, headers, socket.remoteAddress, and the
 * body as an async iterable; `res`: writeHead, end, headersSent). makeServer wires it to
 * node:http; other runtimes adapt their own requests to it (cloudflare/worker.js).
 * `csp`: the policy rendered pages are sent with (default: RENDER_CSP).
 */
export async function handleRequest(store, req, res, { csp = RENDER_CSP } = {}) {
  {
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
      console.error(`${req.method} ${url.pathname}`); // never log tokens or query strings
    }
  }
}
