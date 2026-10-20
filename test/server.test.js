// End-to-end API tests: a fresh database and server per test, so tests can't see
// each other's pages.   npm test   (or: node --test test/)
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { ACTIVE, PURGED, TRASHED } from '../src/lifecycle.js';
import { ROUTES, makeServer } from '../src/server.js';
import { Store } from '../src/store.js';

const BROWSER = 'Mozilla/5.0 test';
let dir, store, server, base, admin;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'artifacts-'));
  store = new Store(join(dir, 't.db'));
  admin = store.createUser('admin', true);
  server = makeServer(store);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

afterEach(async () => {
  await new Promise((r) => server.close(r));
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

/** [status, parsed JSON or text, headers] */
async function req(method, path, { body, token, ua = BROWSER, raw = false } = {}) {
  const headers = { 'User-Agent': ua };
  if (token) headers.Authorization = `Bearer ${token}`;
  const r = await fetch(base + path, { method, body, headers });
  const text = await r.text();
  return [r.status, raw || !r.headers.get('content-type')?.includes('json') ? text : JSON.parse(text), r.headers];
}
const put = (slug, html, token = admin, query = '') => req('PUT', `/api/artifacts/${slug}${query}`, { body: html, token });
const slugs = (items) => items.map((i) => i.slug);

test('versions, rendering, search and the lifecycle', async () => {
  let [s, a] = await put('trip.html', '<title>Trip Plan</title><p>shelling at low tide</p>', admin, '?note=first');
  assert.deepEqual([s, a.latest_version, a.title, a.url, a.visibility], [201, 1, 'Trip Plan', '/trip.html', 'public']);
  [s, a] = await put('trip.html', '<title>Trip Plan</title><p>uber xl every leg</p>');
  assert.deepEqual([s, a.latest_version], [200, 2]);

  let [, body, h] = await req('GET', '/trip.html'); // no token: public by default
  assert.match(body, /uber xl/);
  assert.match(h.get('content-security-policy'), /sandbox/);
  assert.match((await req('GET', '/trip'))[1], /uber xl/); // .html optional
  assert.match((await req('GET', '/trip.html?v=1'))[1], /shelling/);
  assert.match((await req('GET', '/api/artifacts/trip.html/versions/1'))[1], /shelling/);

  assert.deepEqual(slugs((await req('GET', '/api/artifacts?q=ube'))[1]), ['trip.html']); // prefix
  assert.deepEqual((await req('GET', '/api/artifacts?q=shelling'))[1], []); // latest version only
  for (const typo of ['ubr+xl', 'tirp', 'plna']) {
    assert.deepEqual(slugs((await req('GET', `/api/artifacts?q=${typo}`))[1]), ['trip.html'], typo);
  }
  assert.deepEqual((await req('GET', '/api/artifacts?q=zebra'))[1], []);
  assert.match((await req('GET', '/?q=uber'))[1], /href="\/trip.html"/);

  [s, a] = await req('DELETE', '/api/artifacts/trip.html', { token: admin });
  assert.equal(a.state, TRASHED);
  assert.equal((await req('GET', '/trip.html'))[0], 404);
  assert.equal((await put('trip.html', '<p>x</p>'))[0], 409); // trashed: no new versions
  [s, a] = await req('POST', '/api/artifacts/trip.html/restore', { token: admin });
  assert.equal(a.state, ACTIVE);
  assert.equal((await req('DELETE', '/api/artifacts/trip.html?purge=1', { token: admin }))[0], 409); // trash first
  await req('DELETE', '/api/artifacts/trip.html', { token: admin });
  [s, a] = await req('DELETE', '/api/artifacts/trip.html?purge=1', { token: admin });
  assert.deepEqual([s, a.state], [200, PURGED]);
  assert.equal((await req('GET', '/api/artifacts/trip.html', { token: admin }))[0], 404);
});

test('visibility, ownership and users', async () => {
  const [s, u] = await req('POST', '/api/users', { body: JSON.stringify({ name: 'bob' }), token: admin });
  assert.equal(s, 201);
  const other = u.token;
  await put('shared.html', '<p>everyone sees this</p>');
  const [, a] = await put('notes.html', '<p>private notes</p>', admin, '?visibility=private');

  assert.deepEqual(slugs((await req('GET', '/api/artifacts?q=everyone', { token: other }))[1]), ['shared.html']);
  assert.deepEqual((await req('GET', '/api/artifacts?q=private', { token: other }))[1], []);
  assert.equal((await req('GET', '/notes.html'))[0], 404);
  assert.equal((await req('GET', '/notes.html', { token: admin }))[0], 200);
  assert.match((await req('GET', a.share_url))[1], /private notes/);

  // names are server-wide: someone else can't take or delete yours
  assert.equal((await put('shared.html', '<p>mine</p>', other))[0], 409);
  assert.equal((await req('DELETE', '/api/artifacts/shared.html', { token: other }))[0], 403);
  assert.equal((await req('DELETE', '/api/artifacts/notes.html', { token: other }))[0], 404);
  assert.equal((await put('api', '<p>x</p>', other))[0], 400); // reserved
  const [s2, err] = await req('PUT', '/api/artifacts/?note=x', { body: '<p>x</p>', token: other }); // curl -T + query
  assert.equal(s2, 400);
  assert.match(err.error, /X-Note/);

  await req('POST', '/api/artifacts/notes.html/visibility?to=public', { token: admin });
  assert.equal((await req('GET', '/notes.html'))[0], 200);

  assert.equal((await req('POST', '/api/users', { body: '{"name":"x"}', token: other }))[0], 403);
  assert.equal((await req('GET', '/api/artifacts', { token: 'ak_wrong' }))[0], 401);
  assert.equal((await req('DELETE', '/api/users/bob', { token: admin }))[0], 200);
  assert.equal((await req('GET', '/api/me', { token: other }))[0], 401);
});

test('page views', async () => {
  const [, a] = await put('views.html', '<p>v1</p>');
  await put('views.html', '<p>v2</p>');
  await req('GET', '/views.html');
  await req('GET', '/views.html'); // same visitor, same day
  await req('GET', '/views.html?v=1', { ua: 'Mozilla/5.0 other' });
  await req('GET', a.share_url);
  await req('GET', '/views.html', { ua: 'Slackbot-LinkExpanding 1.0' }); // not counted
  await req('GET', '/views.html', { ua: 'curl/8.7' }); // not counted
  await req('GET', '/api/artifacts/views.html/versions/1'); // API reads don't count

  const [s, r] = await req('GET', '/api/artifacts/views.html/views', { token: admin });
  assert.equal(s, 200);
  assert.deepEqual([r.views, r.visitor_days], [4, 2]);
  assert.deepEqual(r.by_version, { 1: 1, 2: 3 });
  assert.deepEqual(r.by_link, { url: 3, share: 1 });
  assert.equal(r.last_30_days[0].views, 4);
  assert.equal((await req('GET', '/api/artifacts/views.html'))[1].views, 4);
  assert.match((await req('GET', '/'))[1], /4 views/);

  assert.equal((await req('GET', '/api/artifacts/views.html/views'))[0], 401); // owner only
  await req('DELETE', '/api/artifacts/views.html', { token: admin });
  await req('DELETE', '/api/artifacts/views.html?purge=1', { token: admin });
  assert.equal(store.one('SELECT COUNT(*) AS n FROM views').n, 0); // purge takes its views with it
});

test('diff and restoring a version', async () => {
  await put('plan.html', '<h1>Plan</h1><p>Rental car</p><p>Beach day</p>');
  await put('plan.html', '<h1>Plan</h1><p>Uber XL</p><p>Beach day</p>');
  let [, d] = await req('GET', '/api/artifacts/plan.html/diff'); // default: v1 -> v2, visible text
  assert.match(d, /-Rental car\n\+Uber XL/);
  assert.doesNotMatch(d, /<p>/);
  assert.match((await req('GET', '/api/artifacts/plan.html/diff?of=source'))[1], /<p>Uber XL<\/p>/);
  let h;
  [, d, h] = await req('GET', '/review/plan.html/changes?from=1&to=2');
  assert.match(d, /<table/);
  assert.match(d, /Uber XL/);
  assert.match(h.get('content-security-policy'), /sandbox/);

  const [s, a] = await req('POST', '/api/artifacts/plan.html/versions/1/restore', { token: admin });
  assert.deepEqual([s, a.latest_version, a.versions.at(-1).note, a.versions.length], [200, 3, 'restored from v1', 3]);
  assert.match((await req('GET', '/plan.html'))[1], /Rental car/);
  assert.equal((await req('GET', '/api/artifacts/plan.html/diff?from=1&to=3'))[1], ''); // identical
  assert.match((await req('GET', '/review/plan.html/changes?from=1&to=3'))[1], /No differences/);
  assert.equal((await req('POST', '/api/artifacts/plan.html/versions/9/restore', { token: admin }))[0], 404);
});

test('comments', async () => {
  const reviewer = (await req('POST', '/api/users', { body: JSON.stringify({ name: 'reviewer' }), token: admin }))[1].token;
  const stranger = (await req('POST', '/api/users', { body: JSON.stringify({ name: 'stranger' }), token: admin }))[1].token;
  await put('handout.html', '<p>draft</p>');
  await put('handout.html', '<p>draft 2</p>');
  const post = (body, token) => req('POST', '/api/artifacts/handout.html/comments', { body: JSON.stringify(body), token });

  const [s, c] = await post({ body: 'Soften the second point', version: 1 }, reviewer);
  assert.deepEqual([s, c.version, c.author], [201, 1, 'reviewer']);
  const [, r] = await post({ body: 'Done in v2', parent: c.id, version: 2 }, admin);
  assert.deepEqual([r.parent, r.version], [c.id, 1]); // replies stay on the parent's version
  assert.equal((await post({ body: 'x', parent: r.id }, admin))[0], 400); // one level of replies
  assert.equal((await post({ body: '  ' }, reviewer))[0], 400);
  assert.equal((await post({ body: 'anon' }))[0], 401);

  const [, cs] = await req('GET', '/api/artifacts/handout.html/comments?version=1'); // public page: anyone reads
  assert.deepEqual(cs.map((x) => x.body), ['Soften the second point', 'Done in v2']);
  assert.deepEqual((await req('GET', '/api/artifacts/handout.html/comments?version=2'))[1], []);

  assert.ok((await req('POST', `/api/comments/${c.id}/resolve`, { token: admin }))[1].resolved_at); // page owner
  assert.equal((await req('POST', `/api/comments/${c.id}/resolve?undo=1`, { token: reviewer }))[1].resolved_at, null); // author
  assert.equal((await req('DELETE', `/api/comments/${c.id}`, { token: stranger }))[0], 403);
  assert.equal((await req('DELETE', `/api/comments/${c.id}`, { token: reviewer }))[0], 200);
  assert.deepEqual((await req('GET', '/api/artifacts/handout.html/comments'))[1], []); // reply went with it

  const [s2, page] = await req('GET', '/review/handout.html');
  assert.equal(s2, 200);
  assert.match(page, /data-slug="handout.html"/);
});

test('gallery: description, category, filtering and live-search fragments', async () => {
  const doc = (title, cat, desc) =>
    `<title>${title}</title><meta name="description" content="${desc}"><meta name="category" content="${cat}"><p>${title}</p>`;
  await put('kmeans.html', doc('K-means step through', 'machine-learning', 'Watch clusters settle.'));
  await put('anscombe.html', doc('Anscombe quartet', 'data-science', 'Same stats, different data.'));
  await put('plain.html', '<p>no metadata</p>');

  const [, a] = await req('GET', '/api/artifacts/kmeans.html');
  assert.deepEqual([a.category, a.description], ['machine-learning', 'Watch clusters settle.']);
  assert.deepEqual(slugs((await req('GET', '/api/artifacts?category=data-science'))[1]), ['anscombe.html']);
  assert.deepEqual((await req('GET', '/api/categories'))[1],
    [{ category: 'data-science', count: 1 }, { category: 'machine-learning', count: 1 }]);

  const [, page] = await req('GET', '/');
  assert.match(page, /Machine learning <span>1<\/span>/);
  assert.match(page, /Watch clusters settle\./);
  const [, filtered] = await req('GET', '/?category=machine-learning');
  assert.match(filtered, /K-means/);
  assert.doesNotMatch(filtered, /Anscombe/);
  assert.match(page, /id="results" class="grid"/);
  const [, listPage] = await req('GET', '/?view=list&category=data-science');
  assert.match(listPage, /id="results" class="list"/);
  assert.match(listPage, /href="\/\?category=machine-learning&amp;view=list"/); // chips keep the layout
  assert.match(listPage, /data-view="grid" href="\/\?category=data-science"/); // grid is the implicit default
  assert.match((await req('GET', '/?view=bogus'))[1], /id="results" class="grid"/);
  const [, frag] = await req('GET', '/?q=clustrs&fragment=1'); // typo, fragment only
  assert.match(frag, /K-means/);
  assert.doesNotMatch(frag, /<html/);
});

test('docs page lists every documented route; static files', async () => {
  const [s, page, h] = await req('GET', '/api');
  assert.equal(s, 200);
  assert.match(page, /\/api\/artifacts\/&lt;slug&gt;\/restore/);
  assert.equal(page.match(/<tr>/g).length, ROUTES.filter((r) => r.doc).length);
  assert.equal(h.get('content-security-policy'), null); // our page, not a sandboxed artifact
  assert.equal((await req('GET', '/_static/review.js'))[0], 200);
  assert.equal((await req('GET', '/_static/..%2Fsrc%2Fconfig.js'))[0], 404); // no path traversal
});

test('table of contents is added at render time only, for pages with headings', async () => {
  const long = '<title>Guide</title><body><h2>One</h2><p>a</p><h2>Two</h2><h3>Two A</h3><p>b</p></body>';
  const [, a] = await put('guide.html', long);
  await put('short.html', '<h2>Only</h2><h2>Two</h2>');
  await put('optout.html', `<meta name="toc" content="off">${long}`);
  const toc = /data-artifact-toc-script/;

  const [, page] = await req('GET', '/guide.html');
  assert.match(page, toc);
  assert.ok(page.indexOf('data-artifact-toc-script') < page.lastIndexOf('</body>')); // inside the body
  assert.match((await req('GET', a.share_url))[1], toc);
  assert.doesNotMatch((await req('GET', '/guide.html?toc=0'))[1], toc);
  assert.doesNotMatch((await req('GET', '/short.html'))[1], toc); // fewer than 3 headings
  assert.doesNotMatch((await req('GET', '/optout.html'))[1], toc);
  // Stored versions, raw source and diffs never contain it.
  assert.equal((await req('GET', '/api/artifacts/guide.html/versions/1'))[1], long);
  await put('guide.html', long.replace('Two A', 'Two B'));
  assert.doesNotMatch((await req('GET', '/api/artifacts/guide.html/diff'))[1], /toc/i);
});

test('token reset: admin resets a lost token, users rotate their own, pages survive', async () => {
  const bob = (await req('POST', '/api/users', { body: JSON.stringify({ name: 'bob' }), token: admin }))[1].token;
  await put('bobs.html', '<p>bob wrote this</p>', bob);

  assert.equal((await req('POST', '/api/users/bob/token', { token: bob }))[0], 403); // admins only
  const [s, r] = await req('POST', '/api/users/bob/token', { token: admin });
  assert.equal(s, 200);
  assert.equal((await req('GET', '/api/me', { token: bob }))[0], 401); // old token dead
  assert.equal((await req('GET', '/api/me', { token: r.token }))[1].name, 'bob');
  assert.equal((await put('bobs.html', '<p>v2</p>', r.token))[1].latest_version, 2); // still owns the page

  const [, own] = await req('POST', '/api/me/token', { token: r.token });
  assert.equal((await req('GET', '/api/me', { token: r.token }))[0], 401);
  assert.equal((await req('GET', '/api/me', { token: own.token }))[1].name, 'bob');
  assert.equal((await req('POST', '/api/users/nobody/token', { token: admin }))[0], 404);
  assert.equal(store.resetToken('admin').length, 46); // the CLI path, for a lost admin token
});

test('email usernames: a per-deployment setting, masked for anonymous visitors', async () => {
  assert.equal((await req('POST', '/api/users', { body: '{"name":"bob@example.com"}', token: admin }))[0], 400); // default: handles
  store.setUsernames('email'); // what `node src/server.js config usernames email` does
  assert.equal(store.usernames, 'email');
  assert.equal((await req('POST', '/api/users', { body: '{"name":"bob"}', token: admin }))[0], 400);
  const [s, u] = await req('POST', '/api/users', { body: '{"name":" Bob@Example.com "}', token: admin });
  assert.deepEqual([s, u.name], [201, 'bob@example.com']); // trimmed and lowercased

  await put('bobs.html', '<p>hello</p>', u.token);
  await req('POST', '/api/artifacts/bobs.html/comments', { body: '{"body":"nice"}', token: u.token });
  // Anonymous: masked everywhere a name shows.
  assert.equal((await req('GET', '/api/artifacts/bobs.html'))[1].owner, 'bob@…');
  assert.equal((await req('GET', '/api/artifacts/bobs.html/comments'))[1][0].author, 'bob@…');
  const [, page] = await req('GET', '/');
  assert.match(page, /bob@…/);
  assert.doesNotMatch(page, /example\.com/);
  // Signed in: full address. Routes accept addresses, any case.
  assert.equal((await req('GET', '/api/artifacts/bobs.html', { token: admin }))[1].owner, 'bob@example.com');
  assert.equal((await req('GET', '/api/artifacts?owner=BOB@example.com', { token: admin }))[1].length, 1);
  assert.equal((await req('POST', '/api/users/Bob@Example.com/token', { token: admin }))[0], 200);
  assert.equal((await req('DELETE', '/api/users/bob@example.com', { token: admin }))[0], 200);
  assert.throws(() => store.setUsernames('phone'), /usernames must be one of/);
});
