// End-to-end API tests: a fresh database and server per test, so tests can't see
// each other's pages.   npm test   (or: node --test test/)
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
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
  assert.deepEqual([s, a.latest_version, a.title, a.url, a.visibility], [201, 1, 'Trip Plan', '/pages/trip.html', 'public']);
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
  assert.match((await req('GET', '/?q=uber'))[1], /href="\/pages\/trip.html"/);

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

test('legacy /pages/{slug} URLs: new uploads, with or without .html', async () => {
  const doc = '<title>Showstopper timeline</title><h1>Showstopper timeline</h1><p>v1</p>';
  const [s, a] = await put('showstopper-timeline.html', doc);
  assert.equal(s, 201);
  assert.equal(a.url, '/pages/showstopper-timeline.html'); // canonical URL is under /pages/

  for (const path of ['/pages/showstopper-timeline', '/pages/showstopper-timeline.html', '/showstopper-timeline']) {
    const [code, body, h] = await req('GET', path);
    assert.equal(code, 200, path);
    assert.match(body, /Showstopper timeline/, path);
    assert.match(h.get('content-security-policy'), /sandbox/, path); // same sandbox as every page
  }
  // A page stored without an extension resolves exactly (and isn't confused with a .html one).
  await put('roadmap', '<p>no extension</p>');
  assert.match((await req('GET', '/pages/roadmap'))[1], /no extension/);
  assert.equal((await req('GET', '/pages/roadmap.html'))[0], 404);

  // Versions, views and visibility behave the same at the legacy path.
  await put('showstopper-timeline.html', doc.replace('v1', 'v2'));
  assert.match((await req('GET', '/pages/showstopper-timeline?v=1'))[1], /v1/);
  assert.match((await req('GET', '/pages/showstopper-timeline'))[1], /v2/);
  assert.equal((await req('GET', '/api/artifacts/showstopper-timeline.html/views', { token: admin }))[1].views, 5); // 3 paths + ?v=1 + latest
  await put('secret.html', '<p>x</p>', admin, '?visibility=private');
  assert.equal((await req('GET', '/pages/secret'))[0], 404);
  assert.equal((await req('GET', '/pages/secret', { token: admin }))[0], 200);
  await req('DELETE', '/api/artifacts/showstopper-timeline.html', { token: admin });
  assert.equal((await req('GET', '/pages/showstopper-timeline'))[0], 404); // trashed
  assert.equal((await req('GET', '/pages/nope'))[0], 404);
  assert.equal((await req('GET', '/pages/'))[0], 404);
  assert.equal((await put('pages', '<p>x</p>'))[0], 400); // reserved name

  // The gallery and the review page link to the /pages/ form.
  assert.match((await req('GET', '/'))[1], /href="\/pages\/roadmap"/);
  assert.match((await req('GET', '/_static/review.js'))[1], /\/pages\/\$\{S\}/);
});

test('open editing: others add versions to public pages; the owner keeps control', async () => {
  const bob = (await req('POST', '/api/users', { body: '{"name":"bob"}', token: admin }))[1].token;
  await put('plan.html', '<p>v1 by admin</p>');
  await put('mine.html', '<p>private</p>', admin, '?visibility=private');

  assert.equal((await put('plan.html', '<p>bob</p>', bob))[0], 409); // default: owner-only
  store.setEditing('open'); // what `html-server config editing open` does

  let [s, a] = await put('plan.html', '<p>v2 by bob</p>', bob, '?note=tightened');
  assert.deepEqual([s, a.latest_version, a.owner], [200, 2, 'admin']); // still admin's page
  assert.deepEqual(a.versions.map((v) => v.author), ['admin', 'bob']);
  assert.equal(a.can_edit, true);
  assert.equal((await req('GET', '/api/artifacts/plan.html'))[1].can_edit, false); // anonymous

  // Bob can restore an old version; it is credited to him.
  [s, a] = await req('POST', '/api/artifacts/plan.html/versions/1/restore', { token: bob });
  assert.deepEqual([a.latest_version, a.versions.at(-1).author, a.versions.at(-1).note], [3, 'bob', 'restored from v1']);

  // Only the owner trashes, deletes or changes visibility; private pages stay off-limits.
  assert.equal((await req('DELETE', '/api/artifacts/plan.html', { token: bob }))[0], 403);
  assert.equal((await req('POST', '/api/artifacts/plan.html/visibility?to=private', { token: bob }))[0], 403);
  assert.equal((await put('plan.html', '<p>x</p>', bob, '?visibility=private'))[0], 403);
  assert.equal((await put('mine.html', '<p>x</p>', bob))[0], 409);
  await req('DELETE', '/api/artifacts/plan.html', { token: admin });
  assert.equal((await put('plan.html', '<p>x</p>', bob))[0], 409); // trashed: nobody adds versions
});

test('base guard: an upload started from an old version is refused', async () => {
  await put('doc.html', '<p>1</p>');
  await put('doc.html', '<p>2</p>');
  const [s, e] = await put('doc.html', '<p>3</p>', admin, '?base=1');
  assert.equal(s, 409);
  assert.match(e.error, /at v2 now, but you started from v1/);
  assert.equal((await put('doc.html', '<p>3</p>', admin, '?base=2'))[1].latest_version, 3);
  const r = await fetch(`${base}/api/artifacts/doc.html`, { method: 'PUT', body: '<p>4</p>',
    headers: { Authorization: `Bearer ${admin}`, 'X-Base': '2' } });
  assert.equal(r.status, 409); // the header form works too
});

test('older databases: existing versions are credited to the page owner', async () => {
  await put('old.html', '<p>before authors existed</p>');
  store.db.exec('ALTER TABLE versions DROP COLUMN author_id'); // what a 0.2.0 database looks like
  store.close();
  store = new Store(join(dir, 't.db'));
  server.close();
  server = makeServer(store);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  assert.deepEqual((await req('GET', '/api/artifacts/old.html'))[1].versions.map((v) => v.author), ['admin']);
});

test('history page: every version, view links, and compare any two', async () => {
  await put('guide.html', '<title>Guide</title><p>one</p>', admin, '?note=first');
  await put('guide.html', '<title>Guide</title><p>two</p>', admin, '?note=second');
  await put('guide.html', '<title>Guide</title><p>three</p>');
  const [s, page] = await req('GET', '/history/guide');
  assert.equal(s, 200);
  assert.match(page, /3 versions/);
  assert.match(page, /href="\/pages\/guide.html\?v=1">v1<\/a>/);
  assert.match(page, /v3<\/a> <span class="cur">current<\/span>/);
  assert.match(page, /href="\/review\/guide.html\/changes\?from=2&amp;to=3&amp;back=1">changes/);
  assert.match((await req('GET', '/review/guide/changes?from=2&to=3&back=1'))[1], /href="\/history\/guide" target="_top">← History/);
  assert.doesNotMatch((await req('GET', '/review/guide/changes?from=2&to=3'))[1], /← History/); // framed in review: no link
  assert.match(page, /<td>second<\/td>/);
  assert.match(page, /<select name="from"[^>]*>.*<option value="2" selected>/s); // compare defaults: previous vs latest
  assert.match((await req('GET', '/review/guide/changes?from=1&to=3'))[1], /one/); // what the compare form opens
  assert.match((await req('GET', '/'))[1], /href="\/history\/guide.html">history/);
  await put('hidden.html', '<p>x</p>', admin, '?visibility=private');
  assert.equal((await req('GET', '/history/hidden'))[0], 404);
  assert.equal((await req('GET', '/history/hidden', { token: admin }))[0], 200);
});

test('search ranks title matches first, then file names, then body text', async () => {
  await put('notes.html', '<title>Misc notes</title><p>budget budget budget budget budget planning</p>');
  await put('plan.html', '<title>Family budget</title><p>see the spreadsheet</p>');
  await put('household-budget.html', '<title>House</title><p>numbers</p>');
  const order = async (q) => slugs((await req('GET', `/api/artifacts?q=${q}`))[1]);
  assert.deepEqual(await order('budget'), ['plan.html', 'household-budget.html', 'notes.html']);
  assert.deepEqual((await order('family budget'))[0], 'plan.html'); // whole query in the title
  assert.deepEqual(await order('household'), ['household-budget.html']); // file name is searchable
  assert.deepEqual((await order('budgt'))[0], 'plan.html'); // typos still work, same ranking
});

test('an older search index is rebuilt on startup, keeping every page findable', async () => {
  await put('old.html', '<title>Lighthouse keeper</title><p>fog horn</p>');
  // Put back the 0.3.0 layout (title, body) and its version marker, as an old database has.
  store.db.exec("DROP TABLE artifacts_vocab; DROP TABLE artifacts_fts; CREATE VIRTUAL TABLE artifacts_fts USING fts5(title, body);"
    + " CREATE VIRTUAL TABLE artifacts_vocab USING fts5vocab(artifacts_fts, 'row'); DELETE FROM meta WHERE key = 'search_index'");
  store.close();
  store = new Store(join(dir, 't.db'));
  server.close();
  server = makeServer(store);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  assert.deepEqual(slugs((await req('GET', '/api/artifacts?q=lighthouse'))[1]), ['old.html']);
  assert.deepEqual(slugs((await req('GET', '/api/artifacts?q=horn'))[1]), ['old.html']);
  assert.equal(store.setting('search_index'), '2');
});

test('site header, title and search box', async () => {
  const [, page] = await req('GET', '/');
  assert.match(page, /<title>HTML Server<\/title>/);
  assert.match(page, /<a class="brand" href="\/">HTML Server<\/a>/);
  assert.match(page, /<a href="\/gallery">Gallery<\/a>/);
  assert.match(page, /placeholder="Search pages"/);
  assert.doesNotMatch(page, /typos are fine/);
  assert.match((await req('GET', '/api'))[1], /<a href="\/api" class="on"/);
});

test('/gallery: the bundled example pages, filterable and searchable', async () => {
  const [s, page] = await req('GET', '/gallery');
  assert.equal(s, 200);
  assert.match(page, /<title>Gallery · HTML Server<\/title>/);
  assert.equal(page.match(/<article class="card">/g).length, 13);
  assert.match(page, /Machine learning <span>2<\/span>/);
  assert.match(page, /href="\/gallery\/kmeans-step-through.html"/);
  assert.match(page, /data-base="\/gallery"/);
  const [, ml] = await req('GET', '/gallery?category=machine-learning');
  assert.equal(ml.match(/<article class="card">/g).length, 2);
  const [, frag] = await req('GET', '/gallery?q=kmeans&fragment=1');
  assert.equal(frag.match(/<article class="card">/g).length, 1);
  assert.doesNotMatch(frag, /<html/);

  const [s2, ex, h] = await req('GET', '/gallery/kmeans-step-through.html');
  assert.equal(s2, 200);
  assert.match(ex, /k-means/);
  assert.match(h.get('content-security-policy'), /sandbox/);
  assert.equal((await req('GET', '/gallery/nope.html'))[0], 404);
  assert.equal((await req('GET', '/gallery/..%2Fpackage.json'))[0], 404);
  assert.deepEqual((await req('GET', '/'))[1].match(/kmeans/), null); // examples aren't your pages
  assert.equal((await put('gallery', '<p>x</p>'))[0], 400); // reserved
});

test('card previews load the page without counting a view or drawing extras', async () => {
  const long = '<title>Long</title><h2>A</h2><h2>B</h2><h2>C</h2>';
  await put('long.html', long);
  await put('long.html', long + '<p>v2</p>');
  assert.match((await req('GET', '/'))[1], /<iframe src="\/pages\/long.html\?preview=1" loading="lazy"/);
  const [, prev, h] = await req('GET', '/pages/long.html?preview=1&v=1');
  assert.doesNotMatch(prev, /data-artifact-toc-script|data-artifact-version-badge/);
  assert.match(h.get('content-security-policy'), /sandbox/);
  assert.equal((await req('GET', '/api/artifacts/long.html/views', { token: admin }))[1].views, 0);
  assert.doesNotMatch((await req('GET', '/gallery/kmeans-step-through.html?preview=1'))[1], /data-artifact-toc-script/);
});

test('an old version carries a badge linking to the current version and history', async () => {
  const [, a] = await put('memo.html', '<p>one</p>');
  await put('memo.html', '<p>two</p>');
  const [, old] = await req('GET', '/pages/memo?v=1');
  assert.match(old, /data-artifact-version-badge data-n="1" data-latest="2" data-current="\/pages\/memo.html" data-history="\/history\/memo.html"/);
  assert.doesNotMatch((await req('GET', '/pages/memo'))[1], /data-artifact-version-badge/); // current: no badge
  assert.doesNotMatch((await req('GET', '/pages/memo?v=2'))[1], /data-artifact-version-badge/);
  const [, shared] = await req('GET', `${a.share_url}?v=1`);
  assert.match(shared, /data-artifact-version-badge data-n="1" data-latest="2" data-current="\/v\/[\w-]+"/);
  assert.doesNotMatch(shared, /data-history/); // share links may be private: no history link
});

test('footer and docs link to the GitHub release that is running; uploaded pages get neither', async () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const release = `https://github.com/lawwu/html-server/releases/tag/v${pkg.version}`;
  for (const path of ['/', '/gallery', '/api', '/review/x']) {
    const [, page] = await req('GET', path);
    assert.match(page, new RegExp(`<footer class="site-foot"><a href="${release}">HTML Server v${pkg.version.replace(/\./g, '\\.')}</a>`), path);
    assert.match(page, /<a href="https:\/\/github.com\/lawwu\/html-server">Source on GitHub<\/a>/, path);
  }
  const [, docs] = await req('GET', '/api');
  assert.match(docs, new RegExp(`running <a href="${release}">`));
  assert.match(docs, /npm install -g github:lawwu\/html-server#v/);
  await put('mine.html', '<p>my page</p>');
  assert.doesNotMatch((await req('GET', '/pages/mine'))[1], /site-foot|github\.com/);
  assert.doesNotMatch((await req('GET', '/gallery/kmeans-step-through.html'))[1], /site-foot/);
});

test('cards put the category chip beside the title', async () => {
  await put('c.html', '<title>Chart</title><meta name="category" content="data-viz">');
  assert.match((await req('GET', '/'))[1],
    /<div class="head"><h2><a href="\/pages\/c.html">Chart<\/a><\/h2>\s*<a class="tag" href="\/\?category=data-viz">Data visualization<\/a><\/div>/);
});

test('graph: pages and the links between them, visibility-aware, local or global', async () => {
  await put('a.html', '<title>A</title><a href="/pages/b.html">b</a> <a href="c">c</a> <a href="missing.html">x</a>');
  await put('b.html', '<title>B</title><a href="a.html">back to a</a>');
  await put('c.html', '<title>C</title><a href="/d">d</a>');
  await put('d.html', '<title>D</title>');
  await put('secret.html', '<title>S</title>', admin, '?visibility=private');
  await put('e.html', '<title>E</title><a href="/pages/secret">s</a>');

  const [, g] = await req('GET', '/api/graph');
  const name = (id) => g.nodes.find((n) => n.id === id).slug;
  const edges = g.edges.map((e) => `${name(e.source)}>${name(e.target)}`).sort();
  assert.deepEqual(edges, ['a.html>b.html', 'a.html>c.html', 'b.html>a.html', 'c.html>d.html']); // missing + private left out
  assert.ok(!g.nodes.some((n) => n.slug === 'secret.html'));
  const a = g.nodes.find((n) => n.slug === 'a.html');
  assert.deepEqual([a.links_in, a.links_out, a.url], [1, 2, '/pages/a.html']);
  assert.equal((await req('GET', '/api/graph', { token: admin }))[1].edges.length, 5); // the owner sees the private link

  const [, local] = await req('GET', '/api/graph?page=c');
  assert.deepEqual(local.nodes.map((n) => n.slug).sort(), ['a.html', 'c.html', 'd.html']); // one hop, either direction
  const [, wider] = await req('GET', '/api/graph?page=c&depth=2');
  assert.ok(wider.nodes.some((n) => n.slug === 'b.html'));
  assert.equal((await req('GET', '/api/graph?page=c&depth=9'))[0], 400);

  // Links follow the latest version.
  await put('c.html', '<title>C</title><p>no links now</p>');
  assert.equal((await req('GET', '/api/graph?page=c'))[1].nodes.length, 2); // only a links to c

  const [s, page] = await req('GET', '/graph?page=a');
  assert.equal(s, 200);
  assert.match(page, /<title>Graph: A · HTML Server<\/title>/);
  assert.match(page, /<script id="graph-data" type="application\/json">/);
  assert.match((await req('GET', '/history/a'))[1], /href="\/graph\?page=a.html">Graph<\/a>/);
  assert.equal((await put('graph', '<p>x</p>'))[0], 400); // reserved
});

test('links are backfilled once for databases from before the links table', async () => {
  await put('x.html', '<a href="y.html">y</a>');
  await put('y.html', '<p>y</p>');
  store.db.exec("DELETE FROM links; DELETE FROM meta WHERE key = 'links_index'");
  store.close();
  store = new Store(join(dir, 't.db'));
  server.close();
  server = makeServer(store);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await req('GET', '/api/graph'))[1].edges.length, 1);
});

test('search highlights matched words in titles and snippets, typos included', async () => {
  await put('fam.html', '<title>[Draft] Family budget</title><p>monthly budget review</p>');
  const [, hits] = await req('GET', '/api/artifacts?q=budgt');
  assert.equal(hits[0].title_highlight, '[Draft] Family [budget]'); // the API: [brackets]
  assert.match(hits[0].snippet, /monthly \[budget\] review/);
  const [, frag] = await req('GET', '/?q=budgt&fragment=1');
  assert.match(frag, /<h2><a href="\/pages\/fam.html">\[Draft\] Family <mark>budget<\/mark><\/a><\/h2>/); // literal [Draft] stays text
  assert.match(frag, /monthly <mark>budget<\/mark> review/);
  assert.equal((await req('GET', '/api/artifacts'))[1][0].title_highlight, undefined); // not searching: no highlight fields
});
