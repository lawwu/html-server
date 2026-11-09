// Real Chromium checks, run separately with `npm run test:browser` after installing
// Playwright Chromium. Every server and browser belongs to this test, never a user's.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
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
  put('private.md', '# Private\n\nPrivate content', { visibility: 'private' });
  put('no-gesture.html', '<title>No gesture</title><script>setTimeout(() => parent.postMessage({htmlServer: "go", href: location.origin + "/docs"}, "*"), 50)</script><p>No gesture</p>');
  put('links.html', '<title>Links</title><a id="local" href="/pages/beta.md">Beta</a>');
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
  const invoker = page.locator('a.gh'); await invoker.focus();
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

test('upload: choose files, sign in, publish, fix a refused name, and drop more', async () => {
  await page.goto(base + '/');
  await page.locator('#upload').click();
  const dialog = page.locator('.upload-dialog');
  assert.equal(await page.evaluate(() => document.activeElement.textContent), 'choose files');
  await dialog.locator('input[type="file"]').setInputFiles([
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
    await page.locator('.upload-dialog input[type="file"]').setInputFiles([
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
