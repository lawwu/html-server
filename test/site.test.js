// The docs site (scripts/build-site.js), built for real into a temp folder as `npm run
// site` and the Pages workflow build it, then read back: what the server drew, with
// what needs a server left out and every link relative.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { checkLinks } from '../scripts/build-site.js';
import { examples } from '../src/examples.js';
import { TOOLS } from '../src/mcp.js';
import { docsMarkdown } from '../src/pages.js';
import { ROUTES } from '../src/server.js';

const SCRIPT = new URL('../scripts/build-site.js', import.meta.url).pathname;
const ROOT = new URL('..', import.meta.url).pathname;
let dir, site;

/** Run the build; resolves { code, out, err }. */
function build(out) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [SCRIPT, out]);
    let stdout = '', err = '';
    p.stdout.on('data', (d) => { stdout += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('close', (code) => resolve({ code, out: stdout, err }));
  });
}
const read = (f) => readFileSync(join(site, f), 'utf8');
const data = (html, id) => JSON.parse(html.match(new RegExp(`<script id="${id}" type="application/json">(.*?)</script>`, 's'))[1]);

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'html-server-site-'));
  site = join(dir, 'site');
  const r = await build(site);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^built the docs site: \d+ files/);
});
after(() => rmSync(dir, { recursive: true, force: true }));

test('the README is the home page, as a note: explorer, graph, previews, backlinks', () => {
  const home = read('index.html');
  assert.match(home, /<h1 class="article-title">HTML Server<\/h1>/);
  assert.match(home, /<ul class="tree"><li><a href="changelog.html" target="_top">Changelog<\/a><\/li><li><a href="index.html" target="_top" class="on"/);
  assert.match(home, /<a href="changelog.html"><code>CHANGELOG\.md<\/code><\/a>/); // the README's own link to the file
  assert.match(home, /<a href="https:\/\/github\.com\/lawwu\/html-server\/blob\/main\/LICENSE">/); // a repo file: GitHub shows it
  assert.equal(data(home, 'page-source'), readFileSync(join(ROOT, 'README.md'), 'utf8')); // Copy markdown copies the file
  // Hover previews are keyed by the link's address, which public/popover.js looks up.
  const previews = data(home, 'page-previews');
  assert.deepEqual(Object.keys(previews), ['changelog.html']);
  assert.match(previews['changelog.html'].html, /<h2 id="unreleased">/);
  assert.deepEqual(data(home, 'site-graph').nodes.map((n) => n[2]).sort(), ['changelog.html', 'index.html']);
  assert.match(read('changelog.html'), /<section class="backlinks"><h3>Backlinks<\/h3><ul><li><a href="index.html" target="_top">HTML Server<\/a>/);
});

test('what needs a server is left out: search, history, comments, the graph and stats pages', () => {
  for (const f of ['index.html', 'changelog.html', 'docs.html', 'gallery/index.html']) {
    const html = read(f);
    const nav = html.match(/<nav class="side-nav"[^>]*>(.*?)<\/nav>/)[1];
    assert.deepEqual([...nav.matchAll(/>([^<]+)<\/a>/g)].map((m) => m[1]), ['Gallery', 'Docs'], f);
    for (const gone of ['class="side-search"', 'Titles only here', 'target="_top">history</a>', 'target="_top">comments</a>',
      'class="graph-expand"', '_static/gallery.js', 'id="search"']) {
      assert.ok(!html.includes(gone), `${f} has ${gone}`);
    }
  }
  assert.match(read('index.html'), /<p class="content-meta">[^<]*min read<\/p>/); // no version: the site has no history
});

test('the Docs page is the server\'s, from the code: CLI usage, MCP tools, every route', () => {
  assert.equal(read('docs.md'), docsMarkdown('http://127.0.0.1:8765', ROUTES, { tools: TOOLS }));
  const docs = read('docs.html');
  assert.match(docs, /<link rel="stylesheet" href="_static\/style\.css"><link rel="stylesheet" href="_static\/note\.css">/);
  assert.match(docs, /HTML Server v[\d.]+ · <a href="docs\.md">Markdown<\/a>/);
  assert.match(docs, /This page is Markdown: <a href="docs\.md">/);
  assert.match(docs, /<code>publish_page<\/code>/);
  assert.match(read('_static/style.css'), /url\(fonts\/schibsted-grotesk\.woff2\)/); // fonts beside the stylesheet
  for (const f of ['schibsted-grotesk.woff2', 'source-sans-3-italic.woff2', 'OFL-schibstedgrotesk.txt']) assert.ok(existsSync(join(site, '_static/fonts', f)), f);
});

test('the gallery: every example, its card, and the copy the card previews', () => {
  const gallery = read('gallery/index.html');
  const all = examples();
  assert.equal(all.length, 13);
  assert.equal(gallery.match(/<article class="card/g).length, all.length);
  assert.match(gallery, /<span class="tag">Featured<\/span>/); // a label: there's no filtered page to link to
  for (const e of all) {
    assert.ok(gallery.includes(`<a class="thumb" href="${e.slug}" tabindex="-1" aria-hidden="true"><iframe src="preview/${e.slug}"`), e.slug);
    const raw = readFileSync(join(ROOT, 'gallery', e.slug), 'utf8');
    assert.equal(read(`gallery/preview/${e.slug}`), raw); // as ?preview=1 serves it
    assert.ok(read(`gallery/${e.slug}`).startsWith(raw.slice(0, 200)), e.slug); // the page, with its contents sidebar when it has headings
  }
  assert.match(read('gallery/anscombes-quartet-notebook.html'), /data-artifact-toc-script/);
});

test('a rebuild empties the last build; a folder with other files in it is left alone', async () => {
  writeFileSync(join(site, 'stale.html'), 'from an older build');
  assert.equal((await build(site)).code, 0);
  assert.ok(!existsSync(join(site, 'stale.html')));
  assert.ok(existsSync(join(site, 'index.html')));

  const mine = join(dir, 'mine');
  mkdirSync(mine);
  writeFileSync(join(mine, 'notes.txt'), 'keep me');
  const r = await build(mine);
  assert.equal(r.code, 1);
  assert.match(r.err, /^error: .*mine has files this script didn't write/);
  assert.equal(readFileSync(join(mine, 'notes.txt'), 'utf8'), 'keep me');
});

test('the link check names every link the static site can\'t follow', () => {
  const d = join(dir, 'links');
  mkdirSync(join(d, 'sub'), { recursive: true });
  const graph = JSON.stringify({ current: 1, nodes: [[1, 'A', 'index.html'], [2, 'B', '/pages/b.md']], edges: [] });
  writeFileSync(join(d, 'index.html'), `<a href="/graph">graph</a> <a href="missing.html">x</a> <a href="#top">top</a>
<a href="https://example.com/">out</a> <img src="data:image/png;base64,AA"> <a href="sub/ok.html?v=1#a">ok</a>
<link rel="stylesheet" href="site.css"><script>const s = '<a href="/review/x">';</script>
<script id="site-graph" type="application/json">${graph}</script>`);
  writeFileSync(join(d, 'sub/ok.html'), '<a href="../index.html">home</a>');
  writeFileSync(join(d, 'site.css'), '@font-face { src: url(fonts/gone.woff2) } a { background: url("data:image/gif;base64,AA") }');
  assert.throws(() => checkLinks(d), (e) => {
    assert.equal(e.message, "links the static site can't follow:\n  index.html: /graph\n  index.html: missing.html\n  index.html: /pages/b.md\n  site.css: fonts/gone.woff2");
    return true;
  });
});
