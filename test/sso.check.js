// Single sign-on in real Chromium (Playwright), run with `npm run test:browser`: signing in
// through a fake OIDC provider, working without a token, and the one thing that must hold
// for SSO to be safe: an uploaded page, sandboxed, can't use the viewer's session.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';
import AxeBuilder from '@axe-core/playwright';
import { fakeProvider } from './fake-oidc.js';

const home = mkdtempSync(join(tmpdir(), 'html-sso-'));
process.env.HTML_SERVER_HOME = home;
const { setSso } = await import('../src/config.js');
const { Store, hashToken } = await import('../src/store.js');
const { makeServer } = await import('../src/server.js');
let store, server, browser, idp, base, author;

// Every way an uploaded page might try to act as whoever is viewing it, each recorded where the page can see it.
const HOSTILE = `<title>Hostile</title><p id="out">running</p>
<form id="f" method="post" action="ORIGIN/api/me/token"></form>
<script>(async () => {
  const out = {};
  const tryIt = async (name, url, init) => { try { const r = await fetch(url, init); out[name] = r.type === 'opaque' ? 'opaque' : r.status; } catch (e) { out[name] = 'blocked'; } };
  await tryIt('me', 'ORIGIN/api/me', { credentials: 'include' });
  await tryIt('private', 'ORIGIN/api/artifacts/secret.md', { credentials: 'include' });
  await tryIt('rotate', 'ORIGIN/api/me/token', { method: 'POST', credentials: 'include', mode: 'no-cors' });
  document.getElementById('out').textContent = JSON.stringify(out);
  setTimeout(() => document.getElementById('f').submit(), 1500); // and a plain form post, once the results are read
})();</script>`;

before(async () => {
  idp = await fakeProvider();
  setSso({ OIDC_ISSUER: idp.issuer, OIDC_CLIENT_ID: 'html-server', OIDC_CLIENT_SECRET: 'shh', OIDC_ALLOW_INSECURE_HTTP: 'true' });
  store = new Store(join(home, 'test.db'));
  author = store.createUser('author', true);
  server = makeServer(store);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  const owner = store.userForToken(author).id;
  store.putVersion(owner, 'hostile.html', Buffer.from(HOSTILE.replaceAll('ORIGIN', base)));
  store.putVersion(owner, 'secret.md', Buffer.from('# Secret'), { visibility: 'private' });
  store.putVersion(owner, 'discuss.md', Buffer.from('# Discuss\n\nSomething to talk about.'));
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH } : {}) });
});
after(async () => {
  setSso({});
  await browser?.close();
  if (server) await new Promise((r) => server.close(r));
  store?.close();
  await idp?.close();
  rmSync(home, { recursive: true, force: true });
});

test('SSO in Chromium: sign in, upload without a token, and an uploaded page gets nothing of the session', async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));

  // Opening the site sends you to the provider and back, signed in, where you started.
  idp.st.next = { sub: 'v-1', email: 'viewer@example.com', email_verified: true };
  await page.goto(`${base}/stats`);
  await page.waitForURL(`${base}/stats`);
  await page.waitForFunction(() => document.querySelector('.session:not([hidden])')?.textContent.includes('Signed in as viewer'));
  assert.equal(await page.locator('.session a[href="/account"]').isVisible(), true);
  const cookie = (await context.cookies(base)).find((c) => c.name === 'html_server_session');
  assert.deepEqual([cookie.httpOnly, cookie.sameSite], [true, 'Lax']);
  assert.equal(await page.evaluate(() => document.cookie.includes('html_server_session')), false); // scripts can't read it

  // Upload with no token pasted: the session is enough.
  await page.goto(`${base}/`);
  await page.locator('#upload').click();
  await page.locator('.upload-dialog input[type="file"]').setInputFiles([{ name: 'mine.html', mimeType: 'text/html', buffer: Buffer.from('<title>Mine</title><p>mine</p>') }]);
  assert.equal(await page.locator('.upload-dialog .move-signin').isHidden(), true); // no token asked for
  await page.locator('.upload-dialog [type="submit"]').click();
  await page.locator('.upload-dialog').getByText('Uploaded 1.').waitFor();
  assert.equal(store.exact('mine.html', store.userForToken(author).id).owner, 'viewer');

  // The account page makes a token.
  page.once('dialog', (d) => d.accept());
  await page.goto(`${base}/account`);
  await page.getByRole('button', { name: 'Make a new token' }).click();
  await page.locator('#account-new').waitFor(); // shown once the new token is back
  const token = await page.locator('#claim-token').inputValue();
  assert.equal(store.userForToken(token).name, 'viewer');
  const hashBefore = store.one("SELECT token_hash FROM users WHERE name = 'viewer'").token_hash;
  const axe = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
  assert.deepEqual(axe.violations.map((v) => ({ id: v.id, targets: v.nodes.map((n) => n.target) })), [], 'the account page');

  // A hostile uploaded page, opened while signed in: its requests carry nothing of the session.
  await page.goto(`${base}/pages/hostile.html`);
  const frame = page.frameLocator('.page-frame');
  const results = JSON.parse(await frame.locator('#out').filter({ hasNotText: 'running' }).textContent());
  assert.notEqual(results.me, 200, JSON.stringify(results));
  assert.notEqual(results.private, 200, JSON.stringify(results));
  await page.waitForTimeout(2500); // the form post, too
  assert.equal(store.one("SELECT token_hash FROM users WHERE name = 'viewer'").token_hash, hashBefore); // no token was made for it
  assert.equal(hashToken(token), hashBefore);

  // Signing out ends that session, here and at the provider. (The fake provider then signs the
  // browser straight back in on its way home, as a real one would if its own session lived on.)
  const signedIn = (await context.cookies(base)).find((c) => c.name === 'html_server_session').value;
  assert.ok(store.sessionUser(signedIn));
  await page.goto(`${base}/account`);
  const [logout] = await Promise.all([page.waitForRequest((r) => r.url().startsWith(`${idp.issuer}/logout`)), page.getByRole('button', { name: 'Sign out' }).last().click()]);
  assert.equal(new URL(logout.url()).searchParams.get('post_logout_redirect_uri'), `${base}/`);
  assert.equal(store.sessionUser(signedIn), null);
  assert.deepEqual(errors, []);
  await context.close();
});

test('SSO in Chromium: a token saved before single sign-on never gets in the way, and commenting needs only the session', async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  // A token this browser kept from before (the claim page's "Sign in here"), replaced since.
  await page.goto(`${base}/healthz`);
  await page.evaluate(() => localStorage.setItem('artifact_token', 'ak_replaced-long-ago'));
  idp.st.next = { sub: 'c-1', email: 'carol@example.com', email_verified: true };
  await page.goto(`${base}/review/discuss.md`);
  // Force the fast-load ordering that used to fail in CI: the review has already
  // selected its version and updated the address before we check where sign-in landed.
  await page.waitForFunction(() => new URLSearchParams(location.search).get('v') === '1');
  await page.waitForURL((url) => url.origin === base && url.pathname === '/review/discuss.md');
  await page.locator('#who', { hasText: 'Signed in as carol' }).waitFor(); // was "Saved token was rejected."
  assert.equal(await page.evaluate(() => localStorage.getItem('artifact_token')), null); // forgotten: the session is the sign-in
  // Commenting, replying and resolving with no token at all.
  await page.locator('#body').fill('Looks good to me');
  await page.locator('#new button').click(); // was "Sign in to comment."
  const comment = page.locator('#list .c', { hasText: 'Looks good to me' });
  await comment.waitFor();
  assert.equal(await comment.getByRole('button', { name: 'Reply' }).isVisible(), true);
  await comment.getByRole('button', { name: 'Resolve' }).click();
  await page.locator('#list .c.done', { hasText: 'Looks good to me' }).waitFor();
  assert.equal(store.one("SELECT COUNT(*) AS n FROM comments c JOIN users u ON u.id = c.author_id WHERE u.name = 'carol' AND c.resolved_at IS NOT NULL").n, 1);
  assert.deepEqual(errors, []);
  await context.close();
});

test('SSO: note and notebook scripts never receive another viewer\'s private previews, navigation or assets', async (t) => {
  const context = await browser.newContext();
  t.after(() => context.close());
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  idp.st.next = { sub: 'privacy-viewer', email: 'privacy-viewer@example.com', email_verified: true };
  await page.goto(`${base}/account`);
  await page.getByRole('heading', { name: 'Your account', exact: true }).waitFor();
  const viewer = store.one("SELECT id FROM users WHERE name = 'privacy-viewer'").id;
  const owner = store.userForToken(author).id;
  store.putVersion(viewer, 'viewer-secret.md', Buffer.from('# PRIVATE_TITLE_CANARY\n\nPRIVATE_PREVIEW_CANARY\n\n[[untrusted-note]]'), { visibility: 'private' });
  const privateAsset = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><text>PRIVATE_ASSET_CANARY</text></svg>');
  const allowedAsset = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><text>PAGE_ASSET_CANARY</text></svg>');
  store.putAsset(viewer, 'viewer-secret.svg', privateAsset);
  store.putAsset(owner, 'page-allowed.svg', allowedAsset);
  store.putVersion(owner, 'public-linked.md', Buffer.from('# Public linked\n\nPUBLIC_PREVIEW_CANARY'));
  const markdown = '# Untrusted\n\n[[viewer-secret]] [[public-linked]]\n\n![[viewer-secret.svg]] ![[page-allowed.svg]]';
  const script = "<script>addEventListener('DOMContentLoaded', () => { window.authorRead = document.documentElement.outerHTML; });</script>";
  store.putVersion(owner, 'untrusted-note.md', Buffer.from(`${markdown}\n\n${script}`));
  store.putVersion(owner, 'untrusted-note.md', Buffer.from(`${markdown}\n\n${script}\n\nSecond version.`));
  store.putVersion(owner, 'untrusted-notebook.ipynb', Buffer.from(JSON.stringify({ nbformat: 4, cells: [
    { cell_type: 'markdown', source: markdown },
    { cell_type: 'code', source: '', outputs: [{ output_type: 'display_data', data: { 'text/html': script } }] },
  ] })));
  const sharedAsset = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><text>SHARED_ASSET_CANARY</text></svg>');
  store.putAsset(owner, 'shared-only.svg', sharedAsset);
  const shared = store.putVersion(owner, 'untrusted-private.md', Buffer.from(`${markdown}\n\n![[shared-only.svg]]\n\n${script}`), { visibility: 'private' });
  for (const path of ['/pages/untrusted-note.md', '/pages/untrusted-note.md?v=1', '/pages/untrusted-note.md?preview=1',
    '/pages/untrusted-note.md?embed=1', '/pages/untrusted-notebook.ipynb', shared.share_url]) {
    await page.goto(base + path);
    await page.waitForFunction(() => typeof window.authorRead === 'string');
    const seen = await page.evaluate(() => window.authorRead);
    for (const secret of ['PRIVATE_TITLE_CANARY', 'PRIVATE_PREVIEW_CANARY', privateAsset.toString('base64')]) {
      assert.ok(!seen.includes(secret), `${path} exposed ${secret}`);
    }
    assert.ok(seen.includes(allowedAsset.toString('base64')), `${path} still shows its authorized asset`);
    if (path === shared.share_url) assert.ok(seen.includes(sharedAsset.toString('base64')), 'the share link still grants its private asset');
    if (!path.includes('preview=1')) assert.ok(seen.includes('PUBLIC_PREVIEW_CANARY'), `${path} keeps public hover previews`);
  }
  // The viewer's private explorer remains available in the site's trusted pages.
  await page.goto(base);
  assert.equal(await page.getByRole('link', { name: 'PRIVATE_TITLE_CANARY', exact: true }).count() > 0, true);
});
