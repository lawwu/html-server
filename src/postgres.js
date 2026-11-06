// PostgreSQL storage, optional: chosen when DATABASE_URL is set (see the README's
// "PostgreSQL" section). An adapter giving Store the same small synchronous interface
// node:sqlite does (exec, prepare → all/get/run, transaction, close), over pg-native's
// synchronous libpq calls, and translating the SQL Store writes for SQLite into
// PostgreSQL's. It is a compatibility layer for this application's queries, not a
// general SQLite-to-PostgreSQL translator: SQL it doesn't know throws, so a new query
// that needs a rule fails loudly in the PostgreSQL test run rather than quietly here.
//
// Only cli.js imports this file, and only when PostgreSQL is chosen; pg-native (a
// native addon over libpq) is loaded from here, so SQLite installs and the Cloudflare
// Worker never need it.
//
// Limits of this first backend: every query blocks Node's event loop while it runs, as
// node:sqlite's do but over a network; and Store keeps caches that assume it is the only
// writer, so run one server process per database. Nothing here makes several replicas safe.
import { Buffer } from 'node:buffer';
import { createRequire } from 'node:module';
import { ApiError, foldWord } from './text.js';

// --- assumptions, in one place ------------------------------------------------------
/** Seconds to wait for a connection, added to DATABASE_URL only when it sets none itself. */
export const CONNECT_TIMEOUT_SECONDS = 10;
/** Longest any one statement may run, and longest it may wait for a lock. */
export const STATEMENT_TIMEOUT = '30s';
export const LOCK_TIMEOUT = '10s';
/** Characters of each searchable field (title, name, body) that go into the search index. */
export const SEARCH_FIELD_CHARS = 32768;
/** Search weights per field, as ts_rank takes them ({D, C, B, A}): body 0.1, name 0.5, title 1 (bm25's 1 : 5 : 10). */
const RANK_WEIGHTS = "'{0, 0.1, 0.5, 1}'";
/** The search index's layout: when it changes, Store rebuilds it from every page's latest version. */
const SEARCH_INDEX_VERSION = 'pg1';
/** Tables whose `id` is an identity column: an INSERT into one reports the new id (lastInsertRowid). */
const IDENTITY_TABLES = new Set();

// --- configuration ------------------------------------------------------------------
/**
 * The PostgreSQL URI to use, from DATABASE_URL: null when it isn't set at all (SQLite).
 * Set but empty, or not a postgres:/postgresql: URI, is a mistake to report rather than
 * a reason to fall back to SQLite. Error messages never include the value: it may hold a password.
 */
export function databaseUrl(env = process.env) {
  if (!Object.hasOwn(env, 'DATABASE_URL') || env.DATABASE_URL === undefined) return null;
  const url = String(env.DATABASE_URL).trim();
  if (!url) throw new Error('DATABASE_URL is set but empty: unset it to use SQLite, or give a postgres:// URI');
  if (!/^postgres(?:ql)?:\/\//i.test(url)) throw new Error('DATABASE_URL must be a postgres:// or postgresql:// URI');
  return url;
}

/**
 * The URI as libpq gets it: exactly as given (its own query encoding kept, never parsed
 * and written out again), with a connect_timeout added only when it has none.
 */
export function connectionString(url) {
  if (/[?&]connect_timeout=/i.test(url)) return url;
  return `${url}${url.includes('?') ? '&' : '?'}connect_timeout=${CONNECT_TIMEOUT_SECONDS}`;
}

/** Where the data lives, for the startup line: host, port and database, never a user name, password or option. */
export function describeUrl(url) {
  try {
    const u = new URL(url);
    const host = u.hostname || u.searchParams.get('host') || 'localhost';
    const db = decodeURIComponent(u.pathname.replace(/^\//, '')) || u.searchParams.get('dbname') || '';
    return `PostgreSQL ${host}${u.port ? `:${u.port}` : ''}${db ? `/${db}` : ''}`;
  } catch {
    return 'PostgreSQL';
  }
}

/** pg-native, loaded only now; a clear message when it isn't installed or didn't build. */
export function loadDriver() {
  const require = createRequire(import.meta.url);
  try {
    return require('pg-native');
  } catch (e) {
    throw new Error('PostgreSQL needs the pg-native package, which builds against libpq: install libpq '
      + '(e.g. `brew install libpq` or `apt-get install libpq-dev`) and a C toolchain, then reinstall html-server '
      + `(or run \`npm install pg-native\` beside it). (${e.code || e.message})`);
  }
}

// --- SQL translation ----------------------------------------------------------------
/**
 * Split SQL into code and quoted parts: [{ code: true, text }, { code: false, text }, ...].
 * Quoted parts are '...' strings ('' inside) and "..." identifiers; `--` comments are dropped.
 */
function segments(sql) {
  const out = [];
  let code = '', i = 0;
  while (i < sql.length) {
    const c = sql[i];
    if (c === "'" || c === '"') {
      let j = i + 1;
      for (; j < sql.length; j++) {
        if (sql[j] === c) { if (sql[j + 1] === c) j++; else break; }
      }
      if (code) out.push({ code: true, text: code });
      code = '';
      out.push({ code: false, text: sql.slice(i, j + 1) });
      i = j + 1;
    } else if (c === '-' && sql[i + 1] === '-') {
      const end = sql.indexOf('\n', i);
      i = end === -1 ? sql.length : end;
    } else {
      code += c;
      i++;
    }
  }
  if (code) out.push({ code: true, text: code });
  return out;
}

/** Statements of a script, split on semicolons outside quotes; empty ones dropped. */
export function statements(sql) {
  const out = [];
  let cur = '';
  for (const s of segments(sql)) {
    if (!s.code) { cur += s.text; continue; }
    const parts = s.text.split(';');
    cur += parts[0];
    for (const p of parts.slice(1)) { out.push(cur); cur = p; }
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

// Function calls Store writes in SQLite's dialect, with quoted arguments: whole-statement patterns.
const QUOTED_FORMS = [
  // A Unix time as the server's local calendar day; the session's TimeZone is kept as Node's.
  [/\bdate\(\s*([\w.]+)\s*,\s*'unixepoch'\s*,\s*'localtime'\s*\)/gi, "to_char(to_timestamp($1), 'YYYY-MM-DD')"],
  [/\bgroup_concat\(\s*([\w.]+)\s*,\s*('[^']*')\s*\)/gi, 'string_agg($1, $2)'],
];
// Rewrites inside code (never inside quotes).
const CODE_FORMS = [
  [/\binstr\(/gi, 'strpos('],
  [/\bchar\((\d+)\)/gi, 'chr($1)'],
];
const DDL_FORMS = [
  [/\bINTEGER\s+PRIMARY\s+KEY\b/gi, 'INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY'],
  [/\bREAL\b/gi, 'DOUBLE PRECISION'], // never PostgreSQL's REAL: 4 bytes can't hold a Unix time to the second
  [/\bBLOB\b/gi, 'BYTEA'],
];
// SQLite-only SQL with no rule here: Store must go through the search strategy instead.
const UNSUPPORTED = /\b(MATCH|bm25|highlight|snippet|fts5|fts5vocab|sqlite_master|rowid|VIRTUAL\s+TABLE|ATTACH|VACUUM)\b/i;

/**
 * One statement of Store's SQL, in PostgreSQL's dialect: `?` → $1, $2…; INSERT OR IGNORE →
 * ON CONFLICT DO NOTHING; SQLite's date, group_concat, instr and char; its column types;
 * PRAGMA table_info. Text columns compare as SQLite's do, byte by byte (COLLATE "C"),
 * unless they say COLLATE NOCASE, which the database defines as a case-insensitive ICU
 * collation (see SETUP). An INSERT into a table with an identity id returns the new id.
 */
export function translate(sql) {
  let s = sql.trim().replace(/;\s*$/, '');
  if (/^PRAGMA\s+foreign_keys\b/i.test(s)) return '';
  const info = s.match(/^PRAGMA\s+table_info\((\w+)\)$/i);
  if (info) {
    return 'SELECT column_name AS name FROM information_schema.columns'
      + ` WHERE table_schema = current_schema() AND table_name = '${info[1].toLowerCase()}'`;
  }
  if (/^PRAGMA\b/i.test(s)) throw new Error(`unsupported in the PostgreSQL adapter: ${s.slice(0, 60)}`);
  for (const [re, to] of QUOTED_FORMS) s = s.replace(re, to);
  const ddl = /^(CREATE\s+TABLE|ALTER\s+TABLE)\b/i.test(s);
  if (ddl) {
    const table = s.match(/^CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)/i)?.[1];
    if (table && /\bid\s+INTEGER\s+PRIMARY\s+KEY\b/i.test(s)) IDENTITY_TABLES.add(table.toLowerCase());
  }
  let n = 0, ignore = false;
  const parts = segments(s).map((seg) => {
    if (!seg.code) return seg.text;
    let t = seg.text;
    if (UNSUPPORTED.test(t)) throw new Error(`unsupported in the PostgreSQL adapter: ${s.slice(0, 80)}`);
    if (/\bINSERT\s+OR\s+IGNORE\s+INTO\b/i.test(t)) { ignore = true; t = t.replace(/\bINSERT\s+OR\s+IGNORE\s+INTO\b/i, 'INSERT INTO'); }
    for (const [re, to] of CODE_FORMS) t = t.replace(re, to);
    if (ddl) {
      for (const [re, to] of DDL_FORMS) t = t.replace(re, to);
      // TEXT compares byte by byte, as in SQLite, wherever a column doesn't choose NOCASE.
      t = t.split('\n').map((line) => (/\bCOLLATE\b/i.test(line) ? line : line.replace(/\bTEXT\b/g, 'TEXT COLLATE "C"'))).join('\n');
    }
    return t.replace(/\?/g, () => `$${++n}`);
  });
  s = parts.join('');
  if (ignore) s += ' ON CONFLICT DO NOTHING';
  const into = s.match(/^INSERT\s+INTO\s+(\w+)/i)?.[1]?.toLowerCase();
  if (into && IDENTITY_TABLES.has(into) && !/\bRETURNING\b/i.test(s)) s += ' RETURNING id';
  return s;
}

// --- values -----------------------------------------------------------------------
/** A JavaScript value as a libpq text parameter. */
export function param(v) {
  if (v === undefined || v === null) return null;
  if (typeof v === 'boolean') return v ? 1 : 0; // as SQLite stores them
  if (typeof v === 'bigint') return v.toString();
  if (Buffer.isBuffer(v) || v instanceof Uint8Array) return `\\x${Buffer.from(v).toString('hex')}`; // bytea, byte for byte
  if (typeof v === 'string' && v.includes('\0')) {
    // libpq passes text as C strings: everything after a NUL would be dropped without a word.
    throw new ApiError(400, 'text with a NUL character (U+0000) can’t be stored in PostgreSQL');
  }
  return v;
}

/** pg-types parsers: 8-byte integers and numerics (COUNT, SUM) as numbers, refusing ones JavaScript can't hold exactly. */
function typeParsers(types) {
  const int8 = (v) => {
    const n = Number(v);
    if (!Number.isSafeInteger(n)) throw new Error(`integer ${v} is too large for JavaScript`);
    return n;
  };
  return {
    getTypeParser(oid, format) {
      if (oid === 20) return int8; // int8: COUNT(*), SUM of integers
      if (oid === 1700) return (v) => { const n = Number(v); if (Number.isInteger(n)) return int8(v); return n; }; // numeric: SUM of int8
      return types.getTypeParser(oid, format);
    },
  };
}

/** The session time zone that matches Node's local time now (TZ may change while running, as tests do). */
const nodeTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

// --- the database object Store uses -------------------------------------------------
// Run once per connection: the NOCASE collation names in Store's SQL resolve to; and the
// folding the search index and its queries share (lowercase, accents off, every run of
// characters that isn't a letter or digit a space).
const SETUP = [
  `CREATE COLLATION IF NOT EXISTS nocase (provider = icu, locale = 'und-u-ks-level2', deterministic = false)`,
  `CREATE FUNCTION html_server_fold(t text) RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $f$
     SELECT regexp_replace(regexp_replace(normalize(lower(t COLLATE "und-x-icu"), NFD),
       '[\\u0300-\\u036f\\u1ab0-\\u1aff\\u1dc0-\\u1dff\\u20d0-\\u20ff\\ufe20-\\ufe2f]', '', 'g'),
       '[^[:alnum:]]+', ' ', 'g')
   $f$`,
];

/** Native clients being closed, kept from the garbage collector until libuv is done with them (see close). */
const CLOSING = new Set();

export class PostgresDatabase {
  /**
   * Connect and get the database ready. `Client`: pg-native's class (tests may pass another).
   * Anything failing here closes the connection before the error goes on.
   */
  static open(url, { Client, types } = {}) {
    if (!Client) {
      Client = loadDriver();
      // pg-types comes with pg-native: load it from there, whatever the install's layout.
      const require = createRequire(createRequire(import.meta.url).resolve('pg-native'));
      types ??= require('pg-types');
    }
    const client = new Client({ types: typeParsers(types) });
    const db = new PostgresDatabase(client);
    try {
      client.connectSync(connectionString(url));
      // Notices ("already exists, skipping") are for people at a psql prompt, not a server's log.
      db.raw(`SET client_min_messages = warning; SET statement_timeout = '${STATEMENT_TIMEOUT}'; SET lock_timeout = '${LOCK_TIMEOUT}'`);
      db.raw(SETUP[0]);
      // Made once, never replaced: the search index is generated with it (a new fold needs a new name).
      if (!db.raw("SELECT to_regprocedure('html_server_fold(text)') IS NOT NULL AS x")[0].x) db.raw(SETUP[1]);
    } catch (e) {
      db.close().catch(() => {});
      throw cleanError(e, client);
    }
    return db;
  }

  constructor(client) {
    this.client = client;
    this.depth = 0; // open transactions: 0, or 1 + the savepoints inside
    this.tz = null;
    this.tzEnv = Symbol('unset');
    this.search = postgresSearch;
    this.backend = 'postgres';
  }

  /** Untranslated SQL, PostgreSQL's own: rows. */
  raw(sql, values) {
    if (!this.client) throw new Error('the PostgreSQL connection is closed');
    this.syncTimeZone();
    try {
      return values ? this.client.querySync(sql, values.map(param)) : this.client.querySync(sql);
    } catch (e) {
      throw cleanError(e, this.client);
    }
  }

  /** Keep the session's TimeZone the same as Node's, so local days agree with JavaScript's. */
  syncTimeZone() {
    if (this.tzEnv === process.env.TZ) return;
    this.tzEnv = process.env.TZ;
    const tz = nodeTimeZone();
    if (tz === this.tz) return;
    this.client.querySync(`SET TIME ZONE '${tz.replace(/'/g, "''")}'`);
    this.tz = tz;
  }

  exec(sql) {
    const script = statements(sql).map(translate).filter(Boolean);
    if (script.length) this.raw(script.join(';\n'));
  }

  prepare(sql) {
    const text = translate(sql);
    const query = (args) => (text ? this.raw(text, args) : []);
    return {
      all: (...args) => query(args),
      get: (...args) => query(args)[0],
      run: (...args) => {
        const rows = query(args);
        return { changes: Number(this.client.pq.cmdTuples() || 0), lastInsertRowid: rows[0]?.id };
      },
    };
  }

  /** fn() in a transaction; inside another one, in a savepoint, so it can fail alone. */
  transaction(fn) {
    const sp = this.depth ? `sp${this.depth}` : null;
    this.raw(sp ? `SAVEPOINT ${sp}` : 'BEGIN');
    this.depth++;
    try {
      const out = fn();
      this.depth--;
      this.raw(sp ? `RELEASE SAVEPOINT ${sp}` : 'COMMIT');
      return out;
    } catch (e) {
      this.depth--;
      if (this.client) this.raw(sp ? `ROLLBACK TO SAVEPOINT ${sp}` : 'ROLLBACK');
      throw e;
    }
  }

  /**
   * Close the connection; a promise, settled once the native handle is done with. libpq's
   * addon closes its socket watcher with libuv's asynchronous uv_close but lets go of the
   * object at once: if the garbage collector freed it before libuv's close phase ran, libuv
   * would write to freed memory and the process would crash. So a closing client is held
   * (CLOSING) until two turns of the event loop have passed, after that phase.
   */
  close() {
    const client = this.client;
    this.client = null;
    if (!client) return Promise.resolve();
    CLOSING.add(client);
    return new Promise((resolve) => {
      const released = () => setImmediate(() => setImmediate(() => { CLOSING.delete(client); resolve(); }));
      try { client.end(released); } catch { released(); }
    });
  }
}

/** libpq's message trimmed, with the error's SQLSTATE (e.g. 23505 for a duplicate) as `sqlState`. */
function cleanError(e, client) {
  if (e instanceof ApiError) return e;
  let state;
  try { state = client?.pq?.resultErrorFields?.()?.sqlState; } catch { /* no result */ }
  const err = new Error(String(e.message || e).replace(/^ERROR:\s*/, '').split('\n')[0].trim());
  if (state) err.sqlState = state;
  return err;
}

// --- search -------------------------------------------------------------------------
/**
 * A word as tsquery terms: folded as the index folds (lowercase, accents off), split where
 * the index splits it ("foo_bar" is foo followed by bar), `prefix` on its last part, and
 * `weight` (A: titles) on each. Null when nothing of it is a letter or digit.
 */
function term(word, { prefix = false, weight = '' } = {}) {
  const parts = foldWord(word).match(/[\p{L}\p{N}]+/gu);
  if (!parts) return null;
  return parts.map((p, i) => {
    const star = prefix && i === parts.length - 1 ? '*' : '';
    return `'${p}'${star || weight ? `:${star}${weight}` : ''}`;
  }).join(' <-> ');
}

/**
 * The words of a search (queryWords) as a tsquery: every word must match, as a prefix or
 * as one of its alternatives. `exact`: the words as typed only; `weight` 'A': in titles.
 * Null when no word has anything to look for.
 */
export function tsQuery(words, { exact = false, weight = '' } = {}) {
  const groups = [];
  for (const { word, also } of words) {
    const alts = [term(word, { prefix: true, weight }), ...(exact ? [] : also.map((w) => term(w, { weight })))].filter(Boolean);
    if (!alts.length) return null;
    groups.push(`(${alts.join(' | ')})`);
  }
  return groups.length ? groups.join(' & ') : null;
}

const WORD = /[\p{L}\p{N}\p{Co}]+/gu;
/** A title with the words a search matched between \u0001 and \u0002, as FTS5's highlight() marks them. */
export function highlightTitle(title, words) {
  const want = words.map(({ word, also }) => ({ word: foldWord(word), also: also.map(foldWord) }));
  return String(title).replace(WORD, (tok) => {
    const t = foldWord(tok);
    return want.some(({ word, also }) => t.startsWith(word) || also.includes(t)) ? `\u0001${tok}\u0002` : tok;
  });
}

/**
 * The search index in PostgreSQL: each page's title, name and body as indexed (the whole
 * text, kept for snippets and previews), and a weighted tsvector generated from the first
 * SEARCH_FIELD_CHARS characters of each, folded by html_server_fold, under a GIN index.
 * Store calls these as it calls the SQLite ones (see sqliteSearch in store.js).
 */
export const postgresSearch = {
  version: SEARCH_INDEX_VERSION,
  exists(s) { return !!s.db.raw("SELECT to_regclass('artifacts_fts') IS NOT NULL AS x")[0].x; },
  create(s) {
    const field = (col, w) => `setweight(to_tsvector('simple'::regconfig, html_server_fold(left(${col}, ${SEARCH_FIELD_CHARS}))), '${w}')`;
    s.db.raw('DROP TABLE IF EXISTS artifacts_fts');
    s.db.raw(`CREATE TABLE artifacts_fts (
      id INTEGER PRIMARY KEY REFERENCES artifacts(id) ON DELETE CASCADE,
      title TEXT NOT NULL, name TEXT NOT NULL, body TEXT NOT NULL,
      doc tsvector GENERATED ALWAYS AS (${field('title', 'A')} || ${field('name', 'B')} || ${field('body', 'C')}) STORED)`);
    s.db.raw('CREATE INDEX artifacts_fts_doc ON artifacts_fts USING gin (doc)');
  },
  put(s, id, { title, name, body }) {
    const clean = (t) => String(t ?? '').replace(/\0/g, ' '); // derived text: a NUL may become a space
    s.db.raw('INSERT INTO artifacts_fts (id, title, name, body) VALUES ($1, $2, $3, $4)'
      + ' ON CONFLICT (id) DO UPDATE SET title = excluded.title, name = excluded.name, body = excluded.body',
    [id, clean(title), clean(name), clean(body)]);
  },
  remove(s, id) { s.db.raw('DELETE FROM artifacts_fts WHERE id = $1', [id]); },
  bodies(s, ids) {
    if (!ids.length) return new Map();
    return new Map(s.db.raw(`SELECT id, body FROM artifacts_fts WHERE id IN (${ids.map(Number).join(',')})`).map((r) => [r.id, r.body]));
  },
  terms(s) { return s.db.raw("SELECT word AS term FROM ts_stat('SELECT doc FROM artifacts_fts')").map((r) => r.term); },
  /** Search rows (Store.list's columns `cols`, plus title_hits), filtered by `where`/`args` (Store's SQL, translated). */
  search(s, { cols, where, args, words, q, ranked, order, limit, offset }) {
    const all = tsQuery(words);
    if (!all) return [];
    const exact = tsQuery(words, { exact: true });
    const titled = tsQuery(words, { exact: true, weight: 'A' });
    const near = words.some((w) => w.also.length);
    const rows = s.all(`SELECT ${cols} FROM artifacts_fts f JOIN artifacts a ON a.id = f.id JOIN users u ON u.id = a.owner_id`
      + ` WHERE f.doc @@ ?::tsquery AND ${where} ORDER BY strpos(lower(a.title), lower(?)) > 0 DESC, (f.doc @@ ?::tsquery) DESC, `
      + (ranked ? `${near ? '(f.doc @@ ?::tsquery) DESC, ' : ''}ts_rank(${RANK_WEIGHTS}, f.doc, ?::tsquery) DESC, a.id` : order) + ' LIMIT ? OFFSET ?',
    all, ...args, q.trim(), titled, ...(ranked ? [...(near ? [exact] : []), all] : []), limit, offset);
    return rows.map((r) => ({ ...r, title_hits: highlightTitle(r.title, words) }));
  },
  count(s, { where, args, words }) {
    const all = tsQuery(words);
    if (!all) return 0;
    return s.one('SELECT COUNT(*) AS n FROM artifacts_fts f JOIN artifacts a ON a.id = f.id JOIN users u ON u.id = a.owner_id'
      + ` WHERE f.doc @@ ?::tsquery AND ${where}`, all, ...args).n;
  },
};
