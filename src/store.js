// All data access, on SQLite: Node's built-in node:sqlite by default, or any database
// object with the same small synchronous interface (exec, prepare → run/get/all,
// optionally transaction(fn) and close), such as a Cloudflare Durable Object's
// (cloudflare/sqlite.js). Each request's handler runs to completion against a
// synchronous database, so each method is atomic without locks; multi-statement writes
// still go through tx() so a failure leaves nothing half-done.
import { createHash, randomBytes } from 'node:crypto';
import {
  API_CALL_RETENTION_DAYS, ASSET_TYPES, BOT_UA_RE, CLIENT_KINDS, MAX_ASSET_BYTES, MAX_TAGS_PER_PAGE, SEARCH_WEIGHTS, TAG_RE, DEFAULT_EDITING, DEFAULT_USERNAMES, DEFAULT_VISIBILITY, EDITING_MODES, MASK_EMAILS_FOR_ANONYMOUS, MAX_COMMENT_CHARS, RESERVED_SLUGS,
  PAGE_EXT_RE, SEARCH_SORT, SLUG_HINT, SLUG_RE, SORTS, USERNAME_RULES,
  VIEW_REPORT_DAYS, VISIBILITIES,
} from './config.js';
import { ACTIVE, NONE, PURGED, TRASHED, transition } from './lifecycle.js';
import {
  assetPaths, isMarkdown, linkCandidates, noteAssets, noteLines, noteLinks, noteTags, noteTitle, parseFrontmatter, renderMarkdown,
} from './markdown.js';
import { isNotebook, markdownCells, notebookMarkdown, parseNotebook } from './notebook.js';
import {
  ApiError, HIT, Vocabulary, bracketHits, extractLines, extractLinks, extractText, ftsMatch, metaContent, queryWords, scriptText,
  searchName, snippet,
} from './text.js';

/**
 * What a page says about itself, for HTML and Markdown alike: title, description,
 * category, tags it declares, its searchable text, and the pages it links to (a note's
 * Markdown links are read from where it lives, `path`).
 */
export function pageMeta(slug, text, { path = '' } = {}) {
  if (isNotebook(slug)) {
    // Title, tags and description: frontmatter cell, else notebook metadata; else the first
    // # heading of a Markdown cell, else the file name.
    const nb = parseNotebook(text);
    const data = { ...nb.metadata, ...nb.front };
    const tags = noteTags({ tags: data.tags ?? data.keywords ?? [] }).map(normalizeTag).filter(Boolean);
    const md = notebookMarkdown(nb);
    return {
      kind: 'notebook',
      title: data.title ? String(data.title) : noteTitle({}, markdownCells(nb), slug.replace(/\.ipynb$/i, '.md')),
      description: String(data.description ?? data.summary ?? ''),
      category: normalizeTag(data.category) || tags[0] || '',
      tags,
      body: extractText(renderMarkdown(md)).body,
      links: noteLinks(markdownCells(nb), { path }),
      assets: noteAssets(markdownCells(nb)),
      aliases: (Array.isArray(data.aliases) ? data.aliases : data.aliases ? [data.aliases] : []).map((x) => String(x).trim()).filter(Boolean),
      draft: data.draft === true || data.publish === false,
    };
  }
  if (isMarkdown(slug)) {
    const { data, body } = parseFrontmatter(text);
    const tags = noteTags(data).map(normalizeTag).filter(Boolean);
    return {
      kind: 'markdown',
      title: noteTitle(data, body, slug),
      description: String(data.description ?? data.summary ?? ''),
      category: normalizeTag(data.category) || tags[0] || '',
      tags,
      body: extractText(renderMarkdown(text)).body,
      links: noteLinks(text, { path }),
      assets: noteAssets(text),
      aliases: (Array.isArray(data.aliases) ? data.aliases : data.aliases ? [data.aliases] : []).map((x) => String(x).trim()).filter(Boolean),
      draft: data.draft === true || data.publish === false,
    };
  }
  const { title, body } = extractText(text);
  const category = metaContent(text, 'category').toLowerCase();
  return {
    kind: 'html', title, description: metaContent(text, 'description'), category,
    tags: [normalizeTag(category)].filter(Boolean), body: `${body} ${scriptText(text).replace(/\n/g, ' ')}`.trim(),
    links: extractLinks(text, { isSlug: (s) => SLUG_RE.test(s) && !RESERVED_SLUGS.has(s.toLowerCase()) }),
    assets: assetPaths(text),
  };
}

// Same schema as the Python version, so an existing artifacts.db keeps working.
const SCHEMA = `
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    token_hash TEXT NOT NULL UNIQUE,
    is_admin INTEGER NOT NULL DEFAULT 0,
    created_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS artifacts (
    id INTEGER PRIMARY KEY,
    owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    slug TEXT NOT NULL,
    title TEXT NOT NULL,
    state TEXT NOT NULL,
    share_id TEXT NOT NULL UNIQUE,
    visibility TEXT NOT NULL DEFAULT 'public',
    latest_version INTEGER NOT NULL,
    created_at REAL NOT NULL,
    updated_at REAL NOT NULL,
    UNIQUE (slug)
);
CREATE TABLE IF NOT EXISTS versions (
    artifact_id INTEGER NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
    n INTEGER NOT NULL,
    html BLOB NOT NULL,
    sha256 TEXT NOT NULL,
    size INTEGER NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    created_at REAL NOT NULL,
    PRIMARY KEY (artifact_id, n)
);
CREATE INDEX IF NOT EXISTS versions_by_time ON versions (created_at);
CREATE TABLE IF NOT EXISTS views (
    artifact_id INTEGER NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
    n INTEGER NOT NULL,             -- version shown
    at REAL NOT NULL,
    visitor TEXT NOT NULL,          -- daily-salted hash, see BOT_UA_RE in config.js
    via TEXT NOT NULL               -- 'url' (/<slug>) or 'share' (/v/<id>)
);
CREATE INDEX IF NOT EXISTS views_by_artifact ON views (artifact_id, at);
-- One row per /api request, for the usage stats admins see (0.7.0). Never a query string,
-- request body or token: the route's pattern, who called and how it went.
CREATE TABLE IF NOT EXISTS api_calls (
    id INTEGER PRIMARY KEY,
    at REAL NOT NULL,
    client TEXT NOT NULL,           -- mcp, cli, browser or http (see CLIENT_KINDS)
    name TEXT NOT NULL DEFAULT '',  -- the MCP tool or CLI command, when the client said
    method TEXT NOT NULL,
    route TEXT NOT NULL,            -- e.g. /api/artifacts/<slug>
    status INTEGER NOT NULL,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS api_calls_by_time ON api_calls (at);
-- The same, totalled per day, once the detailed rows pass API_CALL_RETENTION_DAYS. Kept for good.
CREATE TABLE IF NOT EXISTS api_calls_daily (
    day TEXT NOT NULL,              -- YYYY-MM-DD, the server's local day
    client TEXT NOT NULL,
    name TEXT NOT NULL,
    method TEXT NOT NULL,
    route TEXT NOT NULL,
    calls INTEGER NOT NULL,
    errors INTEGER NOT NULL,        -- 4xx and 5xx
    server_errors INTEGER NOT NULL, -- 5xx
    PRIMARY KEY (day, client, name, method, route)
);
CREATE TABLE IF NOT EXISTS comments (
    id INTEGER PRIMARY KEY,
    artifact_id INTEGER NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
    n INTEGER NOT NULL,             -- the version commented on
    parent_id INTEGER REFERENCES comments(id) ON DELETE CASCADE,  -- set on replies
    author_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    body TEXT NOT NULL,
    created_at REAL NOT NULL,
    resolved_at REAL                -- top-level comments only
);
CREATE INDEX IF NOT EXISTS comments_by_artifact ON comments (artifact_id, n);
CREATE TABLE IF NOT EXISTS tags (
    artifact_id INTEGER NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
    tag TEXT NOT NULL,
    PRIMARY KEY (artifact_id, tag)
);
CREATE INDEX IF NOT EXISTS tags_by_tag ON tags (tag);
CREATE TABLE IF NOT EXISTS aliases (             -- other names a note answers to (frontmatter aliases)
    artifact_id INTEGER NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
    alias TEXT NOT NULL COLLATE NOCASE,
    PRIMARY KEY (artifact_id, alias)
);
CREATE INDEX IF NOT EXISTS aliases_by_alias ON aliases (alias);
CREATE TABLE IF NOT EXISTS assets (              -- images and PDFs that notes embed, by file name
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE,
    mime TEXT NOT NULL,
    data BLOB NOT NULL,
    sha256 TEXT NOT NULL,
    size INTEGER NOT NULL,
    owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    updated_at REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS artifacts_by_slug_nocase ON artifacts (slug COLLATE NOCASE);
CREATE TABLE IF NOT EXISTS links (               -- what each page's latest version links to
    from_id INTEGER NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
    to_slug TEXT NOT NULL,                       -- as written: a page's name, or a wikilink's folder path ("plugins/Backlinks")
    PRIMARY KEY (from_id, to_slug)
);
-- What each link may mean, worked out when pages change rather than when they're read:
-- every page it may mean, best first (see Store.candidates). Each viewer's link goes to the
-- best of these they can see, so trashing a page or making it private needs no update.
CREATE TABLE IF NOT EXISTS link_targets (
    from_id INTEGER NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
    to_slug TEXT NOT NULL,                       -- the link, as in links
    target_id INTEGER NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
    rank INTEGER NOT NULL,                       -- 0: the best match
    PRIMARY KEY (from_id, to_slug, target_id)
);
CREATE INDEX IF NOT EXISTS link_targets_by_target ON link_targets (target_id);
-- The names each page's links may mean, lowercase: how a new page, or one whose names
-- change, finds the links to work out again.
CREATE TABLE IF NOT EXISTS link_names (
    from_id INTEGER NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    PRIMARY KEY (from_id, name)
);
CREATE INDEX IF NOT EXISTS link_names_by_name ON link_names (name);
-- The images and PDFs each page's latest version shows, by name: whose pages vouch for a
-- file, so it's served only to people who can see one of them (Store.canReadAsset).
CREATE TABLE IF NOT EXISTS asset_refs (
    artifact_id INTEGER NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
    name TEXT NOT NULL COLLATE NOCASE,
    PRIMARY KEY (artifact_id, name)
);
CREATE INDEX IF NOT EXISTS asset_refs_by_name ON asset_refs (name);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;
// The search index has its own version: when its columns change, it is rebuilt
// from each page's latest version on startup (see ensureSearchIndex).
const SEARCH_INDEX_VERSION = '3'; // 3: prefix indexes; script text, aliases and tags; 2: title, name, body (0.4.0); 1: title, body
// So do the links (see ensureLinks): 1, each link kept as written, with the pages it may mean
// worked out on every change (link_targets), Markdown links read from where a note lives,
// and the images and PDFs each page shows (asset_refs).
const LINKS_VERSION = '1';
// Columns added after the first release, per table: [name, definition, backfill SQL].
// Applied on startup if missing, so older databases upgrade in place.
const ADDED_COLUMNS = {
  artifacts: [
    ['description', "TEXT NOT NULL DEFAULT ''"], // from <meta name="description">, for the gallery
    ['category', "TEXT NOT NULL DEFAULT ''"], //    from <meta name="category">
    ['pinned_at', 'REAL'], // set when pinned to the home page's Featured section (0.5.0)
    ['source', "TEXT NOT NULL DEFAULT ''"], // the folder a page was synced from, so `sync --prune` only touches its own (0.6.0)
    // A note's bare file name, lowercase ("backlinks" for plugins/Backlinks.md), so [[Backlinks]]
    // finds it however deep it lives (0.6.0). Existing pages: their name minus the extension.
    // Where a synced note lives in its folder ("features/backlinks.md"), for the explorer
    // and breadcrumbs (0.6.0). Empty for pages uploaded directly.
    ['path', "TEXT NOT NULL DEFAULT ''"],
    ['name_key', "TEXT NOT NULL DEFAULT ''",
      "UPDATE artifacts SET name_key = lower(CASE WHEN slug LIKE '%.markdown' THEN substr(slug, 1, length(slug) - 9) WHEN slug LIKE '%.html' THEN substr(slug, 1, length(slug) - 5) WHEN slug LIKE '%.htm' OR slug LIKE '%.md' THEN substr(slug, 1, length(slug) - (CASE WHEN slug LIKE '%.htm' THEN 4 ELSE 3 END)) ELSE slug END)"],
  ],
  versions: [
    // Who uploaded each version (0.3.0, for open editing). Versions from before then
    // could only have come from the page's owner, so they're credited to them.
    // NULL afterwards means the uploader's account was deleted.
    ['author_id', 'INTEGER REFERENCES users(id) ON DELETE SET NULL',
      'UPDATE versions SET author_id = (SELECT owner_id FROM artifacts WHERE artifacts.id = versions.artifact_id)'],
  ],
};
// Indexes on columns that ADDED_COLUMNS may have just added.
const ADDED_INDEXES = ['CREATE INDEX IF NOT EXISTS artifacts_by_name_key ON artifacts (name_key)'];

const now = () => Date.now() / 1000;
const sha256 = (s) => createHash('sha256').update(s).digest('hex');
export const hashToken = sha256;
const localDay = (t) => new Date(t * 1000).toLocaleDateString('en-CA'); // YYYY-MM-DD, server's timezone
const VIEWS = '(SELECT COUNT(*) FROM views v WHERE v.artifact_id = a.id) AS views';
const TAGS = "(SELECT group_concat(t.tag, ',') FROM tags t WHERE t.artifact_id = a.id) AS tags_csv";
const PREVIEW_CHARS = 420; // how much of a page a hover preview shows
const SELECT = `SELECT a.*, u.name AS owner, ${VIEWS}, ${TAGS} FROM artifacts a JOIN users u ON u.id = a.owner_id`;
const CANDIDATE = 'SELECT a.id, a.slug, a.owner_id, a.state, a.visibility FROM artifacts a'; // what choosing among candidates needs
// Featured (pinned) pages first, in the order they were pinned; then newest first.
// Featured (pinned) pages first, in the order they were pinned; then the chosen sort.
const PINNED_FIRST = 'a.pinned_at IS NULL, a.pinned_at';
const SORT_ORDER = {
  updated: 'a.updated_at DESC, a.id DESC',
  created: 'a.created_at DESC, a.id DESC',
  views: 'views DESC, a.updated_at DESC', // `views` is the count selected with each page (VIEWS)
  title: 'lower(a.title), a.id',
};

/** "Trip Plans" → "trip-plans", and Quartz's nested "plugin/emitter" → "plugin-emitter"; null if it can't be a tag. */
export function normalizeTag(t) {
  const s = String(t ?? '').trim().toLowerCase().replace(/^#/, '').replace(/[\s_/]+/g, '-').replace(/[^a-z0-9-]/g, '').replace(/-+/g, '-').replace(/^-|-$/g, '');
  return TAG_RE.test(s) ? s : null;
}
const ASSET_META = 'id, name, mime, sha256, size, owner_id, updated_at'; // an asset's columns but its file
const assetInfo = (a) => ({ name: a.name, mime: a.mime, size: a.size, sha256: a.sha256, url: `/assets/${encodeURIComponent(a.name)}`, updated_at: a.updated_at });
const COMMENT_SELECT = 'SELECT c.id, c.n AS version, c.parent_id AS parent, u.name AS author, c.body,'
  + ' c.created_at, c.resolved_at FROM comments c JOIN users u ON u.id = c.author_id';


export function visible(a, viewerId) {
  if (viewerId != null && a.owner_id === viewerId) return true;
  return a.state === ACTIVE && a.visibility === 'public';
}

/** "alice@example.com" → "alice@…" for viewers who aren't signed in. */
export function displayName(name, viewerId) {
  if (!MASK_EMAILS_FOR_ANONYMOUS || viewerId != null || !name.includes('@')) return name;
  return `${name.split('@')[0]}@…`;
}

export function summary(a, viewerId = null) {
  return {
    slug: a.slug,
    url: `/pages/${a.slug}`, // the canonical, stable page URL; /<slug> is an alias
    owner: displayName(a.owner, viewerId),
    title: a.title,
    description: a.description,
    category: a.category,
    state: a.state,
    visibility: a.visibility,
    latest_version: a.latest_version,
    share_url: `/v/${a.share_id}`,
    created_at: a.created_at,
    updated_at: a.updated_at,
    views: a.views ?? null,
    tags: a.tags_csv ? a.tags_csv.split(',').sort() : [],
    pinned: a.pinned_at != null,
  };
}

export class Store {
  /** `db`: a database file's path (node:sqlite), or an open database object (see the top of this file). */
  constructor(db) {
    // node:sqlite is loaded only when asked for a file, so runtimes without it can use the rest.
    this.db = typeof db === 'string' ? new (process.getBuiltinModule('node:sqlite').DatabaseSync)(db) : db;
    this.statements = new Map();
    this.db.exec(SCHEMA);
    for (const [table, added] of Object.entries(ADDED_COLUMNS)) {
      const cols = new Set(this.db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
      for (const [name, def, backfill] of added) {
        if (cols.has(name)) continue;
        this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${def}`);
        if (backfill) this.db.exec(backfill);
      }
    }
    for (const sql of ADDED_INDEXES) this.db.exec(sql);
    this.db.prepare("INSERT OR IGNORE INTO meta VALUES ('visitor_secret', ?)").run(randomBytes(16).toString('hex'));
    this.visitorSecret = this.db.prepare("SELECT value FROM meta WHERE key = 'visitor_secret'").get().value;
    this.vocab = null; // indexed words for fuzzy search; reset whenever the index changes
    // Bumped by every change to pages (see changed): what's worked out from them (the link
    // graph, the explorer, hover previews) is kept until then. Only this Store writes pages;
    // the CLI's server commands touch users and settings.
    this.revision = 0;
    this.memo = new Map();
    if (this.setting('tags_index') !== '1') { // 0.5.0: categories become each page's first tag
      this.run("INSERT OR IGNORE INTO tags (artifact_id, tag) SELECT id, category FROM artifacts WHERE category != ''");
      this.setSetting('tags_index', '1');
    }
    this.ensureSearchIndex(); // after the tags: they're searchable
    this.ensureLinks();
  }

  close() { this.db.close?.(); }

  /** Create the search index, or rebuild it from every page's latest version if its layout changed. */
  ensureSearchIndex() {
    const exists = this.one("SELECT 1 AS x FROM sqlite_master WHERE name = 'artifacts_fts'");
    if (exists && this.setting('search_index', '1') === SEARCH_INDEX_VERSION) return;
    this.tx(() => {
      // prefix: also index each word's first 1, 2 and 3 letters, so the first keys typed
      // in a live search don't have to gather every word that starts with them.
      this.db.exec('DROP TABLE IF EXISTS artifacts_vocab; DROP TABLE IF EXISTS artifacts_fts;'
        + " CREATE VIRTUAL TABLE artifacts_fts USING fts5(title, name, body, prefix='1 2 3');"
        + " CREATE VIRTUAL TABLE artifacts_vocab USING fts5vocab(artifacts_fts, 'row');");
      const rows = this.all('SELECT a.id, a.slug, a.description, v.html FROM artifacts a'
        + ' JOIN versions v ON v.artifact_id = a.id AND v.n = a.latest_version');
      for (const r of rows) this.index(r.id, `${r.description} ${pageMeta(r.slug, Buffer.from(r.html).toString('utf8')).body}`);
      this.setSetting('search_index', SEARCH_INDEX_VERSION);
    });
    this.vocab = null;
  }

  /**
   * Read every page's links again from its latest version and work out what each means:
   * when how links are kept changes (LINKS_VERSION), and when a version is newer than
   * the links reflect (links_upto), as after running an older release that doesn't keep
   * link_targets. The links table stays as 0.8.0 reads it, and links_index (what 0.8.0
   * checks before reading them all again itself) stays set, so rolling back needs no rebuild.
   */
  ensureLinks() {
    const newest = this.one('SELECT MAX(created_at) AS t FROM versions').t ?? 0;
    if (this.setting('links_resolved') === LINKS_VERSION && Number(this.setting('links_upto', '0')) >= newest) return;
    this.tx(() => {
      this.db.exec('DELETE FROM links; DELETE FROM link_targets; DELETE FROM link_names; DELETE FROM asset_refs;');
      const rows = this.all('SELECT a.id, a.slug, a.path, v.html FROM artifacts a JOIN versions v ON v.artifact_id = a.id AND v.n = a.latest_version');
      for (const r of rows) {
        const meta = pageMeta(r.slug, Buffer.from(r.html).toString('utf8'), { path: r.path });
        this.setLinks(r.id, meta.links);
        this.setAssetRefs(r.id, meta.assets);
      }
      for (const [k, v] of [['links_resolved', LINKS_VERSION], ['links_index', '1'], ['links_upto', String(newest)]]) this.setSetting(k, v);
    });
  }

  /** The images and PDFs a page's latest version shows (see canReadAsset). */
  setAssetRefs(id, names) {
    this.run('DELETE FROM asset_refs WHERE artifact_id = ?', id);
    for (const n of names) this.run('INSERT OR IGNORE INTO asset_refs (artifact_id, name) VALUES (?, ?)', id, n);
  }

  /** A page's links, as pageMeta gives them: kept, and what each may mean worked out. */
  setLinks(id, links) {
    for (const t of ['links', 'link_targets', 'link_names']) this.run(`DELETE FROM ${t} WHERE from_id = ?`, id);
    for (const to of new Set(links)) {
      this.run('INSERT INTO links (from_id, to_slug) VALUES (?, ?)', id, to);
      for (const n of linkCandidates(to)) this.run('INSERT OR IGNORE INTO link_names (from_id, name) VALUES (?, ?)', id, n.toLowerCase());
      this.resolveLink(id, to);
    }
  }

  /** Work out what one link may mean (link_targets), best first. */
  resolveLink(id, to) {
    this.run('DELETE FROM link_targets WHERE from_id = ? AND to_slug = ?', id, to);
    this.candidates(to).forEach((a, rank) => this.run('INSERT INTO link_targets (from_id, to_slug, target_id, rank) VALUES (?,?,?,?)', id, to, a.id, rank));
  }

  /** Work out again what the links on these pages that may mean one of `names` (lowercase) may mean. */
  resolveLinks(ids, names) {
    const wanted = new Set(names);
    for (const id of ids) {
      for (const { to_slug: to } of this.all('SELECT to_slug FROM links WHERE from_id = ?', id)) {
        if (linkCandidates(to).some((n) => wanted.has(n.toLowerCase()))) this.resolveLink(id, to);
      }
    }
  }

  /** The names a page answers to, lowercase, the way link_names keeps them (see candidates). */
  namesOf(id) {
    const a = this.one('SELECT slug, name_key FROM artifacts WHERE id = ?', id);
    if (!a) return [];
    const slug = a.slug.toLowerCase();
    const aliases = this.all('SELECT alias FROM aliases WHERE artifact_id = ?', id).map((r) => r.alias.toLowerCase());
    return [slug, slug.replace(PAGE_EXT_RE, ''), a.name_key, ...aliases, ...aliases.map((x) => x.replace(/\s+/g, '-'))];
  }

  /** Pages with a link that may mean one of these names (lowercase). */
  linkersOf(names) {
    const list = [...new Set(names)].filter(Boolean), out = new Set();
    for (let i = 0; i < list.length; i += 90) { // some databases bind at most 100 values
      const part = list.slice(i, i + 90);
      for (const r of this.all(`SELECT DISTINCT from_id FROM link_names WHERE name IN (${part.map(() => '?').join(',')})`, ...part)) out.add(r.from_id);
    }
    return [...out];
  }

  /** fn(), kept until the next change to pages (see changed). */
  cached(key, fn) {
    if (!this.memo.has(key)) {
      if (this.memo.size >= 1000) this.memo.clear();
      this.memo.set(key, fn());
    }
    return this.memo.get(key);
  }

  /** Pages, their links, names, visibility, tags or assets changed: forget what was worked out from them. */
  changed() {
    this.revision++;
    this.memo.clear();
  }

  /**
   * (Re)index one page: its title; its file name, aliases and tags (searchName); and
   * `text`, its description and body (the description is what its card shows). Without
   * `text`, the text already indexed: for when only its tags changed.
   */
  index(id, text) {
    const a = this.one('SELECT title, slug FROM artifacts WHERE id = ?', id);
    text ??= this.one('SELECT body FROM artifacts_fts WHERE rowid = ?', id)?.body ?? '';
    const names = [...this.all('SELECT alias FROM aliases WHERE artifact_id = ?', id).map((r) => r.alias),
      ...this.all('SELECT tag FROM tags WHERE artifact_id = ?', id).map((r) => r.tag)];
    this.run('DELETE FROM artifacts_fts WHERE rowid = ?', id);
    this.run('INSERT INTO artifacts_fts (rowid, title, name, body) VALUES (?,?,?,?)', id, a.title, searchName(a.slug, a.title, names), text.trim());
    this.vocab = null;
  }

  tx(fn) {
    if (this.db.transaction) return this.db.transaction(fn); // the database runs it (Durable Objects forbid BEGIN)
    this.db.exec('BEGIN');
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  one(sql, ...args) { return this.statement(sql).get(...args); }
  all(sql, ...args) { return this.statement(sql).all(...args); }
  run(sql, ...args) { return this.statement(sql).run(...args); }

  /** A prepared statement, kept for reuse: preparing one costs more than running most of ours. */
  statement(sql) {
    let st = this.statements.get(sql);
    if (!st) {
      if (this.statements.size >= 500) this.statements.clear(); // some SQL is written per call (ids in it)
      this.statements.set(sql, st = this.db.prepare(sql));
    }
    return st;
  }

  // --- users ---------------------------------------------------------------------
  // --- settings (per deployment, in the meta table) -----------------------------
  setting(key, fallback) { return this.one('SELECT value FROM meta WHERE key = ?', key)?.value ?? fallback; }
  setSetting(key, value) { this.run('INSERT INTO meta VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, value); }

  get usernames() { return this.setting('usernames', DEFAULT_USERNAMES); }
  setUsernames(mode) {
    if (!USERNAME_RULES[mode]) throw new ApiError(400, `usernames must be one of ${Object.keys(USERNAME_RULES).join(', ')}`);
    this.setSetting('usernames', mode);
  }

  get editing() { return this.setting('editing', DEFAULT_EDITING); }
  setEditing(mode) {
    if (!EDITING_MODES.includes(mode)) throw new ApiError(400, `editing must be one of ${EDITING_MODES.join(', ')}`);
    this.setSetting('editing', mode);
  }

  /** May this user add versions to this page? The owner always; anyone signed in under open editing. */
  canEdit(a, userId) {
    if (userId == null) return false;
    if (a.owner_id === userId) return true;
    return this.editing === 'open' && a.state === ACTIVE && a.visibility === 'public';
  }

  /** A page by its exact name that this user may add versions to (see exact). */
  editable(slug, userId) {
    const a = this.exact(slug, userId);
    if (!this.canEdit(a, userId)) throw new ApiError(403, `'${a.slug}' belongs to ${a.owner}`);
    return a;
  }

  /** Lowercase, then check against this deployment's rule. */
  normalizeUsername(name) {
    const n = String(name ?? '').trim().toLowerCase();
    const rule = USERNAME_RULES[this.usernames];
    if (!rule.re.test(n)) throw new ApiError(400, `username must be ${rule.hint}`);
    return n;
  }

  /** Returns the new user's token: a fresh one, or `token` when the deployment supplies it (its first admin). */
  createUser(name, isAdmin = false, { token = 'ak_' + randomBytes(32).toString('base64url') } = {}) {
    name = this.normalizeUsername(name);
    try {
      this.run('INSERT INTO users (name, token_hash, is_admin, created_at) VALUES (?,?,?,?)',
        name, hashToken(token), isAdmin ? 1 : 0, now());
    } catch (e) {
      if (/UNIQUE/.test(e.message)) throw new ApiError(409, `user '${name}' already exists`);
      throw e;
    }
    return token;
  }

  /** Issue a new token for an existing user; the old one stops working at once. Pages are untouched. */
  resetToken(name) {
    name = String(name ?? '').trim().toLowerCase();
    const token = 'ak_' + randomBytes(32).toString('base64url');
    const { changes } = this.run('UPDATE users SET token_hash = ? WHERE name = ?', hashToken(token), name);
    if (!changes) throw new ApiError(404, 'no such user');
    return token;
  }

  userForToken(token) { return this.one('SELECT * FROM users WHERE token_hash = ?', hashToken(token)); }

  listUsers() {
    return this.all('SELECT name, is_admin, created_at FROM users ORDER BY name')
      .map((u) => ({ ...u, is_admin: !!u.is_admin }));
  }

  deleteUser(name) {
    name = String(name ?? '').trim().toLowerCase();
    this.tx(() => {
      const u = this.one('SELECT id FROM users WHERE name = ?', name);
      if (!u) throw new ApiError(404, 'no such user');
      for (const { id } of this.all('SELECT id FROM artifacts WHERE owner_id = ?', u.id)) {
        this.run('DELETE FROM artifacts_fts WHERE rowid = ?', id);
      }
      this.run('DELETE FROM users WHERE id = ?', u.id);
    });
    this.vocab = null;
    this.changed();
  }

  // --- artifact lookup ---------------------------------------------------------
  /**
   * Every page a name may mean, best first: the one resolver behind URLs, wikilinks,
   * Markdown links, backlinks and the graph. The page of that exact name, else with .html,
   * .md or .ipynb added (so /trip-plan finds trip-plan.html); the same ignoring case (so
   * [[Weekly Review]] finds Weekly-Review.md); for a bare name, notes of that file name
   * wherever they live, shortest path first (Quartz: [[Backlinks]] finds
   * plugins-Backlinks.md; never for a name with an extension, so /pages/x.html can't land on
   * some other page called x); last, notes with it among their aliases ([[WR]] finds Weekly
   * Review). A wikilink's folder path ("plugins/Backlinks") means that path's page first,
   * then its bare name. Rows are light (id, slug, owner_id, state, visibility): which of
   * them a viewer gets is up to the caller.
   */
  candidates(name) {
    const out = new Map();
    for (const n of linkCandidates(name)) {
      const forms = [n, `${n}.html`, `${n}.md`, `${n}.ipynb`], lower = forms.map((f) => f.toLowerCase());
      const rows = this.all(`${CANDIDATE} WHERE a.slug COLLATE NOCASE IN (?, ?, ?, ?)`, ...forms);
      const place = (a) => { const i = forms.indexOf(a.slug); return i === -1 ? 4 + lower.indexOf(a.slug.toLowerCase()) : i; };
      for (const a of rows.sort((x, y) => place(x) - place(y) || x.id - y.id)) if (!out.has(a.id)) out.set(a.id, a);
      if (!PAGE_EXT_RE.test(n)) {
        for (const a of this.all(`${CANDIDATE} WHERE a.name_key = ? ORDER BY length(a.slug), a.id`, n.toLowerCase())) if (!out.has(a.id)) out.set(a.id, a);
      }
      const spaced = n.replace(/-/g, ' ');
      for (const a of this.all(`${CANDIDATE} JOIN aliases al ON al.artifact_id = a.id WHERE al.alias IN (?, ?) ORDER BY al.alias = ? DESC, a.id`, spaced, n, spaced)) {
        if (!out.has(a.id)) out.set(a.id, a);
      }
    }
    return [...out.values()];
  }

  /** The page a link to `name` goes to for this viewer: the best one they can see that isn't trashed; null if none. */
  linkTarget(name, viewerId) {
    return this.candidates(name).find((a) => a.state === ACTIVE && visible(a, viewerId)) ?? null;
  }

  /**
   * The best of the pages a name may mean that `ok` allows, preferring pages that aren't
   * trashed (an owner can still reach their own trashed page by its name); a light row, or null.
   */
  pick(name, ok = () => true) {
    const c = this.candidates(name).filter(ok);
    return c.find((a) => a.state === ACTIVE) ?? c[0] ?? null;
  }

  /** A page by name, for reading: the best one this viewer can see (see pick). */
  readable(name, viewerId) {
    const a = this.pick(name, (x) => visible(x, viewerId));
    if (!a) throw new ApiError(404, 'no such artifact');
    return this.one(`${SELECT} WHERE a.id = ?`, a.id);
  }

  /** A page by name, whoever can see it: for tests and scripts. */
  find(name) {
    const a = this.pick(name);
    return a ? this.one(`${SELECT} WHERE a.id = ?`, a.id) : undefined;
  }

  /**
   * A page by its exact name, for changing it: writes never guess, so DELETE .../backlinks
   * can't trash plugins-Backlinks.md. A name that only another page answers to is a 404
   * that says which page that is.
   */
  exact(slug, userId) {
    const a = this.one(`${SELECT} WHERE a.slug = ?`, slug);
    if (a && visible(a, userId)) return a;
    const near = a ? null : this.pick(slug, (x) => visible(x, userId));
    throw new ApiError(404, near ? `no page is named '${slug}'; did you mean '${near.slug}'?` : 'no such artifact');
  }

  /** Pages (visible to this viewer) whose links go to page `a`: links resolved as for the graph. */
  backlinks(a, viewerId) {
    const { pages, edges } = this.linkGraph(viewerId);
    const from = new Set(edges.filter((e) => e.target === a.id).map((e) => e.source));
    return pages.filter((p) => from.has(p.id)).sort((x, y) => (x.title < y.title ? -1 : x.title > y.title ? 1 : 0))
      .map((r) => ({ slug: r.slug, title: r.title, url: `/pages/${r.slug}` }));
  }

  /** A page by its exact name that this user owns (see exact). */
  owned(slug, userId) {
    const a = this.exact(slug, userId);
    if (a.owner_id !== userId) throw new ApiError(403, `'${a.slug}' belongs to ${a.owner}`);
    return a;
  }

  // --- writes ----------------------------------------------------------------------
  /**
   * Add a version to the page of exactly this name, or create it. A name that is new but
   * already finds another page (a different case or extension, a note's file name or alias)
   * is refused with a "did you mean": that's almost always the page the uploader meant.
   * `base`: the version the uploader started from; refuse if someone has added one since.
   * `renameFrom`: the uploader's page that this is, renamed in case only (sync sends it).
   */
  putVersion(userId, slug, doc, { title, note = '', visibility, base, source, nameKey, path, renameFrom } = {}) {
    if (!SLUG_RE.test(slug) || RESERVED_SLUGS.has(slug.toLowerCase())) {
      throw new ApiError(400, `slug must be ${SLUG_HINT}, and not a name the server uses itself`);
    }
    if (visibility != null && !VISIBILITIES.includes(visibility)) {
      throw new ApiError(400, `visibility must be one of ${VISIBILITIES.join(', ')}`);
    }
    const text = Buffer.from(doc).toString('utf8');
    const t = now();
    this.tx(() => {
      let a = this.one(`${SELECT} WHERE a.slug = ?`, slug);
      if (!a && renameFrom != null) { // the same page, renamed in case only (what sync sends when a file is)
        const old = this.owned(renameFrom, userId);
        if (old.slug.toLowerCase() !== slug.toLowerCase()) throw new ApiError(400, `'${old.slug}' can only be renamed in case, e.g. to '${old.slug.toLowerCase()}'`);
        this.run('UPDATE artifacts SET slug = ? WHERE id = ?', slug, old.id);
        a = this.one(`${SELECT} WHERE a.slug = ?`, slug);
      }
      if (a && !this.canEdit(a, userId)) { // someone else's: say whose only if this user can see the page
        throw new ApiError(409, `'${slug}' is taken${visible(a, userId) ? ` by ${a.owner}` : ''}; pick another file name`);
      }
      const near = a ? null : this.pick(slug, (x) => x.state === ACTIVE && visible(x, userId));
      if (near) {
        throw new ApiError(409, `no page is named '${slug}', but '${near.slug}' answers to that name: did you mean '${near.slug}'? `
          + 'Upload to that name to add a version, or pick another name for a new page');
      }
      if (a && a.owner_id !== userId && visibility != null && visibility !== a.visibility) {
        throw new ApiError(403, `only ${a.owner} can change the visibility of '${slug}'`);
      }
      if (base != null && a && a.latest_version !== base) {
        throw new ApiError(409, `'${slug}' is at v${a.latest_version} now, but you started from v${base}; `
          + `see what changed (diff ${base} ${a.latest_version}) and upload again`);
      }
      const state = transition(a ? a.state : NONE, a ? 'update' : 'create');
      const meta = pageMeta(slug, text, { path: path ?? a?.path ?? '' });
      const { title: htmlTitle, body, description, category } = meta;
      const namesBefore = a ? this.namesOf(a.id) : [];
      let id, n;
      if (!a) {
        title = title || htmlTitle || slug;
        id = Number(this.run(
          'INSERT INTO artifacts (owner_id, slug, title, state, share_id, visibility, latest_version,'
          + ' created_at, updated_at, description, category) VALUES (?,?,?,?,?,?,1,?,?,?,?)',
          userId, slug, title, state, randomBytes(12).toString('base64url'), visibility || DEFAULT_VISIBILITY,
          t, t, description, category,
        ).lastInsertRowid);
        n = 1;
      } else {
        ({ id } = a);
        n = a.latest_version + 1;
        title = title || htmlTitle || a.title;
        this.run('UPDATE artifacts SET title=?, state=?, visibility=?, latest_version=?, updated_at=?,'
          + ' description=?, category=? WHERE id=?',
        title, state, visibility || a.visibility, n, t, description, category, id);
      }
      this.run('INSERT INTO versions (artifact_id, n, html, sha256, size, note, created_at, author_id) VALUES (?,?,?,?,?,?,?,?)',
        id, n, doc, sha256(doc), doc.length, note, t, userId);
      this.run('DELETE FROM aliases WHERE artifact_id = ?', id);
      for (const al of meta.aliases ?? []) this.run('INSERT OR IGNORE INTO aliases (artifact_id, alias) VALUES (?, ?)', id, al);
      if (source != null) this.run('UPDATE artifacts SET source = ? WHERE id = ?', source, id);
      if (path != null) this.run('UPDATE artifacts SET path = ? WHERE id = ?', path, id);
      // The bare name [[wikilinks]] find it by: what sync says, else the name without its
      // extension. Kept when not given, so a version from `put` or a restore keeps sync's.
      if (nameKey || !a) this.run('UPDATE artifacts SET name_key = ? WHERE id = ?', (nameKey || slug.replace(PAGE_EXT_RE, '')).toLowerCase(), id);
      this.setLinks(id, meta.links);
      this.setAssetRefs(id, meta.assets);
      // A new page, or one answering to other names now, may be what other pages' links mean.
      const names = this.namesOf(id);
      if (!a || [...namesBefore].sort().join('\n') !== [...names].sort().join('\n')) {
        const changed = [...namesBefore, ...names];
        this.resolveLinks(this.linkersOf(changed).filter((x) => x !== id), changed);
      }
      // Tags a page declares (HTML: its category; Markdown: frontmatter tags) follow
      // the page: newly declared ones are added, ones it stopped declaring are removed.
      // Tags added by hand, which the page never declared, are left alone.
      const before = a ? pageMeta(a.slug, this.version(a, a.latest_version).toString('utf8')).tags : [];
      for (const t of meta.tags) if (!before.includes(t)) this.run('INSERT OR IGNORE INTO tags (artifact_id, tag) VALUES (?, ?)', id, t);
      for (const t of before) if (!meta.tags.includes(t)) this.run('DELETE FROM tags WHERE artifact_id = ? AND tag = ?', id, t);
      this.index(id, `${description} ${body}`); // last: its aliases and tags are searchable
      this.setSetting('links_upto', String(t)); // the links reflect this version
    });
    this.changed();
    return this.describe(slug, userId);
  }

  setVisibility(userId, slug, visibility) {
    if (!VISIBILITIES.includes(visibility)) throw new ApiError(400, `visibility must be one of ${VISIBILITIES.join(', ')}`);
    const a = this.owned(slug, userId);
    this.run('UPDATE artifacts SET visibility = ? WHERE id = ?', visibility, a.id);
    this.changed();
    return this.describe(a.slug, userId);
  }

  /** trash / restore / purge */
  apply(userId, slug, event) {
    const a = this.owned(slug, userId);
    const next = transition(a.state, event);
    if (next === PURGED) {
      this.tx(() => {
        this.run('DELETE FROM artifacts_fts WHERE rowid = ?', a.id);
        this.run('DELETE FROM artifacts WHERE id = ?', a.id); // versions, views, comments and links to and from it cascade
      });
      this.vocab = null;
      this.changed();
      return { slug: a.slug, state: PURGED };
    }
    this.run('UPDATE artifacts SET state = ?, updated_at = ? WHERE id = ?', next, now(), a.id);
    this.changed(); // links to it are kept, and followed again once it's restored
    return this.describe(a.slug, userId);
  }

  /** Make version n current again by appending a copy of it; history is never rewritten. */
  restoreVersion(userId, slug, n) {
    const a = this.editable(slug, userId);
    return this.putVersion(userId, a.slug, this.version(a, n), { note: `restored from v${n}` }); // its name_key and path stay
  }

  // --- reads -----------------------------------------------------------------------
  describe(slug, viewerId) {
    const a = this.readable(slug, viewerId);
    const versions = this.all('SELECT v.n, v.sha256, v.size, v.note, v.created_at, u.name AS author'
      + ' FROM versions v LEFT JOIN users u ON u.id = v.author_id WHERE v.artifact_id = ? ORDER BY v.n', a.id);
    return {
      ...summary(a, viewerId),
      can_edit: this.canEdit(a, viewerId), // for the viewer: may they add or restore versions?
      versions: versions.map((v) => ({ ...v, author: v.author ? displayName(v.author, viewerId) : '(deleted user)' })),
    };
  }

  /** Active: every public artifact plus the viewer's own. Trashed: the viewer's own only. */
  /**
   * `sort`: a key of SORTS (default: recently updated), or for a search 'relevance'
   * (its default). Featured pages come first unless searching. A search gives the first
   * `snippets` results a snippet (default: all of them).
   */
  list(viewerId, { q, state = ACTIVE, limit = 50, offset = 0, owner, category, source, sort, snippets = limit } = {}) {
    if (sort && !(sort in SORT_ORDER) && !(q && sort === SEARCH_SORT)) {
      throw new ApiError(400, `sort must be one of ${[...Object.keys(SORTS), ...(q ? [SEARCH_SORT] : [])].join(', ')}`);
    }
    const ranked = q && (!sort || sort === SEARCH_SORT);
    let where, args;
    if (state === TRASHED) [where, args] = ['a.state = ? AND a.owner_id = ?', [TRASHED, viewerId ?? -1]];
    else [where, args] = ["a.state = ? AND (a.visibility = 'public' OR a.owner_id = ?)", [ACTIVE, viewerId ?? -1]];
    if (owner) { where += ' AND u.name = ?'; args.push(owner.toLowerCase()); }
    if (source) { where += ' AND a.source = ? AND a.owner_id = ?'; args.push(source, viewerId ?? -1); } // your synced pages
    // ?category= is the older name for a tag filter; both match a page's tags.
    if (category) { where += ' AND EXISTS (SELECT 1 FROM tags t WHERE t.artifact_id = a.id AND t.tag = ?)'; args.push(category); }
    if (!q) {
      return this.all(`SELECT a.*, u.name AS owner, ${VIEWS}, ${TAGS} FROM artifacts a`
        + ` JOIN users u ON u.id = a.owner_id WHERE ${where} ORDER BY ${PINNED_FIRST}, ${SORT_ORDER[sort || 'updated']} LIMIT ? OFFSET ?`, ...args, limit, offset)
        .map((r) => summary(r, viewerId));
    }
    const words = queryWords(q, this.vocabulary());
    // Titles first, in any order: pages whose title holds the whole query ("ACC-18"), then
    // pages whose title has every word as typed (or a longer word it starts: "ACC 18",
    // "[ACC-18]"); within those and after them, the chosen order. Ranked, that's pages with
    // every word as typed anywhere before pages found only through a typo or another form of
    // a word, then bm25, with title and file-name hits weighted above body hits.
    const near = words.some((w) => w.also.length);
    const exact = ftsMatch(words.map(({ word }) => ({ word, also: [] })));
    const inFts = 'a.id IN (SELECT rowid FROM artifacts_fts WHERE artifacts_fts MATCH ?) DESC';
    const rows = this.all(`SELECT a.*, u.name AS owner, ${VIEWS}, ${TAGS}, highlight(artifacts_fts, 0, char(1), char(2)) AS title_hits`
      + ' FROM artifacts_fts JOIN artifacts a ON a.id = artifacts_fts.rowid JOIN users u ON u.id = a.owner_id'
      + ` WHERE artifacts_fts MATCH ? AND ${where} ORDER BY instr(lower(a.title), lower(?)) > 0 DESC, ${inFts}, `
      + (ranked ? `${near ? `${inFts}, ` : ''}bm25(artifacts_fts, ?, ?, ?)` : SORT_ORDER[sort]) + ' LIMIT ? OFFSET ?',
    ftsMatch(words), ...args, q.trim(), `title : (${exact})`,
    ...(ranked ? [...(near ? [exact] : []), SEARCH_WEIGHTS.title, SEARCH_WEIGHTS.name, SEARCH_WEIGHTS.body] : []), limit, offset);
    // A one-letter search gets no snippets: nearly every word would be marked.
    const texts = words.some((w) => w.word.length > 1) ? this.indexedText(rows.slice(0, snippets).map((r) => r.id)) : new Map();
    return rows.map((r) => {
      const item = summary(r, viewerId);
      const snip = texts.has(r.id) ? snippet(texts.get(r.id), words) || null : null;
      // The API gets [brackets] around matched words; cards get the raw markers (HIT, not serialized).
      Object.assign(item, { snippet: snip && bracketHits(snip), title_highlight: bracketHits(r.title_hits) });
      item[HIT] = { title: r.title_hits, snippet: snip };
      return item;
    });
  }

  /** The text indexed for these pages, by id. (Ids are written into the SQL: some databases bind at most 100 values.) */
  indexedText(ids) {
    if (!ids.length) return new Map();
    return new Map(this.all(`SELECT rowid AS id, body FROM artifacts_fts WHERE rowid IN (${ids.map(Number).join(',')})`).map((r) => [r.id, r.body]));
  }

  /**
   * The links this viewer sees, worked out once per change to the site: every page they can
   * see (active), and each link on those pages going to the best page it may mean that they
   * can see (link_targets). Edges are distinct, none from a page to itself.
   */
  linkGraph(viewerId) {
    return this.cached(`links:${viewerId ?? ''}`, () => {
      const pages = this.all(`SELECT a.id, a.slug, a.title, a.category, ${TAGS} FROM artifacts a`
        + " WHERE a.state = 'active' AND (a.visibility = 'public' OR a.owner_id = ?) ORDER BY a.id", viewerId ?? -1);
      const ids = new Set(pages.map((p) => p.id));
      const best = new Map(); // "from_id link" → [rank, from_id, target_id]
      for (const r of this.all('SELECT from_id, to_slug, target_id, rank FROM link_targets')) {
        if (!ids.has(r.from_id) || !ids.has(r.target_id)) continue;
        const k = `${r.from_id} ${r.to_slug}`, b = best.get(k);
        if (!b || r.rank < b[0]) best.set(k, [r.rank, r.from_id, r.target_id]);
      }
      const edges = [], seen = new Set();
      for (const [, source, target] of best.values()) {
        if (source !== target && !seen.has(`${source} ${target}`)) { seen.add(`${source} ${target}`); edges.push({ source, target }); }
      }
      return { pages, edges };
    });
  }

  /**
   * Pages as nodes and the links between them as edges, for /graph. Only pages this
   * viewer can see, and only links whose target exists and is visible too. `views`:
   * also count each page's views (the global graph shows them; a page's own box doesn't).
   */
  graph(viewerId, { focus, depth = 1, views = true } = {}) {
    let { nodes, edges } = this.cached(`graph:${viewerId ?? ''}`, () => {
      const { pages, edges: all } = this.linkGraph(viewerId);
      const linksIn = new Map(), linksOut = new Map();
      for (const { source, target } of all) {
        linksOut.set(source, (linksOut.get(source) || 0) + 1);
        linksIn.set(target, (linksIn.get(target) || 0) + 1);
      }
      return { edges: all, nodes: pages.map((n) => ({ id: n.id, slug: n.slug, title: n.title, category: n.category, url: `/pages/${n.slug}`,
        links_in: linksIn.get(n.id) || 0, links_out: linksOut.get(n.id) || 0, tags: n.tags_csv ? n.tags_csv.split(',').sort() : [] })) };
    });
    let focusId = null;
    if (focus) {
      // A local graph: the page plus everything within `depth` links of it, either direction.
      focusId = this.readable(focus, viewerId).id;
      const near = new Map();
      for (const { source, target } of edges) for (const [x, y] of [[source, target], [target, source]]) (near.get(x) ?? near.set(x, []).get(x)).push(y);
      const keep = new Set([focusId]);
      for (let d = 0, frontier = [focusId]; d < depth && frontier.length; d++) {
        const next = [];
        for (const id of frontier) for (const y of near.get(id) || []) if (!keep.has(y)) { keep.add(y); next.push(y); }
        frontier = next;
      }
      nodes = nodes.filter((n) => keep.has(n.id));
      edges = edges.filter((e) => keep.has(e.source) && keep.has(e.target));
    }
    if (views) {
      const counts = new Map(this.all('SELECT artifact_id AS id, COUNT(*) AS n FROM views GROUP BY artifact_id').map((r) => [r.id, r.n]));
      nodes = nodes.map((n) => ({ ...n, views: counts.get(n.id) || 0 }));
    }
    return { focus: focusId, edges, nodes };
  }

  /**
   * Hover previews for the pages a note links to: title, tags and the opening text,
   * keyed by slug. Only pages this viewer can see.
   */
  previews(slugs, viewerId) {
    const want = [...new Set(slugs)].slice(0, 200);
    if (!want.length) return {};
    const rows = this.all(`SELECT a.slug, a.title, a.description, f.body, ${TAGS} FROM artifacts a JOIN artifacts_fts f ON f.rowid = a.id`
      + ` WHERE a.slug IN (${want.map(() => '?').join(',')}) AND a.state = 'active' AND (a.visibility = 'public' OR a.owner_id = ?)`,
    ...want, viewerId ?? -1);
    const out = {};
    for (const r of rows) {
      let text = (r.body || '').replace(/\s+/g, ' ').trim();
      if (r.description && text.startsWith(r.description)) text = text.slice(r.description.length).trim();
      if (text.startsWith(r.title)) text = text.slice(r.title.length).trim(); // the page's own heading
      out[r.slug] = { title: r.title, description: r.description, tags: r.tags_csv ? r.tags_csv.split(',').sort() : [],
        text: text.length > PREVIEW_CHARS ? `${text.slice(0, PREVIEW_CHARS).replace(/\s+\S*$/, '')}…` : text };
    }
    return out;
  }

  /** Every page this viewer can see, lightly: what the explorer sidebar lists. */
  explorer(viewerId) {
    return this.cached(`explorer:${viewerId ?? ''}`, () => this.all("SELECT a.slug, a.title, a.path FROM artifacts a WHERE a.state = 'active'"
      + " AND (a.visibility = 'public' OR a.owner_id = ?) ORDER BY lower(a.title)", viewerId ?? -1)
      .map((r) => ({ slug: r.slug, title: r.title, path: r.path, url: `/pages/${r.slug}` })));
  }

  /** Categories in use among pages this viewer can see, with counts. */
  categories(viewerId) {
    return this.tags(viewerId).map(({ tag, count }) => ({ category: tag, count }));
  }

  /**
   * Everything /stats shows, for the pages this viewer can see (public pages, plus
   * their own private ones). Days and weeks are in the server's local time, and
   * every series is filled in, so a quiet day is a zero rather than a gap.
   */
  stats(viewerId, { days = 30, weeks = 12, top = 10 } = {}) {
    const vis = "a.state = 'active' AND (a.visibility = 'public' OR a.owner_id = ?)";
    const v = viewerId ?? -1;
    const one = (sql) => this.one(sql, v);
    // The last `days` local days, today included, from midnight on the first; the days before
    // them for comparison. Counted on the calendar (setDate), so a DST change can't skip a day or repeat one.
    const dayStart = (back) => { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - back); return d; };
    const since = dayStart(days - 1).getTime() / 1000;
    const totals = {
      pages: one(`SELECT COUNT(*) AS n FROM artifacts a WHERE ${vis}`).n,
      featured: one(`SELECT COUNT(*) AS n FROM artifacts a WHERE ${vis} AND a.pinned_at IS NOT NULL`).n,
      versions: one(`SELECT COUNT(*) AS n FROM versions x JOIN artifacts a ON a.id = x.artifact_id WHERE ${vis}`).n,
      views: one(`SELECT COUNT(*) AS n FROM views x JOIN artifacts a ON a.id = x.artifact_id WHERE ${vis}`).n,
      comments: one(`SELECT COUNT(*) AS n FROM comments x JOIN artifacts a ON a.id = x.artifact_id WHERE ${vis}`).n,
      tags: one(`SELECT COUNT(DISTINCT t.tag) AS n FROM tags t JOIN artifacts a ON a.id = t.artifact_id WHERE ${vis}`).n,
      authors: one(`SELECT COUNT(DISTINCT x.author_id) AS n FROM versions x JOIN artifacts a ON a.id = x.artifact_id WHERE ${vis}`).n,
      bytes: one(`SELECT COALESCE(SUM(x.size), 0) AS n FROM versions x JOIN artifacts a ON a.id = x.artifact_id AND x.n = a.latest_version WHERE ${vis}`).n,
    };
    const recentViews = this.one(`SELECT COUNT(*) AS n, COUNT(DISTINCT x.visitor || date(x.at, 'unixepoch', 'localtime')) AS d`
      + ` FROM views x JOIN artifacts a ON a.id = x.artifact_id WHERE ${vis} AND x.at >= ?`, v, since);
    Object.assign(totals, { views_recent: recentViews.n, visitor_days_recent: recentViews.d });
    // The 30 days before those, so the page can say whether views are up or down.
    totals.views_previous = this.one(`SELECT COUNT(*) AS n FROM views x JOIN artifacts a ON a.id = x.artifact_id WHERE ${vis} AND x.at >= ? AND x.at < ?`,
      v, dayStart(2 * days - 1).getTime() / 1000, since).n;

    const byDay = new Map(this.all("SELECT date(x.at, 'unixepoch', 'localtime') AS day, COUNT(*) AS n FROM views x"
      + ` JOIN artifacts a ON a.id = x.artifact_id WHERE ${vis} AND x.at >= ? GROUP BY day`, v, since).map((r) => [r.day, r.n]));
    const viewsByDay = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = dayStart(i).toLocaleDateString('en-CA');
      viewsByDay.push({ day: d, views: byDay.get(d) || 0 });
    }

    // Weeks start on Monday; label each by its Monday.
    const monday = (t) => { const d = new Date(t); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return d; };
    const thisWeek = monday(Date.now());
    const start = new Date(thisWeek); start.setDate(start.getDate() - 7 * (weeks - 1));
    const uploads = this.all(`SELECT x.created_at FROM versions x JOIN artifacts a ON a.id = x.artifact_id WHERE ${vis} AND x.created_at >= ?`,
      v, start.getTime() / 1000);
    const uploadsByWeek = Array.from({ length: weeks }, (_, i) => {
      const w = new Date(start); w.setDate(w.getDate() + 7 * i);
      return { week: w.toLocaleDateString('en-CA'), versions: 0 };
    });
    for (const u of uploads) {
      const i = Math.round((monday(u.created_at * 1000) - start) / (7 * 86400000));
      if (uploadsByWeek[i]) uploadsByWeek[i].versions++;
    }

    const pageRows = (sql) => this.all(sql, v, top).map((r) => ({ ...r, url: `/pages/${r.slug}` }));
    return {
      totals,
      views_by_day: viewsByDay,
      uploads_by_week: uploadsByWeek,
      most_viewed: pageRows(`SELECT a.slug, a.title, (SELECT COUNT(*) FROM views x WHERE x.artifact_id = a.id) AS views FROM artifacts a`
        + ` WHERE ${vis} AND views > 0 ORDER BY views DESC, a.title LIMIT ?`),
      most_edited: pageRows(`SELECT a.slug, a.title, a.latest_version AS versions FROM artifacts a WHERE ${vis} AND a.latest_version > 1`
        + ' ORDER BY a.latest_version DESC, a.title LIMIT ?'),
      tags: this.tags(viewerId).sort((x, y) => y.count - x.count || x.tag.localeCompare(y.tag)),
      recent: this.all(`SELECT a.slug, a.title, x.n, x.note, x.created_at, u.name AS author FROM versions x`
        + ` JOIN artifacts a ON a.id = x.artifact_id LEFT JOIN users u ON u.id = x.author_id WHERE ${vis}`
        + ' ORDER BY x.created_at DESC LIMIT ?', v, top)
        .map((r) => ({ ...r, author: r.author ? displayName(r.author, viewerId) : '(deleted user)', url: `/pages/${r.slug}` })),
    };
  }

  /** How many active pages this viewer can see. */
  countPages(viewerId) {
    return this.one("SELECT COUNT(*) AS n FROM artifacts WHERE state = ? AND (visibility = 'public' OR owner_id = ?)", ACTIVE, viewerId ?? -1).n;
  }

  /** Tags in use on pages this viewer can see, with counts, alphabetical. */
  tags(viewerId) {
    return this.all('SELECT t.tag, COUNT(*) AS count FROM tags t JOIN artifacts a ON a.id = t.artifact_id'
      + " WHERE a.state = ? AND (a.visibility = 'public' OR a.owner_id = ?) GROUP BY t.tag ORDER BY t.tag", ACTIVE, viewerId ?? -1)
      .map((r) => ({ ...r }));
  }

  /**
   * Add and remove tags on many pages at once. Each page is checked on its own (you
   * may edit some and not others), so the result reports per page: { slug, tags } or
   * { slug, error }. Pages that worked are saved even if others didn't.
   */
  tagPages(userId, slugs, { add = [], remove = [] } = {}) {
    const fix = (list) => [...new Set(list.map((t) => {
      const n = normalizeTag(t);
      if (!n) throw new ApiError(400, `'${t}' can't be a tag: use letters, digits and dashes (up to 40)`);
      return n;
    }))];
    [add, remove] = [fix(add), fix(remove)];
    if (!slugs.length || (!add.length && !remove.length)) throw new ApiError(400, 'give pages and tags to add or remove');
    const out = this.tx(() => slugs.map((slug) => {
      try {
        const a = this.editable(slug, userId);
        // Checked before anything is written: a page that would go over the limit is left as it was.
        const current = this.all('SELECT tag FROM tags WHERE artifact_id = ?', a.id).map((r) => r.tag);
        const tags = [...new Set([...current.filter((t) => !remove.includes(t)), ...add])].sort();
        if (tags.length > MAX_TAGS_PER_PAGE) throw new ApiError(400, `at most ${MAX_TAGS_PER_PAGE} tags per page`);
        for (const t of remove) this.run('DELETE FROM tags WHERE artifact_id = ? AND tag = ?', a.id, t);
        for (const t of add) this.run('INSERT OR IGNORE INTO tags (artifact_id, tag) VALUES (?, ?)', a.id, t);
        this.index(a.id); // tags are searchable
        return { slug: a.slug, tags };
      } catch (e) {
        if (!e.status) throw e;
        return { slug, error: e.message };
      }
    }));
    this.changed();
    return out;
  }

  // --- assets: images and PDFs that notes embed ---------------------------------------
  /** Store (or replace) an asset by file name. Names follow notes' rule: "My Photo.png" → "My-Photo.png". */
  putAsset(userId, name, data) {
    const ext = (name.match(/\.([a-z0-9]+)$/i)?.[1] || '').toLowerCase();
    if (!ASSET_TYPES[ext]) throw new ApiError(400, `assets must be one of: ${Object.keys(ASSET_TYPES).join(', ')}`);
    if (!data.length || data.length > MAX_ASSET_BYTES) throw new ApiError(413, `an asset must be 1 byte to ${MAX_ASSET_BYTES / 1024 / 1024} MB`);
    const clean = name.trim().replace(/\s+/g, '-');
    if (!SLUG_RE.test(clean)) throw new ApiError(400, 'asset names must be file names (letters, digits, . _ -)');
    const old = this.one('SELECT id, owner_id FROM assets WHERE name = ?', clean);
    if (old && old.owner_id !== userId) throw new ApiError(409, `'${clean}' belongs to someone else`);
    const sha = createHash('sha256').update(data).digest('hex');
    if (old) this.run('UPDATE assets SET data = ?, sha256 = ?, size = ?, mime = ?, updated_at = ? WHERE id = ?', data, sha, data.length, ASSET_TYPES[ext], now(), old.id);
    else this.run('INSERT INTO assets (name, mime, data, sha256, size, owner_id, updated_at) VALUES (?,?,?,?,?,?,?)', clean, ASSET_TYPES[ext], data, sha, data.length, userId, now());
    this.changed();
    return assetInfo(this.asset(clean, { data: false }));
  }

  /** An asset by the name a note uses for it (any case, spaces or dashes); null if none. `data: false` leaves the file out. */
  asset(name, { data = true } = {}) {
    const base = String(name).split('/').pop().trim();
    const sql = `SELECT ${data ? '*' : ASSET_META} FROM assets WHERE name = ?`;
    return this.one(sql, base) ?? this.one(sql, base.replace(/\s+/g, '-')) ?? null;
  }

  /**
   * May this viewer have asset `x`? The person who uploaded it may; anyone else through a
   * page of the uploader's that shows it and that they can see, or whose share link they
   * hold (`via`, its share id). A page only vouches for its own owner's files, so naming
   * someone else's file in your page doesn't publish it.
   */
  canReadAsset(x, viewerId, { via } = {}) {
    if (viewerId != null && x.owner_id === viewerId) return true;
    return !!this.one("SELECT 1 AS ok FROM asset_refs r JOIN artifacts a ON a.id = r.artifact_id WHERE r.name = ? AND a.owner_id = ?"
      + " AND a.state = 'active' AND (a.visibility = 'public' OR a.share_id = ?) LIMIT 1", x.name, x.owner_id, via ?? '');
  }

  /** The assets this user uploaded, or every one for an admin. */
  listAssets(user) {
    return this.all(`SELECT ${ASSET_META} FROM assets${user.is_admin ? '' : ' WHERE owner_id = ?'} ORDER BY name`, ...(user.is_admin ? [] : [user.id])).map(assetInfo);
  }

  deleteAsset(userId, name) {
    const a = this.asset(name, { data: false });
    if (!a) throw new ApiError(404, 'no such asset');
    if (a.owner_id !== userId) throw new ApiError(403, 'only its owner can delete an asset');
    this.run('DELETE FROM assets WHERE id = ?', a.id);
    this.changed();
  }

  /** Pin to (or unpin from) the home page's Featured section: the page's owner, or an admin. */
  pin(user, slug, on) {
    const a = this.exact(slug, user.id);
    if (a.owner_id !== user.id && !user.is_admin) throw new ApiError(403, `only ${a.owner} or an admin can feature '${a.slug}'`);
    if (on && a.pinned_at == null) this.run('UPDATE artifacts SET pinned_at = ? WHERE id = ?', now(), a.id);
    if (!on) this.run('UPDATE artifacts SET pinned_at = NULL WHERE id = ?', a.id);
    this.changed();
    return this.describe(a.slug, user.id);
  }

  /** Every indexed word. Only steers matching; results are still visibility-filtered. */
  vocabulary() {
    this.vocab ??= new Vocabulary(this.all('SELECT term FROM artifacts_vocab').map((r) => r.term));
    return this.vocab;
  }

  version(a, n) {
    const row = this.one('SELECT html FROM versions WHERE artifact_id = ? AND n = ?', a.id, n || a.latest_version);
    if (!row) throw new ApiError(404, 'no such version');
    return Buffer.from(row.html);
  }

  /** Raw source; trashed pages still readable here by their owner. */
  versionHtml(slug, n, viewerId) { return this.version(this.readable(slug, viewerId), n); }

  /** `visit` is [ip, userAgent] to count a page view, or null not to. */
  /** { body, slug, n, latest }: the HTML of version n (default latest), counting a view if `visit`. */
  render(slug, n, viewerId, visit) {
    const a = this.readable(slug, viewerId);
    if (a.state !== ACTIVE) throw new ApiError(404, 'no such artifact');
    const body = this.version(a, n);
    this.countView(a, n, visit, 'url');
    return { body, slug: a.slug, n: n || a.latest_version, latest: a.latest_version, page: a };
  }

  /** Capability link: works for private artifacts too, never for trashed ones. */
  renderShare(shareId, n, visit) {
    const a = this.one('SELECT * FROM artifacts WHERE share_id = ?', shareId);
    if (!a || a.state !== ACTIVE) throw new ApiError(404, 'not found');
    const body = this.version(a, n);
    this.countView(a, n, visit, 'share');
    return { body, slug: a.slug, n: n || a.latest_version, latest: a.latest_version, page: a };
  }

  /**
   * Record one API request (handleRequest calls this). At most hourly, requests older
   * than the retention period are folded into the daily totals, then deleted.
   */
  recordApiCall({ client, name = '', method, route, status, userId = null }) {
    const t = now();
    this.run('INSERT INTO api_calls (at, client, name, method, route, status, user_id) VALUES (?,?,?,?,?,?,?)',
      t, client, name, method, route, status, userId);
    if (!this.lastPrune || t - this.lastPrune > 3600) {
      this.lastPrune = t;
      this.rollUpApiCalls(t - API_CALL_RETENTION_DAYS * 86400);
    }
  }

  /** Fold requests from before `cutoff` into api_calls_daily (adding to any day already there), then drop them. */
  rollUpApiCalls(cutoff) {
    this.tx(() => {
      this.run("INSERT INTO api_calls_daily (day, client, name, method, route, calls, errors, server_errors)"
        + " SELECT date(at, 'unixepoch', 'localtime'), client, name, method, route, COUNT(*), SUM(status >= 400), SUM(status >= 500)"
        + ' FROM api_calls WHERE at < ? GROUP BY 1, 2, 3, 4, 5 ORDER BY 1'
        + ' ON CONFLICT (day, client, name, method, route) DO UPDATE SET calls = calls + excluded.calls,'
        + ' errors = errors + excluded.errors, server_errors = server_errors + excluded.server_errors', cutoff);
      this.run('DELETE FROM api_calls WHERE at < ?', cutoff);
    });
  }

  /**
   * API usage for admins, over the last `days` (server's local days), or all of it when
   * `days` is null: recent requests and the daily totals they're folded into, read as one
   * (a request is only ever in one of the two). Totals by kind of client, calls over time
   * split by kind (per day up to 120 days, per week up to two years, else per month; every
   * period present), the most used MCP tools and CLI commands, the busiest routes, errors.
   * Signed-in users are counted from the detailed records, so over the last 90 days at most.
   */
  usage({ days = 30, top = 10 } = {}) {
    const today = new Date();
    const dayStr = (d) => d.toLocaleDateString('en-CA');
    const ago = (n) => { const d = new Date(today); d.setDate(d.getDate() - n); return d; };
    const sinceDay = days == null ? '' : dayStr(ago(days - 1));
    const since = days == null ? 0 : new Date(`${sinceDay}T00:00`).getTime() / 1000;
    const ALL = "(SELECT date(at, 'unixepoch', 'localtime') AS day, client, name, method, route, 1 AS calls,"
      + ' (status >= 400) AS errors, (status >= 500) AS server_errors FROM api_calls WHERE at >= ?'
      + ' UNION ALL SELECT day, client, name, method, route, calls, errors, server_errors FROM api_calls_daily WHERE day >= ?)';
    const q = (sql, ...more) => this.all(sql.replace('$ALL', ALL), since, sinceDay, ...more);

    const kinds = Object.fromEntries(CLIENT_KINDS.map((k) => [k, 0]));
    for (const r of q('SELECT client, SUM(calls) AS n FROM $ALL GROUP BY client')) kinds[r.client] = r.n;
    const t = q('SELECT SUM(calls) AS calls, SUM(errors) AS errors, SUM(server_errors) AS server_errors, MIN(day) AS first FROM $ALL')[0];
    const users = this.one('SELECT COUNT(DISTINCT user_id) AS n FROM api_calls WHERE at >= ?', since).n;

    // Periods from the start (or the first record, for all time) to today.
    const start = days == null ? new Date(`${t.first || dayStr(today)}T12:00`) : ago(days - 1);
    const span = Math.round((today - start) / 86400000) + 1;
    const unit = span <= 120 ? 'day' : span <= 730 ? 'week' : 'month';
    const periodOf = (dayText) => {
      const d = new Date(`${dayText}T12:00`);
      if (unit === 'week') d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); // weeks start on Monday
      if (unit === 'month') d.setDate(1);
      return dayStr(d);
    };
    const series = new Map();
    // Compared as dates, not times: before noon, today's noon is still ahead and today would drop off.
    for (let d = new Date(`${periodOf(dayStr(start))}T12:00`); dayStr(d) <= dayStr(today);) {
      series.set(dayStr(d), Object.fromEntries(CLIENT_KINDS.map((k) => [k, 0])));
      if (unit === 'day') d.setDate(d.getDate() + 1); else if (unit === 'week') d.setDate(d.getDate() + 7); else d.setMonth(d.getMonth() + 1);
    }
    for (const r of q('SELECT day, client, SUM(calls) AS n FROM $ALL GROUP BY day, client')) {
      const p = series.get(periodOf(r.day));
      if (p) p[r.client] = (p[r.client] || 0) + r.n;
    }
    const named = (client) => q('SELECT name, SUM(calls) AS calls, SUM(errors) AS errors FROM $ALL'
      + " WHERE client = ? AND name != '' GROUP BY name ORDER BY calls DESC, name LIMIT ?", client, top);
    return {
      days,
      unit,
      retention_days: API_CALL_RETENTION_DAYS,
      totals: { calls: t.calls || 0, ...kinds, errors: t.errors || 0, server_errors: t.server_errors || 0, users },
      series: [...series].map(([period, counts]) => ({ period, ...counts })),
      mcp_tools: named('mcp'),
      cli_commands: named('cli'),
      routes: q('SELECT method, route, SUM(calls) AS calls, SUM(errors) AS errors FROM $ALL'
        + ' GROUP BY method, route ORDER BY calls DESC, route LIMIT ?', top),
    };
  }

  countView(a, n, visit, via) {
    if (!visit) return;
    const [ip, ua] = visit;
    if (BOT_UA_RE.test(ua || '')) return;
    const t = now();
    const visitor = sha256(`${this.visitorSecret}|${localDay(t)}|${ip}|${ua}`).slice(0, 16);
    this.run('INSERT INTO views (artifact_id, n, at, visitor, via) VALUES (?,?,?,?,?)',
      a.id, n || a.latest_version, t, visitor, via);
  }

  /** Owner-only traffic report for one page (a read: found by name as pages are). */
  views(userId, slug, days = VIEW_REPORT_DAYS) {
    const a = this.readable(slug, userId);
    if (a.owner_id !== userId) throw new ApiError(403, `'${a.slug}' belongs to ${a.owner}`);
    const total = this.one('SELECT COUNT(*) AS views, COUNT(DISTINCT visitor) AS visitors, MAX(at) AS last'
      + ' FROM views WHERE artifact_id = ?', a.id);
    const byDay = this.all("SELECT date(at, 'unixepoch', 'localtime') AS day, COUNT(*) AS views,"
      + ' COUNT(DISTINCT visitor) AS visitors FROM views WHERE artifact_id = ? AND at >= ?'
      + ' GROUP BY day ORDER BY day DESC', a.id, now() - days * 86400);
    const byVersion = this.all('SELECT n, COUNT(*) AS c FROM views WHERE artifact_id = ? GROUP BY n ORDER BY n', a.id);
    const byVia = this.all('SELECT via, COUNT(*) AS c FROM views WHERE artifact_id = ? GROUP BY via', a.id);
    return {
      slug: a.slug,
      views: total.views,
      visitor_days: total.visitors, // a visitor counts once per day, so this is visitor-days over all time
      last_viewed_at: total.last,
      [`last_${days}_days`]: byDay.map((r) => ({ ...r })),
      by_version: Object.fromEntries(byVersion.map((r) => [String(r.n), r.c])),
      by_link: Object.fromEntries(byVia.map((r) => [r.via, r.c])),
    };
  }

  /** [fromN, toN, oldLines, newLines]. Default: previous version vs latest. */
  diff(slug, viewerId, fromN, toN, of = 'text') {
    if (!['text', 'source'].includes(of)) throw new ApiError(400, 'of must be text or source');
    const a = this.readable(slug, viewerId);
    toN ||= a.latest_version;
    fromN ||= Math.max(toN - 1, 1);
    const [oldDoc, newDoc] = [this.version(a, fromN), this.version(a, toN)].map((b) => b.toString('utf8'));
    // "Visible text" for a note is its Markdown source, which already reads as text.
    const lines = of === 'source' ? (d) => d.split(/\r?\n/) : isMarkdown(a.slug) ? noteLines
      : isNotebook(a.slug) ? (d) => noteLines(notebookMarkdown(parseNotebook(d))) : extractLines; // a notebook: its cells, read as Markdown
    return [fromN, toN, lines(oldDoc), lines(newDoc)];
  }

  // --- comments --------------------------------------------------------------------
  comments(slug, viewerId, n) {
    const a = this.readable(slug, viewerId);
    return (n
      ? this.all(`${COMMENT_SELECT} WHERE c.artifact_id = ? AND c.n = ? ORDER BY c.id`, a.id, n)
      : this.all(`${COMMENT_SELECT} WHERE c.artifact_id = ? ORDER BY c.id`, a.id))
      .map((c) => ({ ...c, author: displayName(c.author, viewerId) }));
  }

  addComment(userId, slug, body, n, parentId) {
    body = (body || '').trim();
    if (!body || body.length > MAX_COMMENT_CHARS) throw new ApiError(400, `comment must be 1-${MAX_COMMENT_CHARS} characters`);
    const a = this.readable(slug, userId);
    if (a.state !== ACTIVE) throw new ApiError(409, 'restore the page before commenting on it');
    if (parentId) {
      const parent = this.one('SELECT n, parent_id FROM comments WHERE id = ? AND artifact_id = ?', parentId, a.id);
      if (!parent) throw new ApiError(404, 'no such comment on this page');
      if (parent.parent_id) throw new ApiError(400, 'reply to the top-level comment, not to a reply');
      n = parent.n;
    }
    n ||= a.latest_version;
    if (n < 1 || n > a.latest_version) throw new ApiError(404, 'no such version');
    const id = this.run('INSERT INTO comments (artifact_id, n, parent_id, author_id, body, created_at) VALUES (?,?,?,?,?,?)',
      a.id, n, parentId || null, userId, body, now()).lastInsertRowid;
    return { ...this.one(`${COMMENT_SELECT} WHERE c.id = ?`, id) };
  }

  /** The comment, if this user wrote it or owns the page. */
  commentForChange(userId, id) {
    const c = this.one('SELECT c.*, a.owner_id FROM comments c JOIN artifacts a ON a.id = c.artifact_id WHERE c.id = ?', id);
    if (!c) throw new ApiError(404, 'no such comment');
    if (userId !== c.author_id && userId !== c.owner_id) {
      throw new ApiError(403, "only the comment's author or the page's owner can do that");
    }
    return c;
  }

  resolveComment(userId, id, resolved) {
    const c = this.commentForChange(userId, id);
    if (c.parent_id) throw new ApiError(400, 'resolve the top-level comment; replies go with it');
    this.run('UPDATE comments SET resolved_at = ? WHERE id = ?', resolved ? now() : null, id);
    return { ...this.one(`${COMMENT_SELECT} WHERE c.id = ?`, id) };
  }

  deleteComment(userId, id) {
    this.commentForChange(userId, id);
    this.run('DELETE FROM comments WHERE id = ?', id); // replies cascade
  }
}

