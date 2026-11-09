// The command line, served by the server itself (/api/cli): the tarball is the package npm
// would pack, installs as one, and the routes, the account page and `login` point at it.
//   node --test test/package.test.js
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { VERSION } from '../src/config.js';
import { cliPackage, packageFiles, tarball } from '../src/package.js';
import { makeServer } from '../src/server.js';
import { testDatabase } from './fixture.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CLI = join(ROOT, 'src', 'cli.js');
let dir, db, store, server, base;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'html-cli-pkg-'));
  db = await testDatabase(dir);
  store = db.open();
  server = makeServer(store);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  await new Promise((r) => server.close(r));
  await store.close();
  await db.drop();
  rmSync(dir, { recursive: true, force: true });
});

/** Unpack a tarball with the system's tar, as npm would read it: the folder it went to. */
function unpack(data, name) {
  const out = join(dir, name);
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'pkg.tgz'), data);
  execFileSync('tar', ['-xzf', 'pkg.tgz'], { cwd: out });
  return join(out, 'package');
}

test('the tarball holds what `npm pack` would, under package/, with the bin executable and no PostgreSQL driver', () => {
  const packed = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: ROOT, encoding: 'utf8' }));
  assert.deepEqual(packageFiles(), packed[0].files.map((f) => f.path).sort());

  const pkg = cliPackage();
  assert.equal(pkg.version, VERSION);
  const root = unpack(pkg.data, 'unpacked');
  for (const rel of ['src/server.js', 'public/style.css', 'LICENSE']) {
    assert.deepEqual(readFileSync(join(root, rel)), readFileSync(join(ROOT, rel)), rel); // byte for byte
  }
  assert.ok(statSync(join(root, 'src/cli.js')).mode & 0o100, 'the bin is executable');
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const original = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  assert.equal(manifest.version, VERSION);
  assert.deepEqual(manifest.bin, original.bin);
  assert.deepEqual(manifest.dependencies, original.dependencies);
  assert.equal(manifest.optionalDependencies, undefined); // pg-native: native, and only a PostgreSQL server needs it
  assert.equal(manifest.allowScripts, undefined);
});

test('the same files make the same bytes; a long path goes in the prefix field', () => {
  const entries = [['package/a.txt', Buffer.from('one'), 0o644], [`package/${'deep/'.repeat(30)}file.js`, Buffer.from('two'), 0o644]];
  assert.deepEqual(tarball(entries), tarball(entries));
  const root = unpack(tarball(entries), 'long');
  assert.equal(readFileSync(join(root, 'a.txt'), 'utf8'), 'one');
  assert.equal(readFileSync(join(root, `${'deep/'.repeat(29)}deep`, 'file.js'), 'utf8'), 'two');
  assert.throws(() => tarball([[`package/${'x'.repeat(120)}`, Buffer.from(''), 0o644]]), /too long/);
});

test('GET /api/cli says how to install; the tarball by its stable name redirects to this version', async () => {
  const info = await (await fetch(`${base}/api/cli`)).json();
  assert.deepEqual(info, { version: VERSION, tarball: `${base}/api/cli/html-server.tgz`, install: `npm install -g ${base}/api/cli/html-server.tgz` });

  const redirect = await fetch(`${base}/api/cli/html-server.tgz`, { redirect: 'manual' });
  assert.equal(redirect.status, 302);
  assert.equal(redirect.headers.get('location'), `/api/cli/html-server-${VERSION}.tgz`);
  assert.equal(redirect.headers.get('cache-control'), 'no-store');

  const r = await fetch(`${base}/api/cli/html-server.tgz`);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'application/gzip');
  assert.equal(r.headers.get('content-encoding'), null); // already gzip: never gzipped again
  assert.deepEqual(Buffer.from(await r.arrayBuffer()), cliPackage().data);
  const etag = r.headers.get('etag');
  assert.equal((await fetch(`${base}/api/cli/html-server-${VERSION}.tgz`, { headers: { 'If-None-Match': etag } })).status, 304);
  assert.equal((await fetch(`${base}/api/cli/html-server-${VERSION}.tgz`, { method: 'HEAD' })).status, 200);

  const old = await fetch(`${base}/api/cli/html-server-0.0.1.tgz`);
  assert.equal(old.status, 404);
  assert.match((await old.json()).error, new RegExp(`version ${VERSION.replaceAll('.', '\\.')} only`));
});

test('the docs page installs the command line from this server', async () => {
  const md = await (await fetch(`${base}/docs.md`)).text();
  assert.match(md, new RegExp(`npm install -g ${base}/api/cli/html-server\\.tgz`));
});

/** Run the CLI: { code, out, err }. */
function cli(args, env) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [CLI, ...args], { env: { ...process.env, ...env } });
    let out = '', err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('close', (code) => resolve({ code, out, err }));
  });
}

test('login says when the server runs another version, and how to match it; not when they match', async () => {
  const other = createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(req.url === '/api/me' ? { name: 'ann' } : { version: '99.0.0', install: 'npm install -g http://there/api/cli/html-server.tgz' }));
  });
  await new Promise((r) => other.listen(0, '127.0.0.1', r));
  try {
    const home = { HTML_SERVER_HOME: join(dir, 'login-home'), HTML_SERVER_URL: '' };
    let r = await cli(['login', '--url', `http://127.0.0.1:${other.address().port}`, '--token', 'ak_x'], home);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, new RegExp(`this command line is ${VERSION.replaceAll('.', '\\.')}, the server 99\\.0\\.0; to match it: npm install -g http://there/api/cli/html-server\\.tgz`));

    const tok = store.createUser('ann', false);
    r = await cli(['login', '--url', base, '--token', tok], home);
    assert.equal(r.code, 0, r.err);
    assert.doesNotMatch(r.out, /to match it/);
  } finally {
    await new Promise((r) => other.close(r));
  }
});
