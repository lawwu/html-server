// `html-server import-sqlite`: a SQLite database moved into PostgreSQL, checked and whole,
// or not at all. Needs a PostgreSQL to import into (TEST_DATABASE_URL; see fixture.js).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, before, beforeEach, test } from 'node:test';
import { destinationState, importSqlite } from '../src/import-sqlite.js';
import { Store } from '../src/store.js';
import { onPostgres, testDatabase } from './fixture.js';

const CLI = new URL('../src/cli.js', import.meta.url).pathname;
const live = onPostgres ? false : 'needs PostgreSQL (TEST_DATABASE_URL)';
const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');
const RAW = Buffer.from([0x3c, 0x70, 0x3e, 0xff, 0xfe, 0x00, 0x3c, 0x2f, 0x70, 0x3e]); // not UTF-8, with a NUL: bytes, kept as bytes
let dir, source, tokens, db, dest;

/** A SQLite database with one of everything an import must keep. */
function makeSource(file) {
  const s = new Store(file);
  const admin = s.createUser('admin', true), bob = s.createUser('bob');
  const [a, b] = [admin, bob].map((t) => s.userForToken(t).id);
  s.putVersion(a, 'plan.html', Buffer.from('<title>Trip plan</title><p>Lisbon in spring</p>'), { note: 'first' });
  s.putVersion(a, 'plan.html', Buffer.from('<title>Trip plan</title><p>Lisbon and Porto in spring</p>'), { note: 'second' });
  s.putVersion(b, 'notes/Café.md', Buffer.from('---\ntags: [food]\naliases: [Coffee notes]\n---\n# Café\n\nSee [[plan]] and ![[pic.png]].\n'));
  s.putVersion(b, 'secret.html', Buffer.from('<p>private</p>'), { visibility: 'private' });
  s.putVersion(a, 'raw.html', RAW, { title: 'Raw bytes' });
  s.putVersion(a, 'old-name.html', Buffer.from('<p>moved</p>'));
  s.movePages(a, [{ from: 'old-name.html', to: 'archive/new-name.html' }]);
  s.putAsset(b, 'pic.png', PNG);
  s.pin(s.userForToken(admin), 'plan.html', true);
  s.setEditing('open');
  const c = s.addComment(b, 'plan.html', 'Porto too?');
  s.addComment(a, 'plan.html', 'Yes', null, c.id);
  s.setTrackPeople('on');
  s.countView(s.find('plan.html'), 2, ['1.2.3.4', 'Mozilla/5.0'], 'url', b); // bob, signed in
  s.recordApiCall({ client: 'cli', name: 'put', method: 'PUT', route: '/api/artifacts/<slug>', status: 200, userId: a });
  s.rollUpApiCalls(Date.now() / 1000 + 10); // into the daily totals
  s.recordApiCall({ client: 'mcp', name: 'search', method: 'GET', route: '/api/search', status: 500, userId: b });
  s.close();
  return { admin, bob };
}

const fileSha = (f) => createHash('sha256').update(readFileSync(f)).digest('hex');
const rows = (s, sql) => s.all(sql).map((r) => ({ ...r }));

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'html-server-import-'));
  source = join(dir, 'artifacts.db');
  tokens = makeSource(source);
});
after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(async () => {
  if (!onPostgres) return;
  db = await testDatabase(dir, 'dest');
  dest = db.open();
});
afterEach(async () => { if (onPostgres) await db.drop(); });

test('a preview checks both sides and imports nothing', { skip: live }, () => {
  const before = fileSha(source);
  const r = importSqlite(source, dest);
  assert.deepEqual([r.applied, r.problems], [false, []]);
  assert.match(r.report[0], /^source: users 2, artifacts 5, page_addresses 1, moves 1, versions 6, views 1, api_calls 1, api_calls_daily 1, api_calls_user_daily 1, comments 2, tags 1, aliases 1, assets 1, asset_grants 1, meta 3$/);
  assert.deepEqual(destinationState(dest), { content: {}, settings: [], telemetry: {} });
  assert.equal(fileSha(source), before); // the source is only ever read
});

test('--apply keeps everything: users and tokens, ids, addresses, history, bytes, comments, tags, usage, settings', { skip: live }, () => {
  const before = fileSha(source);
  const r = importSqlite(source, dest, { apply: true });
  assert.deepEqual([r.applied, r.problems], [true, []]);
  assert.match(r.report.join('\n'), /copied versions: 6 rows, sha256 [0-9a-f]{12}… checked/);
  assert.equal(fileSha(source), before);

  const src = new Store(source);
  try {
    for (const sql of ['SELECT id, slug, title, owner_id, visibility, state, share_id, latest_version, pinned_at, name_key, created_at FROM artifacts ORDER BY id',
      'SELECT id, name, token_hash, is_admin FROM users ORDER BY id', 'SELECT path, artifact_id FROM page_addresses',
      'SELECT artifact_id, n, sha256, note, author_id FROM versions ORDER BY artifact_id, n', 'SELECT id, parent_id, body FROM comments ORDER BY id',
      "SELECT key, value FROM meta WHERE key IN ('visitor_secret', 'editing', 'track_people') ORDER BY key",
      'SELECT artifact_id, viewer_id FROM views', 'SELECT day, user_id, client, name, calls, errors FROM api_calls_user_daily',
      'SELECT artifact_id, name FROM asset_grants ORDER BY artifact_id, name']) {
      assert.deepEqual(rows(dest, sql), rows(src, sql), sql);
    }
    assert.ok(dest.version(dest.find('raw.html'), 1).equals(RAW)); // byte for byte
    assert.ok(Buffer.from(dest.asset('pic.png').data).equals(PNG));
    assert.ok(dest.canReadAsset(dest.asset('pic.png', { data: false }), null)); // its grant came too: a public note shows it
  } finally { src.close(); }

  const bob = dest.userForToken(tokens.bob);
  assert.equal(bob.name, 'bob'); // tokens still work
  assert.equal(dest.editing, 'open');
  assert.equal(dest.find('old-name.html').slug, 'archive/new-name.html'); // its old address still finds it
  assert.equal(dest.find('Coffee notes').slug, 'notes/Café.md'); // aliases
  assert.deepEqual(dest.backlinks(dest.find('plan.html'), null).map((p) => p.slug), ['notes/Café.md']); // links rebuilt
  assert.deepEqual(dest.list(null, { q: 'porto' }).map((p) => p.slug), ['plan.html']); // search rebuilt
  assert.equal(dest.list(bob.id, { q: 'private' }).length, 1); // still bob's private page
  assert.equal(dest.list(null, { q: 'private' }).length, 0);
  assert.equal(dest.stats(null).totals.views, 1);
  assert.equal(dest.usage({ days: null }).totals.calls, 2); // a detailed call and a day's total
  // New rows get new ids, after the imported ones.
  const fresh = dest.putVersion(bob.id, 'after.html', Buffer.from('<p>after</p>'));
  assert.ok(dest.find(fresh.slug).id > Math.max(...rows(dest, 'SELECT id FROM artifacts WHERE slug <> \'after.html\'').map((x) => x.id)));
  assert.doesNotThrow(() => dest.createUser('carol'));

  // A finished import can't be run again over its own result.
  const again = importSqlite(source, dest, { apply: true });
  assert.equal(again.applied, false);
  assert.match(again.problems.join('\n'), /already has content \(users 3, artifacts 6/);
});

test('never into a database already in use: content, settings, or (unless asked) usage records', { skip: live }, () => {
  dest.setEditing('owner');
  assert.match(importSqlite(source, dest, { apply: true }).problems.join('\n'), /already has settings of its own \(editing\)/);
  dest.run("DELETE FROM meta WHERE key = 'editing'");

  dest.recordApiCall({ client: 'browser', method: 'GET', route: '/api/search', status: 200 }); // someone tried the new server first
  const r = importSqlite(source, dest, { apply: true });
  assert.match(r.problems.join('\n'), /usage records from before the move \(api_calls 1\); add --replace-telemetry/);
  const ok = importSqlite(source, dest, { apply: true, replaceTelemetry: true });
  assert.equal(ok.applied, true);
  assert.match(ok.report.join('\n'), /usage records to replace: api_calls 1/);
  assert.equal(dest.one("SELECT COUNT(*) AS n FROM api_calls WHERE client = 'browser'").n, 0);

  const used = importSqlite(source, dest, { apply: true, replaceTelemetry: true });
  assert.match(used.problems.join('\n'), /already has content/);
});

test('addresses PostgreSQL can\'t take are refused before anything is copied: reserved, ambiguous, NUL', { skip: live }, () => {
  const bad = join(dir, 'bad.db');
  const s = new Store(bad);
  const u = s.userForToken(s.createUser('eve')).id;
  for (const name of ['a.html', 'b.html', 'c.html', 'd.html']) s.putVersion(u, name, Buffer.from(`<p>${name}</p>`));
  // As older releases or other case rules allowed: written straight into the file.
  s.run("UPDATE artifacts SET slug = 'healthz' WHERE slug = 'a.html'");
  s.run('UPDATE artifacts SET slug = ? WHERE slug = ?', 'Café.html', 'b.html'); // composed é
  s.run('UPDATE artifacts SET slug = ? WHERE slug = ?', 'CAFÉ.html', 'c.html'); // decomposed, upper case
  s.run("UPDATE artifacts SET title = 'nul' || char(0) || 'here' WHERE slug = 'd.html'");
  s.close();
  const r = importSqlite(bad, dest, { apply: true });
  assert.equal(r.applied, false);
  const text = r.problems.join('\n');
  assert.match(text, /'healthz' takes the address of the server's \/healthz/);
  assert.match(text, /CAFÉ\.html \/ Café\.html: one name in PostgreSQL/);
  assert.match(text, /1 artifacts row\(s\) have a NUL character in title/);
  assert.deepEqual(destinationState(dest).content, {});
});

test('any failure while copying or checking rolls the whole import back', { skip: live }, () => {
  let checked = 0;
  const lying = () => { checked++; return { rows: -1, sha256: 'x' }; };
  assert.throws(() => importSqlite(source, dest, { apply: true, verify: lying }), /users didn't arrive as sent .* nothing was imported/);
  assert.equal(checked, 1);
  assert.deepEqual(destinationState(dest), { content: {}, settings: [], telemetry: {} });
  assert.equal(dest.one('SELECT COUNT(*) AS n FROM artifacts_fts').n, 0); // the rebuilt index went too
  assert.equal(importSqlite(source, dest, { apply: true }).applied, true); // and it can be run again, cleanly
});

/** The CLI; resolves { code, out, err }. */
function cli(args, env) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [CLI, ...args], { env: { ...process.env, HTML_SERVER_HOME: join(dir, 'home'), DATABASE_URL: undefined, ...env } });
    let out = '', err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('close', (code) => resolve({ code, out, err }));
  });
}

test('the command: needs DATABASE_URL, previews by default, imports with --apply, refuses to run twice', { skip: live }, async () => {
  const env = db.env;
  let r = await cli(['import-sqlite', source], { DATABASE_URL: '' });
  assert.match(r.err, /DATABASE_URL is set but empty/);
  r = await cli(['import-sqlite', source, '--apply', '--preview'], env);
  assert.match(r.err, /--apply and --preview: pick one/);
  r = await cli(['import-sqlite', join(dir, 'nope.db')], env);
  assert.match(r.err, /no SQLite database at/);
  r = await cli(['import-sqlite', source], env);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^preview of importing .* into PostgreSQL /);
  assert.match(r.out, /preview only: nothing imported/);
  r = await cli(['import-sqlite', source, '--apply'], env);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /imported: start the server with this DATABASE_URL/);
  r = await cli(['import-sqlite', source, '--apply'], env);
  assert.equal(r.code, 1);
  assert.match(r.err, /already has content[\s\S]*error: nothing imported: 1 problem to fix first/);
  for (const out of [r.out, r.err]) assert.doesNotMatch(out, /search_path|ak_|token_hash/); // no credentials, no tokens
});
