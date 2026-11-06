import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import test from 'node:test';

test('a malformed request gets 400 without terminating the Node server', { timeout: 10000 }, async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'html-bad-request-'));
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    const {Store} = await import(${JSON.stringify(new URL('../src/store.js', import.meta.url).href)});
    const {makeServer} = await import(${JSON.stringify(new URL('../src/server.js', import.meta.url).href)});
    const server = makeServer(new Store(':memory:'));
    server.listen(0, '127.0.0.1', () => console.log(server.address().port));
  `], { env: { ...process.env, HTML_SERVER_HOME: home }, stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = new Promise((r) => child.once('exit', r));
  t.after(async () => { child.kill(); await exited; rmSync(home, { recursive: true, force: true }); });
  const port = await new Promise((resolve, reject) => {
    child.stdout.once('data', (d) => resolve(Number(d.toString().trim())));
    child.once('error', reject);
  });
  const response = await new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => socket.end('GET http://[ HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'));
    let text = '';
    socket.on('data', (d) => { text += d; }); socket.on('error', reject); socket.on('end', () => resolve(text));
  });
  assert.match(response, /^HTTP\/1\.1 400/);
  assert.equal((await fetch(`http://127.0.0.1:${port}/docs`)).status, 200);
  assert.equal(child.exitCode, null);
});
