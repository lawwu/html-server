// Claim links with GitHub sign-in: only the link's GitHub account gets the token. GitHub is
// played by a small fake (authorize, token exchange, /user, /user/emails, token revocation),
// so nothing leaves this machine.   node --test test/github-signin.test.js
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { setGitHubSignIn } from '../src/config.js';
import { makeServer } from '../src/server.js';
import { testDatabase } from './fixture.js';

let dir, db, store, server, base, admin, github, gh;

// The fake GitHub: whoever "signs in" next, and what it was asked.
function fakeGitHub() {
  const state = { next: null, exchanged: [], revoked: [], failExchange: false };
  const srv = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const json = (status, obj) => res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(obj));
    const url = new URL(req.url, 'http://x');
    if (req.method === 'POST' && url.pathname === '/login/oauth/access_token') {
      const b = JSON.parse(body);
      state.exchanged.push(b);
      if (state.failExchange || b.client_secret !== 'shh' || !state.next) return json(200, { error: 'bad_verification_code' });
      return json(200, { access_token: `gho_${b.code}`, token_type: 'bearer' });
    }
    if (req.method === 'DELETE' && url.pathname === '/applications/app-id/token') { // the app itself, by its ID and secret
      if (req.headers.authorization !== `Basic ${Buffer.from('app-id:shh').toString('base64')}`) return json(401, { message: 'Bad credentials' });
      state.revoked.push(JSON.parse(body).access_token);
      return res.writeHead(204).end();
    }
    const who = state.next;
    if (req.headers.authorization !== `Bearer gho_${who?.code}`) return json(401, { message: 'Bad credentials' });
    if (url.pathname === '/user') return json(200, { login: who.login, id: who.id });
    if (url.pathname === '/user/emails') return json(200, who.emails);
    json(404, {});
  });
  return { srv, state };
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'artifacts-'));
  db = await testDatabase(dir);
  store = db.open();
  admin = store.createUser('admin', true);
  github = fakeGitHub();
  await new Promise((r) => github.srv.listen(0, '127.0.0.1', r));
  gh = `http://127.0.0.1:${github.srv.address().port}`;
  setGitHubSignIn({ GITHUB_CLIENT_ID: 'app-id', GITHUB_CLIENT_SECRET: 'shh', GITHUB_URL: gh, GITHUB_API_URL: gh });
  server = makeServer(store);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

afterEach(async () => {
  setGitHubSignIn({});
  await new Promise((r) => server.close(r));
  await new Promise((r) => github.srv.close(r));
  await store.close();
  await db.drop();
  rmSync(dir, { recursive: true, force: true });
});

const link = async (login, token = admin) => (await fetch(`${base}/api/users/${login}/claim`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } })).json();

/**
 * Open the link and sign in to GitHub as `who` ({ login, id, emails }), the way a browser
 * does: the button, GitHub's page (skipped: the fake signs `who` straight in), the way back.
 * Returns [status, page, { authorize, cookie }].
 */
async function claimAs(path, who, { cookie: useCookie = true } = {}) {
  const start = await fetch(base + path, { method: 'POST', redirect: 'manual' });
  assert.equal(start.status, 303);
  const authorize = new URL(start.headers.get('location'));
  const cookie = start.headers.get('set-cookie');
  const code = `c${Math.random().toString(36).slice(2)}`;
  github.state.next = { ...who, code };
  const back = await fetch(`${base}/api/claim/callback?code=${code}&state=${authorize.searchParams.get('state')}`,
    { headers: useCookie ? { cookie: cookie.split(';')[0] } : {} });
  return [back.status, await back.text(), { authorize, cookie, headers: back.headers }];
}
const tokenIn = (page) => page.match(/id="claim-token" readonly value="(ak_[\w-]+)"/)?.[1];
const me = async (token) => (await fetch(`${base}/api/me`, { headers: { Authorization: `Bearer ${token}` } })).status;
const OCTO = { login: 'Octo-Cat', id: 583231, emails: [{ email: 'octo@personal.example', primary: true, verified: true }, { email: 'Octo@Company.com', primary: false, verified: true }] };

test('GitHub sign-in: the link is for a GitHub account, and only it gets the token', async () => {
  const l = await link('Octo-Cat');
  assert.deepEqual(Object.keys(l).sort(), ['claim_path', 'claim_url', 'expires_at', 'github_login', 'sign_in']);
  assert.deepEqual([l.github_login, l.sign_in], ['octo-cat', 'github']);
  assert.deepEqual(store.listUsers().map((u) => u.name), ['admin']); // no account until someone signs in

  // The page asks for GitHub, and shows nothing yet.
  const page = await (await fetch(base + l.claim_path)).text();
  assert.match(page, /This link is for the GitHub account <strong>octo-cat<\/strong>[^]*<button type="submit" class="primary">Continue with GitHub<\/button>/);

  // Someone else signs in: refused, and the link stays good for its owner.
  const [s1, wrong] = await claimAs(l.claim_path, { login: 'mallory', id: 666, emails: [] });
  assert.equal(s1, 403);
  assert.match(wrong, /This link isn&#39;t for you[^]*for the GitHub account octo-cat, and you signed in to GitHub as mallory/);
  assert.equal(tokenIn(wrong), undefined);
  assert.equal((await fetch(base + l.claim_path)).status, 200);

  // The owner: sent to GitHub with this app, this callback, the email scope and a state; back, the token.
  const [s2, mine, { authorize, cookie, headers }] = await claimAs(l.claim_path, OCTO);
  assert.equal(`${authorize.origin}${authorize.pathname}`, `${gh}/login/oauth/authorize`);
  assert.deepEqual(Object.fromEntries([...authorize.searchParams].filter(([k]) => k !== 'state')),
    { client_id: 'app-id', redirect_uri: `${base}/api/claim/callback`, scope: 'user:email', login: 'octo-cat', allow_signup: 'false' });
  assert.match(authorize.searchParams.get('state'), /^[\w-]{43}$/);
  assert.match(cookie, /^html_server_claim=[\w-]{43}; Path=\/api\/claim; Max-Age=900; HttpOnly; SameSite=Lax$/);
  assert.equal(s2, 200);
  assert.match(mine, /Your token, octo-cat<\/h1>[^]*Your account is new/);
  assert.equal(await me(tokenIn(mine)), 200);
  assert.equal(headers.get('cache-control'), 'no-store');
  assert.match(headers.get('set-cookie'), /^html_server_claim=; .*Max-Age=0/); // the sign-in cookie is cleared
  assert.deepEqual(store.listUsers().find((u) => u.name === 'octo-cat'), { ...store.listUsers().find((u) => u.name === 'octo-cat'), github_id: 583231 });
  assert.equal(github.state.exchanged.at(-1).redirect_uri, `${base}/api/claim/callback`); // the secret only ever went to GitHub
  // GitHub's token from each sign-in, mallory's included, is revoked straight after: nothing of it is kept.
  assert.equal(github.state.revoked.length, 2);
  assert.equal(github.state.revoked.at(-1), `gho_${github.state.next.code}`);

  // Used: gone, whichever way it's tried again.
  assert.equal((await fetch(base + l.claim_path)).status, 410);
  assert.equal((await fetch(base + l.claim_path, { method: 'POST', redirect: 'manual' })).status, 410);
});

test('GitHub sign-in: the way back must be in the browser that left, and GitHub must answer', async () => {
  const l = await link('octo-cat');
  const [s1, page] = await claimAs(l.claim_path, OCTO, { cookie: false }); // e.g. a link to the callback sent to someone (login CSRF)
  assert.equal(s1, 400);
  assert.match(page, /This sign-in didn&#39;t start in this browser/);
  github.state.failExchange = true;
  const [s2, page2] = await claimAs(l.claim_path, OCTO);
  assert.equal(s2, 502);
  assert.match(page2, /Couldn&#39;t check who you are with GitHub/);
  github.state.failExchange = false;
  assert.equal((await fetch(`${base}/api/claim/callback?error=access_denied&state=x`)).status, 403); // pressed Cancel at GitHub
  const [s3, page3] = await claimAs(l.claim_path, OCTO); // still good after all that
  assert.equal(s3, 200);
  assert.ok(tokenIn(page3));
});

test('GitHub sign-in: one account per GitHub account, found by its id however its login changes', async () => {
  const [, first] = await claimAs((await link('octo-cat')).claim_path, OCTO);
  const t1 = tokenIn(first);
  // Renamed on GitHub: the same account here (name mode keeps its name), and the old token is replaced.
  const [, again] = await claimAs((await link('octo-renamed')).claim_path, { ...OCTO, login: 'octo-renamed' });
  assert.match(again, /Your token, octo-cat<\/h1>/);
  assert.doesNotMatch(again, /Your account is new/);
  assert.equal(await me(t1), 401);
  assert.equal(await me(tokenIn(again)), 200);
  assert.deepEqual(store.listUsers().map((u) => u.name), ['admin', 'octo-cat']);

  // An account made before, by name and not yet tied to GitHub, is taken over by its GitHub account...
  store.createUser('dana');
  const [, dana] = await claimAs((await link('dana')).claim_path, { login: 'dana', id: 7, emails: [] });
  assert.equal(store.listUsers().find((u) => u.name === 'dana').github_id, 7);
  assert.ok(tokenIn(dana));
  // ...but not an admin's, and not one tied to another GitHub account.
  store.createUser('ops', true);
  const [s, ops] = await claimAs((await link('ops')).claim_path, { login: 'ops', id: 8, emails: [] });
  assert.equal(s, 409);
  assert.match(ops, /ops is an admin account, which a claim link can&#39;t take over/);
});

test('GitHub sign-in on an email server: the verified email at an allowed domain, followed when it changes', async () => {
  store.setUsernames('email');
  store.setEmailDomains('company.com');
  // The primary (personal) address isn't allowed; the verified company one is used.
  const [, first] = await claimAs((await link('octo-cat')).claim_path, OCTO);
  assert.match(first, /Your token, octo@company\.com<\/h1>/);
  const t1 = tokenIn(first);
  // GitHub's company email changes: the account follows, keeping its pages.
  const owner = store.userForToken(t1).id;
  store.putVersion(owner, 'kept.md', Buffer.from('# Kept'));
  const moved = { ...OCTO, emails: [{ email: 'octavia@company.com', primary: true, verified: true }] };
  const [, renamed] = await claimAs((await link('octo-cat')).claim_path, moved);
  assert.match(renamed, /Your token, octavia@company\.com<\/h1>[^]*Your account was <strong>octo@company\.com<\/strong>; it's now <strong>octavia@company\.com<\/strong>/);
  assert.equal(store.exact('kept.md', owner).owner, 'octavia@company.com');
  assert.deepEqual(store.listUsers().map((u) => u.name), ['admin', 'octavia@company.com']);
  // No verified address at the domain: refused, nothing made.
  const outsider = { login: 'stranger', id: 99, emails: [{ email: 'me@else.org', primary: true, verified: true }, { email: 'x@company.com', primary: false, verified: false }] };
  const [s, page] = await claimAs((await link('stranger')).claim_path, outsider);
  assert.equal(s, 403);
  assert.match(page, /no verified email at company\.com/);
  // An address someone else already holds: refused, not merged.
  store.createUser('taken@company.com');
  const [s2, page2] = await claimAs((await link('octo-cat')).claim_path, { ...OCTO, emails: [{ email: 'taken@company.com', primary: true, verified: true }] });
  assert.equal(s2, 409);
  assert.match(page2, /taken@company\.com already belongs to another account here/);
  // The domain rule holds for admins making users too.
  assert.equal((await fetch(`${base}/api/users`, { method: 'POST', headers: { Authorization: `Bearer ${admin}` }, body: '{"name":"eve@gmail.com"}' })).status, 400);
});

test('GitHub sign-in: a claims-only token never reaches an admin, even one tied to GitHub', async () => {
  const bot = store.createUser('ci-bot', false, { claimsOnly: true });
  store.createUser('boss', true, { githubId: 42 });
  const l = await link('the-boss', bot); // the link names a GitHub login; who it is shows only at sign-in
  const [s, page] = await claimAs(l.claim_path, { login: 'the-boss', id: 42, emails: [] });
  assert.equal(s, 403);
  assert.match(page, /Your token can&#39;t be made[^]*a claims-only token can&#39;t make links for &#39;boss&#39;/);
  assert.equal((await fetch(`${base}/api/users/not_a_login/claim`, { method: 'POST', headers: { Authorization: `Bearer ${bot}` } })).status, 400);
});
