// End-to-end API tests: a fresh database and server per test, so tests can't see
// each other's pages.   npm test   (or: node --test test/server.test.js)
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { ACTIVE, PURGED, TRASHED } from '../src/lifecycle.js';
import { ROUTES, makeServer } from '../src/server.js';
import { Store, normalizeTag } from '../src/store.js';

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
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4a00000000049454e44ae426082', 'hex');
/** The graph's edges as "from>to" page names, sorted, as this token's owner (or anyone, without one) sees them. */
const graphEdges = async (token) => {
  const [, g] = await req('GET', '/api/graph', { token });
  const name = (id) => g.nodes.find((n) => n.id === id).slug;
  return g.edges.map((e) => `${name(e.source)}>${name(e.target)}`).sort();
};
const backlinksOf = (slug, viewer = null) => store.backlinks(store.find(slug), viewer).map((b) => b.slug);

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
  assert.doesNotMatch(filtered.slice(filtered.indexOf('id="results"')), /Anscombe/); // (the explorer still lists every page)
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

test('one docs page for the CLI, MCP and API, from Markdown; static files', async () => {
  const [s, page, h] = await req('GET', '/docs');
  assert.equal(s, 200);
  assert.equal((await req('GET', '/api'))[1], page); // /api is the same page
  assert.match(page, /\/api\/artifacts\/&lt;slug&gt;\/restore/);
  assert.match(page, /<h2 id="command-line">Command line<\/h2>/);
  assert.match(page, /sync DIR \[--private\]/); // the CLI's own usage text
  assert.match(page, /<code>publish_page<\/code>/); // the MCP tools
  assert.doesNotMatch(page, /\/Users\//); // generic paths, not this machine's
  assert.match(page, /<button type="button" class="copy-source" data-copy-source="page-source">.*<span>Copy markdown<\/span><\/button>/);
  assert.match(page, /This page is Markdown: <a href="\/docs\.md">/); // its own Markdown, not a page called docs.md
  const md = await fetch(`${base}/docs.md`);
  assert.match(md.headers.get('content-type'), /text\/markdown/);
  const text = await md.text();
  assert.match(text, /^# Docs\n/);
  assert.match(text, /\| PUT \| `\/api\/artifacts\/<slug>` \| token \|/);
  const endpoints = text.slice(text.indexOf('### Endpoints')).split('\n').filter((l) => /^\| (GET|PUT|POST|DELETE) /.test(l));
  assert.equal(endpoints.length, ROUTES.filter((r) => r.doc).length); // every documented route
  assert.equal(JSON.parse(page.match(/<script id="page-source" type="application\/json">([^<]*)<\/script>/)[1]), text); // what copy copies
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

test('search finds what scripts write, aliases, tags, joined-up file names and other forms of words', async () => {
  await put('board.html', `<title>Triage</title><div id="board"></div><script>
    const tickets = [{ title: 'Rotate a share link' }, { title: 'Per-version deletion' }];</script>`);
  await put('reading.md', '---\ntitle: Reading list\naliases: [Bookshelf]\n---\nCase studies in plotting data.\n');
  await put('ObsidianFlavoredMarkdown.md', '# Syntax\n\nCallouts and more.\n');
  const found = async (q) => slugs((await req('GET', `/api/search?q=${encodeURIComponent(q)}`))[1].results);
  assert.deepEqual(await found('rotate share link'), ['board.html']); // only in its script
  assert.deepEqual(await found('bookshelf'), ['reading.md']); // an alias
  assert.deepEqual(await found('flavored'), ['ObsidianFlavoredMarkdown.md']); // a word inside a file name
  assert.deepEqual(await found('study plot'), ['reading.md']); // "studies", "plotting"
  assert.deepEqual(await found('kanban'), []);
  await req('POST', '/api/tags', { body: JSON.stringify({ pages: ['board.html'], add: ['kanban'] }), token: admin });
  assert.deepEqual(await found('kanban'), ['board.html']); // a tag added by hand
});

test('pages with the words as typed rank before pages found through a typo', async () => {
  await put('a.html', '<title>One</title><p>graph graph graph graph graph</p>'); // "graph" is close to "grape"
  await put('b.html', '<title>Two</title><p>a grape, among many other words that make this page longer than the first</p>');
  assert.deepEqual(slugs((await req('GET', '/api/artifacts?q=grape'))[1]), ['b.html', 'a.html']);
});

test('the home page writes snippets for its first cards only, and a one-letter search none', async () => {
  const { CARD_SNIPPETS } = await import('../src/config.js');
  for (let i = 0; i < CARD_SNIPPETS + 2; i++) await put(`p${i}.html`, `<title>Page ${i}</title><p>common words</p>`);
  const [, frag] = await req('GET', '/?q=common&fragment=1');
  assert.equal((frag.match(/<article /g) || []).length, CARD_SNIPPETS + 2);
  assert.equal((frag.match(/<mark>common<\/mark>/g) || []).length, CARD_SNIPPETS);
  assert.ok((await req('GET', '/api/search?q=common&limit=60'))[1].results.every((r) => r.snippet)); // the API: all of them
  assert.ok((await req('GET', '/api/search?q=c'))[1].results.every((r) => r.snippet === null));
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
  assert.equal(store.setting('search_index'), '3');
});

test('site header, title and search box', async () => {
  const [, page] = await req('GET', '/');
  assert.match(page, /<title>HTML Server<\/title>/);
  assert.match(page, /<h2 class="page-title"><a href="\/" target="_top">HTML Server<\/a><\/h2>/);
  assert.match(page, /<a href="\/gallery" target="_top">Gallery<\/a>/);
  assert.match(page, /placeholder="Search pages"/);
  assert.doesNotMatch(page, /typos are fine/);
  assert.match((await req('GET', '/docs'))[1], /<a href="\/docs" target="_top" class="on"/);
});

test('/gallery: the bundled example pages, filterable and searchable', async () => {
  const [s, page] = await req('GET', '/gallery');
  assert.equal(s, 200);
  assert.match(page, /<title>Gallery · HTML Server<\/title>/);
  assert.equal(page.match(/<article class="card[^"]*"/g).length, 13);
  assert.match(page, /Machine learning <span>2<\/span>/);
  assert.match(page, /href="\/gallery\/kmeans-step-through.html"/);
  assert.match(page, /data-base="\/gallery"/);
  const [, ml] = await req('GET', '/gallery?category=machine-learning');
  assert.equal(ml.match(/<article class="card[^"]*"/g).length, 2);
  const [, frag] = await req('GET', '/gallery?q=kmeans&fragment=1');
  assert.equal(frag.match(/<article class="card[^"]*"/g).length, 1);
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
  assert.match(docs, new RegExp(`<a href="${release}">HTML Server v`));
  assert.match(docs, /npm install -g github:lawwu\/html-server#v/);
  await put('mine.html', '<p>my page</p>');
  assert.doesNotMatch((await req('GET', '/pages/mine'))[1], /site-foot|github\.com/);
  assert.doesNotMatch((await req('GET', '/gallery/kmeans-step-through.html'))[1], /site-foot/);
});

test('cards put the category chip beside the title', async () => {
  await put('c.html', '<title>Chart</title><meta name="category" content="data-viz">');
  assert.match((await req('GET', '/'))[1],
    /<div class="head"><h2><a href="\/pages\/c.html">Chart<\/a><\/h2>\s*<span class="tags"><a class="tag" href="\/\?category=data-viz">Data visualization<\/a><\/span><\/div>/);
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
  await put('Z.md', '# Z\n\n[[y]]'); // a note: read as Markdown, by its name
  store.db.exec("DELETE FROM links; DELETE FROM link_targets; DELETE FROM meta WHERE key LIKE 'links_%'");
  store.close();
  store = new Store(join(dir, 't.db'));
  server.close();
  server = makeServer(store);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  assert.deepEqual(await graphEdges(), ['Z.md>y.html', 'x.html>y.html']);
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

test('featured pages: pinned to the top by their owner or an admin, in pin order', async () => {
  const bob = (await req('POST', '/api/users', { body: '{"name":"bob"}', token: admin }))[1].token;
  await put('one.html', '<title>One</title>');
  await put('two.html', '<title>Two</title>');
  await put('bobs.html', '<title>Bob page</title>', bob);
  await put('three.html', '<title>Three</title>');

  assert.equal((await req('POST', '/api/artifacts/one.html/pin', { token: bob }))[0], 403); // not his page
  assert.equal((await req('POST', '/api/artifacts/bobs.html/pin', { token: bob }))[1].pinned, true); // his own
  await req('POST', '/api/artifacts/one.html/pin', { token: admin }); // pinned second
  const list = (await req('GET', '/api/artifacts'))[1];
  assert.deepEqual(slugs(list).slice(0, 2), ['bobs.html', 'one.html']); // pinned first, in pin order
  assert.deepEqual(list.slice(0, 3).map((a) => a.pinned), [true, true, false]);

  const [, page] = await req('GET', '/');
  // One grid, its section titles inside it, so live search can reorder cards without moving them.
  assert.match(page, /<div class="cards"><h2 class="section-title" data-section="featured">.*Featured<\/h2>.*bobs\.html.*one\.html.*<h2 class="section-title" data-section="all">All pages<\/h2>.*three\.html/s);
  assert.match(page, /<article class="card pinned" data-slug="one.html">/);
  assert.doesNotMatch((await req('GET', '/?q=three&fragment=1'))[1], /Featured/); // searching: one ranked list

  await req('DELETE', '/api/artifacts/bobs.html/pin', { token: admin }); // admins can unpin anyone's
  assert.deepEqual(slugs((await req('GET', '/api/artifacts'))[1])[0], 'one.html');
});

test('tags: categories become tags; tag many pages at once; filter by tag', async () => {
  const bob = (await req('POST', '/api/users', { body: '{"name":"bob"}', token: admin }))[1].token;
  await put('a.html', '<title>A</title><meta name="category" content="data-viz">');
  await put('b.html', '<title>B</title>');
  await put('c.html', '<title>C</title>', bob);
  assert.deepEqual((await req('GET', '/api/artifacts/a.html'))[1].tags, ['data-viz']); // from the meta tag

  const [s, r] = await req('POST', '/api/tags', { token: admin,
    body: JSON.stringify({ pages: ['a.html', 'b.html', 'c.html', 'nope', 'b'], add: ['Trip Plans', 'q4'] }) });
  assert.equal(normalizeTag('plugin/Emitter'), 'plugin-emitter'); // Quartz nested tags
  assert.equal(s, 200);
  assert.deepEqual(r.results, [
    { slug: 'a.html', tags: ['data-viz', 'q4', 'trip-plans'] }, // normalized: "Trip Plans" → trip-plans
    { slug: 'b.html', tags: ['q4', 'trip-plans'] },
    { slug: 'c.html', error: "'c.html' belongs to bob" }, // checked page by page
    { slug: 'nope', error: 'no such artifact' },
    { slug: 'b', error: "no page is named 'b'; did you mean 'b.html'?" }, // a write: by exact name
  ]);
  assert.deepEqual(slugs((await req('GET', '/api/artifacts?category=trip-plans'))[1]).sort(), ['a.html', 'b.html']);
  assert.deepEqual((await req('GET', '/api/tags'))[1].find((t) => t.tag === 'q4'), { tag: 'q4', count: 2 });

  await req('POST', '/api/tags', { token: admin, body: JSON.stringify({ pages: ['a.html'], remove: ['q4', 'data-viz'] }) });
  assert.deepEqual((await req('GET', '/api/artifacts/a.html'))[1].tags, ['trip-plans']);
  await put('a.html', '<title>A</title><meta name="category" content="data-viz"><p>v2</p>'); // same category: not re-added
  assert.deepEqual((await req('GET', '/api/artifacts/a.html'))[1].tags, ['trip-plans']);

  assert.equal((await req('POST', '/api/tags', { token: admin, body: '{"pages":["a.html"],"add":["!!"]}' }))[0], 400);
  assert.equal((await req('POST', '/api/tags', { body: '{"pages":["a.html"],"add":["x"]}' }))[0], 401);
  store.setEditing('open');
  assert.equal((await req('POST', '/api/tags', { token: bob, body: '{"pages":["b.html"],"add":["seen"]}' }))[1].results[0].tags.includes('seen'), true);

  const [, home] = await req('GET', '/');
  assert.match(home, /<button type="button" id="select"/);
  assert.match(home, /<input type="checkbox" value="b.html"/);
  assert.match(home, /data-category="trip-plans"/); // tag chips in the filter bar
});

test('existing categories become tags once, on startup', async () => {
  await put('old.html', '<title>Old</title><meta name="category" content="architecture">');
  store.db.exec("DELETE FROM tags; DELETE FROM meta WHERE key = 'tags_index'");
  store.close();
  store = new Store(join(dir, 't.db'));
  server.close();
  server = makeServer(store);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  assert.deepEqual((await req('GET', '/api/artifacts/old.html'))[1].tags, ['architecture']);
});

test('stats: totals and series over the pages you can see', async () => {
  const bob = (await req('POST', '/api/users', { body: '{"name":"bob"}', token: admin }))[1].token;
  await put('a.html', '<title>Alpha</title><meta name="category" content="data-viz">');
  await put('a.html', '<title>Alpha</title><meta name="category" content="data-viz"><p>v2</p>', admin);
  await put('b.html', '<title>Beta</title>', bob);
  await put('hidden.html', '<title>Hidden</title>', admin, '?visibility=private');
  await req('GET', '/pages/a.html');
  await req('GET', '/pages/a.html', { ua: 'Mozilla/5.0 other' });
  await req('GET', '/pages/b.html');

  const [, s] = await req('GET', '/api/stats');
  assert.deepEqual(
    [s.totals.pages, s.totals.versions, s.totals.views, s.totals.views_recent, s.totals.tags, s.totals.authors],
    [2, 3, 3, 3, 1, 2]); // the private page is left out
  assert.equal(s.views_by_day.length, 30);
  assert.equal(s.views_by_day.at(-1).views, 3); // today, filled series
  assert.equal(s.uploads_by_week.length, 12);
  assert.equal(s.uploads_by_week.at(-1).versions, 3);
  assert.deepEqual(s.most_viewed.map((p) => [p.slug, p.views]), [['a.html', 2], ['b.html', 1]]);
  assert.deepEqual(s.most_edited.map((p) => [p.slug, p.versions]), [['a.html', 2]]);
  assert.deepEqual(s.recent[0].slug, 'b.html');
  assert.equal((await req('GET', '/api/stats', { token: admin }))[1].totals.pages, 3); // the owner counts it

  const [code, page] = await req('GET', '/stats');
  assert.equal(code, 200);
  assert.match(page, /<title>Stats · HTML Server<\/title>/);
  assert.match(page, /<span class="ht-label">Pages<\/span><b>2<\/b>/); // public pages only for an anonymous visitor
  assert.match(page, /<svg class="spark"[^>]*aria-label="Views per day, last 30 days">/); // the headline's trend line
  assert.match(page, /<figcaption><span>Views per day<\/span><b>3 in 30 days<\/b><\/figcaption>/);
  assert.match(page, /<section id="usage"[^]*Admins<\/span>/); // the usage section, filled in for admins by stats.js
  assert.doesNotMatch(page, /API calls per day/); // never drawn into the public page
  assert.match(page, /data-tip="Alpha: 2 views"/);
  assert.match(page, /<details class="tview"><summary>Show as table<\/summary>/); // every chart has a table view
  assert.equal((await put('stats', '<p>x</p>'))[0], 400); // reserved
});

test('API usage: each /api call recorded by kind of client, shown to admins only', async () => {
  const call = (path, headers = {}, method = 'GET') => fetch(`${base}${path}`, { method, headers });
  const usage = async () => (await req('GET', '/api/stats/usage', { token: admin }))[1];
  const before = (await usage()).totals;
  await call('/api/artifacts?q=secret-words', { 'x-html-server-client': 'mcp/search_pages' });
  await call('/api/artifacts/nope.html', { 'x-html-server-client': 'mcp/get_page' }); // 404, still counted
  await call('/api/artifacts', { 'x-html-server-client': 'cli/ls', authorization: `Bearer ${admin}` });
  await call('/api/search?q=x', { 'sec-fetch-site': 'same-origin' }); // a browser (the ⌘K box)
  await call('/api/tags'); // curl, a script
  await call('/api/tags', { 'x-html-server-client': 'mcp/<script>' }); // a label that isn't one: plain HTTP
  await call('/pages/nothing-here'); // not /api: not counted
  const u = await usage();
  const d = (k) => u.totals[k] - before[k];
  // http: the two plain calls, plus the first usage() reading itself (recorded once it has answered).
  assert.deepEqual([d('mcp'), d('cli'), d('browser'), d('http')], [2, 1, 1, 3]);
  assert.ok(u.mcp_tools.some((r) => r.name === 'get_page' && r.errors >= 1));
  assert.ok(u.cli_commands.some((r) => r.name === 'ls'));
  assert.ok(u.routes.some((r) => r.route === '/api/artifacts/<slug>' && r.method === 'GET')); // the pattern, not the page name
  assert.equal(u.series.length, 30);
  assert.equal(u.unit, 'day');
  assert.equal(u.retention_days, 90);
  const rows = store.all('SELECT * FROM api_calls');
  assert.ok(!JSON.stringify(rows).includes('secret-words')); // never the query string
  assert.ok(!JSON.stringify(rows).includes(admin)); // never the token
  assert.ok(rows.some((r) => r.client === 'cli' && r.user_id != null)); // who, when signed in

  assert.equal((await req('GET', '/api/stats/usage'))[0], 401); // admins only
  const bob = store.createUser('usage-bob');
  assert.equal((await req('GET', '/api/stats/usage', { token: bob }))[0], 403);
  assert.equal((await req('GET', '/api/stats/usage?days=0', { token: admin }))[0], 400);
  assert.equal((await req('GET', '/api/stats/usage?days=soon', { token: admin }))[0], 400);
  const year = (await req('GET', '/api/stats/usage?days=365', { token: admin }))[1];
  assert.equal(year.unit, 'week'); // longer periods group the bars
  assert.ok(year.series.length >= 52 && year.series.length <= 54);
  const frag = await (await call('/stats/usage', { authorization: `Bearer ${admin}` })).text();
  assert.match(frag, /API calls per day, by client/);
  assert.match(frag, /<nav class="range-picker"[^]*data-days="all">All time<\/a>/);
  assert.match(frag, /<ul class="legend-row"><li><i class="sw s1"><\/i>MCP<\/li>/); // more than one series: a legend
  assert.match(frag, /<code>GET \/api\/artifacts\/&lt;slug&gt;<\/code>/);
  assert.equal((await call('/stats/usage')).status, 401);

  // Past the retention period a request's details go, but it stays counted in the daily totals, for good.
  const old = Date.now() / 1000 - 200 * 86400;
  const insert = (at, status) => store.run('INSERT INTO api_calls (at, client, name, method, route, status, user_id) VALUES (?,?,?,?,?,?,?)',
    at, 'mcp', 'get_page', 'GET', '/api/old', status, 1);
  insert(old, 200); insert(old + 60, 404);
  const allBefore = (await req('GET', '/api/stats/usage?days=all', { token: admin }))[1];
  store.lastPrune = 0;
  store.recordApiCall({ client: 'http', method: 'GET', route: '/api/tags', status: 200 }); // triggers the hourly fold
  assert.equal(store.one("SELECT COUNT(*) AS n FROM api_calls WHERE route = '/api/old'").n, 0); // details gone
  assert.deepEqual({ ...store.one("SELECT calls, errors FROM api_calls_daily WHERE route = '/api/old'") }, { calls: 2, errors: 1 });
  insert(old + 120, 200); // another from that day, folded later: added to the same day's totals
  store.rollUpApiCalls(Date.now() / 1000 - 90 * 86400);
  assert.equal(store.one("SELECT calls FROM api_calls_daily WHERE route = '/api/old'").calls, 3);
  const all = (await req('GET', '/api/stats/usage?days=all', { token: admin }))[1];
  assert.equal(all.days, null);
  assert.equal(all.unit, 'week'); // 200 days back: weekly bars
  assert.equal(all.totals.mcp - allBefore.totals.mcp, 1); // the third old call; the first two were already counted
  assert.ok(all.mcp_tools.some((r) => r.name === 'get_page' && r.calls >= 3));
  assert.ok(all.routes.some((r) => r.route === '/api/old' && r.calls === 3 && r.errors === 1));
  assert.equal(all.series.reduce((n, p) => n + p.mcp + p.cli + p.browser + p.http, 0), all.totals.calls); // nothing counted twice
  const recent = (await req('GET', '/api/stats/usage?days=30', { token: admin }))[1];
  assert.ok(!recent.routes.some((r) => r.route === '/api/old')); // outside the last 30 days
});

test('home shows the page count; header links to GitHub with the version', async () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  await put('p1.html', '<title>One</title>');
  await put('p2.html', '<title>Two</title>');
  await req('POST', '/api/artifacts/p1.html/pin', { token: admin });
  const [, page] = await req('GET', '/');
  assert.match(page, /<p id="count" class="meta" data-total="2 pages · 1 featured">2 pages · 1 featured<\/p>/);
  assert.match((await req('GET', '/?q=one'))[1], /<p id="count"[^>]*>1 match<\/p>/);
  assert.match(page, new RegExp(`<a class="gh" href="https://github.com/lawwu/html-server/releases/tag/v${pkg.version}" target="_top"[^>]*><svg[^]*?</svg><span>v${pkg.version.replace(/\./g, '\\.')}</span></a>`));
  assert.match((await req('GET', '/gallery'))[1], /data-total="13 example pages"/);
});

test('HEAD is answered like GET, without a body, and is not a page view', async () => {
  await put('head-check.html', '<title>Head check</title><p>' + 'x'.repeat(4000) + '</p>');
  const views = async () => (await req('GET', '/api/artifacts/head-check.html'))[1].views;
  const browser = { 'user-agent': 'Mozilla/5.0' };
  for (const path of ['/pages/head-check.html', '/', '/docs', '/api/artifacts/head-check.html', '/_static/style.css']) {
    const [head, get] = await Promise.all(['HEAD', 'GET'].map((method) => fetch(`${base}${path}`, { method, headers: browser })));
    assert.equal(head.status, get.status, path);
    assert.equal(head.headers.get('content-type'), get.headers.get('content-type'), path);
    assert.equal(await head.text(), '', path); // no body
  }
  const plain = { ...browser, 'accept-encoding': 'identity' }; // compare lengths uncompressed
  const page = await fetch(`${base}/pages/head-check.html`, { method: 'HEAD', headers: plain });
  assert.match(page.headers.get('content-security-policy'), /allow-popups-to-escape-sandbox/); // the headers a page really gets
  assert.equal(Number(page.headers.get('content-length')),
    (await (await fetch(`${base}/pages/head-check.html`, { headers: plain })).arrayBuffer()).byteLength);
  const before = await views();
  await fetch(`${base}/pages/head-check.html`, { method: 'HEAD', headers: browser });
  assert.equal(await views(), before); // monitors polling with HEAD don't inflate the count
  assert.equal((await fetch(`${base}/pages/no-such-page`, { method: 'HEAD' })).status, 404);
});

test('sorting pages: by update, creation, views or title, featured pages first; searches too', async () => {
  const view = (slug, n) => Promise.all(Array.from({ length: n }, () =>
    fetch(`${base}/pages/${slug}`, { headers: { 'user-agent': 'Mozilla/5.0' } })));
  await put('sort-b.html', '<title>Banana trip</title>');
  await put('sort-a.html', '<title>Apple trip</title>');
  await put('sort-c.html', '<title>Cherry trip</title>');
  await put('sort-b.html', '<title>Banana trip</title><p>edited</p>'); // most recently updated
  await view('sort-c.html', 3);
  await view('sort-a.html', 1);
  const order = async (qs) => (await req('GET', `/api/artifacts?${qs}`))[1].map((a) => a.slug).filter((s) => s.startsWith('sort-'));
  assert.deepEqual(await order(''), ['sort-b.html', 'sort-c.html', 'sort-a.html']); // default: recently updated
  assert.deepEqual(await order('sort=created'), ['sort-c.html', 'sort-a.html', 'sort-b.html']);
  assert.deepEqual(await order('sort=views'), ['sort-c.html', 'sort-a.html', 'sort-b.html']);
  assert.deepEqual(await order('sort=title'), ['sort-a.html', 'sort-b.html', 'sort-c.html']);

  await req('POST', '/api/artifacts/sort-c.html/pin', { token: admin }); // featured stays on top whatever the sort
  assert.deepEqual(await order('sort=title'), ['sort-c.html', 'sort-a.html', 'sort-b.html']);

  const search = async (qs) => (await req('GET', `/api/search?q=trip&${qs}`))[1].results.map((a) => a.slug);
  assert.deepEqual(await search('sort=title'), ['sort-a.html', 'sort-b.html', 'sort-c.html']);
  assert.deepEqual(await search('sort=views'), ['sort-c.html', 'sort-a.html', 'sort-b.html']);
  assert.equal((await req('GET', '/api/search?q=trip&sort=relevance'))[0], 200);

  const [s, e] = await req('GET', '/api/artifacts?sort=popular');
  assert.equal(s, 400);
  assert.match(e.error, /sort must be one of updated, created, views, title/);
  assert.equal((await req('GET', '/api/artifacts?sort=relevance'))[0], 400); // best match needs a query

  const [, home] = await req('GET', '/?sort=views');
  assert.match(home, /<select id="sort" name="sort">[^]*<option value="views" selected>Most viewed<\/option>/);
  assert.match(home, /<option value="relevance" hidden disabled>Best match<\/option>/); // only while searching
  assert.match(home, /data-view="list" href="\/\?view=list&amp;sort=views"/); // links keep the sort
  const [, found] = await req('GET', '/?q=trip');
  assert.match(found, /<option value="relevance" selected>Best match<\/option>/);
});

test('markdown notes: rendered pages, wikilinks across kinds, backlinks, tags, search, diff, graph', async () => {
  const review = '---\ntitle: Weekly Review\ntags: [planning, habits]\ndescription: What happened this week\n---\n'
    + '## Wins\n\nShipped the [[Launch Plan]]. See also [[Missing Note]].\n\n> [!tip] Keep going\n> Small steps.\n';
  let [s, a] = await put('Weekly-Review.md', review);
  assert.equal(s, 201);
  assert.deepEqual([a.title, a.description, a.tags, a.url], ['Weekly Review', 'What happened this week', ['habits', 'planning'], '/pages/Weekly-Review.md']);
  await put('launch-plan.html', '<title>Launch plan</title><p>Back to <a href="Weekly-Review.md">the review</a></p>');

  const [, page, h] = await req('GET', '/pages/weekly-review'); // no extension, any case
  assert.match(h.get('content-security-policy'), /sandbox/);
  assert.match(page, /<h1 class="article-title">Weekly Review<\/h1>/);
  assert.match(page, /<a class="wikilink" href="\/pages\/launch-plan.html">Launch Plan<\/a>/); // wikilink to an HTML page
  assert.match(page, /wikilink missing[^>]*>Missing Note</);
  assert.match(page, /class="callout callout-tip"/);
  assert.match(page, /<section class="backlinks"><h3>Backlinks<\/h3><ul><li><a href="\/pages\/launch-plan.html" target="_top">Launch plan<\/a>/);
  assert.match(page, /<a class="tag-link" href="\/\?category=planning" target="_top">planning<\/a>/);
  assert.match(page, /<section class="graph-view">[^]*href="\/pages\/launch-plan.html"/); // the local graph: its linked page
  assert.match(page, /<a class="wikilink" href="\/pages\/launch-plan.html"/);
  assert.match(page, /data-artifact-toc-script|<h2 id="wins">/); // headings get anchors (sidebar needs 3+)
  assert.equal((await req('GET', '/api/artifacts/Weekly-Review.md/versions/1'))[1], review); // raw source is the Markdown

  assert.deepEqual(slugs((await req('GET', '/api/search?q=shipped'))[1].results), ['Weekly-Review.md']);
  assert.deepEqual(slugs((await req('GET', '/api/artifacts?category=habits'))[1]), ['Weekly-Review.md']);

  // Frontmatter tags follow the note; a tag added by hand stays.
  await req('POST', '/api/tags', { token: admin, body: JSON.stringify({ pages: ['Weekly-Review.md'], add: ['starred'] }) });
  [, a] = await put('Weekly-Review.md', review.replace('[planning, habits]', '[planning]').replace('Small steps.', 'Big steps.'));
  assert.deepEqual(a.tags, ['planning', 'starred']);
  const [, diff] = await req('GET', '/api/artifacts/Weekly-Review.md/diff');
  assert.match(diff, /-> Small steps\.\n\+> Big steps\./); // Markdown diffs are the source lines

  const [, g] = await req('GET', '/api/graph');
  const name = (id) => g.nodes.find((n) => n.id === id).slug;
  assert.deepEqual(g.edges.map((e) => `${name(e.source)}>${name(e.target)}`).sort(),
    ['Weekly-Review.md>launch-plan.html', 'launch-plan.html>Weekly-Review.md']);
  assert.deepEqual(g.nodes.find((n) => n.slug === 'Weekly-Review.md').tags, ['planning', 'starred']);

  const [, old] = await req('GET', '/pages/Weekly-Review.md?v=1'); // an old version renders as it was
  assert.match(old, /Small steps\./);
  assert.match(old, /data-artifact-version-badge/);
});

test('notes: rendered hover previews of linked notes, the site graph for the live graph, fonts, gzip', async () => {
  await put('Alpha.md', '# Alpha\n\nSee [[Beta]] and [[framed-2]].');
  await put('Beta.md', '# Beta\n\n> [!tip] Hello\n> from beta\n\nMore text.');
  await put('framed-2.html', '<title>Framed two</title><p>plain html page text</p>');
  const [, note] = await req('GET', '/pages/Alpha');
  const previews = JSON.parse(note.match(/<script id="page-previews" type="application\/json">([^<]*)<\/script>/)[1]);
  assert.match(previews['Beta.md'].html, /class="callout callout-tip"/); // a note's preview is the note, rendered
  assert.equal(previews['framed-2.html'].html, undefined); // an HTML page's preview is its text
  assert.match(previews['framed-2.html'].text, /plain html page text/);
  const graph = JSON.parse(note.match(/<script id="site-graph" type="application\/json">([^<]*)<\/script>/)[1]);
  assert.ok(graph.nodes.some(([, title]) => title === 'Beta'));
  assert.match(note, /url\(data:font\/woff2;base64,/); // the main typefaces travel with the sandboxed note
  const font = await fetch(`${base}/_static/fonts/source-sans-3.woff2`);
  assert.equal(font.headers.get('content-type'), 'font/woff2');
  const gz = await fetch(`${base}/pages/Alpha`, { headers: { 'accept-encoding': 'gzip' } });
  assert.equal(gz.headers.get('content-encoding'), 'gzip');
  assert.match(await gz.text(), /<h1 class="article-title">Alpha<\/h1>/);
});

test('an HTML page opened in a browser tab gets the frame; iframes, clients and ?raw=1 get the page', async () => {
  await put('framed.html', '<title>Framed</title><meta name="category" content="trips"><p>inside</p>');
  await put('Points.md', 'See [[framed]]');
  const get = async (path, dest) => {
    const r = await fetch(`${base}${path}`, { headers: { 'user-agent': 'Mozilla/5.0', ...(dest ? { 'sec-fetch-dest': dest } : {}) } });
    return [await r.text(), r.headers];
  };
  const [frame, fh] = await get('/pages/framed', 'document');
  const views = async () => (await req('GET', '/api/artifacts/framed.html'))[1].views;
  assert.equal(await views(), 0); // the frame isn't a view; the iframe loading the page is
  await get('/pages/framed', 'iframe');
  assert.equal(await views(), 1);
  assert.match(frame, /<iframe class="page-frame auto" src="\/pages\/framed.html\?embed=1" title="Framed"><\/iframe>/);
  assert.match(frame, /<aside class="sidebar left">/);
  assert.match(frame, /<a class="tag-link" href="\/\?category=trips">trips<\/a>/);
  assert.match(frame, /data-src="\/api\/artifacts\/framed.html\/versions\/1">.*<span>Copy HTML<\/span>/);
  assert.match(frame, /<section class="backlinks"><h3>Backlinks<\/h3><ul><li><a href="\/pages\/Points.md"/);
  assert.match(frame, /"Points.md":\{"title":"Points"/); // its hover preview
  assert.equal(fh.get('content-security-policy'), null); // the frame is the server's own page; the page inside stays sandboxed
  for (const [path, dest] of [['/pages/framed', 'iframe'], ['/pages/framed', undefined], ['/pages/framed?raw=1', 'document']]) {
    const [raw, h] = await get(path, dest);
    assert.match(raw, /<p>inside<\/p>/, `${path} ${dest}`);
    assert.match(h.get('content-security-policy'), /sandbox/);
  }
  // In the frame, the page opts in to responsive iframes and reports its height.
  const [embedded] = await get('/pages/framed?embed=1', 'iframe');
  assert.match(embedded, /<meta name="responsive-embedded-sizing" content="allow-origins=\*">/);
  assert.match(embedded, /<script data-html-server-embed>/);
  assert.doesNotMatch(embedded, /data-artifact-toc-script|data-artifact-version-badge/);
  await put('app.html', '<html><head><meta name="html-server-frame" content="window"></head><body>app</body></html>');
  const [app] = await get('/pages/app?embed=1', 'iframe'); // a page can ask to stay at window height
  assert.doesNotMatch(app, /<meta name="responsive-embedded-sizing"/);
  assert.match(app, /data-html-server-embed/);
  const [note] = await get('/pages/Points', 'document'); // notes are already pages of the site
  assert.match(note, /<h1 class="article-title">Points<\/h1>/);
  assert.doesNotMatch(note, /<iframe class="page-frame"/);
});

test('notes are pages of the site: sidebars, footer and stylesheet; previews without them; HTML pages never wrapped', async () => {
  await put('Note.md', '# Note\n\nHello');
  await put('raw.html', '<p>my own html</p>');
  const [, note] = await req('GET', '/pages/Note');
  assert.match(note, /<style>[^<]*\.sidebar \{[^<]*\.article-title/s); // the site's styles and the note's, inlined
  assert.match(note, /<aside class="sidebar left">[^]*<h2 class="page-title"><a href="\/" target="_top">HTML Server<\/a>/);
  assert.match(note, /<details class="explorer" open>[^]*<a href="\/pages\/Note.md" target="_top" class="on" aria-current="page">Note<\/a>/);
  assert.match(note, /<aside class="sidebar right">/);
  assert.match(note, /<footer class="site-foot">/);
  assert.match(note, /<a href="\/history\/Note.md" target="_top">history<\/a>/);
  assert.match(note, /<span>Copy markdown<\/span>/);
  assert.equal(JSON.parse(note.match(/<script id="page-source" type="application\/json">([^<]*)<\/script>/)[1]), '# Note\n\nHello'); // what it copies
  const dark = await (await fetch(`${base}/pages/Note`, { headers: { cookie: 'theme=dark' } })).text();
  assert.match(dark, /<html lang="en" data-theme="dark">/); // the switch's choice reaches sandboxed notes by cookie
  const [, preview] = await req('GET', '/pages/Note?preview=1');
  assert.doesNotMatch(preview, /class="sidebar|<footer class="site-foot"/);
  assert.match(preview, /<h1 class="article-title">Note<\/h1>/);
  const [, raw] = await req('GET', '/pages/raw.html');
  assert.doesNotMatch(raw, /class="site"|style\.css/);
});

// --- From the deep review (0.8.0): one resolver, links worked out on writes, exact names
// for writes, private assets, and the smaller fixes. Each test names what it guards.


test('links: a trashed page or one the viewer can\'t see never shadows the page a link means', async () => {
  const bob = (await req('POST', '/api/users', { body: '{"name":"bob"}', token: admin }))[1].token;
  await put('x.html', '<title>Old x</title>');
  await put('x.md', '# New x');
  await put('y.html', '<title>Bob\'s private y</title>', bob, '?visibility=private');
  await put('y.md', '# Public y');
  await put('Hub.md', '# Hub\n\nSee [[x]] and [[y]].');
  await req('DELETE', '/api/artifacts/x.html', { token: admin }); // x.html would win [[x]], but it's trashed

  const [, hub] = await req('GET', '/pages/Hub.md');
  assert.match(hub, /<a class="wikilink" href="\/pages\/x.md">x<\/a>/); // not "not written yet"
  assert.match(hub, /<a class="wikilink" href="\/pages\/y.md">y<\/a>/); // bob's private y.html isn't anyone else's
  assert.deepEqual(await graphEdges(), ['Hub.md>x.md', 'Hub.md>y.md']);
  assert.deepEqual(backlinksOf('x.md'), ['Hub.md']);
  assert.match((await req('GET', '/pages/x'))[1], /New x/); // the URL too

  await req('POST', '/api/artifacts/x.html/restore', { token: admin }); // back: x.html is what [[x]] means again
  assert.deepEqual(await graphEdges(), ['Hub.md>x.html', 'Hub.md>y.md']);
  assert.deepEqual(backlinksOf('x.md'), []);
  assert.deepEqual(await graphEdges(bob), ['Hub.md>x.html', 'Hub.md>y.html']); // bob sees his own y.html, which [[y]] means first
});

test('links: aliases count for backlinks and the graph; a folder link means only its page', async () => {
  await put('Weekly-Review.md', '---\naliases: [WR]\n---\n# Weekly Review');
  await put('Monday.md', '# Monday\n\nFiled under [[WR]].');
  assert.deepEqual(backlinksOf('Weekly-Review.md'), ['Monday.md']);
  assert.deepEqual(await graphEdges(), ['Monday.md>Weekly-Review.md']);

  // [[plugins/Backlinks]] means plugins-Backlinks.md, and only it: not every page named Backlinks.
  await put('plugins-Backlinks.md', '# Backlinks (plugin)', admin, '?name=backlinks&path=plugins/Backlinks.md');
  await put('features-Backlinks.md', '# Backlinks (feature)', admin, '?name=backlinks&path=features/Backlinks.md');
  await put('Index.md', '# Index\n\nSee [[plugins/Backlinks]].');
  assert.deepEqual(backlinksOf('plugins-Backlinks.md'), ['Index.md']);
  assert.deepEqual(backlinksOf('features-Backlinks.md'), []);
  // Its bare name is the fallback, as when rendering: with plugins-Backlinks.md gone, the shortest other one.
  await req('DELETE', '/api/artifacts/plugins-Backlinks.md', { token: admin });
  assert.deepEqual(backlinksOf('features-Backlinks.md'), ['Index.md']);
  // A tag link is a tag, not a page called "emitter".
  await put('emitter.md', '# Emitter');
  await put('Tags.md', '# Tags\n\n[[tags/plugin/emitter]]');
  assert.deepEqual(backlinksOf('emitter.md'), []);
});

test('links are worked out on writes: a page made, renamed or aliased later is found without re-saving the linker', async () => {
  await put('Plan.md', '# Plan\n\nNext: [[Later]], [[Nick]] and [[sub/Thing]].');
  assert.deepEqual(await graphEdges(), []);
  await put('Later.md', '# Later'); // made after the link to it
  await put('Somebody.md', '---\naliases: [Nick]\n---\n# Somebody'); // answers to an alias
  await put('notes-Thing.md', '# Thing', admin, '?name=thing&path=notes/Thing.md'); // by bare name, from a folder
  assert.deepEqual(await graphEdges(), ['Plan.md>Later.md', 'Plan.md>Somebody.md', 'Plan.md>notes-Thing.md']);
  await put('Somebody.md', '# Somebody'); // drops the alias
  assert.deepEqual(await graphEdges(), ['Plan.md>Later.md', 'Plan.md>notes-Thing.md']);
  await put('sub-Thing.md', '# The sub thing', admin, '?name=thing&path=sub/Thing.md'); // the exact folder path wins
  assert.deepEqual(await graphEdges(), ['Plan.md>Later.md', 'Plan.md>sub-Thing.md']);
  await req('DELETE', '/api/artifacts/Later.md', { token: admin });
  await req('DELETE', '/api/artifacts/Later.md?purge=1', { token: admin });
  assert.deepEqual(await graphEdges(), ['Plan.md>sub-Thing.md']);
  assert.match((await req('GET', '/pages/Plan.md'))[1], /wikilink missing[^>]*>Later</);
});

test('graph, explorer and previews are worked out once per change: every write bumps the site revision', async () => {
  await put('a.md', '# A\n\n[[b]]');
  await put('b.md', '# B');
  const r0 = store.revision;
  const g = store.graph(null, { views: false });
  assert.equal(store.graph(null, { views: false }).nodes, g.nodes); // the same nodes: kept, not worked out again
  assert.equal(store.explorer(null), store.explorer(null));
  await req('POST', '/api/artifacts/b.md/visibility?to=private', { token: admin });
  assert.ok(store.revision > r0);
  assert.notEqual(store.graph(null, { views: false }).nodes, g.nodes);
  assert.deepEqual(await graphEdges(), []); // b.md is private now: no edge for anonymous viewers
  for (const write of [
    () => req('POST', '/api/tags', { token: admin, body: '{"pages":["a.md"],"add":["x"]}' }),
    () => req('POST', '/api/artifacts/a.md/pin', { token: admin }),
    () => req('PUT', '/api/assets/pic.png', { body: PNG, token: admin }),
    () => req('DELETE', '/api/artifacts/a.md', { token: admin }),
  ]) {
    const before = store.revision;
    await write();
    assert.ok(store.revision > before, String(write));
  }
});

test('writes use exact names: a near miss is refused, naming the page it may mean', async () => {
  const bob = (await req('POST', '/api/users', { body: '{"name":"bob"}', token: admin }))[1].token;
  await put('plugins-Backlinks.md', '# Backlinks', admin, '?name=backlinks&path=plugins/Backlinks.md');
  await put('report.html', '<title>Report</title>');
  let [s, e] = await req('DELETE', '/api/artifacts/backlinks', { token: admin });
  assert.deepEqual([s, e.error], [404, "no page is named 'backlinks'; did you mean 'plugins-Backlinks.md'?"]);
  assert.equal(store.find('plugins-Backlinks.md').state, 'active'); // untouched
  for (const [method, path] of [['POST', '/api/artifacts/report/visibility?to=private'], ['POST', '/api/artifacts/report/pin'],
    ['POST', '/api/artifacts/report/versions/1/restore'], ['POST', '/api/artifacts/report/restore'], ['DELETE', '/api/artifacts/Report.html']]) {
    [s, e] = await req(method, path, { token: admin });
    assert.deepEqual([s, e.error], [404, "no page is named 'report'; did you mean 'report.html'?".replace("'report'", `'${path.split('/')[3]}'`)], path);
  }
  assert.match((await req('POST', '/api/tags', { token: admin, body: '{"pages":["report"],"add":["x"]}' }))[1].results[0].error, /did you mean 'report.html'/);
  // A new name that another page answers to: refused, so "report" can't become a second, public page.
  [s, e] = await put('report', '<p>meant to update report.html</p>');
  assert.equal(s, 409);
  assert.match(e.error, /no page is named 'report', but 'report.html' answers to that name: did you mean 'report.html'\?/);
  assert.equal((await put('REPORT.HTML', '<p>x</p>'))[0], 409); // case alone
  assert.equal((await put('backlinks', '<p>x</p>'))[0], 409); // a note's file name
  assert.equal(store.find('report').slug, 'report.html'); // nothing new was made
  assert.equal((await put('report.html', '<p>v2</p>'))[0], 200); // the exact name works
  // Someone else's private page: taken, but not whose.
  await put('diary.html', '<p>private</p>', bob, '?visibility=private');
  [s, e] = await put('diary.html', '<p>x</p>');
  assert.deepEqual([s, e.error], [409, "'diary.html' is taken; pick another file name"]);
  await put('open.html', '<p>public</p>', bob);
  assert.match((await put('open.html', '<p>x</p>'))[1].error, /taken by bob/); // a page you can see: its owner is no secret
});

test('a version from `put` or a restore keeps the bare name sync gave the page, so [[ShortName]] still finds it', async () => {
  await put('plugins-Backlinks.md', '# Backlinks v1', admin, '?name=backlinks&path=plugins/Backlinks.md');
  await put('plugins-Backlinks.md', '# Backlinks v2'); // a plain upload: no ?name=
  await req('POST', '/api/artifacts/plugins-Backlinks.md/versions/1/restore', { token: admin });
  assert.equal(store.find('plugins-Backlinks.md').name_key, 'backlinks');
  await put('Uses.md', '# Uses\n\n[[Backlinks]]');
  assert.match((await req('GET', '/pages/Uses.md'))[1], /<a class="wikilink" href="\/pages\/plugins-Backlinks.md">Backlinks<\/a>/);
});

test('Markdown links to other files of a synced folder go to their pages, #sections kept', async () => {
  await put('finance-profile.md', '# Profile\n\n## Savings', admin, '?name=profile&path=finance/profile.md');
  await put('finance.md', '# Finance', admin, '?name=finance&path=finance/index.md');
  await put('health-README.md', '# Health\n\nSee [the profile](../finance/profile.md#savings), [finance](../finance/index.md),'
    + ' [from the top](/finance/profile.md), [a sibling](other.md) and [100%](100%.md).', admin, '?name=readme&path=health/README.md');
  const [s, page] = await req('GET', '/pages/health-README.md');
  assert.equal(s, 200); // a stray % is no error
  assert.match(page, /<a href="\/pages\/finance-profile.md#savings">the profile<\/a>/);
  assert.match(page, /<a href="\/pages\/finance.md">finance<\/a>/); // a folder's index.md is the folder's page
  assert.match(page, /<a href="\/pages\/finance-profile.md">from the top<\/a>/);
  assert.match(page, /<a href="\/pages\/health-other.md">a sibling<\/a>/); // not written yet: where it would be
  assert.deepEqual(backlinksOf('finance-profile.md'), ['health-README.md']);
  assert.deepEqual(await graphEdges(), ['health-README.md>finance-profile.md', 'health-README.md>finance.md']);
});

test('notes and pages in any script: Unicode names upload, link and serve', async () => {
  let [s, a] = await put(encodeURIComponent('Über-uns.md'), '# Über uns');
  assert.deepEqual([s, a.slug], [201, 'Über-uns.md']);
  [s, a] = await put(encodeURIComponent('日本語-メモ.md'), '# メモ\n\n[[Über uns]]');
  assert.equal(s, 201);
  const [, page] = await req('GET', `/pages/${encodeURIComponent('日本語-メモ.md')}`);
  assert.match(page, /<a class="wikilink" href="\/pages\/Über-uns.md">Über uns<\/a>/);
  assert.deepEqual(backlinksOf('Über-uns.md'), ['日本語-メモ.md']);
  assert.equal((await req('GET', `/pages/${encodeURIComponent('über-uns')}`))[0], 200); // any case, no extension
});

test('assets are served only to those who may see them', async () => {
  const bob = (await req('POST', '/api/users', { body: '{"name":"bob"}', token: admin }))[1].token;
  await req('PUT', '/api/assets/secret.png', { body: PNG, token: admin });
  await req('PUT', '/api/assets/shared.pdf', { body: Buffer.from('%PDF-1.4 shared'), token: admin });
  const [, priv] = await put('Private.md', '# Private\n\n![[secret.png]] and [[shared.pdf]]', admin, '?visibility=private');
  const get = (name, opts) => req('GET', `/assets/${name}`, { raw: true, ...opts });

  assert.equal((await get('secret.png'))[0], 404); // only a private page shows it
  assert.equal((await get('secret.png', { token: bob }))[0], 404);
  assert.equal((await get('secret.png', { token: admin }))[0], 200); // its uploader
  const share = priv.share_url.slice(3);
  assert.equal((await get(`secret.png?from=${share}`))[0], 200); // through the private page's share link
  assert.match((await req('GET', priv.share_url))[1], /href="\/assets\/shared.pdf\?from=[\w-]+"/); // which its links carry
  assert.equal((await get(`secret.png?from=nope`))[0], 404);

  // Naming someone else's file in your own public page doesn't publish it, or show it there.
  const [, bobs] = await put('Bobs.md', '# Bob\n\n![[secret.png]]', bob);
  assert.equal((await get('secret.png'))[0], 404);
  assert.match((await req('GET', bobs.url))[1], /<span class="embed missing" title="Not uploaded">secret.png<\/span>/);
  // A public page of the uploader's that shows it does.
  await put('Public.md', '# Public\n\n[[shared.pdf]]');
  assert.equal((await get('shared.pdf'))[0], 200);
  assert.equal((await get('secret.png'))[0], 404);

  // The list: your own assets; an admin sees all; nobody anonymously.
  await req('PUT', '/api/assets/bobs.png', { body: PNG, token: bob });
  assert.deepEqual((await req('GET', '/api/assets', { token: bob }))[1].map((x) => x.name), ['bobs.png']);
  assert.deepEqual((await req('GET', '/api/assets', { token: admin }))[1].map((x) => x.name), ['bobs.png', 'secret.png', 'shared.pdf']);
  assert.equal((await req('GET', '/api/assets'))[0], 401);
});

test('responses: nosniff on text, Vary always, favicon.ico and robots.txt answered without a lookup', async () => {
  await put('page.html', '<p>tiny</p>');
  for (const path of ['/api/tags', '/pages/page.html', '/docs.md', '/_static/style.css']) {
    const [, , h] = await req('GET', path);
    assert.equal(h.get('x-content-type-options'), 'nosniff', path);
    assert.equal(h.get('vary'), 'Accept-Encoding', path); // also when this response wasn't gzipped
  }
  for (const path of ['/favicon.ico', '/robots.txt']) {
    const [s, body, h] = await req('GET', path);
    assert.deepEqual([s, body, h.get('cache-control')], [404, { error: 'not found' }, 'public, max-age=86400'], path);
  }
  assert.equal((await req('GET', '/assets/x.png', { raw: true }))[2].get('vary'), 'Accept-Encoding'); // not text, still Vary
});

test('a framed page with no <head> keeps its doctype first (no quirks mode)', async () => {
  await put('bare.html', '<!doctype html><p>no head here</p>');
  const r = await fetch(`${base}/pages/bare.html?embed=1`, { headers: { 'user-agent': BROWSER } });
  assert.match(await r.text(), /^<!doctype html><meta name="responsive-embedded-sizing" content="allow-origins=\*"><p>no head here/);
});

test('tagging checks the 20-tag limit before writing anything', async () => {
  const many = Array.from({ length: 19 }, (_, i) => `t${i}`);
  await put('full.html', '<p>x</p>');
  await req('POST', '/api/tags', { token: admin, body: JSON.stringify({ pages: ['full.html'], add: many }) });
  const [, r] = await req('POST', '/api/tags', { token: admin, body: JSON.stringify({ pages: ['full.html'], add: ['a1', 'a2'] }) });
  assert.match(r.results[0].error, /at most 20 tags per page/);
  assert.equal((await req('GET', '/api/artifacts/full.html'))[1].tags.length, 19); // nothing was added
});

test('stats: each of the last 30 days once across a DST change, counted from local midnight', async (t) => {
  const tz = process.env.TZ;
  process.env.TZ = 'America/Los_Angeles';
  t.after(() => { if (tz === undefined) delete process.env.TZ; else process.env.TZ = tz; });
  await put('seen.html', '<p>x</p>');
  const id = store.find('seen.html').id;
  const at = (local) => new Date(local).getTime() / 1000; // local times, read in TZ
  store.run("INSERT INTO views (artifact_id, n, at, visitor, via) VALUES (?, 1, ?, 'a', 'url')", id, at('2026-10-02T23:45')); // a 31st day back
  store.run("INSERT INTO views (artifact_id, n, at, visitor, via) VALUES (?, 1, ?, 'b', 'url')", id, at('2026-10-03T00:15'));
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-01T23:30') }); // the day the clocks went back: 25 hours long
  const s = store.stats(null);
  const days = s.views_by_day.map((d) => d.day);
  assert.equal(new Set(days).size, 30);
  assert.deepEqual([days[0], days.at(-1)], ['2026-10-03', '2026-11-01']);
  assert.equal(s.totals.views_recent, 1); // from midnight on the first day, not 30 × 24 hours before now
  t.mock.timers.setTime(new Date('2026-03-09T00:30').getTime()); // just after midnight following a 23-hour day
  assert.deepEqual(store.stats(null, { days: 3 }).views_by_day.map((d) => d.day), ['2026-03-07', '2026-03-08', '2026-03-09']);
});

test('the usage chart keeps today in the morning too (its days were compared as times)', async (t) => {
  const tz = process.env.TZ;
  process.env.TZ = 'America/Los_Angeles';
  t.after(() => { if (tz === undefined) delete process.env.TZ; else process.env.TZ = tz; });
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-28T09:00') });
  store.recordApiCall({ client: 'cli', name: 'ls', method: 'GET', route: '/api/artifacts', status: 200 });
  const u = store.usage({ days: 30 });
  assert.equal(u.series.length, 30);
  assert.deepEqual(u.series.at(-1), { period: '2026-10-28', mcp: 0, cli: 1, browser: 0, http: 0 });
});

test('search puts pages with the words in their title first, in whatever order is chosen', async () => {
  await put('ticket.html', '<title>ACC-18: login times out</title><p>The session expires after 5 minutes.</p>');
  await put('ticket-2.html', '<title>ACC 18 follow-up</title><p>Shorter sessions.</p>'); // the words, not the whole query
  for (let i = 0; i < 8; i++) { // newer, busier pages that mention the ticket in their text
    await put(`board-${i}.html`, `<title>Sprint board ${i}</title><p>ACC-17, ACC-18 and ACC-19. ACC-18 is blocked; ACC-180 next.</p>`);
    await req('GET', `/pages/board-${i}.html`);
  }
  const top = async (qs) => (await req('GET', `/api/search?q=ACC-18&${qs}`))[1].results.slice(0, 3).map((a) => a.slug);
  assert.deepEqual(await top(''), ['ticket.html', 'ticket-2.html', 'board-0.html']); // best match
  for (const sort of ['updated', 'created', 'views', 'title']) {
    assert.deepEqual((await top(`sort=${sort}`)).slice(0, 2), ['ticket.html', 'ticket-2.html'], sort); // titles first in any order
  }
  assert.deepEqual(await top('sort=updated'), ['ticket.html', 'ticket-2.html', 'board-7.html']); // then the order chosen
  const [, cards] = await req('GET', '/?q=ACC-18&sort=updated&fragment=1'); // the home page, with a sort it remembered
  assert.match(cards, /^[^]*?href="\/pages\/ticket\.html"/);
  assert.equal(cards.indexOf('href="/pages/ticket.html"') < cards.indexOf('href="/pages/board-7.html"'), true);
});

test('diffs: big versions with a few changes are quick; versions too far apart say so instead of using GBs', async () => {
  const lines = (prefix, n) => Array.from({ length: n }, (_, i) => `<p>${prefix} ${i}</p>`).join('\n');
  await put('long.html', lines('line', 40000));
  await put('long.html', lines('line', 40000).replace('<p>line 100</p>', '<p>changed</p>').replace('<p>line 39900</p>', '<p>also changed</p>'));
  let t0 = performance.now();
  const [s, diff] = await req('GET', '/api/artifacts/long.html/diff');
  assert.equal(s, 200);
  assert.match(diff, /-line 100\n\+changed/);
  assert.match(diff, /-line 39900\n\+also changed/);
  assert.ok(performance.now() - t0 < 2000);
  await put('long.html', lines('other', 40000)); // every line differs
  t0 = performance.now();
  const [s2, e] = await req('GET', '/api/artifacts/long.html/diff');
  assert.deepEqual([s2, e.error], [422, 'too many changes to show: these versions differ almost everywhere; compare their sources instead']);
  assert.ok(performance.now() - t0 < 5000);
  const [s3, page] = await req('GET', '/review/long.html/changes');
  assert.equal(s3, 200);
  assert.match(page, /<p class="same">Too many changes to show/);
});
