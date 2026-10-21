// Every tunable in one place, with the reason for its value.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// The running version comes from package.json, so --version, the footer and the
// release links can never drift from what's installed.
export const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
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
export const MAX_BODY_BYTES = 16 * 1024 * 1024; // 16 MB per version

// A page's name is its uploaded file name: no slashes, starts with a letter or digit.
export const SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
// Usernames are a per-deployment setting, stored in the database
// (`node src/server.js config usernames email`): short handles by default, or emails.
export const USERNAME_RULES = {
  name: { re: /^[a-z0-9][a-z0-9_-]{0,39}$/, hint: 'lowercase letters, digits, - and _ (up to 40)' },
  email: { re: /^[^\s@/]{1,64}@[^\s@/.]+(\.[^\s@/.]+)+$/, hint: 'an email address, like alice@example.com' },
};
export const DEFAULT_USERNAMES = 'name';
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
export const RESERVED_SLUGS = new Set(['api', 'v', 'review', 'pages', 'history', 'gallery', 'graph', 'stats', 'favicon.ico', 'robots.txt']);

export const VISIBILITIES = ['public', 'private'];
export const DEFAULT_VISIBILITY = 'public'; // everything visible unless an upload says private

// Rendered artifacts run in an opaque origin: scripts and forms work, but they
// cannot read this origin's storage or call the API as the viewer.
export const RENDER_CSP = 'sandbox allow-scripts allow-forms allow-popups allow-modals';

// Fuzzy search: each typed word also matches indexed words at least this similar
// (Ratcliff/Obershelp ratio, 0-1, the same measure as Python's difflib), so
// "sheling" finds "shelling". Words of 1-2 letters only prefix-match, because at
// that length nearly everything is "close".
export const FUZZY_CUTOFF = 0.75;
export const FUZZY_MIN_LEN = 3;
export const FUZZY_MAX_EXPANSIONS = 3; // per typed word
// Search ranking (FTS5 bm25 column weights): a hit in the title counts 10x a hit in
// the page text, and the file name ("kmeans-step-through.html" → "kmeans step
// through") 5x. Pages whose title contains the whole query come first regardless.
export const SEARCH_WEIGHTS = { title: 10, name: 5, body: 1 };

// Page views: every render counts once. Visitors are a hash of (server secret,
// day, IP, user agent), so one person counts once per day and no IP or user agent
// is stored. Crawlers, link-preview fetchers (iMessage, Slack) and command-line
// clients are not counted.
export const BOT_UA_RE = /bot|crawl|spider|slurp|preview|facebookexternalhit|curl|wget|python-urllib|node/i;
export const VIEW_REPORT_DAYS = 30;

// Table of contents: added to a page at render time (never to the stored version)
// when it has at least this many h2/h3 headings. public/toc.js decides placement;
// a page opts out with <meta name="toc" content="off">, a single view with ?toc=0.
export const TOC_MIN_HEADINGS = 3;

// Tags: server-side labels, any number per page. A page's <meta name="category"> is
// added as a tag automatically; the rest are added and removed by the page's editors.
export const TAG_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
export const MAX_TAGS_PER_PAGE = 20;

export const MAX_COMMENT_CHARS = 10_000;
export const DIFF_CONTEXT_LINES = 3;
