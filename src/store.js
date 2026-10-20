// All data access, on Node's built-in SQLite. Node runs one request's handler at
// a time and node:sqlite is synchronous, so each method is atomic without locks;
// multi-statement writes still go through tx() so a failure leaves nothing half-done.
import { createHash, randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import {
  BOT_UA_RE, DEFAULT_USERNAMES, DEFAULT_VISIBILITY, MASK_EMAILS_FOR_ANONYMOUS, MAX_COMMENT_CHARS, RESERVED_SLUGS,
  SLUG_RE, USERNAME_RULES,
  VIEW_REPORT_DAYS, VISIBILITIES,
} from './config.js';
import { ACTIVE, NONE, PURGED, TRASHED, transition } from './lifecycle.js';
import { ApiError, extractLines, extractText, ftsQuery } from './text.js';

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
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE VIRTUAL TABLE IF NOT EXISTS artifacts_fts USING fts5(title, body);
CREATE VIRTUAL TABLE IF NOT EXISTS artifacts_vocab USING fts5vocab(artifacts_fts, 'row');
`;
// Columns added after the first release: [name, definition]. Applied if missing.
const ADDED_COLUMNS = [
  ['description', "TEXT NOT NULL DEFAULT ''"], // from <meta name="description">, for the gallery
  ['category', "TEXT NOT NULL DEFAULT ''"], //    from <meta name="category">
];

const now = () => Date.now() / 1000;
const sha256 = (s) => createHash('sha256').update(s).digest('hex');
export const hashToken = sha256;
const localDay = (t) => new Date(t * 1000).toLocaleDateString('en-CA'); // YYYY-MM-DD, server's timezone
const VIEWS = '(SELECT COUNT(*) FROM views v WHERE v.artifact_id = a.id) AS views';
const SELECT = `SELECT a.*, u.name AS owner, ${VIEWS} FROM artifacts a JOIN users u ON u.id = a.owner_id`;
const COMMENT_SELECT = 'SELECT c.id, c.n AS version, c.parent_id AS parent, u.name AS author, c.body,'
  + ' c.created_at, c.resolved_at FROM comments c JOIN users u ON u.id = c.author_id';

function metaContent(doc, name) {
  for (const tag of doc.match(/<meta\b[^>]*>/gi) || []) {
    if (new RegExp(`\\bname\\s*=\\s*["']?${name}["'\\s>/]`, 'i').test(tag)) {
      const m = tag.match(/\bcontent\s*=\s*(?:"([^"]*)"|'([^']*)')/i);
      if (m) return (m[1] ?? m[2]).trim();
    }
  }
  return '';
}

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
    const cols = new Set(this.db.prepare('PRAGMA table_info(artifacts)').all().map((c) => c.name));
    for (const [name, def] of ADDED_COLUMNS) {
      if (!cols.has(name)) this.db.exec(`ALTER TABLE artifacts ADD COLUMN ${name} ${def}`);
    }
    this.db.prepare("INSERT OR IGNORE INTO meta VALUES ('visitor_secret', ?)").run(randomBytes(16).toString('hex'));
    this.visitorSecret = this.db.prepare("SELECT value FROM meta WHERE key = 'visitor_secret'").get().value;
    this.vocab = null; // indexed words for fuzzy search; reset whenever the index changes
  }

  close() { this.db.close(); }

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
  putVersion(userId, slug, doc, { title, note = '', visibility } = {}) {
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
      if (a && a.owner_id !== userId) throw new ApiError(409, `'${slug}' is taken by ${a.owner}; pick another file name`);
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
      this.run('INSERT INTO versions (artifact_id, n, html, sha256, size, note, created_at) VALUES (?,?,?,?,?,?,?)',
        id, n, doc, sha256(doc), doc.length, note, t);
      this.run('DELETE FROM artifacts_fts WHERE rowid = ?', id);
      // The description is searchable too: it's what the gallery card shows.
      this.run('INSERT INTO artifacts_fts (rowid, title, body) VALUES (?,?,?)', id, title, `${description} ${body}`.trim());
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
    const a = this.owned(slug, userId);
    return this.putVersion(userId, a.slug, this.version(a, n), { note: `restored from v${n}` });
  }

  // --- reads -----------------------------------------------------------------------
  describe(slug, viewerId) {
    const a = this.readable(slug, viewerId);
    const versions = this.all('SELECT n, sha256, size, note, created_at FROM versions WHERE artifact_id = ? ORDER BY n', a.id);
    return { ...summary(a, viewerId), versions: versions.map((v) => ({ ...v })) };
  }

  /** Active: every public artifact plus the viewer's own. Trashed: the viewer's own only. */
  list(viewerId, { q, state = ACTIVE, limit = 50, owner, category } = {}) {
    let where, args;
    if (state === TRASHED) [where, args] = ['a.state = ? AND a.owner_id = ?', [TRASHED, viewerId ?? -1]];
    else [where, args] = ["a.state = ? AND (a.visibility = 'public' OR a.owner_id = ?)", [ACTIVE, viewerId ?? -1]];
    if (owner) { where += ' AND u.name = ?'; args.push(owner.toLowerCase()); }
    if (category) { where += ' AND a.category = ?'; args.push(category); }
    const rows = q
      ? this.all(`SELECT a.*, u.name AS owner, ${VIEWS}, snippet(artifacts_fts, 1, '[', ']', '…', 12) AS snippet`
        + ' FROM artifacts_fts JOIN artifacts a ON a.id = artifacts_fts.rowid JOIN users u ON u.id = a.owner_id'
        + ` WHERE artifacts_fts MATCH ? AND ${where} ORDER BY rank LIMIT ?`, ftsQuery(q, this.vocabulary()), ...args, limit)
      : this.all(`SELECT a.*, u.name AS owner, ${VIEWS}, NULL AS snippet FROM artifacts a`
        + ` JOIN users u ON u.id = a.owner_id WHERE ${where}`
        + " ORDER BY a.category = 'featured' DESC, a.updated_at DESC LIMIT ?", ...args, limit);
    return rows.map((r) => (r.snippet ? { ...summary(r, viewerId), snippet: r.snippet } : summary(r, viewerId)));
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
  render(slug, n, viewerId, visit) {
    const a = this.readable(slug, viewerId);
    if (a.state !== ACTIVE) throw new ApiError(404, 'no such artifact');
    const body = this.version(a, n);
    this.countView(a, n, visit, 'url');
    return body;
  }

  /** Capability link: works for private artifacts too, never for trashed ones. */
  renderShare(shareId, n, visit) {
    const a = this.one('SELECT * FROM artifacts WHERE share_id = ?', shareId);
    if (!a || a.state !== ACTIVE) throw new ApiError(404, 'not found');
    const body = this.version(a, n);
    this.countView(a, n, visit, 'share');
    return body;
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

