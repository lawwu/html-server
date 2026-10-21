// All data access, on Node's built-in SQLite. Node runs one request's handler at
// a time and node:sqlite is synchronous, so each method is atomic without locks;
// multi-statement writes still go through tx() so a failure leaves nothing half-done.
import { createHash, randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import {
  BOT_UA_RE, SEARCH_WEIGHTS, DEFAULT_EDITING, DEFAULT_USERNAMES, DEFAULT_VISIBILITY, EDITING_MODES, MASK_EMAILS_FOR_ANONYMOUS, MAX_COMMENT_CHARS, RESERVED_SLUGS,
  SLUG_RE, USERNAME_RULES,
  VIEW_REPORT_DAYS, VISIBILITIES,
} from './config.js';
import { ACTIVE, NONE, PURGED, TRASHED, transition } from './lifecycle.js';
import { ApiError, HIT, bracketHits, extractLines, extractLinks, extractText, ftsQuery, metaContent } from './text.js';

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
const SELECT = `SELECT a.*, u.name AS owner, ${VIEWS} FROM artifacts a JOIN users u ON u.id = a.owner_id`;
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
  };
}

export class Store {
  constructor(path) {
    this.db = new DatabaseSync(path);
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
  }

  close() { this.db.close(); }

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
      for (const r of rows) this.index(r.id, r.title, r.slug, r.description, extractText(Buffer.from(r.html).toString('utf8')).body);
      this.setSetting('search_index', SEARCH_INDEX_VERSION);
    });
    this.vocab = null;
  }

  /** Fill the links table once for databases from before it existed (0.4.0). */
  ensureLinks() {
    if (this.setting('links_index') === '1') return;
    this.tx(() => {
      for (const r of this.all('SELECT a.id, v.html FROM artifacts a JOIN versions v ON v.artifact_id = a.id AND v.n = a.latest_version')) {
        this.updateLinks(r.id, Buffer.from(r.html).toString('utf8'));
      }
      this.setSetting('links_index', '1');
    });
  }

  updateLinks(id, html) {
    this.run('DELETE FROM links WHERE from_id = ?', id);
    for (const to of extractLinks(html, { isSlug: (s) => SLUG_RE.test(s) && !RESERVED_SLUGS.has(s.toLowerCase()) })) {
      this.run('INSERT OR IGNORE INTO links (from_id, to_slug) VALUES (?, ?)', id, to);
    }
  }

  /** (Re)index one page. The description is searchable too: it's what its card shows. */
  index(id, title, slug, description, body) {
    const name = slug.replace(/\.html?$/i, '').replace(/[-_.]+/g, ' ');
    this.run('DELETE FROM artifacts_fts WHERE rowid = ?', id);
    this.run('INSERT INTO artifacts_fts (rowid, title, name, body) VALUES (?,?,?,?)', id, title, name, `${description} ${body}`.trim());
  }

  tx(fn) {
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

  createUser(name, isAdmin = false) {
    name = this.normalizeUsername(name);
    const token = 'ak_' + randomBytes(32).toString('base64url');
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
  /** Exact slug, else `<slug>.html`, so /trip-plan finds trip-plan.html. */
  find(slug) {
    return this.one(`${SELECT} WHERE a.slug = ?`, slug) ?? this.one(`${SELECT} WHERE a.slug = ?`, `${slug}.html`);
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
  putVersion(userId, slug, doc, { title, note = '', visibility, base } = {}) {
    if (!SLUG_RE.test(slug) || RESERVED_SLUGS.has(slug.toLowerCase())) {
      throw new ApiError(400, `slug must be a file name matching ${SLUG_RE.source}, not reserved`);
    }
    if (visibility != null && !VISIBILITIES.includes(visibility)) {
      throw new ApiError(400, `visibility must be one of ${VISIBILITIES.join(', ')}`);
    }
    const text = Buffer.from(doc).toString('utf8');
    const { title: htmlTitle, body } = extractText(text);
    const description = metaContent(text, 'description');
    const category = metaContent(text, 'category').toLowerCase();
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
      this.updateLinks(id, text);
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
  list(viewerId, { q, state = ACTIVE, limit = 50, owner, category } = {}) {
    let where, args;
    if (state === TRASHED) [where, args] = ['a.state = ? AND a.owner_id = ?', [TRASHED, viewerId ?? -1]];
    else [where, args] = ["a.state = ? AND (a.visibility = 'public' OR a.owner_id = ?)", [ACTIVE, viewerId ?? -1]];
    if (owner) { where += ' AND u.name = ?'; args.push(owner.toLowerCase()); }
    if (category) { where += ' AND a.category = ?'; args.push(category); }
    const rows = q
      // Ranked: the whole query appearing in the title first, then bm25 with title
      // and file-name hits weighted above body hits (SEARCH_WEIGHTS).
      ? this.all(`SELECT a.*, u.name AS owner, ${VIEWS}, snippet(artifacts_fts, 2, char(1), char(2), '…', 12) AS snippet,`
        + ' highlight(artifacts_fts, 0, char(1), char(2)) AS title_hits'
        + ' FROM artifacts_fts JOIN artifacts a ON a.id = artifacts_fts.rowid JOIN users u ON u.id = a.owner_id'
        + ` WHERE artifacts_fts MATCH ? AND ${where}`
        + ' ORDER BY instr(lower(a.title), lower(?)) > 0 DESC, bm25(artifacts_fts, ?, ?, ?) LIMIT ?',
        ftsQuery(q, this.vocabulary()), ...args, q.trim(), SEARCH_WEIGHTS.title, SEARCH_WEIGHTS.name, SEARCH_WEIGHTS.body, limit)
      : this.all(`SELECT a.*, u.name AS owner, ${VIEWS}, NULL AS snippet FROM artifacts a`
        + ` JOIN users u ON u.id = a.owner_id WHERE ${where}`
        + " ORDER BY a.category = 'featured' DESC, a.updated_at DESC LIMIT ?", ...args, limit);
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
    const nodes = this.all('SELECT a.id, a.slug, a.title, a.category, a.owner_id,'
      + " (SELECT COUNT(*) FROM views v WHERE v.artifact_id = a.id) AS views FROM artifacts a"
      + " WHERE a.state = ? AND (a.visibility = 'public' OR a.owner_id = ?) ORDER BY a.id", ACTIVE, viewerId ?? -1);
    const ids = new Set(nodes.map((n) => n.id));
    const edges = this.all("SELECT DISTINCT l.from_id AS source, t.id AS target FROM links l"
      + " JOIN artifacts t ON t.slug = l.to_slug OR t.slug = l.to_slug || '.html'")
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
        views: n.views, links_in: deg('target')(n.id), links_out: deg('source')(n.id) })),
    };
  }

  /** Categories in use among pages this viewer can see, with counts. */
  categories(viewerId) {
    return this.all("SELECT category, COUNT(*) AS count FROM artifacts WHERE category != '' AND state = ?"
      + " AND (visibility = 'public' OR owner_id = ?) GROUP BY category ORDER BY category = 'featured' DESC, category", ACTIVE, viewerId ?? -1)
      .map((r) => ({ ...r }));
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
    return { body, slug: a.slug, n: n || a.latest_version, latest: a.latest_version };
  }

  /** Capability link: works for private artifacts too, never for trashed ones. */
  renderShare(shareId, n, visit) {
    const a = this.one('SELECT * FROM artifacts WHERE share_id = ?', shareId);
    if (!a || a.state !== ACTIVE) throw new ApiError(404, 'not found');
    const body = this.version(a, n);
    this.countView(a, n, visit, 'share');
    return { body, slug: a.slug, n: n || a.latest_version, latest: a.latest_version };
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
    const lines = of === 'text' ? extractLines : (d) => d.split(/\r?\n/);
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

