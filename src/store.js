// All data access, on SQLite: Node's built-in node:sqlite by default, or any database
// object with the same small synchronous interface (exec, prepare → run/get/all,
// optionally transaction(fn) and close), such as a Cloudflare Durable Object's
// (cloudflare/sqlite.js). Each request's handler runs to completion against a
// synchronous database, so each method is atomic without locks; multi-statement writes
// still go through tx() so a failure leaves nothing half-done.
import { createHash, randomBytes } from 'node:crypto';
import {
  API_CALL_RETENTION_DAYS, ASSET_TYPES, BOT_UA_RE, CLIENT_KINDS, MAX_ASSET_BYTES, MAX_TAGS_PER_PAGE, SEARCH_WEIGHTS, TAG_RE, DEFAULT_EDITING, DEFAULT_USERNAMES, DEFAULT_VISIBILITY, EDITING_MODES, MASK_EMAILS_FOR_ANONYMOUS, MAX_COMMENT_CHARS, RESERVED_SLUGS,
  PAGE_EXT_RE, SEARCH_SORT, SLUG_RE, SORTS, USERNAME_RULES,
  VIEW_REPORT_DAYS, VISIBILITIES,
} from './config.js';
import { ACTIVE, NONE, PURGED, TRASHED, transition } from './lifecycle.js';
import { isMarkdown, noteLines, noteLinks, noteTags, noteTitle, parseFrontmatter, renderMarkdown } from './markdown.js';
import { isNotebook, markdownCells, notebookMarkdown, parseNotebook } from './notebook.js';
import { ApiError, HIT, bracketHits, extractLines, extractLinks, extractText, ftsQuery, metaContent } from './text.js';

/**
 * What a page says about itself, for HTML and Markdown alike: title, description,
 * category, tags it declares, its searchable text, and the pages it links to.
 */
export function pageMeta(slug, text) {
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
      links: noteLinks(markdownCells(nb)),
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
      links: noteLinks(text),
      aliases: (Array.isArray(data.aliases) ? data.aliases : data.aliases ? [data.aliases] : []).map((x) => String(x).trim()).filter(Boolean),
      draft: data.draft === true || data.publish === false,
    };
  }
  const { title, body } = extractText(text);
  const category = metaContent(text, 'category').toLowerCase();
  return {
    kind: 'html', title, description: metaContent(text, 'description'), category,
    tags: [normalizeTag(category)].filter(Boolean), body,
    links: extractLinks(text, { isSlug: (s) => SLUG_RE.test(s) && !RESERVED_SLUGS.has(s.toLowerCase()) }),
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
CREATE TABLE IF NOT EXISTS links (               -- what each page's latest version links to
    from_id INTEGER NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
    to_slug TEXT NOT NULL,                       -- as written; resolved (also as <slug>.html) when read
    PRIMARY KEY (from_id, to_slug)
);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;
// The search index has its own version: when its columns change, it is rebuilt
// from each page's latest version on startup (see ensureSearchIndex).
const SEARCH_INDEX_VERSION = '2'; // 2: title, name, body (0.4.0); 1: title, body
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

const now = () => Date.now() / 1000;
const sha256 = (s) => createHash('sha256').update(s).digest('hex');
export const hashToken = sha256;
const localDay = (t) => new Date(t * 1000).toLocaleDateString('en-CA'); // YYYY-MM-DD, server's timezone
const VIEWS = '(SELECT COUNT(*) FROM views v WHERE v.artifact_id = a.id) AS views';
const TAGS = "(SELECT group_concat(t.tag, ',') FROM tags t WHERE t.artifact_id = a.id) AS tags_csv";
const PREVIEW_CHARS = 420; // how much of a page a hover preview shows
const SELECT = `SELECT a.*, u.name AS owner, ${VIEWS}, ${TAGS} FROM artifacts a JOIN users u ON u.id = a.owner_id`;
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
    this.db.exec(SCHEMA);
    for (const [table, added] of Object.entries(ADDED_COLUMNS)) {
      const cols = new Set(this.db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
      for (const [name, def, backfill] of added) {
        if (cols.has(name)) continue;
        this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${def}`);
        if (backfill) this.db.exec(backfill);
      }
    }
    this.db.prepare("INSERT OR IGNORE INTO meta VALUES ('visitor_secret', ?)").run(randomBytes(16).toString('hex'));
    this.visitorSecret = this.db.prepare("SELECT value FROM meta WHERE key = 'visitor_secret'").get().value;
    this.vocab = null; // indexed words for fuzzy search; reset whenever the index changes
    this.ensureSearchIndex();
    this.ensureLinks();
    if (this.setting('tags_index') !== '1') { // 0.5.0: categories become each page's first tag
      this.run("INSERT OR IGNORE INTO tags (artifact_id, tag) SELECT id, category FROM artifacts WHERE category != ''");
      this.setSetting('tags_index', '1');
    }
  }

  close() { this.db.close?.(); }

  /** Create the search index, or rebuild it from every page's latest version if its layout changed. */
  ensureSearchIndex() {
    const exists = this.one("SELECT 1 AS x FROM sqlite_master WHERE name = 'artifacts_fts'");
    if (exists && this.setting('search_index', '1') === SEARCH_INDEX_VERSION) return;
    this.tx(() => {
      this.db.exec('DROP TABLE IF EXISTS artifacts_vocab; DROP TABLE IF EXISTS artifacts_fts;'
        + ' CREATE VIRTUAL TABLE artifacts_fts USING fts5(title, name, body);'
        + " CREATE VIRTUAL TABLE artifacts_vocab USING fts5vocab(artifacts_fts, 'row');");
      const rows = this.all('SELECT a.id, a.slug, a.title, a.description, v.html FROM artifacts a'
        + ' JOIN versions v ON v.artifact_id = a.id AND v.n = a.latest_version');
      for (const r of rows) this.index(r.id, r.title, r.slug, r.description, pageMeta(r.slug, Buffer.from(r.html).toString('utf8')).body);
      this.setSetting('search_index', SEARCH_INDEX_VERSION);
    });
    this.vocab = null;
  }

  /** Fill the links table once for databases from before it existed (0.4.0). */
  ensureLinks() {
    if (this.setting('links_index') === '1') return;
    this.tx(() => {
      for (const r of this.all('SELECT a.id, v.html FROM artifacts a JOIN versions v ON v.artifact_id = a.id AND v.n = a.latest_version')) {
        this.updateLinks(r.id, pageMeta(r.slug, Buffer.from(r.html).toString('utf8')).links);
      }
      this.setSetting('links_index', '1');
    });
  }

  updateLinks(id, links) {
    this.run('DELETE FROM links WHERE from_id = ?', id);
    for (const to of links) this.run('INSERT OR IGNORE INTO links (from_id, to_slug) VALUES (?, ?)', id, to);
  }

  /** (Re)index one page. The description is searchable too: it's what its card shows. */
  index(id, title, slug, description, body) {
    const name = slug.replace(PAGE_EXT_RE, '').replace(/[-_.]+/g, ' ');
    this.run('DELETE FROM artifacts_fts WHERE rowid = ?', id);
    this.run('INSERT INTO artifacts_fts (rowid, title, name, body) VALUES (?,?,?,?)', id, title, name, `${description} ${body}`.trim());
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

  one(sql, ...args) { return this.db.prepare(sql).get(...args); }
  all(sql, ...args) { return this.db.prepare(sql).all(...args); }
  run(sql, ...args) { return this.db.prepare(sql).run(...args); }

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

  editable(slug, userId) {
    const a = this.readable(slug, userId);
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
  }

  // --- artifact lookup ---------------------------------------------------------
  /**
   * A page by name: exact, else with .html or .md added (so /trip-plan finds
   * trip-plan.html and /weekly-review finds weekly-review.md), else the same ignoring
   * case (so [[Weekly Review]] finds Weekly-Review.md).
   */
  find(slug) {
    for (const s of [slug, `${slug}.html`, `${slug}.md`, `${slug}.ipynb`]) {
      const a = this.one(`${SELECT} WHERE a.slug = ?`, s);
      if (a) return a;
    }
    return this.one(`${SELECT} WHERE lower(a.slug) IN (lower(?), lower(?), lower(?), lower(?)) ORDER BY a.id LIMIT 1`, slug, `${slug}.html`, `${slug}.md`, `${slug}.ipynb`)
      // Then by bare file name, shortest path first (Quartz), so [[Backlinks]] finds plugins-Backlinks.md.
      // Only for bare names: /pages/x.html must never land on some other page called x.
      ?? (PAGE_EXT_RE.test(slug) ? null : this.one(`${SELECT} WHERE a.name_key = lower(?) ORDER BY length(a.slug), a.id LIMIT 1`, slug))
      // Last, a note's aliases (frontmatter `aliases:`), so [[WR]] finds "Weekly Review".
      ?? this.one(`${SELECT} JOIN aliases al ON al.artifact_id = a.id WHERE al.alias = ? ORDER BY a.id LIMIT 1`, slug.replace(/-/g, ' '))
      ?? this.one(`${SELECT} JOIN aliases al ON al.artifact_id = a.id WHERE al.alias = ? ORDER BY a.id LIMIT 1`, slug);
  }

  /** Pages (visible to this viewer) that link to page `a`, by any of the names it answers to. */
  backlinks(a, viewerId) {
    const base = a.slug.replace(PAGE_EXT_RE, '');
    return this.all("SELECT DISTINCT f.slug, f.title FROM links l JOIN artifacts f ON f.id = l.from_id"
      + " WHERE lower(l.to_slug) IN (lower(?), lower(?), lower(?)) AND f.id != ? AND f.state = 'active'"
      + " AND (f.visibility = 'public' OR f.owner_id = ?) ORDER BY f.title", a.slug, base, a.name_key || base, a.id, viewerId ?? -1)
      .map((r) => ({ slug: r.slug, title: r.title, url: `/pages/${r.slug}` }));
  }

  readable(slug, viewerId) {
    const a = this.find(slug);
    if (!a || !visible(a, viewerId)) throw new ApiError(404, 'no such artifact');
    return a;
  }

  owned(slug, userId) {
    const a = this.readable(slug, userId);
    if (a.owner_id !== userId) throw new ApiError(403, `'${a.slug}' belongs to ${a.owner}`);
    return a;
  }

  // --- writes ----------------------------------------------------------------------
  /** `base`: the version the uploader started from; refuse if someone has added one since. */
  putVersion(userId, slug, doc, { title, note = '', visibility, base, source, nameKey, path } = {}) {
    if (!SLUG_RE.test(slug) || RESERVED_SLUGS.has(slug.toLowerCase())) {
      throw new ApiError(400, `slug must be a file name matching ${SLUG_RE.source}, not reserved`);
    }
    if (visibility != null && !VISIBILITIES.includes(visibility)) {
      throw new ApiError(400, `visibility must be one of ${VISIBILITIES.join(', ')}`);
    }
    const text = Buffer.from(doc).toString('utf8');
    const meta = pageMeta(slug, text);
    const { title: htmlTitle, body, description, category } = meta;
    const t = now();
    this.tx(() => {
      const a = this.one(`${SELECT} WHERE a.slug = ?`, slug);
      if (a && !this.canEdit(a, userId)) throw new ApiError(409, `'${slug}' is taken by ${a.owner}; pick another file name`);
      if (a && a.owner_id !== userId && visibility != null && visibility !== a.visibility) {
        throw new ApiError(403, `only ${a.owner} can change the visibility of '${slug}'`);
      }
      if (base != null && a && a.latest_version !== base) {
        throw new ApiError(409, `'${slug}' is at v${a.latest_version} now, but you started from v${base}; `
          + `see what changed (diff ${base} ${a.latest_version}) and upload again`);
      }
      const state = transition(a ? a.state : NONE, a ? 'update' : 'create');
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
      this.index(id, title, slug, description, body);
      this.updateLinks(id, meta.links);
      this.run('DELETE FROM aliases WHERE artifact_id = ?', id);
      for (const al of meta.aliases ?? []) this.run('INSERT OR IGNORE INTO aliases (artifact_id, alias) VALUES (?, ?)', id, al);
      if (source != null) this.run('UPDATE artifacts SET source = ? WHERE id = ?', source, id);
      if (path != null) this.run('UPDATE artifacts SET path = ? WHERE id = ?', path, id);
      this.run('UPDATE artifacts SET name_key = ? WHERE id = ?', (nameKey || slug.replace(PAGE_EXT_RE, '')).toLowerCase(), id);
      // Tags a page declares (HTML: its category; Markdown: frontmatter tags) follow
      // the page: newly declared ones are added, ones it stopped declaring are removed.
      // Tags added by hand, which the page never declared, are left alone.
      const before = a ? pageMeta(a.slug, this.version(a, a.latest_version).toString('utf8')).tags : [];
      for (const t of meta.tags) if (!before.includes(t)) this.run('INSERT OR IGNORE INTO tags (artifact_id, tag) VALUES (?, ?)', id, t);
      for (const t of before) if (!meta.tags.includes(t)) this.run('DELETE FROM tags WHERE artifact_id = ? AND tag = ?', id, t);
    });
    this.vocab = null;
    return this.describe(slug, userId);
  }

  setVisibility(userId, slug, visibility) {
    if (!VISIBILITIES.includes(visibility)) throw new ApiError(400, `visibility must be one of ${VISIBILITIES.join(', ')}`);
    const a = this.owned(slug, userId);
    this.run('UPDATE artifacts SET visibility = ? WHERE id = ?', visibility, a.id);
    return this.describe(a.slug, userId);
  }

  /** trash / restore / purge */
  apply(userId, slug, event) {
    const a = this.owned(slug, userId);
    const next = transition(a.state, event);
    if (next === PURGED) {
      this.tx(() => {
        this.run('DELETE FROM artifacts_fts WHERE rowid = ?', a.id);
        this.run('DELETE FROM artifacts WHERE id = ?', a.id); // versions, views, comments cascade
      });
      this.vocab = null;
      return { slug: a.slug, state: PURGED };
    }
    this.run('UPDATE artifacts SET state = ?, updated_at = ? WHERE id = ?', next, now(), a.id);
    return this.describe(a.slug, userId);
  }

  /** Make version n current again by appending a copy of it; history is never rewritten. */
  restoreVersion(userId, slug, n) {
    const a = this.editable(slug, userId);
    return this.putVersion(userId, a.slug, this.version(a, n), { note: `restored from v${n}` });
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
   * (its default). Featured pages come first unless searching.
   */
  list(viewerId, { q, state = ACTIVE, limit = 50, owner, category, source, sort } = {}) {
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
    const rows = q
      // Ranked: the whole query appearing in the title first, then bm25 with title
      // and file-name hits weighted above body hits (SEARCH_WEIGHTS).
      ? this.all(`SELECT a.*, u.name AS owner, ${VIEWS}, ${TAGS}, snippet(artifacts_fts, 2, char(1), char(2), '…', 12) AS snippet,`
        + ' highlight(artifacts_fts, 0, char(1), char(2)) AS title_hits'
        + ' FROM artifacts_fts JOIN artifacts a ON a.id = artifacts_fts.rowid JOIN users u ON u.id = a.owner_id'
        + ` WHERE artifacts_fts MATCH ? AND ${where}`
        + (ranked ? ' ORDER BY instr(lower(a.title), lower(?)) > 0 DESC, bm25(artifacts_fts, ?, ?, ?) LIMIT ?' : ` ORDER BY ${SORT_ORDER[sort]} LIMIT ?`),
        ftsQuery(q, this.vocabulary()), ...args, ...(ranked ? [q.trim(), SEARCH_WEIGHTS.title, SEARCH_WEIGHTS.name, SEARCH_WEIGHTS.body] : []), limit)
      : this.all(`SELECT a.*, u.name AS owner, ${VIEWS}, ${TAGS}, NULL AS snippet FROM artifacts a`
        + ` JOIN users u ON u.id = a.owner_id WHERE ${where} ORDER BY ${PINNED_FIRST}, ${SORT_ORDER[sort || 'updated']} LIMIT ?`, ...args, limit);
    return rows.map((r) => {
      const item = summary(r, viewerId);
      if (!q) return item;
      // The API gets [brackets] around matched words; cards get the raw markers (HIT, not serialized).
      Object.assign(item, { snippet: r.snippet ? bracketHits(r.snippet) : null, title_highlight: bracketHits(r.title_hits) });
      item[HIT] = { title: r.title_hits, snippet: r.snippet };
      return item;
    });
  }

  /**
   * Pages as nodes and the links between them as edges, for /graph. Only pages this
   * viewer can see, and only links whose target exists and is visible too.
   */
  graph(viewerId, { focus, depth = 1 } = {}) {
    const nodes = this.all(`SELECT a.id, a.slug, a.title, a.category, a.owner_id, ${TAGS},`
      + ' (SELECT COUNT(*) FROM views v WHERE v.artifact_id = a.id) AS views FROM artifacts a'
      + " WHERE a.state = ? AND (a.visibility = 'public' OR a.owner_id = ?) ORDER BY a.id", ACTIVE, viewerId ?? -1);
    const ids = new Set(nodes.map((n) => n.id));
    const edges = this.all("SELECT DISTINCT l.from_id AS source, t.id AS target FROM links l"
      + " JOIN artifacts t ON lower(t.slug) IN (lower(l.to_slug), lower(l.to_slug) || '.html', lower(l.to_slug) || '.md', lower(l.to_slug) || '.ipynb') OR t.name_key = lower(l.to_slug)")
      .filter((e) => e.source !== e.target && ids.has(e.source) && ids.has(e.target))
      .map((e) => ({ source: e.source, target: e.target }));
    const deg = (k) => (id) => edges.filter((e) => e[k] === id).length;
    let keep = null, focusId = null;
    if (focus) {
      // A local graph: the page plus everything within `depth` links of it, either direction.
      const f = this.readable(focus, viewerId);
      focusId = f.id;
      keep = new Set([f.id]);
      for (let d = 0, frontier = [f.id]; d < depth && frontier.length; d++) {
        const next = [];
        for (const e of edges) {
          for (const [a, b] of [[e.source, e.target], [e.target, e.source]]) {
            if (frontier.includes(a) && !keep.has(b)) { keep.add(b); next.push(b); }
          }
        }
        frontier = next;
      }
    }
    return {
      focus: focusId,
      edges: keep ? edges.filter((e) => keep.has(e.source) && keep.has(e.target)) : edges,
      nodes: nodes.filter((n) => !keep || keep.has(n.id)).map((n) => ({ id: n.id, slug: n.slug, title: n.title, category: n.category, url: `/pages/${n.slug}`,
        views: n.views, links_in: deg('target')(n.id), links_out: deg('source')(n.id),
        tags: n.tags_csv ? n.tags_csv.split(',').sort() : [] })),
    };
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
    return this.all("SELECT a.slug, a.title, a.path FROM artifacts a WHERE a.state = 'active'"
      + " AND (a.visibility = 'public' OR a.owner_id = ?) ORDER BY lower(a.title)", viewerId ?? -1)
      .map((r) => ({ slug: r.slug, title: r.title, path: r.path, url: `/pages/${r.slug}` }));
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
    const since = now() - days * 86400;
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
      v, since - days * 86400, since).n;

    const byDay = new Map(this.all("SELECT date(x.at, 'unixepoch', 'localtime') AS day, COUNT(*) AS n FROM views x"
      + ` JOIN artifacts a ON a.id = x.artifact_id WHERE ${vis} AND x.at >= ? GROUP BY day`, v, since).map((r) => [r.day, r.n]));
    const viewsByDay = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(Date.now() - i * 86400000).toLocaleDateString('en-CA');
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
    return this.tx(() => slugs.map((slug) => {
      try {
        const a = this.editable(slug, userId);
        for (const t of remove) this.run('DELETE FROM tags WHERE artifact_id = ? AND tag = ?', a.id, t);
        for (const t of add) this.run('INSERT OR IGNORE INTO tags (artifact_id, tag) VALUES (?, ?)', a.id, t);
        const tags = this.all('SELECT tag FROM tags WHERE artifact_id = ? ORDER BY tag', a.id).map((r) => r.tag);
        if (tags.length > MAX_TAGS_PER_PAGE) throw new ApiError(400, `at most ${MAX_TAGS_PER_PAGE} tags per page`);
        return { slug: a.slug, tags };
      } catch (e) {
        if (!e.status) throw e;
        return { slug, error: e.message };
      }
    }));
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
    return this.assetInfo(clean);
  }

  /** An asset by the name a note uses for it (any case, spaces or dashes); null if none. */
  asset(name) {
    const base = String(name).split('/').pop().trim();
    return this.one('SELECT * FROM assets WHERE name = ?', base) ?? this.one('SELECT * FROM assets WHERE name = ?', base.replace(/\s+/g, '-'));
  }

  assetInfo(name) {
    const a = this.asset(name);
    if (!a) throw new ApiError(404, 'no such asset');
    return { name: a.name, mime: a.mime, size: a.size, sha256: a.sha256, url: `/assets/${encodeURIComponent(a.name)}`, updated_at: a.updated_at };
  }

  listAssets() {
    return this.all('SELECT name FROM assets ORDER BY name').map((r) => this.assetInfo(r.name));
  }

  deleteAsset(userId, name) {
    const a = this.asset(name);
    if (!a) throw new ApiError(404, 'no such asset');
    if (a.owner_id !== userId) throw new ApiError(403, 'only its owner can delete an asset');
    this.run('DELETE FROM assets WHERE id = ?', a.id);
  }

  /** Pin to (or unpin from) the home page's Featured section: the page's owner, or an admin. */
  pin(user, slug, on) {
    const a = this.readable(slug, user.id);
    if (a.owner_id !== user.id && !user.is_admin) throw new ApiError(403, `only ${a.owner} or an admin can feature '${a.slug}'`);
    if (on && a.pinned_at == null) this.run('UPDATE artifacts SET pinned_at = ? WHERE id = ?', now(), a.id);
    if (!on) this.run('UPDATE artifacts SET pinned_at = NULL WHERE id = ?', a.id);
    return this.describe(a.slug, user.id);
  }

  /** Every indexed word. Only steers matching; results are still visibility-filtered. */
  vocabulary() {
    this.vocab ??= this.all('SELECT term FROM artifacts_vocab').map((r) => r.term);
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
    for (let d = new Date(`${periodOf(dayStr(start))}T12:00`); d <= today;) {
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

  /** Owner-only traffic report for one page. */
  views(userId, slug, days = VIEW_REPORT_DAYS) {
    const a = this.owned(slug, userId);
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

