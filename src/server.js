// The HTTP server: the route table (which also generates the /api docs page) and
// its handlers. The command line (serve, create-user, put, ls, ...) is src/cli.js.
import { createServer } from 'node:http';
import { gzipSync } from 'node:zlib';
import { fileBytes } from './files.js';
import {
  CLI_FROM_GITHUB, CARD_SNIPPETS, LIST_LIMIT, MAX_BODY_BYTES, PAGE_SIZE, POPULAR_MAX_WEEKS, POPULAR_WEEKS, PREVIEW_CSP, RENDER_CSP, renderCsp,
  githubSignIn,
  publicOrigin,
  sso,
} from './config.js';
import { ACTIVE, TRASHED } from './lifecycle.js';
import { cliPackage } from './package.js';
import { SESSION_COOKIE, clearLoginCookie, clearSessionCookie, finishLogin, logoutUrl, sessionCookie, startLogin } from './sso.js';
import { VIEWS, aboutMarkdown, accountPage, claimPage, claimProblemPage, claimedPage, countLabel, docsMarkdown, galleryPage, graphPage, markdownPage, pagerNav, personSection, resultsBody, reviewPage, statsPage, usageSection } from './pages.js';
import { exampleCategories, findExamples } from './examples.js';
import { encodePath, pageUrl, validatePath } from './paths.js';
import { Store } from './store.js';
import { TOOLS as MCP_TOOLS } from './mcp.js';
import { PageDelivery } from './page-delivery.js';
import { ApiError, unifiedDiff } from './text.js';

const FILE = '(?<slug>[\\p{L}\\p{N}][\\p{L}\\p{N}\\p{M}_.-]*)'; // a page or asset name (see SLUG_RE)
const SLUG = '(?<slug>[\\p{L}\\p{N}][\\p{L}\\p{N}\\p{M}_./-]*)'; // a page or asset name (see SLUG_RE)
const CID = '(?<cid>\\d+)';

// [method, path regex, handler, who may call it, what it does]. The /api docs page
// renders from this table, so documenting a route means filling in its row; rows
// with no description stay off the page. The bare /<slug> page route matches last.
export const ROUTES = [
  ['GET', '/(?<folder>[\\p{L}\\p{N}][\\p{L}\\p{N}\\p{M}_./-]*)/', 'folder', 'anyone*', 'Folder contents, subfolders, and scoped search. `?recursive=1` includes descendants'],
  ['POST', '/api/moves', 'movePages', 'owner', 'Move pages atomically: `{"moves":[{"from":"report.html","to":"research/report.html"}]}`. History and share links survive; old addresses redirect'],
  ['GET', '/api/folders', 'folders', 'anyone*', 'Folder choices visible to the viewer'],
  ['GET', '/', 'gallery', 'anyone', 'Your pages: browse, filter by `?category=`, search (`?q=`, titles rank first, whatever the sort); `?sort=updated|created|views|title` (featured pages stay on top); `?view=list` for the list layout'],
  ['GET', '/stats', 'stats', 'anyone*',
    `Totals, views and uploads over time, the most popular pages (most visits over the last ${POPULAR_WEEKS} weeks; \`?weeks=\` 1-${POPULAR_MAX_WEEKS} or \`all\`), the most edited, tags, recent uploads`],
  ['GET', '/api/stats', 'statsData', 'anyone*', 'The same numbers as JSON (the same `?weeks=`)'],
  ['GET', '/random', 'random', 'anyone*',
    'Go to a random page you can see (a redirect). `?folder=` or `?category=` picks one in a folder or with a tag; `?not=<name>` skips that page'],
  ['GET', '/api/stats/usage', 'usageData', 'admin',
    'API usage, last 30 days (`?days=365`, or `?days=all`): calls by kind of client (MCP, CLI, browser, other HTTP), over time, the most used MCP tools and CLI commands, the busiest routes, errors. Details are kept 90 days, daily totals for good'],
  ['GET', '/stats/usage', 'usage', 'admin', null], // the same, as the section /stats shows admins
  ['GET', '/api/stats/usage/people/(?<name>[^/]+)', 'personData', 'admin',
    'One user\'s activity over the same `?days=`: API calls by kind of client, errors, the MCP tools and CLI commands they used most,'
    + ' and the pages they viewed while signed in, most recent first (viewers are recorded only with `html-server config track-people on`)'],
  ['GET', '/stats/usage/people/(?<name>[^/]+)', 'person', 'admin', null], // the same, as /stats shows it
  ['GET', '/graph', 'graph', 'anyone*',
    'Your pages and the links between them, as an interactive graph. `?page=<name>` (and `&depth=2`) for one page\'s neighbourhood'],
  ['GET', '/api/graph', 'graphData', 'anyone*',
    'The graph as JSON: `nodes` (pages, with links in and out) and `edges` (`source` → `target` page ids); same `?page=` and `?depth=`'],
  ['GET', '/gallery/?', 'examples', 'anyone', 'The example pages that ship with HTML Server, with the same filters and search'],
  ['GET', '/gallery/(?<file>[A-Za-z0-9][\\w.-]*\\.html)', 'example', 'anyone',
    'One example page: in a browser tab, in the site\'s frame, as a page is; `?raw=1` for the example alone'],
  ['GET', '/docs/?', 'docs', 'anyone', 'This page: using HTML Server from the command line, MCP and HTTP'],
  ['GET', '/api/?', 'docs', 'anyone', 'The same page'],
  ['GET', '/docs\\.md', 'docsSource', 'anyone', 'This page as Markdown'],
  ['GET', '/about', 'about', 'anyone', 'About HTML Server: why HTML, why a server for it, and the effective-html skills the gallery\'s examples were made with'],
  ['GET', '/about\\.md', 'aboutSource', 'anyone', null],
  ['GET', '/api/docs\\.md', 'docsSource', 'anyone', null],
  ['GET', '/_static/(?<file>[\\w.-]+)', 'static', 'anyone', null],
  ['GET', '/_static/fonts/(?<font>[\\w.-]+\\.woff2)', 'font', 'anyone', null],
  ['GET', '/api/cli/?', 'cliInfo', 'anyone',
    'How to install this server\'s command line from the server itself: `{version, tarball, install}`. No sign-in needed'],
  ['GET', '/api/cli/html-server\\.tgz', 'cliLatest', 'anyone',
    'The `html-server` command line, as the npm package of the version this server runs (a redirect to `html-server-<version>.tgz`): `npm install -g <this URL>`'],
  ['GET', '/api/cli/html-server-(?<version>[\\w.-]+)\\.tgz', 'cliTarball', 'anyone', null],
  ['GET', '/healthz', 'health', 'anyone',
    'For load balancers and uptime monitors (HEAD works too): `{"status":"ok"}` once the database answers, else a 503. Not counted in the usage stats'],
  // Asked for by browsers and crawlers on every visit: a 404 straight away, never a page lookup.
  ['GET', '/favicon\\.ico', 'notFound', 'anyone', null],
  ['GET', '/robots\\.txt', 'notFound', 'anyone', null],
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
    'List pages, featured first, then recently updated. `?sort=updated|created|views|title`, `?q=` search, `?category=`, `?owner=`, `?limit=` (up to 500) and `?offset=` for the next ones, `?state=trashed` (your own trash, token required)'],
  ['GET', '/api/search', 'search', 'anyone*',
    'Search pages: `?q=` (required; typo-tolerant, titles rank first), `&tag=`, `&limit=` (default 20), `&sort=` (default `relevance`; or updated, created, views, title, after the pages whose title has the words). Results carry'
    + ' `title_highlight` and `snippet` with matched words in [brackets]. Answers cross-origin requests (sandboxed'
    + ' notes search with it), which carry no token: public pages only'],
  ['GET', `/assets/${FILE}`, 'assetFile', 'anyone*',
    'An image or PDF that notes embed: for whoever uploaded it, and for anyone who can see one of their pages that shows it'],
  ['GET', '/api/assets', 'assets', 'token', 'Your assets (images, PDFs; an admin: every one) with their size and sha256'],
  ['PUT', `/api/assets/${FILE}`, 'putAsset', 'token', 'Upload or replace an asset (png, jpg, gif, webp, avif, svg, pdf; up to 10 MB). Notes embed it by file name'],
  ['DELETE', `/api/assets/${FILE}`, 'deleteAsset', 'owner', 'Delete an asset'],
  ['GET', '/api/categories', 'categories', 'anyone', 'Tags in use, with counts, as `{category, count}` (older name)'],
  ['GET', '/api/tags', 'tags', 'anyone*', 'Tags in use on pages you can see, with counts'],
  ['POST', '/api/tags', 'tagPages', 'token',
    'Tag many pages at once: body `{"pages": ["a.html", "b"], "add": ["trips"], "remove": ["draft"]}`.'
    + ' Each page needs edit rights; the result reports each page\'s tags or its error'],
  ['POST', `/api/artifacts/${SLUG}/pin`, 'pin', 'owner or admin', 'Feature a page: pin it to the top of the home page'],
  ['DELETE', `/api/artifacts/${SLUG}/pin`, 'unpin', 'owner or admin', 'Unpin a featured page'],
  ['PUT', `/api/artifacts/${SLUG}`, 'put', 'token',
    'Upload a page, or add a version (yours, or anyone\'s public page under open editing). `?note=` / `X-Note`,'
    + ' `X-Title`, `X-Visibility: private`; `?base=n` refuses if the page has moved past version n. The name is exact: a'
    + ' new name that another page already answers to (`report` while `report.html` exists) is refused, naming that page.'
    + ' `?rename_from=` your page whose name differs only in case renames it (what `sync` does when a file is renamed so)'],
  ['PUT', '/api/artifacts/?', 'putNoName', 'token', null],
  ['POST', `/api/artifacts/${SLUG}`, 'put', 'token', 'Same as PUT'],
  ['GET', `/api/artifacts/${SLUG}`, 'describe', 'anyone*', 'Metadata and version history'],
  ['GET', `/api/artifacts/${SLUG}/versions/(?<n>\\d+)`, 'raw', 'anyone*', 'The source of version n as text: HTML, or a note\'s Markdown'],
  ['GET', `/api/artifacts/${SLUG}/diff`, 'diff', 'anyone*',
    'What changed, as a unified diff. `?from=1&to=3` (default: previous vs latest), `?of=source` for HTML instead of visible text'],
  ['POST', `/api/artifacts/${SLUG}/versions/(?<n>\\d+)/restore`, 'restoreVersion', 'owner',
    'Make version n current again. Adds a new version copied from n, so nothing is lost'],
  ['POST', `/api/artifacts/${SLUG}/visibility`, 'visibility', 'owner', '`?to=public` or `?to=private`; making public pages private revokes old share links'],
  ['POST', `/api/artifacts/${SLUG}/share`, 'rotateShare', 'owner', 'Revoke the old share link and return a new owner-only share_url'],
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
    'Create a user: body `{"name": "bob"}`, add `"admin": true` for an admin, or `"claims_only": true` for a token that can only make claim links (for CI). Returns the token once'],
  ['POST', '/api/me/token', 'rotateOwnToken', 'token',
    'Replace your own token, e.g. if it leaked. Returns the new one once; the old one stops working'],
  ['POST', '/api/users/(?<name>[^/]+)/token', 'resetToken', 'admin',
    'Issue a new token for a user who lost theirs. Their pages are untouched; the old token stops working'],
  ['DELETE', '/api/users/(?<name>[^/]+)', 'deleteUser', 'admin', 'Delete a user and all of their pages'],
  ['POST', '/api/users/(?<name>[^/]+)/claim', 'claimLink', 'admin, or a claims-only token',
    'A one-time link that shows the user a new token in their browser, making the user if there is none. Returns `claim_path`, `claim_url` and `expires_at`, never the token, so it can run in a CI log (README: Users and admins). A new link replaces an unused one; the old token works until the link is used. With GitHub sign-in on, NAME is a GitHub login, and only someone signed in to GitHub as it gets the token'],
  ['GET', '/api/oidc/login', 'oidcLogin', 'anyone', 'Sign in through the OIDC provider (single sign-on, when it\'s set up); `?next=` is where to go after'],
  ['GET', '/api/oidc/callback', 'oidcCallback', 'anyone', 'Where the OIDC provider sends the browser back after signing in'],
  ['POST', '/api/oidc/logout', 'oidcLogout', 'anyone', 'Sign out: ends this browser\'s session, and the provider\'s too if it offers that'],
  ['GET', '/account', 'account', 'signed in', 'Your account: make or replace your API token (for the CLI, MCP and scripts); an admin also sees the users'],
  ['GET', '/api/claim/callback', 'claimCallback', 'anyone', 'Where GitHub sends someone back after signing in for a claim link (with GitHub sign-in on)'],
  ['GET', '/api/claim/(?<code>[\\w-]+)', 'claimPage', 'anyone with the link', 'The claim link: whose token it shows, and a button that shows it'],
  ['POST', '/api/claim/(?<code>[\\w-]+)', 'claim', 'anyone with the link', 'Show the token, once: it replaces the user\'s old one, and the link stops working. With GitHub sign-in on, it first sends you to sign in to GitHub as the link\'s account'],
].map(([method, path, handler, who, doc]) => ({ method, path, handler, who, doc, re: new RegExp(`^${path}$`, 'u'), label: routeLabel(path) }))
  .sort((a, b) => routePriority(a) - routePriority(b));

/** An address for a Location header, which is ASCII: anything else in it, percent-encoded. */
const asciiLocation = (path) => path.replace(/[^\x00-\x7f]+/gu, encodeURIComponent);
/** A page's address for a Location header. */
const pageLocation = (slug) => asciiLocation(pageUrl(slug));

function routePriority(r) {
  if (r.handler === 'render') return 4;
  if (r.handler === 'folder') return 3;
  if (['describe', 'put', 'review'].includes(r.handler)) return 2;
  return 0;
}

// Handlers a claims-only token may call (see Ctx.user's `claims`).
const CLAIMS_OK = new Set(['me', 'rotateOwnToken', 'claimLink']);

// With SSO on, what can be reached without signing in: signing in itself, health checks,
// the files the sign-in pages need, claim links (they carry their own proof), and the
// command line's package (the same MIT code as on GitHub; npm can't sign in to fetch it).
const OPEN_WITH_SSO = new Set(['oidcLogin', 'oidcCallback', 'oidcLogout', 'health', 'static', 'font', 'notFound',
  'claimPage', 'claim', 'claimCallback', 'cliInfo', 'cliLatest', 'cliTarball']);

/**
 * Not signed in: a browser opening a page is sent to sign in, and comes back here after;
 * anything else gets a 401. `path` as the browser sent it, still percent-encoded, so the
 * address it comes back to can go in a Location header.
 */
function signInFirst(c, path) {
  const h = c.req.headers;
  const opening = (c.req.method === 'GET' || c.head) && (h['sec-fetch-dest'] === 'document' || (!h['sec-fetch-dest'] && /text\/html/.test(h.accept || '')));
  if (opening) {
    const next = encodeURIComponent(path + c.url.search);
    return c.send(302, 'text/plain; charset=utf-8', '', { Location: `/api/oidc/login?next=${next}`, 'Cache-Control': 'no-store' });
  }
  throw new ApiError(401, 'sign in, or send a bearer token');
}

const CLAIM_HEADERS = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Robots-Tag': 'noindex' };
// The sign-in under way, so GitHub's answer is taken only in the browser that asked (login CSRF).
const CLAIM_COOKIE = 'html_server_claim';
const githubCallback = (c, gh) => gh.callbackUrl || `${c.origin()}/api/claim/callback`;

/**
 * Who signed in, from GitHub: the code exchanged for a token (the app's secret stays on this
 * server), then their login, numeric id and email addresses. The token is revoked straight
 * after (best effort): nothing of GitHub's is kept.
 */
async function githubUser(gh, code, redirectUri) {
  const exchange = await fetch(`${gh.web}/login/oauth/access_token`, {
    method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': 'html-server' },
    body: JSON.stringify({ client_id: gh.clientId, client_secret: gh.clientSecret, code, redirect_uri: redirectUri }),
  });
  const { access_token: token, error, error_description: why } = await exchange.json().catch(() => ({}));
  if (!token) throw new Error(why || error || `GitHub answered ${exchange.status}`);
  const headers = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'html-server' };
  const get = async (path) => {
    const r = await fetch(`${gh.api}${path}`, { headers });
    if (!r.ok) throw new Error(`GitHub ${path}: ${r.status}`);
    return r.json();
  };
  try {
    const [user, emails] = await Promise.all([get('/user'), get('/user/emails')]);
    return { login: user.login, id: user.id, emails };
  } finally {
    await fetch(`${gh.api}/applications/${encodeURIComponent(gh.clientId)}/token`, {
      method: 'DELETE', body: JSON.stringify({ access_token: token }),
      headers: { Authorization: `Basic ${Buffer.from(`${gh.clientId}:${gh.clientSecret}`).toString('base64')}`, Accept: 'application/vnd.github+json', 'User-Agent': 'html-server', 'Content-Type': 'application/json' },
    }).catch(() => {});
  }
}
const COMPRESSIBLE = /^(text\/|application\/json|image\/svg)/;
const STATIC_TYPES = { css: 'text/css; charset=utf-8', js: 'text/javascript; charset=utf-8', svg: 'image/svg+xml' };

class Ctx {
  constructor(store, req, res, url, csp = RENDER_CSP) {
    Object.assign(this, { store, req, res, url, query: url.searchParams, csp });
  }

  send(status, type, body, headers = {}) {
    let buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
    // Text goes gzipped to clients that take it: notes carry their styles and fonts inline.
    // Vary on every response, gzipped or not, so a cache never hands a gzipped copy to a
    // client that didn't ask for one; and text is never sniffed as something else.
    headers = { Vary: 'Accept-Encoding', ...(COMPRESSIBLE.test(type) ? { 'X-Content-Type-Options': 'nosniff' } : {}), ...headers };
    if (buf.length > 1024 && COMPRESSIBLE.test(type) && /\bgzip\b/.test(this.req.headers['accept-encoding'] || '')) {
      buf = gzipSync(buf);
      headers = { ...headers, 'Content-Encoding': 'gzip' };
    }
    this.status = status; // for the usage stats
    this.res.writeHead(status, { 'Content-Type': type, 'Content-Length': buf.length, ...headers });
    this.res.end(this.head ? undefined : buf); // HEAD: the same status and headers, no body
  }

  json(status, obj) { this.send(status, 'application/json', JSON.stringify(obj, null, 2) + '\n'); }
  /** A page of the site's own. Signed in through SSO, its <body> says as whom, for its scripts (the top bar, Upload, comments). */
  html(body) {
    const u = this.sessionUser();
    if (u) body = body.replace('<body ', `<body data-sso-user="${u.name.replace(/[&"<>]/g, (ch) => `&#${ch.charCodeAt(0)};`)}" `);
    this.send(200, 'text/html; charset=utf-8', body);
  }
  text(body) { this.send(200, 'text/plain; charset=utf-8', body); }

  /** Adapt a complete delivery result to HTTP; only trusted site pages get SSO identity. */
  deliver(kind, key) {
    const cookie = this.req.headers.cookie || '';
    const delivery = new PageDelivery(this.store, {
      query: this.url.search, document: this.req.headers['sec-fetch-dest'] === 'document',
      viewer: () => this.viewerId(), visit: this.visit(), sso: !!sso(),
      theme: cookie.match(/(?:^|;\s*)theme=(dark|light)/)?.[1],
      sidebar: cookie.match(/(?:^|;\s*)sidebar=(hidden)(?:;|$)/)?.[1],
    });
    const result = delivery[kind](key);
    if (result.kind === 'site') return this.html(result.body);
    if (result.kind === 'redirect') return this.send(302, 'text/plain', '', {
      Location: asciiLocation(result.location), ...(result.noStore ? { 'Cache-Control': 'no-store' } : {}),
    });
    this.send(200, 'text/html; charset=utf-8', result.body, {
      'Content-Security-Policy': result.preview ? PREVIEW_CSP : this.csp, 'X-Content-Type-Options': 'nosniff',
    });
  }

  /** ?page=<name>[&depth=n]: a local graph around one page (depth 1-3, default 1). */
  graphScope() {
    const depth = this.int('depth');
    if (depth != null && (depth < 1 || depth > 3)) throw new ApiError(400, 'depth must be 1, 2 or 3');
    return { focus: this.query.get('page') || undefined, depth: depth ?? 1 };
  }

  /**
   * A gallery listing, or with ?fragment just its cards (what live search swaps in).
   * `page()` gives what only the whole page shows (its categories and total), so a
   * fragment, asked for at every key pressed, doesn't work them out.
   */
  listing(items, opts, page = () => ({})) {
    const base = opts.base || (opts.section === 'gallery' ? '/gallery' : '/');
    // Previous and Next keep everything else in the address (search, tag, order, layout).
    if (opts.pages > 1) {
      const keep = new URLSearchParams(this.query);
      keep.delete('fragment');
      opts.pager = pagerNav(opts.page, opts.pages, (n) => {
        const p = new URLSearchParams(keep);
        if (n > 1) p.set('page', String(n)); else p.delete('page');
        return `${base}${p.size ? `?${p}` : ''}`;
      });
    }
    if (this.query.get('fragment')) return this.html(resultsBody(items, opts.q, { base, page: opts.page, pager: opts.pager, count: countLabel(items, opts) }));
    const view = VIEWS.includes(this.query.get('view')) ? this.query.get('view') : 'grid';
    this.html(galleryPage(items, { ...opts, ...page(), view, explorer: this.explorer() }));
  }

  /** ?page= for the home page and folders: which PAGE_SIZE cards to show (1, the first, unless given). */
  pageNumber() {
    const n = this.int('page') ?? 1;
    if (!Number.isInteger(n) || n < 1 || n > 1e6) throw new ApiError(400, 'page must be a page number, from 1');
    return n;
  }

  /** The page that shows a claimed token, once, with how to use it here. */
  claimed(shown) { return claimedPage({ ...shown, server: this.origin(), cli: !!cliPackage() }); }

  /** The docs page's Markdown: CLI, MCP and API (pages.js docsMarkdown). */
  docs() { return docsMarkdown(this.origin(), ROUTES, { tools: MCP_TOOLS, cliHere: !!cliPackage() }); }
  /** The viewer's pages, for the explorer in every page's sidebar. */
  explorer() { return this.store.explorer(this.viewerId()); }

  /** ?days= for the usage stats: a number of days (default 30), or `all`. */
  usageDays() {
    if (this.query.get('days') === 'all') return null;
    const d = this.int('days') ?? 30;
    if (!Number.isInteger(d) || d < 1 || d > 36500) throw new ApiError(400, 'days must be a number of days, or all');
    return d;
  }

  /** ?weeks= for /stats's Popular list: a number of weeks (default POPULAR_WEEKS), or `all`. */
  popularWeeks() {
    if (this.query.get('weeks') === 'all') return null;
    const w = this.int('weeks') ?? POPULAR_WEEKS;
    if (w < 1 || w > POPULAR_MAX_WEEKS) throw new ApiError(400, `weeks must be a number of weeks (1-${POPULAR_MAX_WEEKS}), or all`);
    return w;
  }

  /**
   * This server's address as people reach it: HTML_SERVER_PUBLIC_URL (or OIDC_REDIRECT_URI's)
   * when set; else as this request reached it, behind a proxy that terminates TLS with the
   * scheme it says it used.
   */
  origin() { return publicOrigin() ?? this.requestOrigin(); }

  /** This server as this request reached it: behind a proxy that terminates TLS, the scheme it says it used. */
  requestOrigin() {
    const proto = String(this.req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
    return `${proto === 'https' ? 'https' : 'http'}://${this.req.headers.host || 'localhost'}`;
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

  /**
   * Who's asking: the bearer token's user, or a browser signed in through SSO. A claims-only
   * token works only where `claims` says it may (making claim links, /api/me). With SSO, the
   * token of someone who signs in through it stops working after OIDC_TOKEN_IDLE_DAYS
   * without signing in, so people the provider has removed lose API access too.
   */
  user({ admin = false, claims = false } = {}) {
    const auth = this.req.headers.authorization || '';
    let u;
    if (auth.startsWith('Bearer ')) {
      u = this.store.userForToken(auth.slice(7).trim());
      if (!u) throw new ApiError(401, 'bad token');
      const s = sso();
      if (s?.tokenIdleDays && u.oidc_sub != null && (u.last_sso_at ?? 0) < Date.now() / 1000 - s.tokenIdleDays * 86400) {
        throw new ApiError(401, `this token stopped working: its owner hasn't signed in for ${s.tokenIdleDays} days. Sign in at ${this.origin()}/account and it works again`);
      }
    } else {
      u = this.sessionUser();
      if (!u) throw new ApiError(401, sso() ? 'sign in, or send a bearer token' : 'missing bearer token');
    }
    this.actorId = u.id; // keep the authenticated identity even if a handler rotates its token
    if (u.claims_only && !claims) throw new ApiError(403, 'this token can only make claim links');
    if (admin && !u.is_admin) throw new ApiError(403, 'admin only');
    return u;
  }

  /** Reads are open: no token means anonymous (or, with SSO, the signed-in browser); a bad token is still an error. */
  viewerId() { return this.req.headers.authorization ? this.user().id : this.sessionUser()?.id ?? null; }

  /**
   * The browser's signed-in user (SSO), or null. Its cookie counts for this site's own pages
   * and for opening an address (a link, a bookmark), never for a request an uploaded page
   * makes: pages are sandboxed with an opaque origin, so theirs arrive cross-site, or with
   * Origin: null, and get nothing of the viewer's. A change (anything but GET) also has to
   * come from this site's pages (its Origin), so another site can't make one (CSRF).
   */
  sessionUser() {
    if (this.session !== undefined) return this.session;
    this.session = null;
    if (!sso()) return null;
    const h = this.req.headers;
    const id = (h.cookie || '').match(new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([\\w-]+)`))?.[1];
    if (!id || h.origin === 'null') return null;
    const read = this.req.method === 'GET' || this.req.method === 'HEAD';
    const site = h['sec-fetch-site'];
    const opening = read && h['sec-fetch-mode'] === 'navigate' && h['sec-fetch-dest'] === 'document';
    if (site && site !== 'same-origin' && site !== 'none' && !opening) return null;
    // Its public address, or the one this request came to (an admin on the machine itself).
    if (!read && h.origin !== this.origin() && h.origin !== this.requestOrigin()) return null;
    this.session = this.store.sessionUser(id);
    if (this.session && !h.authorization) this.actorId = this.session.id;
    return this.session;
  }
  /**
   * Who's viewing, for the view count; null for HEAD (link checkers and uptime monitors aren't
   * views). Behind a reverse proxy every request comes from the proxy, so the client's own
   * address is the first in X-Forwarded-For when there is one. Only ever hashed into a daily
   * visitor id: someone setting it themselves can only count as more visitors, as they could
   * by changing their user agent.
   */
  visit() {
    if (this.head) return null;
    const forwarded = String(this.req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    return [forwarded || this.req.socket.remoteAddress, this.req.headers['user-agent'] || ''];
  }
}

const handlers = {
  // --- reads, open to everyone subject to visibility ---
  gallery(c) {
    const q = (c.query.get('q') || '').trim();
    const category = c.query.get('category') || '';
    const sort = c.query.get('sort') || '';
    const page = c.pageNumber();
    const items = c.store.list(null, { q: q || undefined, category: category || undefined, sort: sort || undefined,
      limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE, snippets: CARD_SNIPPETS });
    // Counted, not the cards: a listing shows one page of them.
    const total = c.store.count(null, { category: category || undefined });
    const found = q ? c.store.count(null, { q, category: category || undefined }) : total;
    c.listing(items, { q, category, sort, section: 'pages', total, found, page, pages: Math.ceil(found / PAGE_SIZE) },
      () => ({ categories: c.store.categories(null) }));
  },
  folders(c) {
    const paths = new Set();
    for (const a of c.store.explorer(c.viewerId())) {
      const parts = a.slug.split('/');
      for (let i = 1; i < parts.length; i++) paths.add(parts.slice(0, i).join('/'));
    }
    c.json(200, [...paths].sort());
  },
  folder(c, { folder }) {
    try { validatePath(folder, { folder: true }); } catch { throw new ApiError(404, 'no such folder'); }
    const viewer = c.viewerId();
    const { folders } = c.store.folder(folder, viewer);
    const q = (c.query.get('q') || '').trim(), sort = c.query.get('sort') || '';
    const recursive = !!q || c.query.get('recursive') === '1';
    const category = c.query.get('category') || '';
    const page = c.pageNumber();
    const opts = { folder, recursive, q, sort: sort || undefined, category, limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE };
    const items = c.store.list(viewer, opts);
    const total = c.store.count(viewer, { folder, recursive, category });
    const found = q ? c.store.count(viewer, { folder, recursive, category, q }) : total;
    c.listing(items, { q, sort, category, section: 'pages', base: `/${encodePath(folder)}/`, folder, folders,
      recursive, total, found, page, pages: Math.ceil(found / PAGE_SIZE) });
  },
  async movePages(c) {
    const user = c.user();
    const body = await c.jsonBody();
    c.json(200, { results: c.store.movePages(user.id, body.moves) });
  },
  stats(c) { c.html(statsPage(c.store.stats(c.viewerId(), { popular: c.popularWeeks() }), { explorer: c.explorer() })); },
  statsData(c) { c.json(200, c.store.stats(c.viewerId(), { popular: c.popularWeeks() })); },
  random(c) {
    const filter = (k) => c.query.get(k) || undefined;
    const folder = filter('folder');
    const slug = c.store.random(c.viewerId(), { not: filter('not'), folder, category: filter('category') });
    // Nothing to pick from: the folder or the home page, which say so.
    const to = slug ? pageLocation(slug) : folder ? `/${encodePath(folder)}/` : '/';
    c.send(302, 'text/plain', '', { Location: to, 'Cache-Control': 'no-store' });
  },
  usageData(c) { c.user({ admin: true }); c.json(200, c.store.usage({ days: c.usageDays() })); },
  usage(c) { c.user({ admin: true }); c.html(usageSection(c.store.usage({ days: c.usageDays() }))); },
  personData(c, { name }) { const u = c.user({ admin: true }); c.json(200, c.store.personActivity(name, { days: c.usageDays() }, u.id)); },
  person(c, { name }) { const u = c.user({ admin: true }); c.html(personSection(c.store.personActivity(name, { days: c.usageDays() }, u.id))); },
  graph(c) { c.html(graphPage(c.store.graph(c.viewerId(), c.graphScope()), { explorer: c.explorer() })); },
  graphData(c) { c.json(200, c.store.graph(c.viewerId(), c.graphScope())); },
  examples(c) {
    const q = (c.query.get('q') || '').trim();
    const category = c.query.get('category') || '';
    const found = findExamples({ q, category });
    c.listing(found, { q, category, section: 'gallery', total: q ? findExamples({ category }).length : found.length, found: found.length },
      () => ({ categories: exampleCategories() }));
  },
  example(c, { file }) { c.deliver('example', file); },
  docs(c) { c.html(markdownPage({ title: 'Docs', md: c.docs(), active: 'docs', sourceUrl: '/docs.md', explorer: c.explorer() })); },
  docsSource(c) { c.send(200, 'text/markdown; charset=utf-8', c.docs()); },
  about(c) { c.html(markdownPage({ title: 'About', md: aboutMarkdown(), active: 'about', sourceUrl: '/about.md', explorer: c.explorer() })); },
  aboutSource(c) { c.send(200, 'text/markdown; charset=utf-8', aboutMarkdown()); },
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
  render(c, { slug }) { c.deliver('named', slug); },
  renderShare(c, { share }) { c.deliver('shared', share); },
  // Always the shell: the script loads the page with the viewer's saved token, so
  // private pages work and missing ones show "not found" in place.
  review(c, { slug }) { c.html(reviewPage(slug)); },
  history(c, { slug }) { c.deliver('history', slug); },
  reviewChanges(c, { slug }) { c.deliver('changes', slug); },
  list(c) {
    const viewer = c.viewerId();
    const state = c.query.get('state') || ACTIVE;
    if (![ACTIVE, TRASHED].includes(state)) throw new ApiError(400, 'state must be active or trashed');
    if (state === TRASHED && viewer == null) throw new ApiError(401, 'trash is visible to its owner only');
    c.json(200, c.store.list(viewer, {
      q: c.query.get('q') || undefined,
      state,
      limit: Math.min(c.int('limit') ?? 50, LIST_LIMIT),
      offset: c.int('offset') ?? 0,
      owner: c.query.get('owner') || undefined,
      category: c.query.get('category') || undefined,
      source: c.query.get('source') || undefined,
      folder: c.query.get('folder') ?? undefined,
      recursive: c.query.get('recursive') !== '0',
      sort: c.query.get('sort') || undefined,
    }));
  },
  categories(c) { c.json(200, c.store.categories(c.viewerId())); },
  assetFile(c, { slug }) {
    const a = c.store.asset(slug);
    // A private note's file links carry its share id (?from=), like its share link. With SSO,
    // someone not signed in gets a file only through the page whose share id that is: a
    // public page's files are for signed-in people, like the page.
    const signedIn = !sso() || !!c.req.headers.authorization || !!c.sessionUser();
    if (!a || !c.store.canReadAsset(a, c.viewerId(), { via: c.query.get('from'), publicPages: signedIn })) throw new ApiError(404, 'no such asset');
    // SVG can carry script: serve it (and everything) sandboxed and unsniffed. Private: who may have it depends on who asks.
    c.send(200, a.mime, Buffer.from(a.data), { 'Content-Security-Policy': c.csp, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, no-cache' });
  },
  assets(c) { c.json(200, c.store.listAssets(c.user())); },
  /** Up, and the database answers. Says nothing else, whatever went wrong: anyone may ask. */
  health(c) {
    try {
      c.store.one('SELECT 1 AS ok');
    } catch (e) {
      console.error('health check: the database did not answer:', e.message);
      return c.send(503, 'application/json', `${JSON.stringify({ status: 'unavailable' })}\n`, { 'Cache-Control': 'no-store' });
    }
    c.send(200, 'application/json', `${JSON.stringify({ status: 'ok' })}\n`, { 'Cache-Control': 'no-store' });
  },
  /** Where to install the command line from: this server, if it can offer its package. */
  cliInfo(c) {
    const pkg = cliPackage();
    if (!pkg) return c.json(200, { version: null, tarball: null, install: CLI_FROM_GITHUB });
    const tarball = `${c.origin()}/api/cli/html-server.tgz`;
    c.json(200, { version: pkg.version, tarball, install: `npm install -g ${tarball}` });
  },
  /** The package, by a name that always means this server's version. */
  cliLatest(c) {
    const pkg = cliPackage();
    if (!pkg) throw new ApiError(404, `this server can't offer its command line; install it with: ${CLI_FROM_GITHUB}`);
    c.send(302, 'text/plain; charset=utf-8', '', { Location: `/api/cli/html-server-${pkg.version}.tgz`, 'Cache-Control': 'no-store' });
  },
  cliTarball(c, { version }) {
    const pkg = cliPackage();
    if (!pkg) throw new ApiError(404, `this server can't offer its command line; install it with: ${CLI_FROM_GITHUB}`);
    if (version !== pkg.version) throw new ApiError(404, `this server has version ${pkg.version} only: /api/cli/html-server-${pkg.version}.tgz`);
    const etag = `"${pkg.sha256}"`;
    const headers = { ETag: etag, 'Cache-Control': 'public, max-age=3600', 'Content-Disposition': `attachment; filename="html-server-${pkg.version}.tgz"` };
    if (c.req.headers['if-none-match'] === etag) return c.send(304, 'application/gzip', '', headers);
    c.send(200, 'application/gzip', pkg.data, headers);
  },
  notFound(c) { c.send(404, 'application/json', `${JSON.stringify({ error: 'not found' })}\n`, { 'Cache-Control': 'public, max-age=86400' }); },
  async putAsset(c, { slug }) { const u = c.user(); c.json(200, c.store.putAsset(u.id, slug, await c.body())); },
  deleteAsset(c, { slug }) { c.store.deleteAsset(c.user().id, slug); c.json(200, { deleted: slug }); },
  search(c) {
    const q = (c.query.get('q') || '').trim();
    if (!q) throw new ApiError(400, 'search needs ?q=');
    const tag = c.query.get('tag') || undefined;
    const results = c.store.list(c.viewerId(), { q, category: tag, folder: c.query.get('folder') ?? undefined, sort: c.query.get('sort') || undefined, limit: Math.min(c.int('limit') ?? 20, 200) });
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
  me(c) {
    const u = c.user({ claims: true });
    c.json(200, { name: u.name, is_admin: !!u.is_admin, ...(u.claims_only ? { claims_only: true } : {}) });
  },
  listUsers(c) { c.user({ admin: true }); c.json(200, c.store.listUsers()); },
  async createUser(c) {
    c.user({ admin: true });
    const data = await c.jsonBody();
    const name = c.store.normalizeUsername(data.name);
    const token = c.store.createUser(name, !!data.admin, { claimsOnly: !!data.claims_only });
    c.json(201, { name, token, note: 'shown once; store it' });
  },
  rotateOwnToken(c) {
    const u = c.user({ claims: true }); // a claims-only token can replace itself, e.g. if CI's secret leaked
    c.json(200, { name: u.name, token: c.store.resetToken(u.name), note: 'shown once; the old token no longer works' });
  },
  resetToken(c, { name }) {
    c.user({ admin: true });
    c.json(200, { name, token: c.store.resetToken(name), note: 'shown once; the old token no longer works' });
  },
  claimLink(c, { name }) {
    const u = c.user({ claims: true });
    if (!u.is_admin && !u.claims_only) throw new ApiError(403, 'admin or claims-only token only');
    if (githubSignIn()) { // the link is for a GitHub account; whose account here is settled at sign-in
      const { github_login, code, expires_at } = c.store.claimLink(name, { limited: !u.is_admin, github: true });
      const path = `/api/claim/${code}`;
      return c.json(201, { github_login, sign_in: 'github', claim_path: path, claim_url: c.origin() + path, expires_at });
    }
    const { name: user, code, expires_at, created } = c.store.claimLink(name, { limited: !u.is_admin });
    const path = `/api/claim/${code}`;
    c.json(201, { name: user, created, claim_path: path, claim_url: c.origin() + path, expires_at });
  },
  // The link's pages: never cached, and sent nowhere as a Referer, since the code is in the address.
  claimPage(c, { code }) {
    const claim = c.store.claimFor(code);
    c.send(claim ? 200 : 410, 'text/html; charset=utf-8', claimPage(claim), CLAIM_HEADERS);
  },
  claim(c, { code }) {
    const gh = githubSignIn();
    if (c.store.claimFor(code)?.github_login && gh) { // sign in to GitHub first, from this browser
      const { state, login } = c.store.startGitHubClaim(code);
      const q = new URLSearchParams({ client_id: gh.clientId, redirect_uri: githubCallback(c, gh), scope: 'user:email', state, login, allow_signup: 'false' });
      return c.send(303, 'text/plain; charset=utf-8', '', { ...CLAIM_HEADERS, Location: `${gh.web}/login/oauth/authorize?${q}`,
        'Set-Cookie': `${CLAIM_COOKIE}=${state}; Path=/api/claim; Max-Age=${15 * 60}; HttpOnly; SameSite=Lax${c.origin().startsWith('https:') ? '; Secure' : ''}` });
    }
    let shown;
    try { shown = c.store.claimToken(code); } catch (e) {
      if (e.status !== 410) throw e;
      return c.send(410, 'text/html; charset=utf-8', claimPage(null), CLAIM_HEADERS);
    }
    c.send(200, 'text/html; charset=utf-8', c.claimed(shown), CLAIM_HEADERS);
  },
  // --- single sign-on ---
  async oidcLogin(c) {
    if (!sso()) throw new ApiError(404, "single sign-on isn't set up on this server");
    const { url, cookie } = await startLogin(c.origin(), c.query.get('next'));
    c.send(302, 'text/plain; charset=utf-8', '', { Location: url, 'Set-Cookie': cookie, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
  },
  async oidcCallback(c) {
    const s = sso();
    if (!s) throw new ApiError(404, "single sign-on isn't set up on this server");
    const secure = c.origin().startsWith('https:');
    const headers = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'Set-Cookie': clearLoginCookie(secure) };
    const problem = (status, title, text) => c.send(status, 'text/html; charset=utf-8', claimProblemPage(title, text), headers);
    if (c.query.get('error')) return problem(403, "Signing in didn't finish", `The sign-in service said: ${c.query.get('error_description') || c.query.get('error')}.`);
    let who;
    try { who = await finishLogin(c.origin(), `${c.origin()}${c.url.pathname}${c.url.search}`, c.req.headers.cookie); } catch (e) {
      if (e.status === 400) return problem(400, "This sign-in didn't start in this browser", 'Open the page you wanted again, and sign in from there.');
      console.error('sign-in:', e.message);
      return problem(502, "Couldn't finish signing in", 'Try again. If it keeps happening, tell an admin.');
    }
    let u;
    try { u = c.store.ssoSignIn(who); } catch (e) {
      if ([400, 403, 409].includes(e.status)) return problem(e.status, "You can't sign in yet", `${e.message}.`);
      throw e;
    }
    const id = c.store.createSession(u.id, s.sessionHours);
    c.send(302, 'text/plain; charset=utf-8', '', { ...headers, Location: asciiLocation(who.next), 'Set-Cookie': [sessionCookie(id, s.sessionHours, secure), clearLoginCookie(secure)] });
  },
  async oidcLogout(c) {
    const secure = c.origin().startsWith('https:');
    c.store.endSession((c.req.headers.cookie || '').match(new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([\\w-]+)`))?.[1]);
    c.send(303, 'text/plain; charset=utf-8', '', { Location: sso() ? await logoutUrl(c.origin()) : '/', 'Set-Cookie': clearSessionCookie(secure), 'Cache-Control': 'no-store' });
  },
  account(c) {
    const s = sso();
    if (!s) return c.html(accountPage({ sso: null }));
    const u = c.user();
    c.html(accountPage({ user: u, sso: s, server: c.origin(), cli: !!cliPackage(), users: u.is_admin ? c.store.listUsers() : null, trackPeople: c.store.trackPeople }));
  },

  /** Back from GitHub: who signed in, checked against the link, then the token, once. */
  async claimCallback(c) {
    const headers = { ...CLAIM_HEADERS, 'Set-Cookie': `${CLAIM_COOKIE}=; Path=/api/claim; Max-Age=0; HttpOnly; SameSite=Lax` };
    const problem = (status, title, text) => c.send(status, 'text/html; charset=utf-8', claimProblemPage(title, text), headers);
    const gh = githubSignIn();
    if (!gh) return problem(404, "GitHub sign-in isn't set up here", 'Ask an admin for a new claim link.');
    if (c.query.get('error')) return problem(403, 'GitHub sign-in was cancelled', 'Open your claim link again to try again.');
    const state = c.query.get('state') || '', code = c.query.get('code') || '';
    const started = (c.req.headers.cookie || '').match(new RegExp(`(?:^|;\\s*)${CLAIM_COOKIE}=([\\w-]+)`))?.[1];
    if (!state || !code || started !== state) {
      return problem(400, "This sign-in didn't start in this browser", 'Open your claim link again in the browser you want to use, and press Continue with GitHub.');
    }
    let who;
    try { who = await githubUser(gh, code, githubCallback(c, gh)); } catch (e) {
      console.error('GitHub sign-in:', e.message);
      return problem(502, "Couldn't check who you are with GitHub", 'Open your claim link again to try again. If it keeps happening, tell an admin.');
    }
    let shown;
    try { shown = c.store.finishGitHubClaim(state, who); } catch (e) {
      if (e.status === 410) return c.send(410, 'text/html; charset=utf-8', claimPage(null), headers);
      if ([400, 403, 409, 502].includes(e.status)) {
        return problem(e.status, e.message.startsWith('this link is for') ? "This link isn't for you" : "Your token can't be made", `${e.message}.`);
      }
      throw e;
    }
    c.send(200, 'text/html; charset=utf-8', c.claimed(shown), headers);
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
      renameFrom: c.query.get('rename_from') ?? undefined, // set by `sync`: the file was renamed, in case only
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
  rotateShare(c, { slug }) { c.json(200, c.store.rotateShare(c.user().id, slug)); },
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
  return createServer((req, res) => {
    handleRequest(store, req, res, { csp }).catch((e) => {
      console.error(e);
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json', 'X-Content-Type-Options': 'nosniff' }).end('{"error":"internal error"}');
      else res.destroy();
    });
  });
}

/**
 * One request, Node-style (`req`: method, url, headers, socket.remoteAddress, and the
 * body as an async iterable; `res`: writeHead, end, headersSent). makeServer wires it to
 * node:http; other runtimes adapt their own requests to it (cloudflare/worker.js).
 * `csp`: the policy rendered pages are sent with (default: RENDER_CSP).
 */
export async function handleRequest(store, req, res, { csp = RENDER_CSP } = {}) {
  {
    let url;
    try { url = new URL(req.url, 'http://localhost'); } catch {
      res.writeHead(400, { 'Content-Type': 'application/json', 'X-Content-Type-Options': 'nosniff' });
      res.end(req.method === 'HEAD' ? undefined : '{"error":"bad URL"}');
      return;
    }
    const c = new Ctx(store, req, res, url, csp);
    c.head = req.method === 'HEAD';
    try {
      let path = url.pathname;
      try { path = decodeURIComponent(path); } catch { throw new ApiError(400, 'bad URL encoding'); }
      for (const r of ROUTES) {
        // HEAD is answered like GET (link checkers, uptime monitors, curl -I), without the body.
        const m = r.method === (c.head ? 'GET' : req.method) && r.re.exec(path);
        if (m) {
          c.route = r;
          // With SSO, a request needs a sign-in: a token that works (checked here, so a made-up
          // header gets nowhere) or the browser's session. A file by a page's link (?from=) is
          // checked by assetFile: only against that page's share link, never as "public".
          if (sso() && !OPEN_WITH_SSO.has(r.handler) && !(r.handler === 'assetFile' && c.query.get('from'))) {
            if (c.req.headers.authorization) c.user({ claims: CLAIMS_OK.has(r.handler) });
            else if (!c.sessionUser()) return signInFirst(c, c.url.pathname);
          }
          return await handlers[r.handler](c, m.groups || {});
        }
      }
      throw new ApiError(404, 'no route');
    } catch (e) {
      if (!e.status) console.error(e);
      if (!res.headersSent) c.json(e.status || 500, { error: e.status ? e.message : 'internal error' });
    } finally {
      // Health checks come every few seconds: neither logged nor counted as API use.
      if (c.route?.handler !== 'health') console.error(`${req.method} ${logPath(c, url)}`);
      if (url.pathname.startsWith('/api/') && !['docsSource', 'health'].includes(c.route?.handler)) recordApiCall(store, req, c);
    }
  }
}

/**
 * A request's path as the log shows it. Never a token or a query string, nor anything in the
 * path that works like a password: a claim link's code (a token until it's used) or a share
 * link's id (it opens a private page).
 */
function logPath(c, url) {
  const h = c.route?.handler;
  if (h === 'renderShare') return '/v/…';
  if (h?.startsWith('claim') && h !== 'claimLink' && h !== 'claimCallback') return '/api/claim/…';
  return url.pathname;
}

/** "/api/artifacts/(?<slug>…)" → "/api/artifacts/<slug>": how a route shows in the docs and the usage stats. */
function routeLabel(pattern) {
  return pattern.replace(/\(\?<(\w+)>[^)]*\)/g, '<$1>').replace(/(.)\/\?$/, '$1').replace(/\/\?/g, '/').replace(/\(\?:|\)\?/g, '').replace(/\\/g, '') || '/';
}

/**
 * One API request, for the usage stats: who called (the client's own label, else
 * browser or plain HTTP), the route's pattern rather than the path, the status, the
 * user. Never the query string, the body or the token. A failure here never fails
 * the request.
 */
const CLIENT_LABEL_RE = /^(mcp|cli)\/([a-z0-9_-]{1,40})$/i;
function recordApiCall(store, req, c) {
  try {
    const label = CLIENT_LABEL_RE.exec(req.headers['x-html-server-client'] || '');
    // Browsers send Sec-Fetch-Site on every request; curl, scripts and Node's fetch don't.
    const client = label ? label[1].toLowerCase() : req.headers['sec-fetch-site'] ? 'browser' : 'http';
    store.recordApiCall({ client, name: label ? label[2] : '', method: c.head ? 'HEAD' : req.method,
      route: c.route?.label ?? '(no route)', status: c.status ?? 500, userId: c.actorId ?? null });
  } catch (e) {
    console.error('usage stats: not recorded:', e.message);
  }
}
