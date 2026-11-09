// Single sign-on through an OIDC provider, against a fake one that does what Entra, Okta or
// Keycloak do: discovery, the authorize redirect, the code exchange with PKCE, an RS256 ID
// token, its keys, and RP-initiated sign-out. Nothing leaves this machine.
//   node --test test/sso.test.js
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { setSso } from '../src/config.js';
import { makeServer } from '../src/server.js';
import { forgetProvider } from '../src/sso.js';
import { fakeProvider } from './fake-oidc.js';
import { testDatabase } from './fixture.js';

let dir, db, store, server, base, admin, idp, issuer;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'artifacts-'));
  db = await testDatabase(dir);
  store = db.open();
  admin = store.createUser('admin', true);
  idp = await fakeProvider();
  issuer = idp.issuer;
  forgetProvider();
  setSso({ OIDC_ISSUER: issuer, OIDC_CLIENT_ID: 'html-server', OIDC_CLIENT_SECRET: 'shh', OIDC_ALLOW_INSECURE_HTTP: 'true',
    OIDC_ADMIN_EMAILS: 'boss@example.com', OIDC_ADMIN_CLAIM: 'roles', OIDC_ADMIN_CLAIM_VALUES: 'HtmlServer.Admin' });
  server = makeServer(store);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

afterEach(async () => {
  setSso({});
  forgetProvider();
  await new Promise((r) => server.close(r));
  await idp.close();
  await store.close();
  await db.drop();
  rmSync(dir, { recursive: true, force: true });
});

const PAGE = { Accept: 'text/html', 'Sec-Fetch-Dest': 'document', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Site': 'none' }; // a browser opening an address
const OWN = { 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Dest': 'empty' }; // this site's own scripts
const cookieOf = (r, name) => r.headers.getSetCookie().find((c) => c.startsWith(`${name}=`))?.split(';')[0];

/**
 * A request to the server with exactly these headers, as a browser sends them. Not fetch:
 * Node's fetch sets Sec-Fetch-Mode itself, so it can't play a browser opening a page.
 * Answers like fetch's Response (status, headers.get, headers.getSetCookie, text, json).
 */
function send(method, url, headers = {}, body = '') {
  return new Promise((resolve, reject) => {
    const req = request(url, { method, headers: { ...headers, ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {}) } }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: { get: (n) => res.headers[n.toLowerCase()] ?? null, getSetCookie: () => res.headers['set-cookie'] || [] },
        text: async () => data, json: async () => JSON.parse(data), clone() { return this; },
      }));
    });
    req.on('error', reject);
    req.end(body || undefined);
  });
}
const get = (path, headers = {}) => send('GET', path.startsWith('http') ? path : base + path, headers);
const post = (path, headers = {}) => send('POST', base + path, headers);

/** Sign in as `who` (OIDC claims) the way a browser does, starting from `path`. Returns { session, landed }. */
async function signIn(who, path = '/') {
  const first = await get(path, PAGE);
  assert.equal(first.status, 302, `${path} sends you to sign in`);
  const login = await get(first.headers.get('location'), PAGE);
  assert.equal(login.status, 302);
  const started = cookieOf(login, 'html_server_oidc');
  idp.st.next = who;
  const back = await fetch(login.headers.get('location'), { redirect: 'manual' }); // the provider's sign-in, then back
  const done = await get(back.headers.get('location'), { ...PAGE, 'Sec-Fetch-Site': 'cross-site', cookie: started });
  assert.equal(done.status, 302, `the callback: ${await done.clone().text()}`);
  return { session: cookieOf(done, 'html_server_session'), landed: done.headers.get('location'), done };
}

test('SSO: nothing without signing in; a browser is sent to sign in, and an API token still works', async () => {
  const page = await get('/stats?weeks=4', PAGE);
  assert.equal(page.status, 302);
  assert.equal(page.headers.get('location'), '/api/oidc/login?next=%2Fstats%3Fweeks%3D4');
  for (const path of ['/', '/api/artifacts', '/api/search?q=x', '/docs', '/about', '/gallery', '/api/me']) {
    assert.equal((await get(path)).status, 401, path); // not a browser opening a page: a 401
  }
  store.putVersion(store.userForToken(admin).id, 'note.md', Buffer.from('# Note'));
  assert.equal((await get('/pages/note.md', PAGE)).status, 302);
  const share = store.exact('note.md', store.userForToken(admin).id).share_id;
  assert.equal((await get(`/v/${share}`, PAGE)).status, 302); // share links need a sign-in too
  for (const path of ['/healthz', '/_static/style.css']) assert.equal((await get(path)).status, 200, path);
  assert.equal((await get('/api/artifacts', { Authorization: `Bearer ${admin}` })).status, 200); // the CLI, MCP and scripts
});

test('SSO: signing in, back where you started, as an account made the first time', async () => {
  const { session, landed, done } = await signIn({ sub: 'u-123', email: 'Ann.Lee@Example.com', email_verified: true, preferred_username: 'ann.lee@example.com' }, '/stats?weeks=4');
  assert.equal(landed, '/stats?weeks=4');
  assert.match(done.headers.getSetCookie().find((c) => c.startsWith('html_server_session=')), /^html_server_session=[\w-]{43}; Path=\/; Max-Age=43200; HttpOnly; SameSite=Lax$/);
  // What the provider was asked: the code flow, PKCE, this server's callback, a state and a nonce.
  const a = idp.st.authorize;
  assert.deepEqual([a.response_type, a.client_id, a.redirect_uri, a.scope, a.code_challenge_method], ['code', 'html-server', `${base}/api/oidc/callback`, 'openid profile email', 'S256']);
  assert.ok(a.state && a.nonce && a.code_challenge);
  const u = store.listUsers().find((x) => x.name === 'ann-lee');
  assert.deepEqual([u.sso, u.is_admin], [true, false]);
  // Signed in: pages, and the page tells its scripts as whom.
  const home = await get('/', { ...PAGE, cookie: session });
  assert.equal(home.status, 200);
  assert.match(await home.text(), /<body data-sso-user="ann-lee" /);
  assert.deepEqual(await (await get('/api/me', { ...OWN, cookie: session })).json(), { name: 'ann-lee', is_admin: false });
});

test('SSO: the account page makes your one API token; it works for the CLI, and stops after 30 idle days', async () => {
  const { session } = await signIn({ sub: 'u-1', email: 'ann@example.com', email_verified: true });
  const page = await (await get('/account', { ...PAGE, cookie: session })).text();
  assert.match(page, /<dt>Username<\/dt><dd>ann<\/dd>[^]*stops working if you don't sign in here for 30 days[^]*Make a new token/);
  assert.doesNotMatch(page, /<h2>Users<\/h2>/); // not an admin
  const made = await post('/api/me/token', { ...OWN, Origin: base, cookie: session });
  assert.equal(made.status, 200);
  const { token } = await made.json();
  assert.equal((await get('/api/me', { Authorization: `Bearer ${token}` })).status, 200);
  const again = (await (await post('/api/me/token', { ...OWN, Origin: base, cookie: session })).json()).token;
  assert.equal((await get('/api/me', { Authorization: `Bearer ${token}` })).status, 401); // one at a time: replaced
  // Thirty days without signing in: the token stops, and says how to fix it; signing in brings it back.
  const id = store.userForToken(again).id;
  store.run('UPDATE users SET last_sso_at = ? WHERE id = ?', Date.now() / 1000 - 31 * 86400, id);
  const stale = await get('/api/me', { Authorization: `Bearer ${again}` });
  assert.equal(stale.status, 401);
  assert.match((await stale.json()).error, /hasn't signed in for 30 days\. Sign in at http:\/\/127\.0\.0\.1:\d+\/account and it works again/);
  await signIn({ sub: 'u-1', email: 'ann@example.com', email_verified: true });
  assert.equal((await get('/api/me', { Authorization: `Bearer ${again}` })).status, 200);
  // Accounts that don't sign in through SSO (the first admin, service accounts) keep their tokens.
  assert.equal((await get('/api/me', { Authorization: `Bearer ${admin}` })).status, 200);
});

test('SSO: the session counts for this site and for opening links, never for an uploaded page, nor a change from elsewhere', async () => {
  const { session } = await signIn({ sub: 'u-1', email: 'ann@example.com' });
  const me = (headers) => get('/api/me', { cookie: session, ...headers });
  assert.equal((await me(OWN)).status, 200); // this site's own scripts
  assert.equal((await me({ ...PAGE, 'Sec-Fetch-Site': 'cross-site' })).status, 200); // a link from another site, opened
  // An uploaded page is sandboxed: its requests are cross-site, or say Origin: null.
  assert.equal((await me({ 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Dest': 'empty' })).status, 401);
  assert.equal((await me({ 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'no-cors', 'Sec-Fetch-Dest': 'image' })).status, 401);
  assert.equal((await me({ ...OWN, Origin: 'null' })).status, 401);
  assert.equal((await me({ 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'iframe' })).status, 401);
  // A change has to come from this site's pages.
  const change = (headers) => post('/api/me/token', { cookie: session, ...headers });
  assert.equal((await change({ ...OWN })).status, 401); // no Origin
  assert.equal((await change({ ...OWN, Origin: 'https://evil.example' })).status, 401);
  assert.equal((await change({ 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document', Origin: 'https://evil.example' })).status, 401); // a form posted from elsewhere
  assert.equal((await change({ ...OWN, Origin: base })).status, 200);
});

test('SSO: admins from the provider, decided once; and accounts follow the provider, not names', async () => {
  await signIn({ sub: 'boss', email: 'boss@example.com', email_verified: true }); // OIDC_ADMIN_EMAILS
  await signIn({ sub: 'r1', email: 'rita@example.com', roles: ['HtmlServer.Admin'] }); // OIDC_ADMIN_CLAIM
  await signIn({ sub: 'u2', email: 'bob@example.com', roles: ['Reader'] });
  const role = (name) => store.listUsers().find((u) => u.name === name)?.is_admin;
  assert.deepEqual([role('boss'), role('rita'), role('bob')], [true, true, false]);
  // The provider's claims changing later neither promotes nor demotes anyone.
  await signIn({ sub: 'u2', email: 'bob@example.com', roles: ['HtmlServer.Admin'] });
  await signIn({ sub: 'r1', email: 'rita@example.com', roles: [] });
  assert.deepEqual([role('rita'), role('bob')], [true, false]);
  // An admin sees the users on the account page.
  const { session } = await signIn({ sub: 'boss', email: 'boss@example.com', email_verified: true });
  const page = await (await get('/account', { ...PAGE, cookie: session })).text();
  assert.match(page, /<h2>Users<\/h2>[^]*<td>bob<\/td><td>user<\/td>[^]*<td>boss<\/td><td>admin<\/td>/);
  // Email usernames: the provider's verified email; an unverified one can't sign in.
  store.setUsernames('email');
  await signIn({ sub: 'e1', email: 'Eve@Example.com', email_verified: true });
  assert.ok(store.listUsers().some((u) => u.name === 'eve@example.com'));
  const first = await get('/', PAGE);
  const login = await get(first.headers.get('location'), PAGE);
  idp.st.next = { sub: 'e2', email: 'mallory@example.com', email_verified: false };
  const back = await fetch(login.headers.get('location'), { redirect: 'manual' });
  const refused = await get(back.headers.get('location'), { ...PAGE, cookie: cookieOf(login, 'html_server_oidc') });
  assert.equal(refused.status, 403);
  assert.match(await refused.text(), /didn&#39;t include a verified email address/);
});

test("SSO: a sign-in has to finish in the browser that started it, and comes back only to this site", async () => {
  const first = await get('/', PAGE);
  const login = await get('/api/oidc/login?next=//evil.example/x', PAGE); // an open redirect, tried
  idp.st.next = { sub: 'u-1', email: 'ann@example.com' };
  const back = await fetch(login.headers.get('location'), { redirect: 'manual' });
  const callback = back.headers.get('location');
  // Without the sign-in's cookie (someone else's browser, or a link sent to someone): refused.
  const stranger = await get(callback, PAGE);
  assert.equal(stranger.status, 400);
  assert.match(await stranger.text(), /This sign-in didn&#39;t start in this browser/);
  // With it: in, and sent to / rather than to the other site.
  const done = await get(callback, { ...PAGE, cookie: cookieOf(login, 'html_server_oidc') });
  assert.equal(done.status, 302);
  assert.equal(done.headers.get('location'), '/');
  assert.ok(first);
  // The provider said no (the person pressed Cancel): a page that says so.
  const cancelled = await get('/api/oidc/callback?error=access_denied&error_description=The+user+cancelled', PAGE);
  assert.equal(cancelled.status, 403);
  assert.match(await cancelled.text(), /The sign-in service said: The user cancelled/);
});

test('SSO: signing out ends the session here and at the provider', async () => {
  const { session } = await signIn({ sub: 'u-1', email: 'ann@example.com' });
  const out = await post('/api/oidc/logout', { ...OWN, Origin: base, cookie: session });
  assert.equal(out.status, 303);
  const to = new URL(out.headers.get('location'));
  assert.equal(`${to.origin}${to.pathname}`, `${issuer}/logout`);
  assert.deepEqual([to.searchParams.get('client_id'), to.searchParams.get('post_logout_redirect_uri')], ['html-server', `${base}/`]);
  assert.match(cookieOf(out, 'html_server_session'), /^html_server_session=$/);
  assert.equal((await get('/api/me', { ...OWN, cookie: session })).status, 401); // the session is gone, not just its cookie
});

test('SSO off: nothing changes', async () => {
  setSso({});
  assert.equal((await get('/api/artifacts')).status, 200);
  assert.equal((await get('/', PAGE)).status, 200);
  assert.match(await (await get('/account', PAGE)).text(), /Single sign-on isn&#39;t set up on this server|Single sign-on isn't set up on this server/);
  assert.equal((await get('/api/oidc/login', PAGE)).status, 404);
});
