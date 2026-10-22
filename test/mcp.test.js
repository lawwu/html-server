// The MCP server, run as a real separate process the way Claude Desktop or Claude
// Code starts it, talking to a real server.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { makeServer } from '../src/server.js';
import { Store } from '../src/store.js';

const CLI = new URL('../src/cli.js', import.meta.url).pathname;
let dir, store, server, url, token, mcp, next = 1;
const waiting = new Map();

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'html-server-mcp-'));
  store = new Store(join(dir, 's.db'));
  token = store.createUser('agent');
  server = makeServer(store);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${server.address().port}`;
  mcp = spawn(process.execPath, [CLI, 'mcp'], {
    env: { ...process.env, HTML_SERVER_HOME: join(dir, 'home'), HTML_SERVER_URL: url, HTML_SERVER_TOKEN: token },
  });
  let buf = '';
  mcp.stdout.on('data', (d) => {
    buf += d;
    for (let i; (i = buf.indexOf('\n')) >= 0;) {
      const msg = JSON.parse(buf.slice(0, i));
      buf = buf.slice(i + 1);
      waiting.get(msg.id)?.(msg);
    }
  });
});
after(async () => {
  mcp.stdin.end();
  await new Promise((r) => mcp.on('exit', r)); // closes cleanly when the client hangs up
  await new Promise((r) => server.close(r));
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

function rpc(method, params) {
  const id = next++;
  return new Promise((resolve) => {
    waiting.set(id, resolve);
    mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}
const call = async (name, args) => (await rpc('tools/call', { name, arguments: args })).result;
const data = (r) => r.structuredContent ?? JSON.parse(r.content[0].text);

test('handshake and tool list', async () => {
  const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  assert.equal(init.result.protocolVersion, '2025-06-18');
  assert.equal(init.result.serverInfo.name, 'html-server');
  assert.ok(init.result.capabilities.tools);
  mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n'); // no reply expected
  const { tools } = (await rpc('tools/list')).result;
  for (const t of ['publish_page', 'search_pages', 'get_page', 'page_history', 'diff_versions', 'tag_pages', 'add_comment', 'feature_page']) {
    assert.ok(tools.some((x) => x.name === t), t);
  }
  assert.ok(tools.every((t) => t.inputSchema?.type === 'object'));
  assert.equal((await rpc('nope')).error.code, -32601);
  assert.deepEqual((await rpc('ping')).result, {});
});

test('publish (private by default), search, read, edit with base_version, history, diff', async () => {
  let r = data(await call('publish_page', { name: 'plan.html', html: '<title>Launch plan</title><p>ship it friday</p>', note: 'first' }));
  assert.equal(r.visibility, 'private');
  assert.match(r.share_url, /\/v\//);
  assert.equal((await fetch(`${url}/pages/plan.html`)).status, 404); // private: not public

  r = data(await call('publish_page', { name: 'notes.html', html: '<title>Notes</title><p>lunch</p>', public: true }));
  assert.equal(r.visibility, 'public');
  assert.match(r.url, /\/pages\/notes\.html$/);

  r = data(await call('search_pages', { query: 'lanch' })); // a typo: "launch" ranks first (title), "lunch" also matches
  assert.deepEqual(r.results.map((x) => x.name), ['plan.html', 'notes.html']);
  assert.equal(r.results[0].title_highlight, '[Launch] plan');

  const page = data(await call('get_page', { name: 'plan' }));
  assert.match(page.html, /ship it friday/);
  assert.equal(page.version, 1);
  r = data(await call('publish_page', { name: 'plan.html', html: '<title>Launch plan</title><p>ship it monday</p>', base_version: 1 }));
  assert.equal(r.visibility, 'private'); // an existing page keeps its visibility
  const stale = await call('publish_page', { name: 'plan.html', html: '<p>x</p>', base_version: 1 });
  assert.equal(stale.isError, true);
  assert.match(stale.content[0].text, /at v2 now, but you started from v1/);

  const h = data(await call('page_history', { name: 'plan.html' }));
  assert.deepEqual(h.versions.map((v) => [v.version, v.author, v.note]), [[1, 'agent', 'first'], [2, 'agent', '']]);
  const diff = (await call('diff_versions', { name: 'plan.html' })).content[0].text;
  assert.match(diff, /-ship it friday\n\+ship it monday/);
});

test('tags, comments, featuring, listing; errors come back as tool results', async () => {
  const t = data(await call('tag_pages', { pages: ['notes.html', 'missing.html'], add: ['meetings'] }));
  assert.deepEqual(t, [{ slug: 'notes.html', tags: ['meetings'] }, { slug: 'missing.html', error: 'no such artifact' }]);
  assert.deepEqual(data(await call('list_pages', { tag: 'meetings' })).map((p) => p.name), ['notes.html']);
  assert.equal(data(await call('add_comment', { name: 'notes.html', body: 'add the agenda' })).posted, true);
  assert.equal(data(await call('list_comments', { name: 'notes.html' }))[0].body, 'add the agenda');
  assert.equal(data(await call('feature_page', { name: 'notes.html', featured: true })).featured, true);
  assert.equal(data(await call('server_info', {})).signed_in_as, 'agent');
  const missing = await call('get_page', { name: 'nope' });
  assert.equal(missing.isError, true);
  assert.match(missing.content[0].text, /no such artifact/);
  assert.equal((await rpc('tools/call', { name: 'nope', arguments: {} })).error.code, -32602);
});

test('publish a Markdown note over MCP', async () => {
  const r = data(await call('publish_page', { name: 'Ideas.md', markdown: '---\ntitle: Ideas\ntags: [brainstorm]\n---\n- [[notes]]\n', public: true }));
  assert.match(r.url, /\/pages\/Ideas\.md$/);
  const page = await (await fetch(`${url}/pages/ideas`)).text();
  assert.match(page, /<h1 class="article-title">Ideas<\/h1>/);
  assert.match(page, /<a class="wikilink" href="\/pages\/notes.html">notes<\/a>/); // resolves to the HTML page
  assert.equal((await call('publish_page', { name: 'empty.md' })).isError, true);
});
