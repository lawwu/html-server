// `html-server import-sqlite PATH [--apply]`: move a SQLite database (artifacts.db, or a
// backup of one) into the PostgreSQL that DATABASE_URL names. A preview by default: it
// checks both sides and says what would be copied, importing no content. --apply copies
// everything in one transaction, rebuilds what's worked out from the pages, checks every
// table it copied against the source, and keeps nothing unless all of it holds.
//
// The source is never written: it is read through a private snapshot, which takes this
// release's schema upgrades in its place. The destination must be unused: an import never
// merges into pages, users or settings already there, so a finished import can't be run
// again over its own result. Initializing the schema (which a preview may do) is the only
// thing that can remain after a failed or refused run.
//
// Reports give counts, table names and page addresses: never a credential, a token hash or
// a page's content.
import { createHash } from 'node:crypto';
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RESERVED_SLUGS } from './config.js';
import { isPagePath } from './paths.js';
import { Store } from './store.js';

// --- assumptions, in one place ------------------------------------------------------
/** At most this many rows, and about this many bytes, per INSERT. Versions can be 16 MB each. */
export const BATCH_ROWS = 500;
export const BATCH_BYTES = 8 * 1024 * 1024;
/**
 * The tables an import copies, parents before children (foreign keys), each with the
 * columns that order its rows for the digest check (text ones marked: compared byte by
 * byte on both sides) and its binary columns. Everything else is worked out again from
 * these: links, link_targets, link_names, asset_refs and the search index.
 */
export const TABLES = [
  { name: 'users', key: ['id'] },
  { name: 'artifacts', key: ['id'] },
  { name: 'page_addresses', key: ['path:text'] },
  { name: 'moves', key: ['id'] },
  { name: 'versions', key: ['artifact_id', 'n'], binary: ['html'] },
  { name: 'views', key: ['artifact_id', 'at', 'n', 'visitor:text', 'via:text'] }, // no key of its own: every column
  { name: 'api_calls', key: ['id'] },
  { name: 'api_calls_daily', key: ['day:text', 'client:text', 'name:text', 'method:text', 'route:text'] },
  { name: 'comments', key: ['id'] }, // by id, so a reply comes after the comment it answers
  { name: 'tags', key: ['artifact_id', 'tag:text'] },
  { name: 'aliases', key: ['artifact_id', 'alias:text'] },
  { name: 'assets', key: ['id'], binary: ['data'] },
  // Which files each page's owner let it show, history included: who may see a private
  // file. Not worked out again from the pages, since an editor's mention isn't a grant.
  { name: 'asset_grants', key: ['artifact_id', 'name:text'] },
  { name: 'meta', key: ['key:text'], where: "key IN ('visitor_secret', 'usernames', 'editing')" },
];
/** Rebuilt from the pages, whatever markers the source has (the search index's table too). */
const DERIVED = ['links', 'link_targets', 'link_names', 'asset_refs', 'artifacts_fts'];
/** Settings someone chose: a destination with either already has a configuration of its own. */
const SETTINGS = ['usernames', 'editing'];
/** What visitors and API calls leave behind: the only rows an unused destination may hold. */
const TELEMETRY = ['views', 'api_calls', 'api_calls_daily'];
/** Tables with an identity id, whose sequence must move past the imported ids. */
const IDENTITY = ['users', 'artifacts', 'moves', 'api_calls', 'comments', 'assets'];

const keyCols = (t) => t.key.map((k) => k.split(':')[0]);
/** ORDER BY for a table's digest: text compared byte by byte, as SQLite's BINARY and PostgreSQL's "C" both do. */
const orderBy = (t, textCollation) => t.key.map((k) => { const [c, type] = k.split(':'); return type === 'text' ? `${c} COLLATE ${textCollation}` : c; }).join(', ');

// --- digests ------------------------------------------------------------------------
/**
 * A running SHA-256 of a table's rows: each value with its type (number, text, bytes,
 * null), so 1 and '1' differ, and binary values in full.
 */
class Digest {
  constructor() { this.hash = createHash('sha256'); this.rows = 0; }
  add(row, cols, binary) {
    this.rows++;
    for (const c of cols) {
      let v = row[c];
      if (binary.includes(c) && typeof v === 'string') v = Buffer.from(v, 'utf8');
      if (v === null || v === undefined) this.hash.update('z|');
      else if (typeof v === 'number' || typeof v === 'bigint') this.hash.update(`n${String(v)}|`);
      else if (typeof v === 'string') this.hash.update(`s${Buffer.byteLength(v)}:`).update(v).update('|');
      else { const b = Buffer.from(v); this.hash.update(`b${b.length}:`).update(b).update('|'); }
    }
    this.hash.update('\n');
  }
  get hex() { return this.hash.digest('hex'); }
}

// --- the source ---------------------------------------------------------------------
/**
 * Read the SQLite file at `path` through a checked, upgraded private snapshot. Returns
 * { db, columns(table), problems, counts, close() }; close() removes the snapshot.
 */
export function openSource(path, { DatabaseSync = process.getBuiltinModule('node:sqlite').DatabaseSync } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'html-server-import-')); // private: 0700
  const snapshot = join(dir, 'snapshot.db');
  let db = null;
  const close = () => {
    try { db?.close(); } catch { /* already closed */ }
    rmSync(dir, { recursive: true, force: true });
  };
  try {
    const original = new DatabaseSync(path, { readOnly: true });
    try {
      const check = original.prepare('PRAGMA integrity_check').get().integrity_check;
      if (check !== 'ok') throw new Error(`${path} fails SQLite's integrity check (${check}); restore a good backup first`);
      original.prepare('VACUUM INTO ?').run(snapshot); // SQLite's consistent snapshot, the live file untouched
    } finally {
      original.close();
    }
    chmodSync(snapshot, 0o600);
    // This release's schema upgrades, applied to the snapshot only.
    new Store(snapshot).close();
    db = new DatabaseSync(snapshot);
    const problems = [];
    for (const r of db.prepare('PRAGMA foreign_key_check').all()) {
      problems.push(`${r.table} row ${r.rowid} points at a missing ${r.parent} row`);
    }
    const addresses = [
      ...db.prepare('SELECT slug AS addr, id AS artifact_id FROM artifacts').all(),
      ...db.prepare('SELECT path AS addr, artifact_id FROM page_addresses').all(),
    ];
    for (const { addr } of addresses) {
      const top = addr.split('/')[0].toLowerCase();
      if (RESERVED_SLUGS.has(top)) problems.push(`'${addr}' takes the address of the server's /${top}; rename or move that page first`);
      else if (!isPagePath(addr)) problems.push(`'${addr}' isn't a page address this release accepts; rename or move that page first`);
    }
    const counts = {};
    for (const t of TABLES) {
      counts[t.name] = db.prepare(`SELECT COUNT(*) AS n FROM ${t.name}${t.where ? ` WHERE ${t.where}` : ''}`).get().n;
      const text = db.prepare(`PRAGMA table_info(${t.name})`).all().filter((c) => /TEXT/i.test(c.type)).map((c) => c.name);
      for (const c of text) {
        // PostgreSQL text can't hold NUL: say where, rather than change anyone's data.
        const n = db.prepare(`SELECT COUNT(*) AS n FROM ${t.name} WHERE instr(CAST(${c} AS BLOB), x'00') > 0`).get().n;
        if (n) problems.push(`${n} ${t.name} row(s) have a NUL character in ${c}, which PostgreSQL can't store`);
      }
    }
    const columns = (table) => db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
    return { db, columns, problems, counts, addresses, close };
  } catch (e) {
    close();
    throw e;
  }
}

// --- the destination ----------------------------------------------------------------
/** What's already in the destination: { content: {table: n}, settings: [...], telemetry: {table: n} }. */
export function destinationState(store) {
  const count = (t) => store.db.raw(`SELECT COUNT(*) AS n FROM ${t}`)[0].n;
  const content = {};
  for (const t of [...TABLES.map((x) => x.name).filter((n) => n !== 'meta' && !TELEMETRY.includes(n)), ...DERIVED]) {
    const n = count(t);
    if (n) content[t] = n;
  }
  const settings = store.db.raw(`SELECT key FROM meta WHERE key IN (${SETTINGS.map((k) => `'${k}'`).join(', ')})`).map((r) => r.key);
  const telemetry = {};
  for (const t of TELEMETRY) { const n = count(t); if (n) telemetry[t] = n; }
  return { content, settings, telemetry };
}

/** Why this destination can't take an import, given its state; [] if it can. */
function refusals({ content, settings, telemetry }, { replaceTelemetry }) {
  const out = [];
  const list = (o) => Object.entries(o).map(([t, n]) => `${t} ${n}`).join(', ');
  // In use: that's the whole answer (its settings and usage records are its own).
  if (Object.keys(content).length) return [`the PostgreSQL database already has content (${list(content)}); an import never merges into it`];
  if (settings.length) out.push(`the PostgreSQL database already has settings of its own (${settings.join(', ')}); an import never replaces them`);
  if (Object.keys(telemetry).length && !replaceTelemetry) {
    out.push(`the PostgreSQL database has usage records from before the move (${list(telemetry)}); `
      + 'add --replace-telemetry to drop them in favour of the imported ones');
  }
  return out;
}

/**
 * Addresses PostgreSQL would count as one name though SQLite keeps them apart (its NOCASE
 * folds ASCII only; PostgreSQL's collation folds every letter's case and composed and
 * decomposed accents): two pages, or two old addresses, under one name.
 */
function ambiguousAddresses(store, addresses) {
  const db = store.db;
  db.raw('CREATE TEMP TABLE IF NOT EXISTS import_addresses (addr TEXT COLLATE "C", artifact_id INTEGER, old BOOLEAN)');
  db.raw('TRUNCATE import_addresses');
  for (let i = 0; i < addresses.length; i += BATCH_ROWS) {
    const part = addresses.slice(i, i + BATCH_ROWS);
    db.raw(`INSERT INTO import_addresses VALUES ${part.map((_, j) => `($${3 * j + 1}, $${3 * j + 2}, $${3 * j + 3})`).join(', ')}`,
      part.flatMap((a) => [a.addr, a.artifact_id, a.old ? 'true' : 'false']));
  }
  const rows = db.raw('SELECT string_agg(addr, \' / \' ORDER BY addr) AS names FROM import_addresses'
    + ' GROUP BY addr COLLATE nocase HAVING COUNT(DISTINCT artifact_id) > 1 OR COUNT(*) FILTER (WHERE old) > 1');
  db.raw('DROP TABLE import_addresses');
  return rows.map((r) => `${r.names}: one name in PostgreSQL, so links and old addresses couldn't tell them apart; rename one first`);
}

// --- copying ------------------------------------------------------------------------
/** Copy one table from the snapshot, in bounded batches; returns the source's digest of what was sent. */
function copyTable(source, store, t) {
  const cols = source.columns(t.name);
  const binary = t.binary ?? [];
  const digest = new Digest();
  const rows = source.db.prepare(`SELECT ${cols.join(', ')} FROM ${t.name}${t.where ? ` WHERE ${t.where}` : ''}`
    + ` ORDER BY ${orderBy(t, 'BINARY')}`).iterate();
  let batch = [], bytes = 0;
  const flush = () => {
    if (!batch.length) return;
    const values = batch.map((_, i) => `(${cols.map((__, j) => `$${i * cols.length + j + 1}`).join(', ')})`).join(', ');
    const conflict = t.name === 'meta' ? ' ON CONFLICT (key) DO UPDATE SET value = excluded.value' : ''; // the destination's own visitor secret gives way
    store.db.raw(`INSERT INTO ${t.name} (${cols.join(', ')}) VALUES ${values}${conflict}`, batch.flatMap((r) => cols.map((c) => r[c])));
    batch = []; bytes = 0;
  };
  for (const row of rows) {
    for (const c of binary) if (typeof row[c] === 'string') row[c] = Buffer.from(row[c], 'utf8'); // loosely typed older rows
    digest.add(row, cols, binary);
    batch.push(row);
    bytes += binary.reduce((n, c) => n + (row[c]?.length ?? 0), 0) + 200;
    if (batch.length >= BATCH_ROWS || bytes >= BATCH_BYTES) flush();
  }
  flush();
  return { cols, binary, rows: digest.rows, sha256: digest.hex };
}

/** The destination's digest of a table, read the same way: same rows, same order, same encoding. */
function destinationDigest(store, t, cols, binary) {
  const digest = new Digest();
  const sql = `SELECT ${cols.join(', ')} FROM ${t.name}${t.where ? ` WHERE ${t.where}` : ''} ORDER BY ${orderBy(t, '"C"')}`;
  // Read in pages so the largest tables needn't fit in memory at once.
  for (let offset = 0; ; offset += BATCH_ROWS) {
    const rows = store.db.raw(`${sql} LIMIT ${BATCH_ROWS} OFFSET ${offset}`);
    for (const r of rows) digest.add(r, cols, binary);
    if (rows.length < BATCH_ROWS) break;
  }
  return { rows: digest.rows, sha256: digest.hex };
}

// --- the command --------------------------------------------------------------------
/**
 * Preview or run an import. `store`: a Store on the PostgreSQL destination (its schema
 * initialized by opening it). Returns { applied, problems, report } with report lines to
 * print; throws only for errors no report can explain.
 */
export function importSqlite(path, store, { apply = false, replaceTelemetry = false, DatabaseSync, verify } = {}) {
  const report = [];
  const source = openSource(path, { DatabaseSync });
  try {
    const state = destinationState(store);
    const problems = [...source.problems, ...refusals(state, { replaceTelemetry })];
    problems.push(...ambiguousAddresses(store, source.addresses.map((a, i) => ({ ...a, old: i >= source.counts.artifacts }))));
    report.push(`source: ${Object.entries(source.counts).map(([t, n]) => `${t} ${n}`).join(', ')}`);
    if (Object.keys(state.telemetry).length && replaceTelemetry) {
      report.push(`destination usage records to replace: ${Object.entries(state.telemetry).map(([t, n]) => `${t} ${n}`).join(', ')}`);
    }
    if (problems.length || !apply) return { applied: false, problems, report };

    const copied = store.tx(() => {
      // Nobody else writes while this runs, and the destination is still as checked.
      store.db.raw(`LOCK TABLE ${[...TABLES.map((t) => t.name), ...DERIVED].join(', ')} IN ACCESS EXCLUSIVE MODE`);
      const again = refusals(destinationState(store), { replaceTelemetry });
      if (again.length) throw new Error(`the destination changed while importing: ${again.join('; ')}`);
      if (replaceTelemetry) for (const t of TELEMETRY) store.db.raw(`DELETE FROM ${t}`);
      const out = TABLES.map((t) => ({ t, ...copyTable(source, store, t) }));
      for (const t of IDENTITY) {
        store.db.raw(`SELECT setval(pg_get_serial_sequence('${t}', 'id'), COALESCE((SELECT MAX(id) FROM ${t}), 0) + 1, false)`);
      }
      // Worked out again from the imported pages, whatever the source's markers said.
      store.ensureSearchIndex({ force: true });
      store.ensureLinks({ force: true });
      for (const c of out) {
        const got = (verify ?? destinationDigest)(store, c.t, c.cols, c.binary);
        if (got.rows !== c.rows || got.sha256 !== c.sha256) {
          throw new Error(`${c.t.name} didn't arrive as sent (${c.rows} rows sent, ${got.rows} found, or their contents differ); nothing was imported`);
        }
      }
      return out;
    });
    store.changed();
    for (const c of copied) report.push(`copied ${c.t.name}: ${c.rows} rows, sha256 ${c.sha256.slice(0, 12)}… checked`);
    report.push('rebuilt the search index, links and file references from the imported pages');
    return { applied: true, problems: [], report };
  } finally {
    source.close();
  }
}
