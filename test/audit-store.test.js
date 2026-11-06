import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { Store } from '../src/store.js';

test('an interrupted column migration rolls back and completes its backfill on restart', () => {
  const dir = mkdtempSync(join(tmpdir(), 'html-migration-'));
  const file = join(dir, 'old.db');
  try {
    let store = new Store(file);
    const owner = store.userForToken(store.createUser('owner')).id;
    store.putVersion(owner, 'old.html', Buffer.from('<p>Old</p>'));
    store.close();
    const db = new DatabaseSync(file);
    db.exec('ALTER TABLE versions DROP COLUMN author_id');
    const wrapped = { prepare: (sql) => db.prepare(sql), exec(sql) {
      if (sql.startsWith('UPDATE versions SET author_id')) throw new Error('interrupted backfill');
      db.exec(sql);
    } };
    assert.throws(() => new Store(wrapped), /interrupted backfill/);
    assert.ok(!db.prepare('PRAGMA table_info(versions)').all().some((c) => c.name === 'author_id'));
    db.close();
    store = new Store(file);
    assert.equal(store.describe('old.html', owner).versions[0].author, 'owner');
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('asset grant migration ignores edits authored by other users', () => {
  const store = new Store(':memory:');
  try {
    const owner = store.userForToken(store.createUser('owner')).id;
    const editor = store.userForToken(store.createUser('editor')).id;
    store.putAsset(owner, 'secret.svg', Buffer.from('<svg>secret</svg>'));
    store.putVersion(owner, 'wiki.md', Buffer.from('# Owner note'));
    // Emulate a pre-fix stored edit, bypassing the new write check.
    store.run('UPDATE versions SET html = ?, author_id = ?', Buffer.from('# Editor\n![[secret.svg]]'), editor);
    store.run('DELETE FROM asset_grants');
    store.setSetting('asset_grants', '0');
    store.ensureAssetGrants();
    assert.equal(store.canReadAsset(store.asset('secret.svg'), null), false);
  } finally { store.close(); }
});

test('preview queries stay within the Durable Object parameter budget', () => {
  const store = new Store(':memory:');
  try {
    const owner = store.userForToken(store.createUser('owner')).id;
    const slugs = Array.from({ length: 105 }, (_, i) => `page-${i}.md`);
    for (const slug of slugs) store.putVersion(owner, slug, Buffer.from('# ' + slug));
    const all = store.all.bind(store);
    store.all = (sql, ...args) => { assert.ok(args.length <= 100, 'too many SQL bindings'); return all(sql, ...args); };
    assert.equal(Object.keys(store.previews(slugs, null)).length, slugs.length);
  } finally { store.close(); }
});

test('example bytes and metadata remain one immutable snapshot until restart', async () => {
  const { examples, exampleHtml } = await import('../src/examples.js?snapshot-test');
  const previous = globalThis.__HTML_SERVER_FILES__;
  const entry = (html) => ({ data: Buffer.from(html).toString('base64'), mtime: 1000 });
  try {
    globalThis.__HTML_SERVER_FILES__ = { 'gallery/one.html': entry('<title>Old</title>') };
    assert.equal(examples()[0].title, 'Old');
    globalThis.__HTML_SERVER_FILES__['gallery/one.html'] = entry('<title>New</title>');
    globalThis.__HTML_SERVER_FILES__['gallery/two.html'] = entry('<title>Added</title>');
    assert.equal(examples()[0].title, 'Old');
    assert.equal(exampleHtml('one.html').toString(), '<title>Old</title>');
    assert.equal(exampleHtml('two.html'), null);
    exampleHtml('one.html').fill(0); // callers cannot change the cached snapshot
    assert.equal(exampleHtml('one.html').toString(), '<title>Old</title>');
  } finally { globalThis.__HTML_SERVER_FILES__ = previous; }
});

test('invalid MCP envelopes return an error instead of throwing', async () => {
  const { handle } = await import('../src/mcp.js');
  for (const msg of [null, [], 42, {}, { method: null }]) assert.equal((await handle(msg)).error.code, -32600);
});
