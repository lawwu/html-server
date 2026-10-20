// The CLI, run as a real separate process against a real server, the way a person
// (or an agent) uses it. HTML_SERVER_HOME points at a temp folder, so the user's
// own ~/.html-server is never touched.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
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

test('errors are one line with a non-zero exit', async () => {
  let r = (await cli(['put', '/nope.html']));
  assert.deepEqual([r.code, r.err.trim()], [1, 'error: usage: put FILE [NOTE] [--private] [--name NAME]']);
  r = (await cli(['whoami'], { HTML_SERVER_HOME: join(dir, 'empty-home') })); // no token anywhere
  assert.equal(r.code, 1);
  assert.match(r.err, /^error: not signed in: run `html-server login`/);
  r = (await cli(['ls'], { HTML_SERVER_URL: 'http://127.0.0.1:1' }));
  assert.match(r.err, /^error: can't reach http:\/\/127\.0\.0\.1:1/);
  r = (await cli(['rm', 'missing.html'], { HTML_SERVER_TOKEN: store.createUser('carol') }));
  assert.deepEqual([r.code, r.err.trim()], [1, 'error: no such artifact']);
  r = (await cli(['frobnicate']));
  assert.equal(r.code, 2);
  assert.match(r.out, /html-server — store, version/);
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
    for (let i = 0; i < 100 && !err.includes('html-server on'); i++) await new Promise((r) => setTimeout(r, 50));
    assert.match(err, new RegExp(`first run: created admin '${defaultAdminName()}' and signed this CLI in`));
    const saved = JSON.parse(readFileSync(join(h, 'credentials.json'), 'utf8'));
    assert.equal(saved.url, `http://127.0.0.1:${port}`);
    const r = await cli(['whoami'], { HTML_SERVER_HOME: h, HTML_SERVER_URL: '' });
    assert.equal(r.out.trim(), `${defaultAdminName()} (admin) on http://127.0.0.1:${port}`);
  } finally {
    child.kill();
  }
});
