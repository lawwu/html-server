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
  await page.waitForURL(`${base}/review/discuss.md`);
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
