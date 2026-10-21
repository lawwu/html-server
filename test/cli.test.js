// The CLI, run as a real separate process against a real server, the way a person
// (or an agent) uses it. HTML_SERVER_HOME points at a temp folder, so the user's
// own ~/.html-server is never touched.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { createServer } from 'node:net';
import { defaultAdminName } from '../src/cli.js';
import { makeServer } from '../src/server.js';
import { Store } from '../src/store.js';

const CLI = new URL('../src/cli.js', import.meta.url).pathname;
let dir, home, db, server, url, store;

/**
 * Run the CLI; resolves { code, out, err }. Asynchronous on purpose: the server
 * under test runs in this process, so a blocking spawnSync would deadlock it.
 */
function cli(args, env = {}) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [CLI, ...args], {
      env: { ...process.env, HTML_SERVER_HOME: home, HTML_SERVER_URL: url, HTML_SERVER_TOKEN: '', ...env },
    });
    let out = '', err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('close', (code) => resolve({ code, out, err }));
  });
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'html-server-cli-'));
  home = join(dir, 'home');
  db = join(home, 'artifacts.db');
  server = makeServer(store = new Store(join(dir, 'server.db')));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  await new Promise((r) => server.close(r));
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test('server commands default to the home folder and keep the token private', async () => {
  const r = (await cli(['config'])); // no --db: opens HTML_SERVER_HOME/artifacts.db
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /usernames: name/);
  assert.ok(existsSync(db));
  assert.equal(statSync(home).mode & 0o777, 0o700);

  const made = (await cli(['create-user', 'alice', '--admin', '--save']));
  assert.equal(made.code, 0, made.err);
  const saved = JSON.parse(readFileSync(join(home, 'credentials.json'), 'utf8'));
  assert.deepEqual(saved, { url: 'http://127.0.0.1:8765', token: made.out.trim() });
  assert.equal(statSync(join(home, 'credentials.json')).mode & 0o777, 0o600);
});

test('client commands: put, ls, find, diff, restore, views, rm, whoami', async () => {
  const token = store.createUser('bob'); // a user on the running server
  const env = { HTML_SERVER_TOKEN: token };
  const page = join(dir, 'notes.html');
  writeFileSync(page, '<title>Notes</title><p>first draft</p>');

  let r = (await cli(['put', page, 'café ✓ first', '--private'], env)); // non-ASCII note
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /published v1: .*\/notes\.html/);
  assert.match(r.out, /share link: +http.*\/v\//);
  writeFileSync(page, '<title>Notes</title><p>second draft</p>');
  assert.match((await cli(['put', page, 'second'], env)).out, /published v2/);
  assert.equal(store.describe('notes.html', store.userForToken(token).id).versions[0].note, 'café ✓ first');

  assert.match((await cli(['ls'], env)).out, /notes\.html +v2 .*\[private\]/);
  assert.doesNotMatch((await cli(['ls'])).out, /notes\.html/); // private: not listed anonymously
  assert.match((await cli(['find', 'secnd'], env)).out, /notes\.html/); // typo-tolerant
  assert.match((await cli(['diff', 'notes.html'], env)).out, /-first draft\n\+second draft/);
  assert.match((await cli(['restore', 'notes.html', '1'], env)).out, /v3 is now a copy of v1/);
  assert.match((await cli(['views', 'notes.html'], env)).out, /"views": 0/);
  assert.match((await cli(['whoami'], env)).out, /^bob on http/);
  assert.match((await cli(['put', page, 'x', '--name', 'other.html'], env)).out, /\/other\.html/);
  assert.match((await cli(['rm', 'notes.html'], env)).out, /notes\.html → trashed/);
  assert.match((await cli(['rm', 'notes.html', '--purge'], env)).out, /notes\.html → purged/);
});

test('--version prints the package.json version', async () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  for (const flag of ['--version', '-v', 'version']) {
    assert.equal((await cli([flag])).out.trim(), pkg.version, flag);
  }
  assert.match((await cli(['help'])).out, new RegExp(`^html-server ${pkg.version.replace(/\./g, '\\.')} — `));
});

test('errors are one line with a non-zero exit', async () => {
  let r = (await cli(['put', '/nope.html']));
  assert.deepEqual([r.code, r.err.trim()], [1, 'error: usage: put FILE [NOTE] [--private] [--name NAME] [--base N]']);
  r = (await cli(['whoami'], { HTML_SERVER_HOME: join(dir, 'empty-home') })); // no token anywhere
  assert.equal(r.code, 1);
  assert.match(r.err, /^error: not signed in: run `html-server login`/);
  r = (await cli(['ls'], { HTML_SERVER_URL: 'http://127.0.0.1:1' }));
  assert.match(r.err, /^error: can't reach http:\/\/127\.0\.0\.1:1/);
  r = (await cli(['rm', 'missing.html'], { HTML_SERVER_TOKEN: store.createUser('carol') }));
  assert.deepEqual([r.code, r.err.trim()], [1, 'error: no such artifact']);
  r = (await cli(['frobnicate']));
  assert.equal(r.code, 2);
  assert.match(r.out, /^html-server \S+ — store, version/);
  assert.match((await cli(['--bogus'])).err, /^error: Unknown option/);
});

test('login checks the token before saving it; logout forgets it', async () => {
  const h = { HTML_SERVER_HOME: join(dir, 'login-home'), HTML_SERVER_URL: '' };
  const file = join(dir, 'login-home', 'credentials.json');
  let r = await cli(['login', '--url', url, '--token', 'ak_wrong'], h);
  assert.equal(r.code, 1);
  assert.match(r.err, /isn't valid.*nothing saved/);
  assert.ok(!existsSync(file));

  const tok = store.createUser('dora');
  r = await cli(['login', '--url', `${url}/`, '--token', tok], h); // trailing slash tolerated
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /signed in as dora on http/);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { url, token: tok });
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.match((await cli(['whoami'], h)).out, /^dora on /); // no env vars: uses the saved login

  assert.match((await cli(['logout'], h)).out, /signed out/);
  assert.ok(!existsSync(file));
  assert.match((await cli(['whoami'], h)).err, /not signed in/);
  assert.match((await cli(['login', '--url', url], { ...h })).err, /no token given/); // not a terminal: no prompt
});

test('first serve on an empty database makes an admin and signs the CLI in', async () => {
  const h = join(dir, 'fresh-home');
  const port = await new Promise((resolve) => {
    const probe = createServer().listen(0, '127.0.0.1', () => { const p = probe.address().port; probe.close(() => resolve(p)); });
  });
  const child = spawn(process.execPath, [CLI, 'serve', '--port', String(port)], {
    env: { ...process.env, HTML_SERVER_HOME: h, HTML_SERVER_URL: '', HTML_SERVER_TOKEN: '' },
  });
  let err = '';
  child.stderr.on('data', (d) => { err += d; });
  try {
    for (let i = 0; i < 100 && !/html-server \S+ on http/.test(err); i++) await new Promise((r) => setTimeout(r, 50));
    assert.match(err, new RegExp(`first run: created admin '${defaultAdminName()}' and signed this CLI in`));
    const saved = JSON.parse(readFileSync(join(h, 'credentials.json'), 'utf8'));
    assert.equal(saved.url, `http://127.0.0.1:${port}`);
    const r = await cli(['whoami'], { HTML_SERVER_HOME: h, HTML_SERVER_URL: '' });
    assert.equal(r.out.trim(), `${defaultAdminName()} (admin) on http://127.0.0.1:${port}`);
  } finally {
    child.kill();
  }
});

test('import: a folder of existing pages is served at /pages/{slug}; re-running is safe', async () => {
  const env = { HTML_SERVER_TOKEN: store.createUser('importer') };
  const src = join(dir, 'old-pages');
  mkdirSync(src);
  writeFileSync(join(src, 'showstopper-timeline.html'), '<title>Showstopper</title><p>from the old service</p>');
  writeFileSync(join(src, 'launch-notes.html'), '<p>launch</p>');
  writeFileSync(join(src, 'README.txt'), 'not a page'); // ignored

  let r = await cli(['import', src], env);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /imported +http.*\/pages\/showstopper-timeline\.html/);
  assert.match(r.out, /2 imported$/m);
  const page = await fetch(`${url}/pages/showstopper-timeline`, { headers: { 'User-Agent': 'Mozilla/5.0 test' } });
  assert.equal(page.status, 200);
  assert.match(await page.text(), /from the old service/);

  r = await cli(['import', src], env); // nothing changed
  assert.match(r.out, /^2 unchanged$/m);
  writeFileSync(join(src, 'launch-notes.html'), '<p>launch, revised</p>');
  r = await cli(['import', src], env);
  assert.match(r.out, /updated +http.*launch-notes\.html/);
  assert.match(r.out, /1 updated, 1 unchanged/);
  assert.equal(store.describe('launch-notes.html', null).latest_version, 2);

  assert.match((await cli(['import', join(dir, 'missing')], env)).err, /usage: import DIR/);
});

test('config editing, history, and put --base', async () => {
  const h = { HTML_SERVER_HOME: join(dir, 'cfg-home') };
  assert.match((await cli(['config', 'editing', 'open'], h)).out, /editing: +open/);
  assert.match((await cli(['config'], h)).out, /editing: +open/);
  assert.match((await cli(['config', 'editing', 'wiki'], h)).err, /editing must be one of owner, open/);

  const env = { HTML_SERVER_TOKEN: store.createUser('eve') };
  const page = join(dir, 'hist.html');
  writeFileSync(page, '<p>one</p>');
  await cli(['put', page, 'first'], env);
  writeFileSync(page, '<p>two</p>');
  await cli(['put', page, 'second'], env);
  const r = await cli(['history', 'hist.html'], env);
  assert.match(r.out, /v2 .* eve +second \(current\)/);
  assert.match(r.out, /v1 .* eve +first/);
  assert.match((await cli(['put', page, 'stale', '--base', '1'], env)).err, /at v2 now, but you started from v1/);
  assert.match((await cli(['put', page, 'fresh', '--base', '2'], env)).out, /published v3/);
});

test('backup: a checked, private snapshot, safe while the server is serving', async () => {
  const h = { HTML_SERVER_HOME: join(dir, 'backup-home') };
  const live = join(dir, 'backup-home', 'artifacts.db');
  await cli(['create-user', 'zed'], h); // creates the database
  // Keep a connection open and write through it, like a running server would.
  const running = new Store(live);
  running.putVersion(running.userForToken(running.resetToken('zed')).id, 'a.html', Buffer.from('<p>a</p>'));

  let r = await cli(['backup'], h);
  assert.equal(r.code, 0, r.err);
  const [, file] = r.out.match(/→ (\S+) \(/);
  assert.match(r.out, /^backed up 1 pages, 1 versions → .*\/backups\/artifacts-\d{4}-\d{2}-\d{2}T\d{6}\.db/);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  const copy = new Store(file);
  assert.match(copy.versionHtml('a.html', 1, null).toString(), /<p>a<\/p>/); // real, readable data
  copy.close();

  const explicit = join(dir, 'elsewhere', 'snap.db');
  assert.match((await cli(['backup', explicit], h)).out, /→ .*elsewhere\/snap\.db/);
  r = await cli(['backup', explicit], h);
  assert.deepEqual([r.code, r.err.trim()], [1, `error: ${explicit} already exists; not overwriting it`]);

  // --keep prunes only our own timestamped files, oldest first.
  const bdir = join(dir, 'backup-home', 'backups');
  writeFileSync(join(bdir, 'artifacts-2020-01-01T000000.db'), 'old');
  writeFileSync(join(bdir, 'artifacts-before-upgrade.db'), 'mine'); // not ours: never touched
  utimesSync(join(bdir, 'artifacts-2020-01-01T000000.db'), new Date(2020, 0, 1), new Date(2020, 0, 1));
  r = await cli(['backup', '--keep', '2'], h);
  assert.match(r.out, /removed old backup artifacts-2020-01-01T000000\.db/);
  assert.equal(readdirSync(bdir).filter((f) => /T\d{6}/.test(f)).length, 2);
  assert.ok(existsSync(join(bdir, 'artifacts-before-upgrade.db')));
  assert.match((await cli(['backup', '--keep', '0'], h)).err, /--keep must be/);
  running.close();
  assert.match((await cli(['backup', '--db', join(dir, 'nope.db')], h)).err, /no database at/);
});

test('pin, unpin, tag add/rm and tags from the CLI', async () => {
  const env = { HTML_SERVER_TOKEN: store.createUser('tagger') };
  const page = join(dir, 'tagme.html');
  writeFileSync(page, '<title>Tag me</title>');
  await cli(['put', page], env);
  await cli(['put', page, 'x', '--name', 'tagme2.html'], env);
  assert.match((await cli(['pin', 'tagme.html'], env)).out, /tagme\.html is featured/);
  assert.match((await cli(['unpin', 'tagme.html'], env)).out, /no longer featured/);
  let r = await cli(['tag', 'add', 'Road Trips', 'tagme.html', 'tagme2', 'missing.html'], env);
  assert.match(r.out, /tagme\.html +road-trips/);
  assert.match(r.out, /tagme2\.html +road-trips/);
  assert.match(r.err, /failed  missing\.html: no such artifact/);
  assert.equal(r.code, 1);
  assert.match((await cli(['tags'], env)).out, /road-trips +2/);
  r = await cli(['tag', 'rm', 'road-trips', 'tagme.html'], env);
  assert.match(r.out, /tagme\.html +\(no tags\)/);
  assert.match((await cli(['tag', 'add', 'x'], env)).err, /usage: tag add\|rm TAG NAME/);
});
