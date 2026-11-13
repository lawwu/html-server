// Every tunable in one place, with the reason for its value.
import { homedir } from 'node:os';
import { fileText } from './files.js';
import { join } from 'node:path';

// The running version comes from package.json, so --version, the footer and the
// release links can never drift from what's installed.
export const VERSION = JSON.parse(fileText('package.json')).version;
/** Installing this version's command line from GitHub, where a server can't offer it itself (Cloudflare). */
export const CLI_FROM_GITHUB = `npm install -g github:lawwu/html-server#v${VERSION}`;
export const REPO_URL = 'https://github.com/lawwu/html-server';
export const RELEASE_URL = `${REPO_URL}/releases/tag/v${VERSION}`; // this version's release notes

// Everything this machine keeps lives in one private folder in the user's home,
// never next to the code (an npx or npm install puts code in a throwaway cache).
// HTML_SERVER_HOME moves it; --db points the server at a different database file.
export const HOME_DIR = process.env.HTML_SERVER_HOME || join(homedir(), '.html-server');
export const DEFAULT_DB = join(HOME_DIR, 'artifacts.db');
// Which server the CLI talks to, and as whom: written by `login` (or by the first
// `serve` on this machine), readable only by you. HTML_SERVER_URL and
// HTML_SERVER_TOKEN override it for one shell or script.
export const CREDENTIALS_FILE = join(HOME_DIR, 'credentials.json');
export const FALLBACK_URL = 'http://127.0.0.1:8765';
// Where `html-server backup` writes when no path is given; `--keep N` prunes here.
export const BACKUP_DIR = join(HOME_DIR, 'backups');
export const DEFAULT_HOST = '127.0.0.1';
export const DEFAULT_PORT = 8765;
export let MAX_BODY_BYTES = 16 * 1024 * 1024; // 16 MB per version

// A page's name is its uploaded file name: no slashes or spaces, starts with a letter or
// digit (of any script: "Über-uns.md" and "日本語メモ.md" are names too), up to 100 characters.
/** The extensions a page name may end in, which a bare name ("trip-plan") leaves off. */
export const PAGE_EXT_RE = /\.(html?|md|markdown|ipynb)$/i;
export const SLUG_RE = /^[\p{L}\p{N}][\p{L}\p{N}\p{M}._-]{0,99}$/u;
export const SLUG_HINT = 'a file name: letters, digits, . _ and -, starting with a letter or digit, up to 100 characters';
// Usernames are a per-deployment setting, stored in the database
// (`node src/server.js config usernames email`): short handles by default, or emails.
export const USERNAME_RULES = {
  name: { re: /^[a-z0-9][a-z0-9_-]{0,39}$/, hint: 'lowercase letters, digits, - and _ (up to 40)' },
  email: { re: /^[^\s@/]{1,64}@[^\s@/.]+(\.[^\s@/.]+)+$/, hint: 'an email address, like alice@example.com' },
};
export const DEFAULT_USERNAMES = 'name';
// A claim link (POST /api/users/NAME/claim) shows its user a new token once, in the browser,
// so the token never passes through whatever asked for the link (a GitHub workflow's log).
// Short, because the link itself may sit in that log: whoever opens it first gets the token.
export const CLAIM_LINK_MINUTES = 15;

// GitHub sign-in for claim links: with a GitHub OAuth app's ID and secret set, a claim link
// is for a GitHub account, and shows its token only to whoever signs in to GitHub as it
// (README: Tokens from a GitHub workflow). Set from the environment by `serve`, and by the
// Cloudflare Worker from its own: GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET, and optionally
// GITHUB_CALLBACK_URL (default: this server's /api/claim/callback, as the browser reached
// it) and GITHUB_URL / GITHUB_API_URL (GitHub Enterprise Server; also the tests' fake GitHub).
let GITHUB = null;
export function setGitHubSignIn(env = {}) {
  GITHUB = env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET ? {
    clientId: env.GITHUB_CLIENT_ID, clientSecret: env.GITHUB_CLIENT_SECRET, callbackUrl: env.GITHUB_CALLBACK_URL || '',
    web: (env.GITHUB_URL || 'https://github.com').replace(/\/+$/, ''), api: (env.GITHUB_API_URL || 'https://api.github.com').replace(/\/+$/, ''),
  } : null;
}
export const githubSignIn = () => GITHUB;

// Single sign-on through any OIDC provider (Microsoft Entra, Okta, Google Workspace,
// Keycloak…): with OIDC_ISSUER, OIDC_CLIENT_ID and OIDC_CLIENT_SECRET set, every page and
// API call needs a sign-in (a browser session) or an API token, and people make their own
// token on /account. Set from the environment by `serve` and by the Cloudflare Worker.
// README: Single sign-on.
export const SSO_SESSION_HOURS = 12; // a browser session; the provider's own session usually makes signing in again a click
export const SSO_TOKEN_IDLE_DAYS = 30; // an SSO user's API token stops working after this long without signing in (0: never)
let SSO = null;
export function setSso(env = {}) {
  const list = (v) => String(v ?? '').split(/[\s,]+/).filter(Boolean);
  const num = (v, fallback) => (v != null && v !== '' && Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : fallback);
  SSO = env.OIDC_ISSUER && env.OIDC_CLIENT_ID && env.OIDC_CLIENT_SECRET ? {
    issuer: env.OIDC_ISSUER, clientId: env.OIDC_CLIENT_ID, clientSecret: env.OIDC_CLIENT_SECRET,
    redirectUri: env.OIDC_REDIRECT_URI || '', // default: this server's /api/oidc/callback, as the browser reached it
    postLogoutRedirectUri: env.OIDC_POST_LOGOUT_REDIRECT_URI || '', // default: this server's /
    scopes: list(env.OIDC_SCOPES || 'openid profile email').join(' '),
    adminEmails: list(env.OIDC_ADMIN_EMAILS).map((e) => e.toLowerCase()),
    adminClaim: env.OIDC_ADMIN_CLAIM || '', adminClaimValues: list(env.OIDC_ADMIN_CLAIM_VALUES),
    sessionHours: num(env.OIDC_SESSION_HOURS, SSO_SESSION_HOURS) || SSO_SESSION_HOURS,
    tokenIdleDays: num(env.OIDC_TOKEN_IDLE_DAYS, SSO_TOKEN_IDLE_DAYS),
    allowInsecureHttp: env.OIDC_ALLOW_INSECURE_HTTP === 'true', // a provider on plain http: local testing only
  } : null;
}
export const sso = () => SSO;

// The address people use to reach this server, when a proxy in front of it changes what the
// server sees (it rewrites Host, or terminates TLS without saying so): HTML_SERVER_PUBLIC_URL,
// e.g. https://pages.company.com. Links the server writes (claim links, install commands,
// the docs) and its check that a signed-in browser's changes come from its own pages use it.
// Unset, the server goes by the Host header and X-Forwarded-Proto, and with single sign-on,
// by OIDC_REDIRECT_URI's address when that's set. Never X-Forwarded-Host: anyone can send it,
// and a cache in front could keep a page written for an address of their choosing.
let PUBLIC_ORIGIN = null;
export function setPublicUrl(env = {}) {
  const v = String(env.HTML_SERVER_PUBLIC_URL ?? '').trim();
  if (!v) { PUBLIC_ORIGIN = null; return; }
  let u;
  try { u = new URL(v); } catch { throw new Error('HTML_SERVER_PUBLIC_URL must be an address like https://pages.company.com'); }
  if (!/^https?:$/.test(u.protocol)) throw new Error('HTML_SERVER_PUBLIC_URL must start with https:// or http://');
  PUBLIC_ORIGIN = u.origin;
}
/** The configured public address's origin ("https://pages.company.com"), or null. */
export function publicOrigin() {
  if (PUBLIC_ORIGIN) return PUBLIC_ORIGIN;
  if (SSO?.redirectUri) { try { return new URL(SSO.redirectUri).origin; } catch { /* not an address: ignored */ } }
  return null;
}
// A GitHub login, up to 39 characters: letters and digits, with single hyphens between them;
// Enterprise Managed Users' logins also have an underscore before the enterprise's shortcode
// (`jdoe_acme`), so single underscores too.
export const GITHUB_LOGIN_RE = /^(?=.{1,39}$)[a-z0-9](?:[-_]?[a-z0-9])*$/i;
// Who may upload new versions of a page, per deployment (`config editing open`):
// "owner" — only the person who created it (the default, so upgrading never opens
// an existing server); "open" — any signed-in user, for public, active pages.
// Either way only the owner can trash, delete or change visibility.
export const EDITING_MODES = ['owner', 'open'];
export const DEFAULT_EDITING = 'owner';
// Email usernames are shown to anonymous visitors only as "alice@…", so a public
// gallery never publishes anyone's address. Signed-in users see them in full.
export const MASK_EMAILS_FOR_ANONYMOUS = true;
// Top-level paths the server itself uses, so no page may take these names.
export const RESERVED_SLUGS = new Set(['api', 'v', 'review', 'pages', 'history', 'gallery', 'graph', 'stats', 'random', 'assets', 'docs', 'about', 'account', 'healthz', 'favicon.ico', 'robots.txt']);

// How lists of pages can be sorted (?sort=, ls --sort), with their labels on the home
// page. Featured pages stay on top whichever is chosen. Searches sort by relevance
// unless asked otherwise.
export const SORTS = { updated: 'Recently updated', created: 'Newest', views: 'Most viewed', title: 'Title A–Z' };
export const SEARCH_SORT = 'relevance';

// Usage of the API, for admins on /stats: one row per /api request, with who called
// (the MCP tool or CLI command, from the client's X-HTML-Server-Client header; else
// "browser" when a browser sent it, or plain "http"), the route's pattern (never the
// query string, body or token) and the status. After this many days a request's row is
// folded into daily totals (per day, client, tool or command, method and route), which are
// kept for good: the long-run numbers stay, only who made each call goes.
export const API_CALL_RETENTION_DAYS = 90;
export const CLIENT_KINDS = ['mcp', 'cli', 'browser', 'http'];

export const VISIBILITIES = ['public', 'private'];
export const DEFAULT_VISIBILITY = 'public'; // everything visible unless an upload says private

// Rendered artifacts run in an opaque origin: scripts and forms work, but they
// cannot read this origin's storage or call the API as the viewer.
// allow-popups-to-escape-sandbox: a link a page opens in a new tab (target="_blank",
// window.open) gets an ordinary, unsandboxed tab. Without it the new tab inherits the
// sandbox, and sites like Jira that need their own storage and cookies only half load.
// The page itself stays sandboxed either way.
export const SANDBOX_DEFAULT = ['allow-scripts', 'allow-forms', 'allow-popups', 'allow-popups-to-escape-sandbox', 'allow-modals'];

// Every allow-* token the HTML sandbox accepts: what `serve --sandbox-allow` may add.
export const SANDBOX_TOKENS = [
  'allow-downloads', 'allow-forms', 'allow-modals', 'allow-orientation-lock', 'allow-pointer-lock', 'allow-popups',
  'allow-popups-to-escape-sandbox', 'allow-presentation', 'allow-same-origin', 'allow-scripts',
  'allow-storage-access-by-user-activation', 'allow-top-navigation', 'allow-top-navigation-by-user-activation',
  'allow-top-navigation-to-custom-protocols',
];

/**
 * The Content-Security-Policy for rendered pages: the default sandbox plus any extra
 * allow-* permissions this server instance was started with. Throws on a token the
 * sandbox doesn't know, naming the valid ones.
 */
export function renderCsp(extra = []) {
  const unknown = extra.filter((t) => !SANDBOX_TOKENS.includes(t));
  if (unknown.length) {
    throw new Error(`unknown sandbox permission${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}. `
      + `Valid: ${SANDBOX_TOKENS.join(', ')}`);
  }
  return `sandbox ${[...new Set([...SANDBOX_DEFAULT, ...extra])].join(' ')}`;
}

export const RENDER_CSP = renderCsp();
// A gallery card's preview (?preview=1) gets to run the page's scripts, so it can draw
// itself, and nothing else, whatever `serve --sandbox-allow` adds: a page in a list can't
// send the list's tab elsewhere, open windows or show alerts. (Not a sandbox attribute on
// the card's frame, which would also hold if the page navigated its frame: some embedded
// browsers refuse to load a sandboxed frame at all, leaving every card blank.)
export const PREVIEW_CSP = 'sandbox allow-scripts';

// Fuzzy search: each typed word also matches indexed words at least this similar
// (Ratcliff/Obershelp ratio, 0-1, the same measure as Python's difflib), so
// "sheling" finds "shelling". Words of 1-2 letters only prefix-match, because at
// that length nearly everything is "close".
export const FUZZY_CUTOFF = 0.75;
export const FUZZY_MIN_LEN = 3;
export const FUZZY_MAX_EXPANSIONS = 3; // per typed word, besides the longer words it starts
// Other forms of a typed word that some page uses match it too ("studies" finds
// "study", "running" finds "run"), up to this many per word.
export const MAX_WORD_FORMS = 4;
// Search ranking (FTS5 bm25 column weights): a hit in the title counts 10x a hit in
// the page text, and the file name ("kmeans-step-through.html" → "kmeans step
// through"), aliases and tags 5x. Pages whose title contains the whole query come
// first regardless, then pages with the words as typed, before pages found only
// through a typo or another form of a word.
export const SEARCH_WEIGHTS = { title: 10, name: 5, body: 1 };
// Snippets: about this many words around what matched. The home page writes them for
// its first cards only (the others show their description), so broad searches stay quick.
export const SNIPPET_WORDS = 12;
export const CARD_SNIPPETS = 48;
// How many cards the home page and a folder show at a time; Previous and Next (?page=N) for
// the rest. The same as CARD_SNIPPETS, so every card on show has its snippet.
export const PAGE_SIZE = 48;
// The most pages one /api/artifacts request returns (`?offset=` for the next ones).
export const LIST_LIMIT = 500;
// Text a page writes with JavaScript (a board's tickets, a quiz's questions, a chart's
// messages) is searchable too, up to this much of it per page.
export const SCRIPT_TEXT_CHARS = 20000;

// Page views: every render counts once. Visitors are a hash of (server secret,
// day, IP, user agent), so one person counts once per day and no IP or user agent
// is stored. Crawlers, link-preview fetchers (iMessage, Slack) and command-line
// clients are not counted.
export const BOT_UA_RE = /bot|crawl|spider|slurp|preview|facebookexternalhit|curl|wget|python-urllib|node/i;
export const VIEW_REPORT_DAYS = 30;
// /stats's Popular list: the pages with the most visits over the last 2 weeks, or the period
// picked from these (?weeks=, any number up to POPULAR_MAX_WEEKS, or all). A visit counts each
// visitor once a day per page, so reloading a page while you edit it doesn't make it popular.
export const POPULAR_WEEKS = 2;
export const POPULAR_CHOICES = [1, 2, 4, 8, 12, 26, 52];
export const POPULAR_MAX_WEEKS = 520;

// Table of contents: added to a page at render time (never to the stored version)
// when it has at least this many h2/h3 headings. public/toc.js decides placement;
// a page opts out with <meta name="toc" content="off">, a single view with ?toc=0.
export const TOC_MIN_HEADINGS = 3;

// Tags: server-side labels; manual tagging is capped at MAX_TAGS_PER_PAGE. A page's <meta name="category"> is
// added as a tag automatically; the rest are added and removed by the page's editors.
export const TAG_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
export const MAX_TAGS_PER_PAGE = 20;

// Assets: images (and PDFs) that notes embed, uploaded by `sync` or the API. Notes
// inline images as data: URIs when rendered, because pages are sandboxed and a sandbox
// may block loading files; MAX_INLINE_BYTES caps that per image (bigger ones link).
export const ASSET_TYPES = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif',
  svg: 'image/svg+xml', pdf: 'application/pdf',
};
export let MAX_ASSET_BYTES = 10 * 1024 * 1024;

/**
 * Lower the upload limits where the database can't hold more per row: a Cloudflare
 * Durable Object's SQLite stores at most 2 MB in one row (cloudflare/worker.js).
 */
export function setUploadLimits({ body, asset }) {
  if (body) MAX_BODY_BYTES = body;
  if (asset) MAX_ASSET_BYTES = asset;
}
export const MAX_INLINE_BYTES = 3 * 1024 * 1024;

export const MAX_COMMENT_CHARS = 10_000;
export const DIFF_CONTEXT_LINES = 3;
// The most work one diff may take, so none holds up the server (each limit is about 0.13 s
// on an M1 Max). Up to DIFF_MAX_CELLS lines × lines, an exact table of what the versions
// share (at most 50 MB); past that Myers' diff, whose memory is the lines alone and whose
// time grows with how much changed, for up to DIFF_MAX_STEPS steps. Past both: "too many
// changes to show". A 40,000-line page with a few edits takes a few milliseconds.
export const DIFF_MAX_CELLS = 25_000_000;
export const DIFF_MAX_STEPS = 10_000_000;
