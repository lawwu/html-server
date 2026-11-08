#!/usr/bin/env node
// The docs site, for GitHub Pages (.github/workflows/pages.yml), drawn by HTML Server
// itself: README.md and CHANGELOG.md as notes, the Docs page, and the example gallery.
// Each page is what the server's own request handler answers (in this process, the way
// cloudflare/worker.js hands it requests, over a throwaway database holding the two
// notes), saved as a file, keeping rendering shared with the server. setStaticSite
// (src/pages.js) leaves out what needs a server, and every link is made relative, so
// the site works under any path, such as https://lawwu.github.io/html-server/. Then
// static attributes, CSS URLs and generated link data are checked, including fragments.
//
//   npm run site                     → _site/
//   node scripts/build-site.js DIR
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'parse5';
import { FALLBACK_URL, REPO_URL } from '../src/config.js';
import { examples } from '../src/examples.js';
import { safeDecode } from '../src/markdown.js';
import { setStaticSite } from '../src/pages.js';
import { handleRequest } from '../src/server.js';
import { Store } from '../src/store.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const NOTES = ['README.md', 'CHANGELOG.md'];
// Left in a folder this script built, so the next build may empty it. A dotfile, so
// Pages doesn't publish it (actions/upload-pages-artifact leaves dotfiles out).
const MARK = '.html-server-site';
// The server the Docs page's examples talk to: the one a fresh install runs.
const HOST = new URL(FALLBACK_URL).host;

const fail = (msg) => { throw Object.assign(new Error(msg), { expected: true }); };

/** The site: each server URL it has → the file that holds it. */
function siteMap() {
  return new Map([
    ['/pages/README.md', 'index.html'],
    ['/pages/CHANGELOG.md', 'changelog.html'],
    ['/docs', 'docs.html'],
    ['/docs.md', 'docs.md'],
    ['/about', 'about.html'],
    ['/about.md', 'about.md'],
    ['/gallery', 'gallery/index.html'],
    // Each example, and the copy its gallery card shows (?preview=1: no contents sidebar).
    ...examples().flatMap((e) => [[e.url, `gallery/${e.slug}`], [`${e.url}?preview=1`, `gallery/preview/${e.slug}`]]),
  ]);
}

/** One GET through the server's request handler: { status, type, body }. */
function get(store, url) {
  return new Promise((done, failed) => {
    const req = { method: 'GET', url, headers: { host: HOST }, socket: { remoteAddress: '' } };
    const res = {
      headersSent: false,
      writeHead(status, headers) { Object.assign(this, { status, headers, headersSent: true }); },
      end(body) { done({ status: this.status, type: this.headers['Content-Type'] || '', body: Buffer.from(body ?? '') }); },
    };
    handleRequest(store, req, res).catch(failed);
  });
}

/**
 * Links made relative to `from` (a file of the site): the server's own paths in
 * attributes and CSS url()s. A link the site doesn't have stays as it is, for the
 * link check to report. `site` maps URLs to files; `used` collects the _static files.
 */
export function linker(from, site, used) {
  /** Where a link to the server goes on the site: one of its files, a file of the repo on GitHub, or null. */
  const locate = (path) => {
    if (site.has(path)) return site.get(path);
    if (path === '/') return 'index.html'; // the title and breadcrumbs: home
    const file = path.match(/^\/_static\/((?:fonts\/)?[\w.-]+)$/)?.[1];
    if (file && existsSync(join(ROOT, 'public', file))) {
      used.add(file);
      return `_static/${file}`;
    }
    // The README links to files of the repo (`[LICENSE](LICENSE)`): GitHub shows them.
    const repo = path.match(/^\/pages\/([\w.-]+)$/)?.[1];
    if (repo && existsSync(join(ROOT, repo))) return `${REPO_URL}/blob/main/${repo}`;
    return null;
  };
  const to = (url) => {
    const at = url.indexOf('#');
    const [u, hash] = at === -1 ? [url, ''] : [url.slice(0, at), url.slice(at)];
    const target = locate(u.replace(/&amp;/g, '&'));
    if (!target) return url;
    return /^https?:/.test(target) ? target + hash : posix.relative(posix.dirname(from), target) + hash;
  };
  const css = (text) => text.replace(/url\(\s*(['"]?)(\/(?!\/)[^)'"\s]+)\1\s*\)/g, (m, quote, url) => `url(${quote}${to(url)}${quote})`);
  const markup = (text, fragmentBase = '') => {
    if (from.endsWith('.css')) return css(text);
    const replacements = [];
    for (const node of elements(parse(text, { sourceCodeLocationInfo: true }))) {
      for (const attr of node.attrs || []) {
        if (!['href', 'src', 'action', 'style'].includes(attr.name)) continue;
        const value = attr.name === 'style' ? css(attr.value) : fragmentBase && attr.value.startsWith('#') ? fragmentBase + attr.value : /^\/(?!\/)/.test(attr.value) ? to(attr.value) : attr.value;
        if (value === attr.value) continue;
        const loc = node.sourceCodeLocation?.attrs?.[attr.name];
        if (loc) replacements.push([loc.startOffset, loc.endOffset, `${attr.name}="${value.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}"`]);
      }
      if (node.tagName === 'style') for (const child of node.childNodes || []) {
        const loc = child.sourceCodeLocation;
        if (loc && child.value) replacements.push([loc.startOffset, loc.endOffset, css(child.value)]);
      }
    }
    for (const [start, end, value] of replacements.sort((a, b) => b[0] - a[0])) text = text.slice(0, start) + value + text.slice(end);
    return text;
  };
  /**
   * A page: its markup outside scripts, and the URLs in the two kinds of data a note
   * carries, its graph (each page's URL) and its hover previews (keyed by page name,
   * which public/popover.js finds by a link's address when it isn't /pages/<name>).
   */
  const page = (html) => html.split(/(<script\b[^>]*>[\s\S]*?<\/script>)/i).map((part, i) => {
    if (i % 2 === 0) return markup(part);
    const [, id, json] = part.match(/^<script id="(site-graph|page-previews)" type="application\/json">([\s\S]*)<\/script>$/) || [];
    if (!id) return part; // code, and the note's own source (its copy button): left as they are
    const data = JSON.parse(json);
    const out = id === 'site-graph'
      ? { ...data, nodes: data.nodes.map(([n, title, url]) => [n, title, to(url)]) }
      : Object.fromEntries(Object.entries(data).map(([slug, p]) => [to(`/pages/${slug}`), p.html ? { ...p, html: markup(p.html, to(`/pages/${slug}`)) } : p]));
    return `<script id="${id}" type="application/json">${JSON.stringify(out).replace(/</g, '\\u003c')}</script>`;
  }).join('');
  return { markup, page };
}

/** An empty folder to build in: a new one, or an earlier build's (MARK) emptied. Anything else is left alone. */
function prepare(out) {
  if (existsSync(out)) {
    if (!statSync(out).isDirectory()) fail(`${out} isn't a folder`);
    const entries = readdirSync(out);
    if (entries.length && !entries.includes(MARK)) fail(`${out} has files this script didn't write; build into a new or empty folder`);
    for (const e of entries) rmSync(join(out, e), { recursive: true, force: true });
  }
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, MARK), 'The docs site, built by scripts/build-site.js. The next build empties this folder.\n');
}

function write(out, file, body) {
  mkdirSync(dirname(join(out, file)), { recursive: true });
  writeFileSync(join(out, file), body);
}

/** Build the site into `out`; returns the files written. */
export async function buildSite(out) {
  out = resolve(out);
  prepare(out);
  const site = siteMap();
  const used = new Set();
  setStaticSite(true);
  const store = new Store(':memory:');
  try {
    const owner = store.userForToken(store.createUser('html-server')).id;
    for (const f of NOTES) store.putVersion(owner, f, readFileSync(join(ROOT, f)));
    for (const [url, file] of site) {
      const r = await get(store, url);
      if (r.status !== 200) fail(`${url}: the server answered ${r.status} ${r.body}`);
      write(out, file, r.type.startsWith('text/html') ? linker(file, site, used).page(r.body.toString('utf8')) : r.body);
    }
  } finally {
    store.close();
    setStaticSite(false);
  }
  // The styles and fonts the pages use; a stylesheet's fonts are its links too.
  for (const file of used) {
    const body = readFileSync(join(ROOT, 'public', file));
    write(out, `_static/${file}`, file.endsWith('.css') ? linker(`_static/${file}`, site, used).markup(body.toString('utf8')) : body);
  }
  // The fonts' licences go with them (SIL Open Font License).
  if ([...used].some((f) => f.startsWith('fonts/'))) {
    for (const f of readdirSync(join(ROOT, 'public/fonts')).filter((x) => x.endsWith('.txt'))) {
      write(out, `_static/fonts/${f}`, readFileSync(join(ROOT, 'public/fonts', f)));
    }
  }
  checkLinks(out);
  return files(out);
}

/** Every file under `dir`, as site paths ("gallery/index.html"), but the build's own MARK. */
function files(dir) {
  const all = [];
  (function walk(d) {
    for (const f of readdirSync(join(dir, d)).sort()) {
      const rel = d ? `${d}/${f}` : f;
      if (statSync(join(dir, rel)).isDirectory()) walk(rel);
      else if (rel !== MARK) all.push(rel);
    }
  })('');
  return all;
}

function* elements(node) {
  if (node.tagName) yield node;
  for (const child of node.childNodes || []) yield* elements(child);
  if (node.content) yield* elements(node.content); // template contents
}
const cssLinks = (text) => [...text.matchAll(/url\(\s*['"]?([^'")]*)/g)].map((m) => m[1].trim());

/** Browser-parsed static attributes, CSS URLs, and generated graph/preview data. */
function links(text, file) {
  if (file.endsWith('.css')) return cssLinks(text);
  const out = [];
  for (const node of elements(parse(text))) {
    const attrs = Object.fromEntries((node.attrs || []).map((a) => [a.name, a.value]));
    for (const name of ['href', 'src', 'action']) if (attrs[name] != null) out.push(attrs[name]);
    if (attrs.style) out.push(...cssLinks(attrs.style));
    const body = (node.childNodes || []).map((n) => n.value || '').join('');
    if (node.tagName === 'style') out.push(...cssLinks(body));
    if (node.tagName !== 'script' || attrs.type !== 'application/json') continue;
    if (attrs.id === 'site-graph') out.push(...JSON.parse(body).nodes.map((n) => n[2]));
    if (attrs.id === 'page-previews') {
      for (const [key, p] of Object.entries(JSON.parse(body))) out.push(key, ...links(p.html || '', file));
    }
  }
  return out;
}

/**
 * Follow every link in the site's pages and stylesheets: each must be a file of the site,
 * a place on the same page, or another site. A link to the server (/…) wouldn't work
 * under a project path, and one to what the site doesn't have (search, history, a page
 * it leaves out) would be a 404: either fails, naming the page and the link.
 */
export function checkLinks(dir) {
  const all = files(dir);
  const have = new Set(all);
  const bad = [];
  const anchors = new Map();
  const hasAnchor = (file, hash) => {
    if (!anchors.has(file)) {
      const found = new Set();
      for (const node of elements(parse(readFileSync(join(dir, file), 'utf8')))) {
        for (const attr of node.attrs || []) if (attr.name === 'id' || (node.tagName === 'a' && attr.name === 'name')) found.add(attr.value);
      }
      anchors.set(file, found);
    }
    return anchors.get(file).has(hash);
  };
  for (const file of all.filter((f) => /\.(html|css)$/.test(f))) {
    for (const raw of links(readFileSync(join(dir, file), 'utf8'), file)) {
      const url = raw.trim();
      if (!url || /^([a-z][a-z0-9+.-]*:|\/\/)/i.test(url)) continue;
      const path = safeDecode(url.split(/[?#]/)[0]);
      let target = path ? posix.normalize(posix.join(posix.dirname(file), path)) : file;
      if (path.endsWith('/')) target = posix.join(target, 'index.html');
      const hash = safeDecode(url.includes('#') ? url.slice(url.indexOf('#') + 1) : '');
      if (url.startsWith('/') || !have.has(target)
          || (hash && !/^top$|^:~:text=/i.test(hash) && target.endsWith('.html') && !hasAnchor(target, hash))) bad.push(`${file}: ${url}`);
    }
  }
  if (bad.length) fail(`links the static site can't follow:\n  ${[...new Set(bad)].join('\n  ')}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  const out = process.argv[2] || '_site';
  buildSite(out).then((written) => {
    const kb = written.reduce((n, f) => n + statSync(join(resolve(out), f)).size, 0) / 1024;
    console.log(`built the docs site: ${written.length} files (${Math.round(kb)} KB) in ${out}`);
  }).catch((e) => {
    console.error(`error: ${e.expected ? e.message : e.stack}`);
    process.exit(1);
  });
}
