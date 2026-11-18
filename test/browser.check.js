// Real Chromium checks, run separately with `npm run test:browser` after installing
// Playwright Chromium. Every server and browser belongs to this test, never a user's.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { before, after, beforeEach, afterEach, test } from 'node:test';
import { chromium } from 'playwright';
import AxeBuilder from '@axe-core/playwright';

const home = mkdtempSync(join(tmpdir(), 'html-browser-'));
process.env.HTML_SERVER_HOME = home;
const { Store } = await import('../src/store.js');
const { makeServer } = await import('../src/server.js');
let store, server, browser, context, page, base, token, errors;
before(async () => {
  store = new Store(join(home, 'test.db'));
  token = store.createUser('browser-owner', true);
  const owner = store.userForToken(token).id;
  const put = (name, body, opts) => store.putVersion(owner, name, Buffer.from(body), opts);
  put('alpha.md', '# Alpha\n\n[[beta]]\n\n## One\nText\n\n## Two\nMore');
  put('beta.md', '# Beta\n\nAnother note');
  put('versions.md', '# Version one');
  put('versions.md', '# Version two');
  put('private.md', '# Private\n\nPrivate content', { visibility: 'private' });
  put('no-gesture.html', '<title>No gesture</title><script>setTimeout(() => parent.postMessage({htmlServer: "go", href: location.origin + "/docs"}, "*"), 50)</script><p>No gesture</p>');
  put('links.html', '<title>Links</title><a id="local" href="/pages/beta.md">Beta</a>');
  // A category is whatever a page's <meta name="category"> says: here, markup that would run if drawn as markup.
  put('odd-category.html', '<title>Odd category</title><meta name="category" content="<img src=x onerror=window.pwned=1 "><p>odd</p>');
  put('hostile.html', `<title>&lt;img src=x onerror=window.pwned=1&gt;</title><script>window.probe={};try{probe.token=localStorage.getItem('artifact_token')}catch(e){probe.storage=e.name}try{probe.parent=parent.document.title}catch(e){probe.parent=e.name}</script><p>Hostile</p>`);
  put('hostile.md', '# Hostile note\n<script>try{window.leaked=localStorage.getItem("artifact_token")}catch(e){window.blocked=e.name}</script>');
  put('hostile.ipynb', JSON.stringify({ nbformat: 4, cells: [{ cell_type: 'code', source: ['1'], outputs: [{ output_type: 'display_data', data: { 'text/html': '<script>try{window.leaked=localStorage.getItem("artifact_token")}catch(e){window.blocked=e.name}</script>' } }] }] }));
  server = makeServer(store);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH } : {}) });
});
after(async () => {
  await browser?.close();
  if (server) await new Promise((r) => server.close(r));
  store?.close();
  rmSync(home, { recursive: true, force: true });
});
beforeEach(async () => {
  context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  page = await context.newPage(); page.setDefaultTimeout(8000);
  errors = []; page.on('pageerror', (e) => errors.push(e.message));
});
afterEach(async () => { await context.close(); assert.deepEqual(errors, []); });

test('HTML, Markdown and notebook scripts cannot read sign-in storage or parent chrome', async () => {
  await page.goto(base + '/docs');
  await page.evaluate((t) => localStorage.setItem('artifact_token', t), token);
  await page.goto(base + '/pages/hostile.html');
  const child = page.frameLocator('.page-frame');
  await child.locator('p').waitFor();
  const frame = page.frames().find((f) => f.url().includes('embed=1'));
  assert.deepEqual(await frame.evaluate(() => window.probe), { storage: 'SecurityError', parent: 'SecurityError' });
  assert.equal(await page.evaluate(() => !!window.pwned), false);
  for (const slug of ['hostile.md', 'hostile.ipynb']) {
    await page.goto(base + '/pages/' + slug);
    assert.deepEqual(await page.evaluate(() => ({ blocked: window.blocked, leaked: window.leaked ?? null })), { blocked: 'SecurityError', leaked: null });
  }
});

test('anonymous and private reviews render, and generated frame links navigate the tab', async () => {
  await page.goto(base + '/review/alpha.md');
  await page.frameLocator('#frame').getByRole('heading', { name: 'Alpha', exact: true }).waitFor();
  await page.frameLocator('#frame').getByRole('navigation', { name: 'Site' }).getByRole('link', { name: 'Docs', exact: true }).click();
  await page.waitForURL(base + '/docs');
  await page.evaluate((t) => localStorage.setItem('artifact_token', t), token);
  await page.goto(base + '/review/private.md');
  await page.frameLocator('#frame').getByText('Private content', { exact: true }).waitFor();
  await page.goto(base + '/pages/links.html');
  await page.frameLocator('.page-frame').locator('#local').click();
  await page.waitForURL(base + '/pages/beta.md');
  assert.equal(await page.locator('h1.article-title').textContent(), 'Beta');
});

test('frame navigation ignores spoofed sources, unsafe protocols, and messages without a gesture', async () => {
  await page.goto(base + '/pages/no-gesture.html');
  await page.waitForTimeout(250); // the artifact's own timer posts without a DevTools-created gesture
  assert.equal(page.url(), base + '/pages/no-gesture.html');
  await page.goto(base + '/pages/links.html');
  await page.frameLocator('.page-frame').locator('#local').waitFor();
  const frame = page.frames().find((f) => f.url().includes('embed=1'));
  await page.mouse.click(1, 1); // a gesture cannot authorize the wrong message source
  await page.evaluate(() => postMessage({ htmlServer: 'go', href: location.origin + '/docs' }, '*'));
  await frame.evaluate(() => parent.postMessage({ htmlServer: 'go', href: 'javascript:window.pwned=1' }, '*'));
  await page.waitForTimeout(100);
  assert.equal(page.url(), base + '/pages/links.html');
  assert.equal(await page.evaluate(() => !!window.pwned), false);
});

test('search contains keyboard focus, restores it, and activates a result', async () => {
  await page.goto(base + '/docs');
  const invoker = page.locator('a.brand'); await invoker.focus();
  await page.keyboard.press('Control+k');
  for (const key of ['Tab', 'Shift+Tab', 'Tab']) {
    await page.keyboard.press(key);
    assert.equal(await page.evaluate(() => !!document.activeElement.closest('.search-modal')), true);
  }
  await page.keyboard.press('Escape');
  assert.equal(await invoker.evaluate((el) => document.activeElement === el), true);
  await page.keyboard.press('Control+k');
  await page.locator('.search-modal input').fill('Beta');
  await page.locator('.search-results a').first().waitFor();
  await page.keyboard.press('Enter');
  await page.waitForURL(base + '/pages/beta.md');
});

test('graph links activate with Enter and its dialog restores focus', async () => {
  await page.goto(base + '/graph');
  const node = page.locator('a.node.page').first(); await node.waitFor();
  const href = await node.getAttribute('href'); await node.focus();
  await page.keyboard.press('Enter'); await page.waitForURL(base + href);
  await page.goto(base + '/pages/alpha.md');
  const expand = page.locator('.graph-expand'); await expand.click();
  assert.equal(await page.evaluate(() => !!document.activeElement.closest('.graph-panel')), true);
  await page.keyboard.press('Shift+Tab');
  assert.equal(await page.evaluate(() => !!document.activeElement.closest('.graph-panel')), true);
  await page.keyboard.press('Escape');
  assert.equal(await expand.evaluate((el) => document.activeElement === el), true);
});

test('a search starting with no results reports its newly inserted card', async () => {
  await page.goto(base + '/?q=zzznomatches');
  await page.locator('#q').fill('Alpha');
  await page.waitForFunction(() => document.getElementById('count').textContent === '1 match');
  assert.equal(await page.locator('.card:visible').count(), 1);
});

test('uploading a new version refreshes its gallery preview and preserves unchanged previews', async () => {
  const slug = 'preview-refresh.html';
  store.putVersion(store.userForToken(token).id, slug, Buffer.from('<title>Preview draft</title><p>First preview</p>'));
  await page.addInitScript((t) => { if (window === window.top) localStorage.setItem('artifact_token', t); }, token);
  await page.goto(base + '/docs');
  await page.goto(base + '/');
  const card = page.locator(`.card[data-slug="${slug}"]`);
  const preview = card.frameLocator('iframe');
  const draft = preview.getByText('First preview', { exact: true });
  await draft.evaluate((p) => { p.dataset.loaded = 'yes'; });
  const alpha = page.frameLocator('.card[data-slug="alpha.md"] iframe').getByRole('heading', { name: 'Alpha', exact: true });
  await alpha.evaluate((h) => { h.dataset.loaded = 'yes'; });

  await page.locator('#q').fill('Alpha');
  await card.waitFor({ state: 'hidden' });
  await page.locator('#q').fill('');
  await card.waitFor();
  await page.locator('#sort').selectOption('title');
  await page.locator('#results[aria-busy="false"]').waitFor();
  assert.equal(await draft.getAttribute('data-loaded'), 'yes');

  await page.locator('#upload').click();
  const dialog = page.locator('.upload-dialog');
  await dialog.locator('input[type="file"]:not([webkitdirectory])').setInputFiles({
    name: slug, mimeType: 'text/html', buffer: Buffer.from('<title>Preview revised</title><p>Second preview</p>'),
  });
  await dialog.getByRole('button', { name: 'Upload', exact: true }).click();
  await dialog.getByText('Uploaded 1.').waitFor();
  await dialog.getByRole('button', { name: 'Close' }).click();
  await card.getByRole('heading', { name: 'Preview revised' }).waitFor();
  await preview.getByText('Second preview', { exact: true }).waitFor();
  assert.equal(await alpha.getAttribute('data-loaded'), 'yes');
  await page.evaluate(() => history.back());
  await page.waitForURL(base + '/docs');
});

for (const [change, replace] of [['a new version', false], ['a replacement page at the same address', true]]) {
  test(`gallery filters keep ${change} after discovering it on a hidden card`, async () => {
    const owner = store.userForToken(token).id;
    const slug = replace ? 'replace-ledger.html' : 'revise-ledger.html';
    const put = (title, body) => store.putVersion(owner, slug, Buffer.from(`<title>${title}</title><p>${body}</p>`));
    put('Ledger totals draft', 'First amount');
    await page.goto(base + '/?q=Ledger');
    const card = page.locator(`.card[data-slug="${slug}"]`);
    const preview = card.frameLocator('iframe');
    await preview.getByText('First amount').waitFor();
    await page.locator('#q').fill('Alpha');
    await card.waitFor({ state: 'hidden' });

    if (replace) { store.apply(owner, slug, 'trash'); store.apply(owner, slug, 'purge'); }
    put('Ledger totals revised', 'New amount');
    await page.locator('#q').fill('totals');
    await card.getByRole('heading', { name: 'Ledger totals revised' }).waitFor();
    await preview.getByText('New amount').waitFor();

    await page.locator('#q').fill('Ledger');
    await card.locator('h2 mark').filter({ hasText: 'Ledger' }).waitFor();
    assert.equal(await card.locator('h2').textContent(), 'Ledger totals revised');
    await preview.getByText('New amount').waitFor();
  });
}

test('a gallery search that discovers a moved page invalidates its old address', async () => {
  const owner = store.userForToken(token).id;
  const oldSlug = 'travel-budget.html', newSlug = 'archive/travel-budget.html';
  store.putVersion(owner, oldSlug, Buffer.from('<title>Travel budget draft</title><p>First budget</p>'));
  const reads = [];
  page.on('request', (r) => { if (new URL(r.url()).searchParams.has('fragment')) reads.push(r.url()); });
  await page.goto(base + '/?q=Travel');
  const oldCard = page.locator(`.card[data-slug="${oldSlug}"]`);
  const movedCard = page.locator(`.card[data-slug="${newSlug}"]`);
  const search = page.locator('#q');
  await oldCard.frameLocator('iframe').getByText('First budget').waitFor();
  await search.fill('Alpha');
  await oldCard.waitFor({ state: 'hidden' });
  const before = reads.length;
  await search.fill('Travel');
  await oldCard.waitFor();
  assert.equal(reads.length, before, 'an unchanged query reuses its cached results');
  await search.fill('Alpha');
  await oldCard.waitFor({ state: 'hidden' });

  store.movePages(owner, [{ from: oldSlug, to: newSlug }]);
  store.putVersion(owner, newSlug, Buffer.from('<title>Travel budget final</title><p>Revised budget</p>'));
  await search.fill('final');
  await movedCard.frameLocator('iframe').getByText('Revised budget').waitFor();
  await search.fill('Travel');
  await page.locator('.card:visible h2 mark').filter({ hasText: 'Travel' }).waitFor();
  assert.equal(await oldCard.isVisible(), false);
  assert.equal(await movedCard.isVisible(), true);
});

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
/** Drop files on the page the way a browser does (a DataTransfer of Files), after dragging them in. */
const drop = (files) => page.evaluate((files) => {
  const dt = new DataTransfer();
  for (const [name, body] of files) dt.items.add(new File([body], name));
  document.body.dispatchEvent(new DragEvent('dragenter', { dataTransfer: dt, bubbles: true }));
  const overlay = document.body.classList.contains('dropping');
  document.body.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
  return overlay && !document.body.classList.contains('dropping');
}, files);

// Deliver reads out of order, deliberately ignoring AbortSignal. A cancelled
// transport alone is insufficient: its response/body may already have arrived.
const deferReads = (prefixes) => page.addInitScript((prefixes) => {
  const send = window.fetch;
  window.testReads = [];
  window.fetch = (path, options) => {
    if (!prefixes.some((p) => String(path).startsWith(p))) return send(path, options);
    return new Promise((resolve, reject) => window.testReads.push({ path,
      respond(body, status = 200) { resolve(new Response(body, { status, headers: { 'Content-Type': String(path).startsWith('/api/') ? 'application/json' : 'text/html' } })); },
      fail() { reject(new Error('offline')); },
    }));
  };
}, prefixes);

test('gallery keeps the latest results when older reads fail, and recovers from a current failure', async () => {
  await deferReads(['/?fragment=1']);
  await page.goto(base + '/');
  await page.locator('#q').fill('Alpha');
  await page.waitForFunction(() => testReads.length === 1);
  await page.locator('#q').fill('Beta');
  await page.waitForFunction(() => testReads.length === 2);
  await page.evaluate(() => testReads[1].respond('<div data-count="Beta results"></div><div class="cards"></div>'));
  await page.getByText('Beta results', { exact: true }).waitFor();
  await page.evaluate(() => testReads[0].fail());
  assert.equal(await page.locator('#count').textContent(), 'Beta results');
  await page.locator('#q').fill('Gamma');
  await page.waitForFunction(() => testReads.length === 3);
  await page.evaluate(() => testReads[2].fail());
  await page.getByText('Search failed. Try again.', { exact: true }).waitFor();
  await page.locator('#q').press('Enter');
  await page.waitForFunction(() => testReads.length === 4);
  await page.evaluate(() => testReads[3].respond('<div data-count="Recovered"></div><div class="cards"></div>'));
  await page.getByText('Recovered', { exact: true }).waitFor();
  assert.equal(await page.locator('#results').getAttribute('aria-busy'), 'false');
});

test('closing and reopening search invalidates old results, including the same query', async () => {
  await deferReads(['/api/search?']);
  await page.goto(base + '/docs');
  await page.keyboard.press('Control+k');
  await page.locator('.search-modal input').fill('Beta');
  await page.waitForFunction(() => testReads.length === 1);
  await page.keyboard.press('Escape');
  await page.keyboard.press('Control+k');
  await page.locator('.search-modal input').fill('Beta');
  await page.waitForFunction(() => testReads.length === 2);
  await page.evaluate(() => testReads[1].respond(JSON.stringify({ results: [{ title: 'Current Beta', url: '/pages/beta.md' }] })));
  await page.getByText('Current Beta', { exact: true }).waitFor();
  await page.evaluate(() => testReads[0].respond(JSON.stringify({ results: [{ title: 'Obsolete Beta', url: '/pages/alpha.md' }] })));
  assert.equal(await page.locator('.search-results').textContent(), 'Current Beta');
  await page.keyboard.press('Enter');
  await page.waitForURL(base + '/pages/beta.md');
});

test('upload freezes a batch, refuses repeated submission and closing, and queues dropped files', async () => {
  await page.addInitScript((t) => { if (window === window.top) localStorage.setItem('artifact_token', t); }, token);
  await page.goto(base + '/');
  await drop([['batch-one.md', '# One'], ['batch-two.md', '# Two']]);
  const dialog = page.locator('.upload-dialog');
  await dialog.getByLabel('Folder for pages').fill('batch');
  let release;
  const held = new Promise((r) => { release = r; });
  await page.route('**/api/artifacts/batch/batch-one.md', async (route) => { await held; await route.continue(); });
  await dialog.locator('[type="submit"]').click();
  await page.waitForFunction(() => document.querySelector('.upload-dialog form').getAttribute('aria-busy') === 'true');
  assert.equal(await dialog.getByLabel('Folder for pages').isDisabled(), true);
  await dialog.locator('form').evaluate((form) => form.dispatchEvent(new SubmitEvent('submit', { cancelable: true })));
  await page.keyboard.press('Escape');
  assert.equal(await dialog.isVisible(), true);
  await drop([['batch-next.md', '# Next']]);
  release();
  await dialog.getByText('Uploaded 2.', { exact: true }).waitFor();
  for (const name of ['batch-one.md', 'batch-two.md']) assert.equal(store.describe('batch/' + name).latest_version, 1);
  assert.equal(store.find('batch/batch-next.md'), undefined);
  await dialog.locator('[type="submit"]').click();
  await dialog.getByText('Uploaded 1.', { exact: true }).waitFor();
  assert.equal(store.describe('batch/batch-next.md').latest_version, 1);
});

test('upload refreshes partial successes after sign-in fails and retries only unfinished files', async () => {
  await page.addInitScript((t) => { if (window === window.top) localStorage.setItem('artifact_token', t); }, token);
  await page.goto(base + '/');
  await drop([['partial-one.md', '# Partial one'], ['partial-two.md', '# Partial two']]);
  let attempts = 0;
  await page.route('**/api/artifacts/partial-two.md', (route) => ++attempts === 1
    ? route.fulfill({ status: 401, contentType: 'application/json', body: '{"error":"expired token"}' }) : route.continue());
  const dialog = page.locator('.upload-dialog');
  await dialog.locator('[type="submit"]').click();
  await dialog.getByText(/Uploaded 1\. That token/).waitFor();
  await page.locator('.card[data-slug="partial-one.md"]').waitFor({ state: 'attached' });
  assert.equal(await dialog.getByLabel('Sign-in token').isVisible(), true);
  await dialog.locator('[type="submit"]').click();
  await dialog.getByText('Uploaded 1.', { exact: true }).waitFor();
  assert.equal(store.describe('partial-one.md').latest_version, 1);
  assert.equal(store.describe('partial-two.md').latest_version, 1);
});

test('bulk actions recover from rejected credentials', async () => {
  await page.addInitScript(() => { if (window === window.top) localStorage.setItem('artifact_token', 'expired'); });
  await page.goto(base + '/');
  await page.locator('#select').click();
  await page.locator('.card[data-slug="alpha.md"] .pick input').check();
  await page.locator('#bulk-tag').fill('test');
  await page.locator('#bulk [data-act="add"]').click();
  await page.getByText('Sign in to change pages:', { exact: false }).waitFor();
  assert.equal(await page.locator('#bulk button').first().isEnabled(), true);
});

test('review version reads and comments cannot replace a newer selection', async () => {
  await deferReads(['/api/artifacts/versions.md']);
  await page.goto(base + '/review/versions.md');
  await page.waitForFunction(() => testReads.length === 1);
  const meta = store.describe('versions.md');
  await page.evaluate((m) => testReads[0].respond(JSON.stringify(m)), meta);
  await page.waitForFunction(() => testReads.length === 2); // v2 comments
  await page.locator('#ver').selectOption('1');
  await page.waitForFunction(() => testReads.length === 3); // v1 metadata
  await page.locator('#ver').selectOption('2');
  await page.waitForFunction(() => testReads.length === 4); // v2 metadata again
  await page.evaluate((m) => testReads[3].respond(JSON.stringify(m)), meta);
  await page.waitForFunction(() => testReads.length === 5);
  await page.evaluate(() => testReads[4].respond('[]'));
  await page.getByText('Comments on v2', { exact: true }).waitFor();
  await page.evaluate((m) => { testReads[2].respond(JSON.stringify(m)); testReads[1].fail(); }, meta);
  assert.equal(await page.locator('#ver').inputValue(), '2');
  assert.equal(await page.locator('#ctitle').textContent(), 'Comments on v2');
  assert.equal(await page.locator('#err').textContent(), '');
  assert.equal(new URL(page.url()).search, '?v=2');
});

test('the comments link on a historical note opens the version being read', async () => {
  await page.goto(base + '/pages/versions.md?v=1');
  await page.locator('.content-meta').getByRole('link', { name: 'comments' }).click();
  await page.getByText(/^Comments on v\d/).waitFor();
  assert.equal(await page.locator('#ver').inputValue(), '1');
  assert.equal(new URL(page.url()).searchParams.get('v'), '1');
});

test('review ignores a previous diff after returning to page and requesting the same diff', async () => {
  await deferReads(['/review/versions.md/changes?']);
  await page.goto(base + '/review/versions.md');
  await page.getByText('Comments on v2', { exact: true }).waitFor();
  await page.locator('#changes').click();
  await page.waitForFunction(() => testReads.length === 1);
  await page.locator('#changes').click();
  await page.locator('#changes').click();
  await page.waitForFunction(() => testReads.length === 2);
  await page.evaluate(() => testReads[1].respond('<p>Current changes</p>'));
  await page.frameLocator('#frame').getByText('Current changes').waitFor();
  await page.evaluate(() => testReads[0].respond('<p>Obsolete changes</p>'));
  assert.match(await page.locator('#frame').getAttribute('srcdoc'), /Current changes/);
});

test('a failed version switch returns a cancelled diff to the current page', async () => {
  await deferReads(['/review/versions.md/changes?']);
  await page.goto(base + '/review/versions.md');
  await page.getByText('Comments on v2', { exact: true }).waitFor();
  await page.locator('#changes').click();
  await page.waitForFunction(() => testReads.length === 1);
  await page.route('**/api/artifacts/versions.md', (route) => route.fulfill({
    status: 503, contentType: 'application/json', body: '{"error":"Version temporarily unavailable"}',
  }));
  await page.locator('#ver').selectOption('1');
  await page.getByText('Version temporarily unavailable', { exact: true }).waitFor();
  assert.equal(await page.locator('#changes').textContent(), 'Show changes');
  assert.equal(await page.locator('#ver').inputValue(), '2');
  await page.frameLocator('#frame').getByRole('heading', { name: 'Version two', exact: true }).waitFor();
  await page.evaluate(() => testReads[0].respond('<p>Obsolete changes</p>'));
  assert.equal(await page.locator('#frame').getAttribute('srcdoc'), null);
});

test('review submits a comment once and restores editing after it finishes', async () => {
  await page.addInitScript((t) => { if (window === window.top) localStorage.setItem('artifact_token', t); }, token);
  await page.goto(base + '/review/versions.md');
  await page.getByText('Comments on v2', { exact: true }).waitFor();
  let release;
  const held = new Promise((r) => { release = r; });
  await page.route('**/api/artifacts/versions.md/comments', async (route) => { await held; await route.continue(); });
  await page.locator('#body').fill('Only once');
  await page.locator('#new button').click();
  assert.equal(await page.locator('#body').isDisabled(), true);
  await page.locator('#new').evaluate((form) => form.dispatchEvent(new SubmitEvent('submit', { cancelable: true })));
  release();
  await page.getByText('Only once', { exact: true }).waitFor();
  assert.equal(store.comments('versions.md', null, 2).filter((c) => c.body === 'Only once').length, 1);
  assert.equal(await page.locator('#body').isEnabled(), true);
});

test('move guards pending writes, then allows correcting a failed destination', async () => {
  await page.addInitScript((t) => { if (window === window.top) localStorage.setItem('artifact_token', t); }, token);
  await page.goto(base + '/review/versions.md?move=1');
  const dialog = page.locator('.move-dialog');
  let release, attempts = 0;
  const held = new Promise((r) => { release = r; });
  await page.route('**/api/moves', async (route) => {
    attempts++;
    await held;
    await route.fulfill({ status: 409, contentType: 'application/json', body: '{"error":"Address is occupied"}' });
  });
  await dialog.locator('[type="submit"]').click();
  await dialog.locator('form').evaluate((form) => form.dispatchEvent(new SubmitEvent('submit', { cancelable: true })));
  await page.keyboard.press('Escape');
  assert.equal(await dialog.isVisible(), true);
  assert.equal(await dialog.getByLabel('Folder', { exact: true }).isDisabled(), true);
  release();
  await dialog.getByText('Address is occupied', { exact: true }).waitFor();
  assert.equal(attempts, 1);
  assert.equal(await dialog.getByLabel('Folder', { exact: true }).isEnabled(), true);
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'detached' });
});

test('statistics ignore old person responses after selection and close, and expose failed refresh recovery', async () => {
  await page.addInitScript((t) => { if (window === window.top) localStorage.setItem('artifact_token', t); }, token);
  await deferReads(['/stats/usage']);
  await page.goto(base + '/stats');
  await page.waitForFunction(() => testReads.length === 1);
  await page.evaluate(() => testReads[0].respond('<div class="range-picker"><a href="?days=90" data-days="90">90 days</a></div>'
    + '<button class="person-link" data-person="a">Person A</button><button class="person-link" data-person="b">Person B</button><div id="person-detail" hidden></div>'));
  await page.getByText('Person A', { exact: true }).click();
  await page.waitForFunction(() => testReads.length === 2);
  await page.getByText('Person B', { exact: true }).click();
  await page.waitForFunction(() => testReads.length === 3);
  await page.evaluate(() => testReads[2].respond('<button class="person-close">Close person</button><p>Current person</p>'));
  await page.getByText('Current person', { exact: true }).waitFor();
  await page.getByText('Close person', { exact: true }).click();
  await page.evaluate(() => testReads[1].respond('<p>Obsolete person</p>'));
  assert.equal(await page.locator('#person-detail').isHidden(), true);
  assert.match(await page.locator('#person-detail').textContent(), /Current person/);
  await page.getByText('90 days', { exact: true }).click();
  await page.waitForFunction(() => testReads.length === 4);
  await page.evaluate(() => testReads[3].respond('expired', 401));
  await page.locator('#usage-signin').waitFor();
  assert.equal(await page.locator('#usage-token').isEnabled(), true);
});

test('a stale popular-period failure cannot navigate away from the latest period', async () => {
  await deferReads(['/stats?weeks=']);
  await page.goto(base + '/stats');
  await page.locator('#popular select').selectOption('2');
  await page.waitForFunction(() => testReads.length === 1);
  await page.locator('#popular select').selectOption('4');
  await page.waitForFunction(() => testReads.length === 2);
  await page.evaluate(() => testReads[1].respond('<section id="popular"><select><option value="4">Latest period</option></select></section>'));
  await page.waitForURL(base + '/stats?weeks=4#popular');
  await page.evaluate(() => testReads[0].fail());
  assert.equal(page.url(), base + '/stats?weeks=4#popular');
  assert.equal(await page.locator('#popular select').inputValue(), '4');
});

test('a failed usage refresh does not leave cancelled person details loading', async () => {
  await page.addInitScript((t) => { if (window === window.top) localStorage.setItem('artifact_token', t); }, token);
  await deferReads(['/stats/usage']);
  await page.goto(base + '/stats');
  await page.waitForFunction(() => testReads.length === 1);
  await page.evaluate(() => testReads[0].respond('<div class="range-picker"><a href="?days=90" data-days="90">90 days</a></div>'
    + '<button class="person-link" data-person="a" aria-expanded="false">Person A</button><div id="person-detail" hidden></div>'));
  await page.getByText('Person A', { exact: true }).click();
  await page.waitForFunction(() => testReads.length === 2);
  await page.getByText('90 days', { exact: true }).click();
  await page.waitForFunction(() => testReads.length === 3);
  await page.evaluate(() => testReads[2].fail());
  await page.getByText('Couldn’t reach the server.', { exact: true }).waitFor();
  assert.equal(await page.locator('#person-detail').isHidden(), true);
  assert.equal(await page.getByText('Person A', { exact: true }).getAttribute('aria-expanded'), 'false');
  await page.evaluate(() => testReads[1].respond('<p>Obsolete person</p>'));
  assert.equal(await page.locator('#person-detail').isHidden(), true);
});

test('clearing a pending usage sign-in releases its busy state without accepting the old token', async () => {
  await deferReads(['/stats/usage']);
  await page.goto(base + '/stats');
  await page.locator('#usage-token').fill('old-token');
  await page.locator('#usage-signin button').click();
  await page.waitForFunction(() => testReads.length === 1);
  assert.equal(await page.locator('#usage-body').getAttribute('aria-busy'), 'true');
  await page.locator('#usage-token').fill('');
  await page.locator('#usage-signin button').click();
  assert.equal(await page.locator('#usage-body').getAttribute('aria-busy'), 'false');
  await page.evaluate(() => testReads[0].respond('<p>Obsolete usage</p>'));
  assert.equal(await page.locator('#usage-signin').isVisible(), true);
  assert.equal(await page.evaluate(() => localStorage.getItem('artifact_token')), null);
  assert.equal(await page.getByText('Obsolete usage', { exact: true }).count(), 0);
});

test('upload: choose files, sign in, publish, fix a refused name, and drop more', async () => {
  await page.goto(base + '/');
  await page.locator('#upload').click();
  const dialog = page.locator('.upload-dialog');
  assert.equal(await page.evaluate(() => document.activeElement.textContent), 'choose files');
  await dialog.locator('input[type="file"]:not([webkitdirectory])').setInputFiles([
    { name: 'Browser Trip.html', mimeType: 'text/html', buffer: Buffer.from('<title>Browser trip</title><p>From the browser</p>') },
    { name: 'diagram.png', mimeType: 'image/png', buffer: PNG },
    { name: 'slides.pptx', mimeType: 'application/octet-stream', buffer: Buffer.from('x') },
  ]);
  assert.deepEqual(await dialog.locator('.upload-list input').evaluateAll((els) => els.map((e) => e.value)), ['Browser-Trip.html', 'diagram.png']);
  await dialog.getByText('slides.pptx: not a page, image or PDF').waitFor();
  await dialog.getByLabel('Version note').fill('from the dialog');
  await dialog.getByRole('button', { name: 'Upload 2 files' }).click();
  await dialog.getByText('Paste your sign-in token first.').waitFor(); // nothing sent
  await dialog.getByLabel('Sign-in token').fill(token);
  await dialog.getByRole('button', { name: 'Upload 2 files' }).click();
  await dialog.getByText('Uploaded 2.').waitFor();
  const meta = await (await fetch(base + '/api/artifacts/Browser-Trip.html')).json();
  assert.deepEqual([meta.visibility, meta.versions.at(-1).note], ['public', 'from the dialog']);
  const assets = await (await fetch(base + '/api/assets', { headers: { Authorization: `Bearer ${token}` } })).json();
  assert.ok(assets.some((a) => a.name === 'diagram.png'));
  await page.locator('.card[data-slug="Browser-Trip.html"]').waitFor(); // the cards behind are redrawn
  assert.equal(await page.evaluate(() => localStorage.getItem('artifact_token')), token);
  assert.equal(await dialog.getByLabel('Sign-in token').isHidden(), true);
  assert.equal(await page.locator('.session').isVisible(), true); // Sign out, from now on

  // Files dropped while it's open join it; a refused name stays to be fixed and sent again.
  assert.equal(await drop([['plan.md', '# Private plan']]), true);
  const row = dialog.locator('.upload-list li').last();
  await row.locator('input').fill('plan');
  await dialog.getByLabel('Folder for pages').fill('trips');
  await dialog.getByRole('checkbox', { name: /Private/ }).check();
  await dialog.getByRole('button', { name: 'Upload', exact: true }).click();
  await row.getByText(/needs its file extension/).waitFor();
  await row.locator('input').fill('plan.md');
  await dialog.getByRole('button', { name: 'Upload', exact: true }).click();
  await dialog.getByText('Uploaded 1.').waitFor();
  const href = await row.getByRole('link').getAttribute('href');
  assert.match(href, /^\/v\//); // a private page opens by its share link: a new tab sends no token
  assert.equal((await fetch(base + '/trips/plan.md')).status, 404);
  assert.equal((await fetch(base + href)).status, 200);
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'detached' });

  // Dropped on the page itself: the drop overlay, then the dialog with the file in it.
  assert.equal(await drop([['dropped.html', '<p>Dropped</p>']]), true);
  assert.equal(await dialog.locator('.upload-list input').inputValue(), 'dropped.html');
});

test('sign out: the top bar names who is signed in and forgets the token; notes never show it', async () => {
  const signedIn = (name) => page.waitForFunction((n) => document.querySelector('.session:not([hidden])')?.textContent.startsWith(`Signed in as ${n} ·`), name);
  const me = [];
  page.on('request', (r) => { if (r.url().endsWith('/api/me')) me.push(r.url()); });
  await page.goto(base + '/');
  assert.equal(await page.locator('.session').isHidden(), true); // nobody signed in
  await page.evaluate((t) => localStorage.setItem('artifact_token', t), token);
  await page.goto(base + '/');
  await signedIn('browser-owner'); // "Signed in as" is for screen readers; the bar shows the name
  assert.equal(await page.locator('.session [data-session-who]').textContent(), 'browser-owner');
  await page.goto(base + '/stats');
  await signedIn('browser-owner');
  assert.equal(me.length, 1); // the name is asked once per token, not on every page
  const axe = await new AxeBuilder({ page }).include('.session').withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
  assert.deepEqual(axe.violations.map((v) => v.id), []);
  await page.goto(base + '/pages/alpha.md'); // sandboxed: can't read the token, so says nothing
  assert.equal(await page.locator('.session').isHidden(), true);

  await page.goto(base + '/');
  await page.locator('.session').getByRole('button', { name: 'Sign out' }).click();
  await page.waitForLoadState('load');
  assert.deepEqual(await page.evaluate(() => [localStorage.getItem('artifact_token'), localStorage.getItem('artifact_user')]), [null, null]);
  assert.equal(await page.locator('.session').isHidden(), true);

  // The review page has the top bar too.
  await page.evaluate((t) => localStorage.setItem('artifact_token', t), token);
  await page.goto(base + '/review/alpha.md');
  await page.locator('#who').getByText('Signed in as browser-owner').waitFor();
  await signedIn('browser-owner');
  await page.locator('.session').getByRole('button', { name: 'Sign out' }).click();
  await page.locator('#who').getByText('Reading as a guest.').waitFor();
  assert.equal(await page.evaluate(() => localStorage.getItem('artifact_token')), null);

  // A token the server no longer takes still shows the line, so it can be signed out.
  await page.evaluate(() => localStorage.setItem('artifact_token', 'ak_revoked'));
  await page.goto(base + '/');
  await page.locator('.session [data-session-who]').getByText('Token not accepted').waitFor();
});

test('the top bar: the same sections on every page, and still there with the sidebar hidden', async () => {
  const sections = () => page.getByRole('navigation', { name: 'Site' }).getByRole('link').allTextContents();
  const want = ['Pages', 'Graph', 'Stats', 'Gallery', 'Docs', 'About'];
  for (const path of ['/', '/stats', '/docs', '/pages/alpha.md', '/pages/links.html', '/review/alpha.md']) {
    await page.goto(base + path);
    assert.deepEqual(await sections(), want, path);
  }
  await page.goto(base + '/');
  await page.getByRole('button', { name: 'Hide the sidebar' }).click();
  assert.equal(await page.locator('#left-sidebar').isHidden(), true);
  assert.deepEqual(await sections(), want);
  await page.goto(base + '/pages/alpha.md');
  assert.equal(await page.locator('#left-sidebar').isHidden(), true); // the choice is kept
  await page.getByRole('button', { name: 'Show the sidebar' }).click();
  assert.equal(await page.locator('#left-sidebar').isVisible(), true);
});

test('moving between pages shifts nothing: the bar, its links and the page start in the same place', async () => {
  const where = () => page.evaluate(() => {
    const box = (s) => { const r = document.querySelector(s)?.getBoundingClientRect(); return r && [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)]; };
    return { brand: box('.brand'), nav: box('.site-nav'), bar: box('.topbar'), main: box('.page > main')?.[0] };
  });
  await page.goto(base + '/');
  const home = await where();
  for (const path of ['/pages/alpha.md', '/pages/links.html', '/gallery', '/gallery/ab-test-readout.html', '/stats', '/graph', '/docs', '/about', '/history/alpha.md']) {
    await page.goto(base + path);
    assert.deepEqual(await where(), home, path);
  }
  await page.goto(base + '/review/alpha.md'); // no sidebar, and a layout of its own; the bar is the same
  const review = await where();
  assert.deepEqual([review.brand, review.nav, review.bar], [home.brand, home.nav, home.bar]);
});

test('a sidebar longer than the window scrolls; its sections never overlap', async () => {
  await page.setViewportSize({ width: 1280, height: 200 }); // shorter than the explorer
  for (const path of ['/', '/pages/alpha.md']) {
    await page.goto(base + path);
    const boxes = await page.locator('.sidebar > *:visible').evaluateAll((els) => els.map((e) => { const r = e.getBoundingClientRect(); return [r.top, r.bottom, e.scrollHeight <= Math.ceil(r.height)]; }));
    boxes.forEach(([, bottom, fits], i) => {
      assert.ok(fits, `${path}: section ${i} is cut short`);
      if (boxes[i + 1] && boxes[i + 1][0] < boxes[i][0] + 1) return; // the right sidebar starts its own column
      if (boxes[i + 1]) assert.ok(bottom <= boxes[i + 1][0], `${path}: section ${i} runs into the next`);
    });
    assert.equal(await page.locator('.sidebar.left').evaluate((s) => s.scrollHeight > s.clientHeight), true, path);
  }
});

test('claim link: a button shows the token once; Sign in here keeps it for this browser', async () => {
  const link = store.claimLink('octo-cat');
  await page.goto(`${base}/api/claim/${link.code}`);
  assert.equal(await page.locator('#claim-token').count(), 0); // opening the link shows nothing yet
  await page.getByRole('button', { name: 'Show my token' }).click();
  const token = await page.locator('#claim-token').inputValue();
  assert.match(token, /^ak_/);
  assert.equal(store.userForToken(token).name, 'octo-cat');
  await page.getByRole('button', { name: 'Sign in here' }).click();
  await page.getByText('Signed in.').waitFor();
  assert.equal(await page.evaluate(() => localStorage.getItem('artifact_token')), token);
  for (const colorScheme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme });
    await page.waitForTimeout(400); // links fade to the new colours (0.2 s): judge them once they're there
    const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
    assert.deepEqual(result.violations.map((v) => ({ id: v.id, targets: v.nodes.map((n) => n.target) })), [], colorScheme);
  }
  await page.reload(); // a reload re-sends the form: the link is used up, and says so
  await page.getByRole('heading', { name: 'This link has been used or has expired' }).waitFor();
  await page.goto(base + '/');
  await page.waitForFunction(() => document.querySelector('.session:not([hidden])')?.textContent.startsWith('Signed in as octo-cat'));
});

test('claim link with GitHub sign-in: Continue with GitHub, and nothing shown before it', async () => {
  const { setGitHubSignIn } = await import('../src/config.js');
  setGitHubSignIn({ GITHUB_CLIENT_ID: 'app-id', GITHUB_CLIENT_SECRET: 'shh', GITHUB_URL: 'https://github.invalid' });
  try {
    const link = store.claimLink('octo-cat', { github: true });
    await page.goto(`${base}/api/claim/${link.code}`);
    await page.getByText('This link is for the GitHub account octo-cat').waitFor();
    const go = page.getByRole('button', { name: 'Continue with GitHub' });
    await go.waitFor();
    assert.equal(await page.locator('#claim-token').count(), 0);
    const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
    assert.deepEqual(result.violations.map((v) => v.id), []);
    // The button sends the browser to GitHub (here an address that goes nowhere), with the sign-in's cookie.
    const [request] = await Promise.all([page.waitForRequest((r) => r.url().startsWith('https://github.invalid/login/oauth/authorize')), go.click()]);
    assert.match(request.url(), /client_id=app-id&redirect_uri=http%3A%2F%2F127\.0\.0\.1%3A\d+%2Fapi%2Fclaim%2Fcallback&scope=user%3Aemail&state=[\w-]{43}&login=octo-cat/);
    assert.equal((await page.context().cookies(`${base}/api/claim/callback`)).find((c) => c.name === 'html_server_claim')?.httpOnly, true); // scoped to /api/claim
  } finally {
    setGitHubSignIn({});
    errors.length = 0; // the page that fails to load at github.invalid isn't the site's error
  }
});

for (const colorScheme of ['light', 'dark']) {
  test(`375px ${colorScheme}: no horizontal overflow, contrast or ARIA regressions`, async () => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.emulateMedia({ colorScheme });
    for (const path of ['/', '/docs', '/about', '/stats', '/pages/alpha.md', '/review/alpha.md']) {
      await page.goto(base + path);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, path);
      const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
      assert.deepEqual(result.violations.map((v) => ({ id: v.id, targets: v.nodes.map((n) => n.target) })), [], path);
    }
    // The upload dialog, with a file it can't take and an error showing.
    await page.goto(base + '/');
    await page.locator('#upload').click();
    await page.locator('.upload-dialog input[type="file"]:not([webkitdirectory])').setInputFiles([
      { name: 'A long file name for a phone screen.html', mimeType: 'text/html', buffer: Buffer.from('<p>x</p>') },
      { name: 'slides.pptx', mimeType: 'application/octet-stream', buffer: Buffer.from('x') },
    ]);
    await page.locator('.upload-dialog [type="submit"]').click(); // no token saved in this context
    await page.locator('.upload-status.err').waitFor();
    assert.equal(await page.evaluate(() => {
      const d = document.querySelector('.upload-dialog');
      return document.documentElement.scrollWidth <= innerWidth && d.scrollWidth <= d.clientWidth;
    }), true, 'upload dialog');
    const result = await new AxeBuilder({ page }).include('.upload-dialog').withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
    assert.deepEqual(result.violations.map((v) => ({ id: v.id, targets: v.nodes.map((n) => n.target) })), [], 'upload dialog');
  });
}

test("the graph draws a page's category as text, never as markup", async () => {
  await page.goto(base + '/graph');
  const legend = page.locator('#legend button', { hasText: '<img src=x' });
  await legend.waitFor(); // the category, shown as the text it is
  await page.waitForTimeout(200); // an <img> with a broken src would have fired its onerror by now
  assert.equal(await page.evaluate(() => !!window.pwned), false);
  assert.equal(await page.locator('#legend img').count(), 0);
});

test("Copy HTML never copies an error as if it were the page", async () => {
  await page.goto(base + '/pages/links.html');
  await page.route('**/api/artifacts/links.html/versions/*', (r) => r.fulfill({ status: 401, contentType: 'application/json', body: '{"error":"sign in, or send a bearer token"}' }));
  const button = page.getByRole('button', { name: 'Copy HTML' });
  await button.click();
  await page.getByRole('button', { name: 'Couldn’t load it' }).waitFor(); // was "Copied", with the error on the clipboard
});

test('a browser folder upload and copied embed load the selected version’s modules, styles and data', async (t) => {
  const folder = join(home, 'browser-site');
  mkdirSync(join(folder, 'assets'), { recursive: true });
  writeFileSync(join(folder, 'index.html'), '<title>Browser site</title><link rel="stylesheet" href="assets/site.css"><p>Loading</p><a href="details.html">Details</a><script type="module" src="assets/app.js"></script>');
  writeFileSync(join(folder, 'assets/site.css'), 'p { color: rgb(17, 34, 51) }');
  writeFileSync(join(folder, 'assets/app.js'), "document.querySelector('p').textContent = await (await fetch('./data.json')).json()");
  writeFileSync(join(folder, 'details.html'), '<h1>Details of this report</h1>');
  const data = join(folder, 'data.json');
  writeFileSync(data, '"First"');
  await page.goto(base);
  await page.evaluate((t) => localStorage.setItem('artifact_token', t), token);
  async function upload() {
    await page.goto(base);
    await page.getByRole('button', { name: 'Upload', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.locator('[webkitdirectory]').setInputFiles(folder);
    await dialog.getByRole('button', { name: 'Upload', exact: true }).click();
    await dialog.getByRole('link', { name: 'Open browser-site.html' }).waitFor();
  }
  await upload();
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto(base + '/pages/browser-site.html');
  const frame = page.frameLocator('.page-frame');
  await frame.getByText('First', { exact: true }).waitFor();
  assert.equal(await frame.locator('p').evaluate((p) => getComputedStyle(p).color), 'rgb(17, 34, 51)');
  await frame.getByRole('link', { name: 'Details' }).click();
  await frame.getByRole('heading', { name: 'Details of this report' }).waitFor();
  assert.equal(page.url(), base + '/pages/browser-site.html');
  const copy = async () => {
    await page.locator('[data-embed]').click();
    return page.evaluate(() => navigator.clipboard.readText());
  };
  const live = await copy();
  await page.getByLabel('Embed version').selectOption('1');
  const pinned = await copy();
  writeFileSync(data, '"Second"');
  await upload();
  const host = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(pinned + live);
  });
  await new Promise((ready) => host.listen(0, '127.0.0.1', ready));
  t.after(() => { host.closeAllConnections(); host.close(); });
  await page.goto(`http://127.0.0.1:${host.address().port}/report`);
  await page.frameLocator('iframe').first().getByText('First', { exact: true }).waitFor();
  await page.frameLocator('iframe').last().getByText('Second', { exact: true }).waitFor();
});
