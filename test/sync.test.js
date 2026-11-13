// Test reconciliation against a small remote model: no HTTP server or CLI process
// is needed to exercise partial failures, dry runs and pruning.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { FolderSync } from '../src/sync.js';
import { syncRemote } from '../src/sync-remote.js';

const hash = (body) => createHash('sha256').update(body).digest('hex');
function folder(t, files) {
  const root = mkdtempSync(join(tmpdir(), 'html-sync-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), body);
  }
  return root;
}
function remote(initial = [], fail = () => false) {
  const pages = new Map(initial.map((p) => [p.slug, { ...p, versions: [{ sha256: hash(p.body ?? '') }], state: 'active', can_edit: true }]));
  const calls = [];
  const change = (method, name) => {
    calls.push([method, name]);
    if (fail(method, name)) throw new Error(`rejected ${method}: ${name}`);
  };
  return {
    pages, calls,
    listSourcePages: async () => [...pages.values()].map((p) => ({ ...p })),
    listAssets: async () => [],
    findPage: async (name) => [...pages.values()].find((p) => p.slug.toLowerCase() === name.toLowerCase()) ?? null,
    async movePage(from, to) { change('move', from); const p = pages.get(from); pages.delete(from); pages.set(to, { ...p, slug: to }); },
    async putPage(name, body, metadata) {
      change('put', name);
      if (metadata.rename_from) pages.delete(metadata.rename_from);
      pages.set(name, { slug: name, body, metadata, versions: [{ sha256: hash(body) }] });
      return { url: `/pages/${name}` };
    },
    async putAsset(name) { change('asset', name); },
    async trashPage(name) { change('trash', name); pages.delete(name); },
  };
}

test('dry-run migration reads the existing address, reports changes and never prunes a moved page', async (t) => {
  const root = folder(t, { 'notes/A.md': '# A', 'new.md': '# New', 'pic.png': 'image' });
  const server = remote([{ slug: 'notes-A.md', source_path: 'notes/A.md', body: '# A' }, { slug: 'gone.md', source_path: 'gone.md' }]);
  const events = [];
  const result = await new FolderSync(root, { remote: server, onEvent: (e) => events.push(e) }).run({ dryRun: true, migratePaths: true, prune: true });
  assert.deepEqual(result.counts, { new: 2, updated: 0, renamed: 0, moved: 1, unchanged: 1, skipped: 0, failed: 0, trashed: 1 });
  assert.deepEqual(server.calls, []);
  assert.deepEqual(events.filter((e) => e.action === 'trashed').map((e) => e.path), ['gone.md']);
  assert.ok(events.every((e) => e.dryRun));
});

test('real migration preserves the successful move when upload fails, continues later files and suppresses pruning', async (t) => {
  const root = folder(t, { 'a/A.md': '# changed', 'z.md': '# later' });
  const server = remote([{ slug: 'a-A.md', source_path: 'a/A.md', body: '# old' }, { slug: 'gone.md', source_path: 'gone.md' }], (method, name) => method === 'put' && name === 'a/A.md');
  const events = [];
  const { counts } = await new FolderSync(root, { remote: server, onEvent: (e) => events.push(e) }).run({ migratePaths: true, prune: true });
  assert.deepEqual(server.calls, [['move', 'a-A.md'], ['put', 'a/A.md'], ['put', 'z.md']]);
  assert.equal(counts.moved, 1);
  assert.equal(counts.failed, 1);
  assert.equal(counts.new, 1);
  assert.ok(server.pages.has('a/A.md'));
  assert.ok(server.pages.has('gone.md'));
  assert.equal(events.find((e) => e.type === 'failure').path, 'a/A.md');
});

test('asset and notebook failures also suppress pruning while later pages still publish', async (t) => {
  for (const file of ['a.png', 'a.ipynb']) {
    const root = folder(t, { [file]: file.endsWith('.ipynb') ? '{"cells":{}}' : 'invalid', 'z.md': '# later' });
    const server = remote([{ slug: 'gone.md', source_path: 'gone.md' }], (method) => method === 'asset');
    const { counts } = await new FolderSync(root, { remote: server }).run({ prune: true });
    assert.equal(counts.failed, 1);
    assert.equal(counts.new, 1);
    assert.ok(server.pages.has('gone.md'));
    assert.ok(server.pages.has('z.md'));
  }
});

test('pruning continues after a trash failure and drafts are eligible for removal', async (t) => {
  const root = folder(t, { 'draft.md': '---\ndraft: true\n---\n# Draft' });
  const server = remote([{ slug: 'gone.md', source_path: 'gone.md' }, { slug: 'draft.md', source_path: 'draft.md' }], (method, name) => method === 'trash' && name === 'gone.md');
  const { counts } = await new FolderSync(root, { remote: server }).run({ prune: true });
  assert.deepEqual(server.calls, [['trash', 'gone.md'], ['trash', 'draft.md']]);
  assert.equal(counts.skipped, 1);
  assert.equal(counts.failed, 1);
  assert.equal(counts.trashed, 1);
});

test('remote moves stay put by default and private only applies to new pages', async (t) => {
  const root = folder(t, { 'A.md': '# changed', 'new.md': '# new' });
  const server = remote([{ slug: 'archive/A.md', source_path: 'A.md', body: '# old' }]);
  const { counts } = await new FolderSync(root, { remote: server }).run({ private: true, prune: true });
  assert.deepEqual(server.calls, [['put', 'archive/A.md'], ['put', 'new.md']]);
  assert.equal(counts.updated, 1);
  assert.equal(server.pages.get('archive/A.md').metadata.visibility, undefined);
  assert.equal(server.pages.get('new.md').metadata.visibility, 'private');
  assert.equal(server.pages.get('archive/A.md').metadata.source, root);
});

test('case-only renames publish a version even when the contents are identical', async (t) => {
  const root = folder(t, { 'note.md': '# Same' });
  const server = remote([{ slug: 'Note.md', source_path: 'Note.md', body: '# Same' }]);
  const { counts } = await new FolderSync(root, { remote: server }).run({ prune: true });
  assert.equal(counts.renamed, 1);
  assert.equal(counts.trashed, 0);
  assert.equal(server.pages.get('note.md').metadata.rename_from, 'Note.md');
});

test('asset collision preflight finishes before consulting the remote', async (t) => {
  const root = folder(t, { 'a/Chart one.png': 'a', 'b/chart-one.PNG': 'b' });
  const inaccessible = new Proxy({}, { get() { throw new Error('remote must not be consulted'); } });
  await assert.rejects(new FolderSync(root, { remote: inaccessible }).run({ prune: true }), /asset name collision/);
});

test('HTTP adapter gathers all pages and only translates the missing-page error', async () => {
  const requests = [];
  const adapter = syncRemote(async (method, path) => {
    requests.push([method, path]);
    if (path.includes('offset=0')) return Array.from({ length: 500 }, (_, i) => ({ slug: `p${i}.md` }));
    if (path.includes('offset=500')) return [{ slug: 'last.md' }];
    throw new Error(path.endsWith('absent.md') ? 'no such artifact' : 'bad token');
  });
  const pages = await adapter.listSourcePages('/my notes');
  assert.equal(pages.length, 501);
  assert.match(requests[0][1], /source=%2Fmy%20notes&limit=500&offset=0$/);
  assert.equal(await adapter.findPage('absent.md'), null);
  await assert.rejects(adapter.findPage('private.md'), /bad token/);
});
