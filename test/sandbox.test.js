// The sandbox rendered pages run in: the default policy (pages sandboxed, popups they
// open not), extra permissions per server instance, and `serve --sandbox-allow`.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { SANDBOX_TOKENS, renderCsp } from '../src/config.js';
import { makeServer } from '../src/server.js';
import { Store } from '../src/store.js';

const CLI = new URL('../src/cli.js', import.meta.url).pathname;
const EXAMPLE = '/gallery/kmeans-step-through.html'; // a rendered page that needs no upload
const DEFAULT = 'sandbox allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals';
let dir;
before(() => { dir = mkdtempSync(join(tmpdir(), 'html-server-sandbox-')); });
after(() => rmSync(dir, { recursive: true, force: true }));

async function csp(server, path = EXAMPLE) {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const r = await fetch(`http://127.0.0.1:${server.address().port}${path}`);
    assert.equal(r.status, 200);
    return r.headers.get('content-security-policy');
  } finally {
    await new Promise((r) => server.close(r));
  }
}

test('by default pages are sandboxed, but links they open in a new tab are not (Jira loads)', async () => {
  const store = new Store(join(dir, 'default.db'));
  const header = await csp(makeServer(store));
  assert.equal(header, DEFAULT);
  assert.doesNotMatch(header, /allow-same-origin/); // the page itself stays in an opaque origin
  store.close();
});

test('a server instance can add sandbox permissions; other instances keep the default', async () => {
  const store = new Store(join(dir, 'extra.db'));
  assert.equal(await csp(makeServer(store, { sandboxAllow: ['allow-downloads', 'allow-popups'] })), `${DEFAULT} allow-downloads`); // no duplicates
  assert.equal(await csp(makeServer(store)), DEFAULT); // scoped to the instance, not global
  store.close();
});

test('unknown sandbox permissions are refused, naming the valid ones', () => {
  assert.throws(() => renderCsp(['allow-everything']), /unknown sandbox permission: allow-everything\. Valid: allow-downloads, /);
  assert.throws(() => renderCsp(['downloads', 'allow-nope']), /unknown sandbox permissions: downloads, allow-nope/);
  assert.throws(() => makeServer(null, { sandboxAllow: ['allow-scripts ; script-src *'] }), /unknown sandbox permission/); // no header injection
  for (const t of SANDBOX_TOKENS) assert.match(renderCsp([t]), new RegExp(`(^| )${t}( |$)`));
});

// --- serve --sandbox-allow -------------------------------------------------------------
function run(args) {
  const p = spawn(process.execPath, [CLI, ...args], { env: { ...process.env, HTML_SERVER_HOME: join(dir, 'home') } });
  const out = { code: null, err: '' };
  p.stderr.on('data', (d) => { out.err += d; });
  const done = new Promise((r) => p.on('close', (code) => { out.code = code; r(out); }));
  return { p, out, done };
}
const freePort = () => new Promise((r) => {
  const s = createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => r(port)); });
});

test('serve --sandbox-allow adds permissions (repeatable) and warns about allow-same-origin', async () => {
  const port = await freePort();
  const { p, out } = run(['serve', '--port', String(port), '--db', join(dir, 'cli.db'),
    '--sandbox-allow', 'allow-downloads', '--sandbox-allow', 'allow-same-origin']);
  try {
    let header = null;
    for (let i = 0; i < 50 && !header; i++) {
      await new Promise((r) => setTimeout(r, 100));
      try { header = (await fetch(`http://127.0.0.1:${port}${EXAMPLE}`)).headers.get('content-security-policy'); } catch { /* starting */ }
    }
    assert.equal(header, `${DEFAULT} allow-downloads allow-same-origin`);
    assert.match(out.err, /warning: allow-same-origin with allow-scripts lets every page's scripts act as this site/);
  } finally {
    p.kill();
  }
});

test('serve refuses an unknown --sandbox-allow value before starting', async () => {
  const { out, done } = run(['serve', '--port', String(await freePort()), '--db', join(dir, 'bad.db'), '--sandbox-allow', 'allow-everything']);
  await done;
  assert.equal(out.code, 1);
  assert.match(out.err, /^error: unknown sandbox permission: allow-everything\. Valid: /);
});

test('serve --sandbox-allow with no value says what it takes, without a stack trace', async () => {
  for (const args of [['serve', '--sandbox-allow'], ['serve', '--sandbox-allow', '--port', '1']]) {
    const { out, done } = run(args);
    await done;
    assert.equal(out.code, 1);
    assert.match(out.err, /^error: --sandbox-allow needs a permission, e\.g\. --sandbox-allow allow-downloads\. Valid: allow-downloads, /);
    assert.match(out.err, /already work without it/);
    assert.doesNotMatch(out.err, /\n\s+at /); // no stack trace
  }
});
