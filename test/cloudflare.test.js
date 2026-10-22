// The Cloudflare adapter (cloudflare/sqlite.js) against a stand-in for a Durable
// Object's storage, built on node:sqlite with the same API shape: sql.exec(query,
// ...bindings) → cursor (toArray, one, rowsWritten), BLOBs back as ArrayBuffers,
// BEGIN refused, transactionSync for transactions. The real thing is exercised with
// `npx wrangler dev` (README, "Deploy to Cloudflare").
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { DurableSqlite } from '../cloudflare/sqlite.js';
import { Store } from '../src/store.js';

function fakeStorage() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  const toAB = (v) => (v instanceof Uint8Array ? v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength) : v);
  const sql = {
    exec(query, ...args) {
      if (/^\s*(BEGIN|COMMIT|ROLLBACK|SAVEPOINT)\b/i.test(query)) throw new Error('use transactionSync');
      if (!args.length && query.includes(';')) { db.exec(query); return { toArray: () => [], one: () => undefined, rowsWritten: 0 }; }
      const st = db.prepare(query);
      let rows = [], written = 0;
      if (st.columns().length) rows = st.all(...args).map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, toAB(v)])));
      else written = Number(st.run(...args).changes);
      return { toArray: () => rows, one: () => rows[0], rowsWritten: written };
    },
  };
  return {
    sql,
    transactionSync(fn) {
      db.exec('BEGIN');
      try { const out = fn(); db.exec('COMMIT'); return out; } catch (e) { db.exec('ROLLBACK'); throw e; }
    },
  };
}

test('the store runs on a Durable Object-shaped database', () => {
  const store = new Store(new DurableSqlite(fakeStorage()));
  const token = store.createUser('ann', true, { token: 'ak_given' });
  assert.equal(token, 'ak_given');
  const ann = store.userForToken('ak_given');
  assert.equal(ann.name, 'ann');

  store.putVersion(ann.id, 'trip.html', Buffer.from('<title>Trip</title><p>Uber XL every leg</p>'));
  store.putVersion(ann.id, 'trip.html', Buffer.from('<title>Trip</title><p>Uber XL every leg, booked</p>'));
  store.putVersion(ann.id, 'Notes.md', Buffer.from('# Notes\n\nSee [[trip]].'));
  const r = store.render('trip', null, ann.id, null);
  assert.ok(Buffer.isBuffer(r.body)); // BLOBs come back as Buffers, as from node:sqlite
  assert.match(r.body.toString(), /booked/);
  assert.equal(r.latest, 2);
  assert.deepEqual(store.list(ann.id, { q: 'uber' }).map((p) => p.slug), ['trip.html']); // FTS5
  assert.deepEqual(store.backlinks(store.find('trip.html'), ann.id).map((b) => b.slug), ['Notes.md']);

  // A failed multi-statement write leaves nothing behind (transactionSync rolls back).
  assert.throws(() => store.tx(() => { store.run("INSERT INTO meta VALUES ('x', '1')"); throw new Error('boom'); }), /boom/);
  assert.equal(store.one("SELECT value FROM meta WHERE key = 'x'"), undefined);

  store.apply(ann.id, 'trip.html', 'trash');
  store.apply(ann.id, 'trip.html', 'purge'); // versions cascade away
  assert.equal(store.one('SELECT COUNT(*) AS n FROM versions WHERE artifact_id NOT IN (SELECT id FROM artifacts)').n, 0);
});
