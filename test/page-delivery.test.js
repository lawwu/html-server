import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { PageDelivery } from '../src/page-delivery.js';
import { examples, exampleHtml } from '../src/examples.js';
import { ApiError } from '../src/text.js';
import { testDatabase } from './fixture.js';

async function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'html-delivery-'));
  const db = await testDatabase(dir), store = db.open();
  t.after(async () => { await store.close(); await db.drop(); rmSync(dir, { recursive: true, force: true }); });
  const owner = store.userForToken(store.createUser('owner')).id;
  const put = (name, source, options) => store.putVersion(owner, name, Buffer.from(source), options);
  return { store, owner, put };
}
const article = (title) => `<!doctype html><html><head><title>${title}</title></head><body><h2>One</h2><h2>Two</h2><h2>Three</h2></body></html>`;
const rejectedViewer = () => { throw new ApiError(401, 'bad token'); };

test('HTML presentation modes own version selection, decorations and view counting', async (t) => {
  const { store, owner, put } = await fixture(t);
  put('report.html', article('Old title'));
  put('report.html', article('New title'));
  const cases = [
    { query: '?v=1', kind: 'site', count: 0 },
    { query: '?v=1&raw=', kind: 'site', count: 0 },
    { query: '?v=1&raw=0', kind: 'artifact', count: 1, toc: true, badge: true },
    { query: '?v=1&embed=1', kind: 'artifact', count: 1, embed: true },
    { query: '?v=1&embed=1&preview=1', kind: 'artifact', count: 0, preview: true },
    { query: '?v=1&raw=1&toc=0', kind: 'artifact', count: 1, badge: true },
  ];
  let views = 0;
  for (const c of cases) {
    const r = new PageDelivery(store, { document: true, query: c.query, visit: ['127.0.0.1', 'Mozilla/5.0'] }).named('report.html');
    assert.equal(r.kind, c.kind, c.query);
    const body = r.body.toString();
    if (c.kind === 'site') {
      assert.ok(body.includes('New title'), 'frame uses current metadata');
      assert.ok(body.includes('v=1&amp;embed=1'));
    } else {
      assert.ok(body.includes('<title>Old title</title>'));
      assert.equal(body.includes('data-artifact-toc-script'), !!c.toc, c.query);
      assert.equal(body.includes('data-artifact-version-badge'), !!c.badge, c.query);
      assert.equal(body.includes('data-html-server-embed'), !!c.embed, c.query);
      assert.equal(body.includes('data-html-server-in-frame'), !!c.embed, c.query);
      assert.equal(r.preview, !!c.preview, c.query);
    }
    views += c.count;
    assert.equal(store.views(owner, 'report.html').views, views, c.query);
  }
  assert.throws(() => new PageDelivery(store, { document: true, query: '?v=99' }).named('report.html'), { status: 404 });
  assert.equal(store.views(owner, 'report.html').views, views);
});

test('redirects preserve the query before version parsing, but never bypass read authorization', async (t) => {
  const { store, owner, put } = await fixture(t);
  put('old.html', article('Private'), { visibility: 'private' });
  store.movePages(owner, [{ from: 'old.html', to: 'research/new.html' }]);
  const opts = { viewer: owner, query: '?v=invalid&raw=1' };
  assert.deepEqual(new PageDelivery(store, opts).named('old.html'), { kind: 'redirect', location: '/research/new.html?v=invalid&raw=1', noStore: true });
  assert.deepEqual(new PageDelivery(store, opts).named('research'), { kind: 'redirect', location: '/research/?v=invalid&raw=1' });
  assert.throws(() => new PageDelivery(store, { query: opts.query }).named('old.html'), { status: 404 });
  assert.throws(() => new PageDelivery(store, opts).named('research/new.html'), { status: 400 });
  assert.throws(() => new PageDelivery(store, { viewer: rejectedViewer }).named('../bad'), { status: 404 });
});

test('shared HTML remains sandboxed, keeps authored links and grants assets even in previews', async (t) => {
  const { store, owner, put } = await fixture(t);
  const html = '<!doctype html><html><head><title>Shared</title></head><body><img src="/assets/chart.png"><a href="sibling.html">Sibling</a></body></html>';
  put('source/report.html', html, { visibility: 'private' });
  put('source/report.html', html + '<!-- v2 -->');
  store.movePages(owner, [{ from: 'source/report.html', to: 'archive/report.html' }]);
  const page = store.find('archive/report.html');
  const result = new PageDelivery(store, { document: true, sso: true, query: '?v=1', viewer: rejectedViewer }).shared(page.share_id);
  assert.equal(result.kind, 'artifact');
  const body = result.body.toString();
  assert.ok(body.startsWith('<!doctype html>'));
  assert.ok(body.includes('<base href="/pages/source/report.html?v=1">'));
  assert.ok(body.includes(`/assets/chart.png?from=${page.share_id}`));
  assert.ok(body.includes('data-current="/v/'));
  assert.ok(!body.includes('data-history='));
  const preview = new PageDelivery(store, { sso: true, query: '?preview=1&embed=1' }).shared(page.share_id);
  assert.equal(preview.preview, true);
  assert.ok(preview.body.toString().includes(`/assets/chart.png?from=${page.share_id}`));
  assert.ok(!preview.body.toString().includes('data-html-server-embed'));
});

test('note and notebook delivery isolates surrounding data while preserving page-authorized assets', async (t) => {
  const { store, owner, put } = await fixture(t);
  const viewer = store.userForToken(store.createUser('viewer')).id;
  store.putVersion(viewer, 'secret.md', Buffer.from('# Unrelated private title\nprivate-preview-marker'), { visibility: 'private' });
  store.putAsset(viewer, 'secret.svg', Buffer.from('<svg>private-asset-marker</svg>'));
  store.putAsset(owner, 'own.svg', Buffer.from('<svg>own-asset-marker</svg>'));
  const markdown = '# Allowed\n[[secret]] ![[secret.svg]] ![[own.svg]]';
  const nb = JSON.stringify({ cells: [{ cell_type: 'markdown', source: markdown }] });
  for (const [name, source] of [['note.md', markdown], ['notebook.ipynb', nb]]) {
    put(name, source, { visibility: 'private' });
    const page = store.find(name);
    for (const query of ['', '?preview=1', '?embed=1']) {
      const result = new PageDelivery(store, { viewer, query, document: true }).shared(page.share_id);
      assert.equal(result.kind, 'artifact');
      const body = result.body.toString();
      for (const hidden of ['Unrelated private title', 'private-preview-marker', Buffer.from('<svg>private-asset-marker</svg>').toString('base64')]) {
        assert.ok(!body.includes(hidden), `${name}${query} leaked ${hidden}`);
      }
      assert.ok(body.includes(Buffer.from('<svg>own-asset-marker</svg>').toString('base64')));
      assert.ok(!body.includes('/_static/session.js'));
      assert.equal(body.includes('id="page-previews"'), !query.includes('preview'));
      assert.equal(body.includes('data-html-server-in-frame'), query.includes('embed'));
      assert.ok(!body.includes('data-html-server-embed'), 'notes retain their own layout');
    }
  }
  put('frame.html', article('Trusted frame'));
  assert.ok(new PageDelivery(store, { viewer, document: true }).named('frame.html').body.includes('Unrelated private title'));
});

test('examples ignore version parameters and need a viewer only for the trusted frame', async (t) => {
  const { store } = await fixture(t);
  const file = examples()[0].slug;
  const raw = new PageDelivery(store, { query: '?preview=1&embed=1&v=bad', document: true, viewer: rejectedViewer }).example(file);
  assert.equal(raw.kind, 'artifact');
  assert.equal(raw.preview, true);
  assert.equal(raw.body.toString(), exampleHtml(file).toString());
  assert.throws(() => new PageDelivery(store, { document: true, viewer: rejectedViewer }).example(file), { status: 401 });
  assert.throws(() => new PageDelivery(store, { document: true, viewer: rejectedViewer }).example('missing.html'), { status: 404 });
});
