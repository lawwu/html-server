// The database the tests run against: a SQLite file, as always, or with TEST_DATABASE_URL
// set (a postgres:// URI to a database the tests may create schemas in), PostgreSQL: each
// test database is a schema of its own, dropped after, so test files can run side by side.
//
//   TEST_DATABASE_URL=postgres:///hs_test?host=/tmp npm test
//
// REQUIRE_POSTGRES=1 turns a missing URL or driver into a failure rather than a quiet
// SQLite run (CI sets it: a green PostgreSQL job must have run against PostgreSQL).
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { Store } from '../src/store.js';

export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL || null;
export const backend = TEST_DATABASE_URL ? 'postgres' : 'sqlite';
export const onPostgres = backend === 'postgres';
/** For tests of SQLite itself (its files, FTS5, VACUUM, its upgrades): skipped, with the reason, on PostgreSQL. */
export const sqliteOnly = onPostgres ? 'SQLite only: this tests SQLite files or upgrades' : false;

if (process.env.REQUIRE_POSTGRES && !onPostgres) throw new Error('REQUIRE_POSTGRES is set, but TEST_DATABASE_URL is not');

let pg = null; // { PostgresDatabase, admin }: the driver, and a connection for making and dropping schemas
async function postgres() {
  if (!pg) {
    const { PostgresDatabase } = await import('../src/postgres.js');
    pg = { PostgresDatabase, admin: PostgresDatabase.open(TEST_DATABASE_URL) };
  }
  return pg;
}

/** A URI for one schema: the given URI, unchanged, with search_path set through libpq's options. */
export function schemaUrl(url, schema) {
  return `${url}${url.includes('?') ? '&' : '?'}options=${encodeURIComponent(`-csearch_path=${schema},public`)}`;
}

/**
 * A database for one test (or one file's tests), in `dir` for SQLite:
 * - open(): a Store on it (again, to reopen it, as a restart would)
 * - env: what a CLI or server child process needs to use the same database
 * - args: the matching command-line flags (--db FILE for SQLite, none for PostgreSQL)
 * - drop(): remove it (PostgreSQL: its schema)
 */
export async function testDatabase(dir, name = 't') {
  if (!onPostgres) {
    const file = join(dir, `${name}.db`);
    return { backend, file, open: () => new Store(file), env: {}, args: ['--db', file], drop: async () => {} };
  }
  const { PostgresDatabase, admin } = await postgres();
  const schema = `hs_test_${process.pid}_${randomBytes(4).toString('hex')}`;
  admin.raw(`CREATE SCHEMA ${schema}`);
  const url = schemaUrl(TEST_DATABASE_URL, schema);
  const stores = [];
  return {
    backend,
    url,
    schema,
    open: () => { const s = new Store(PostgresDatabase.open(url)); stores.push(s); return s; },
    env: { DATABASE_URL: url },
    args: [],
    async drop() {
      await Promise.all(stores.map((s) => s.close()));
      admin.raw(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    },
  };
}

/** A database and a Store on it, in one step. */
export async function testStore(dir, name) {
  const db = await testDatabase(dir, name);
  return { db, store: db.open() };
}
