#!/usr/bin/env node
// html-server: one command line for running the server and for using it.
//
// Server commands work on the database directly (no token needed; you need shell
// access to the machine). Client commands talk to a running server over HTTP.
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { createInterface } from 'node:readline/promises';
import { basename, dirname, join, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { ClientError, SERVER, api, creds, saveCredentials, setClient, token } from './client.js';
import { PAGE_EXT_RE, VERSION } from './config.js';
import { usage } from './usage.js';
import { BACKUP_DIR, CREDENTIALS_FILE, DEFAULT_DB, DEFAULT_HOST, DEFAULT_PORT, FALLBACK_URL, HOME_DIR } from './config.js';


const USAGE = usage({ backupDir: BACKUP_DIR, homeDir: HOME_DIR, server: SERVER });

const CliError = ClientError; // CLI mistakes and API errors print the same way
const PRUNE_PAGE = 500; // pages per request when `sync --prune` lists a folder's pages (the server's most)
const fail = (msg) => { throw new CliError(msg); };

// --- server commands --------------------------------------------------------------
async function openStore(db) {
  mkdirSync(dirname(db), { recursive: true, mode: 0o700 });
  const { Store } = await import('./store.js'); // loaded lazily: client commands don't need SQLite
  return new Store(db);
}

/** --save: sign this CLI in as the user just made, on this machine's server. */
function saveForCli(tok, opts) {
  saveCredentials(creds.url || localUrl(opts), tok);
  console.error(`this CLI is now signed in as that user (${CREDENTIALS_FILE})`);
}
const localUrl = (opts) => `http://${opts.host === '0.0.0.0' ? '127.0.0.1' : opts.host}:${opts.port}`;

/** A local-account name that passes the default username rule, e.g. "Lawrence.Wu" → "lawrence-wu". */
export function defaultAdminName() {
  let n = '';
  try { n = userInfo().username; } catch { /* no OS user */ }
  n = n.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^[^a-z0-9]+|-+$/g, '').slice(0, 40);
  return n || 'admin';
}

/**
 * First run on an empty database: make an admin named after the OS account and,
 * if this CLI isn't signed in anywhere yet, sign it in. Nothing to set up by hand.
 */
function bootstrap(store, opts) {
  if (store.listUsers().length) return;
  if (store.usernames !== 'name') {
    console.error('no users yet: create the first admin with `html-server create-user EMAIL --admin --save`');
    return;
  }
  const name = defaultAdminName();
  const tok = store.createUser(name, true);
  if (creds.token) {
    console.error(`first run: created admin '${name}'. Its token (shown once): ${tok}`);
  } else {
    saveCredentials(localUrl(opts), tok);
    console.error(`first run: created admin '${name}' and signed this CLI in (${CREDENTIALS_FILE})`);
  }
}

const serverCommands = {
  async serve(args, opts) {
    const sandboxAllow = opts['sandbox-allow'] ?? [];
    const { renderCsp } = await import('./config.js');
    let csp;
    try { csp = renderCsp(sandboxAllow); } catch (e) { fail(e.message); }
    if (sandboxAllow.includes('allow-same-origin')) {
      console.error('warning: allow-same-origin with allow-scripts lets every page\'s scripts act as this site:'
        + ' read the token a reviewer saved in the browser, call the API as them, and lift their own sandbox.'
        + ' Only use it if you trust every page on this server.');
    }
    if (sandboxAllow.length) console.error(`pages are served with: ${csp}`);
    const store = await openStore(opts.db);
    bootstrap(store, opts);
    const { makeServer } = await import('./server.js');
    makeServer(store, { sandboxAllow }).listen(Number(opts.port), opts.host, () =>
      console.error(`html-server ${VERSION} on http://${opts.host}:${opts.port}  (db: ${opts.db})`));
  },
  async 'create-user'([name], opts) {
    if (!name) fail('usage: create-user NAME [--admin] [--save]');
    const token = (await openStore(opts.db)).createUser(name, opts.admin);
    console.log(token);
    if (opts.save) saveForCli(token, opts);
  },
  async 'reset-token'([name], opts) {
    if (!name) fail('usage: reset-token NAME [--save]');
    const token = (await openStore(opts.db)).resetToken(name);
    console.log(token);
    if (opts.save) saveForCli(token, opts);
  },
  /**
   * A consistent copy of the database, safe while the server is running: SQLite's
   * VACUUM INTO on a read-only connection, so the live file is never written. The
   * copy is checked before we report success. Restore: stop the server, copy the
   * backup over the database file, start it again.
   */
  async backup([target], opts) {
    if (!existsSync(opts.db)) fail(`no database at ${opts.db}`);
    const stamp = new Date().toLocaleString('sv-SE').replace(' ', 'T').replace(/:/g, ''); // 2026-10-20T121314, local time
    let out;
    if (!target || (existsSync(target) && statSync(target).isDirectory())) {
      const dir = target || BACKUP_DIR;
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      out = join(dir, `artifacts-${stamp}.db`);
      for (let i = 2; existsSync(out); i++) out = join(dir, `artifacts-${stamp}-${i}.db`);
    } else {
      out = target;
      if (existsSync(out)) fail(`${out} already exists; not overwriting it`);
      mkdirSync(dirname(out), { recursive: true, mode: 0o700 });
    }
    const { DatabaseSync } = await import('node:sqlite');
    const src = new DatabaseSync(opts.db, { readOnly: true });
    try { src.prepare('VACUUM INTO ?').run(out); } finally { src.close(); }
    chmodSync(out, 0o600);

    const copy = new DatabaseSync(out, { readOnly: true });
    let check, pages, versions;
    try {
      check = copy.prepare('PRAGMA integrity_check').get().integrity_check;
      pages = copy.prepare('SELECT COUNT(*) AS n FROM artifacts').get().n;
      versions = copy.prepare('SELECT COUNT(*) AS n FROM versions').get().n;
    } finally { copy.close(); }
    if (check !== 'ok') { rmSync(out); fail(`backup failed its integrity check (${check}); nothing kept`); }
    const kb = (statSync(out).size / 1024).toFixed(0);
    console.log(`backed up ${pages} pages, ${versions} versions → ${out} (${kb} KB)`);

    if (opts.keep != null) {
      if (!/^\d+$/.test(opts.keep) || Number(opts.keep) < 1) fail('--keep must be a number of backups, 1 or more');
      // Only touches our own timestamped files in the backup folder, never anything else.
      const dir = dirname(out);
      const ours = readdirSync(dir)
        .filter((f) => /^artifacts-\d{4}-\d{2}-\d{2}T\d{6}(-\d+)?\.db$/.test(f))
        .map((f) => ({ f, t: statSync(join(dir, f)).mtimeMs }))
        .sort((x, y) => y.t - x.t || (y.f > x.f ? 1 : -1))
        .map(({ f }) => f); // newest first
      for (const f of ours.slice(Number(opts.keep))) {
        rmSync(join(dir, f));
        console.log(`removed old backup ${f}`);
      }
    }
  },
  async config([key, value], opts) {
    const store = await openStore(opts.db);
    if (key === 'usernames' && value) store.setUsernames(value);
    else if (key === 'editing' && value) store.setEditing(value);
    else if (key) fail('usage: config [usernames name|email] [editing owner|open]');
    console.log(`usernames: ${store.usernames}`);
    console.log(`editing:   ${store.editing}${store.editing === 'open' ? ' (any signed-in user can add versions to public pages)' : ' (only a page\'s owner adds versions)'}`);
  },
};

// --- login ------------------------------------------------------------------------
async function ask(question, fallback = '') {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try { return (await rl.question(fallback ? `${question} [${fallback}]: ` : `${question}: `)).trim() || fallback; } finally { rl.close(); }
}

/** Read a line without echoing it (a pasted token shouldn't land in the scrollback). */
function askHidden(question) {
  return new Promise((resolve) => {
    const { stdin, stdout } = process;
    stdout.write(`${question}: `);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let s = '';
    const onData = (chunk) => {
      for (const c of chunk) {
        if (c === '\r' || c === '\n') {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off('data', onData);
          stdout.write('\n');
          return resolve(s.trim());
        }
        if (c === '\u0003') { stdout.write('\n'); process.exit(130); } // Ctrl-C
        s = c === '\u007f' ? s.slice(0, -1) : s + c; // backspace
      }
    };
    stdin.on('data', onData);
  });
}

const deployCommands = {
  async deploy(args, opts) {
    if (args[0] !== 'cloudflare') fail('usage: html-server deploy cloudflare [--name NAME] [--user NAME]  (more targets may come; any machine with Node runs `serve`)');
    const { deployCloudflare } = await import('./deploy.js');
    await deployCloudflare({ name: opts.name, user: opts.user || defaultAdminName(), fail });
  },
};

const mcpCommands = {
  async mcp() {
    const { serveStdio } = await import('./mcp.js');
    serveStdio();
    await new Promise(() => {}); // runs until the app closes stdin
  },
};

const accountCommands = {
  async login(args, opts) {
    const tty = process.stdin.isTTY;
    let url = opts.url || (tty ? await ask('Server URL', creds.url || FALLBACK_URL) : creds.url || FALLBACK_URL);
    url = url.replace(/\/+$/, '');
    if (!/^https?:\/\//.test(url)) url = `http://${url}`;
    const tok = (opts.token || (tty ? await askHidden('Token (typing is hidden)') : '')).trim();
    if (!tok) fail('no token given: use --token TOKEN, or run login in a terminal to be asked');
    let r;
    try { r = await fetch(`${url}/api/me`, { headers: { Authorization: `Bearer ${tok}` } }); } catch { fail(`can't reach ${url}`); }
    if (r.status === 401) fail(`that token isn't valid on ${url}; nothing saved`);
    if (!r.ok) fail(`${url} answered ${r.status}; is it an html-server?`);
    const me = await r.json();
    saveCredentials(url, tok);
    console.log(`signed in as ${me.name}${me.is_admin ? ' (admin)' : ''} on ${url}`);
    console.log(`saved to ${CREDENTIALS_FILE} (only you can read it)`);
  },
  async logout() {
    if (!existsSync(CREDENTIALS_FILE)) return console.log('not signed in');
    rmSync(CREDENTIALS_FILE);
    console.log(`signed out of ${creds.url || 'the server'}`);
  },
};

// --- client commands -------------------------------------------------------------

/** Call the API. Returns parsed JSON, or text for non-JSON responses. */
const enc = encodeURIComponent;
const day = (t) => new Date(t * 1000).toLocaleDateString('en-CA');

function printList(items) {
  if (!items.length) return console.log('(nothing)');
  for (const a of items) {
    const lock = `${a.pinned ? ' [featured]' : ''}${a.visibility === 'private' ? ' [private]' : ''}`;
    console.log(`${a.slug.padEnd(40)} v${String(a.latest_version).padEnd(3)} ${String(a.views).padStart(5)} views  ${day(a.updated_at)}  ${a.owner}${lock}  ${a.title}`);
    if (a.snippet) console.log(' '.repeat(42) + a.snippet);
  }
}

function openInBrowser(url) {
  const cmd = { darwin: 'open', win32: 'explorer' }[process.platform] || 'xdg-open';
  try { spawn(cmd, [url], { stdio: 'ignore', detached: true }).on('error', () => console.log(url)).unref(); } catch { console.log(url); }
}

const clientCommands = {
  async put([file, note = ''], opts) {
    if (!file || !existsSync(file)) fail('usage: put FILE [NOTE] [--private] [--name PATH] [--folder FOLDER] [--base N]');
    const name = [opts.folder?.replace(/^\/+|\/+$/g, ''), opts.name || basename(file)].filter(Boolean).join('/'); // upload to the base name, so out/page.html works
    // The name is in the URL, so options can ride in the query string (any characters, unlike headers).
    const q = new URLSearchParams();
    if (note) q.set('note', note);
    if (opts.private) q.set('visibility', 'private');
    if (opts.base != null) {
      if (!/^\d+$/.test(opts.base)) fail('--base must be a version number');
      q.set('base', opts.base);
    }
    const a = await api('PUT', `/api/artifacts/${enc(name)}${q.size ? `?${q}` : ''}`, { body: readFileSync(file), auth: 'required' });
    console.log(`published v${a.latest_version}: ${SERVER}${a.url}`);
    console.log(`review:       ${SERVER}/review/${enc(a.slug)}`);
    if (a.visibility === 'private') console.log(`share link:   ${SERVER}${a.share_url}`);
  },
  /**
   * Bring over an existing folder of pages, e.g. from a service this replaces.
   * Each file keeps its name, so /pages/<name> (with or without .html) keeps
   * working. Safe to re-run: a file identical to the page's latest version is
   * skipped, and a changed one becomes a new version.
   */
  async mv([from, to]) {
    if (!from || !to) fail('usage: mv FROM TO (a full page path, or a folder ending in /)');
    if (to.endsWith('/')) to += from.split('/').at(-1);
    to = to.replace(/^\/+/, '');
    const { results } = await api('POST', '/api/moves', { body: JSON.stringify({ moves: [{ from, to }] }), auth: 'required', json: true });
    console.log(`${from} → ${SERVER}${results[0].url} (old links still work)`);
  },

  async import([dir], opts) {
    if (!dir || !existsSync(dir) || !statSync(dir).isDirectory()) fail('usage: import DIR [--private]');
    const files = readdirSync(dir).filter((f) => /\.html$/i.test(f) && statSync(join(dir, f)).isFile()).sort();
    if (!files.length) fail(`no .html files in ${dir}`);
    const count = { imported: 0, updated: 0, unchanged: 0, failed: 0 };
    for (const f of files) {
      const body = readFileSync(join(dir, f));
      const sha = createHash('sha256').update(body).digest('hex');
      try {
        let latest = null;
        try { latest = (await api('GET', `/api/artifacts/${enc(f)}`)).versions.at(-1); } catch (e) {
          if (e.message !== 'no such artifact') throw e;
        }
        if (latest?.sha256 === sha) { count.unchanged++; continue; }
        const q = new URLSearchParams({ note: latest ? 'imported (changed)' : 'imported' });
        if (opts.private) q.set('visibility', 'private');
        const a = await api('PUT', `/api/artifacts/${enc(f)}?${q}`, { body, auth: 'required' });
        count[latest ? 'updated' : 'imported']++;
        console.log(`${latest ? 'updated ' : 'imported'}  ${SERVER}${a.url}`);
      } catch (e) {
        count.failed++;
        console.error(`failed    ${f}: ${e.message}`);
      }
    }
    console.log(Object.entries(count).filter(([, n]) => n).map(([k, n]) => `${n} ${k}`).join(', '));
    if (count.failed) process.exitCode = 1;
  },
  async pin([name]) {
    if (!name) fail('usage: pin NAME');
    const a = await api('POST', `/api/artifacts/${enc(name)}/pin`, { auth: 'required' });
    console.log(`${a.slug} is featured at the top of ${SERVER}/`);
  },
  async unpin([name]) {
    if (!name) fail('usage: unpin NAME');
    const a = await api('DELETE', `/api/artifacts/${enc(name)}/pin`, { auth: 'required' });
    console.log(`${a.slug} is no longer featured`);
  },
  async tag([op, tag, ...names]) {
    if (!['add', 'rm'].includes(op) || !tag || !names.length) fail('usage: tag add|rm TAG NAME...');
    const body = JSON.stringify({ pages: names, [op === 'add' ? 'add' : 'remove']: [tag] });
    const { results } = await api('POST', '/api/tags', { body, auth: 'required', json: true });
    let failed = 0;
    for (const r of results) {
      if (r.error) { failed++; console.error(`failed  ${r.slug}: ${r.error}`); } else console.log(`${r.slug.padEnd(40)} ${r.tags.join(', ') || '(no tags)'}`);
    }
    if (failed) process.exitCode = 1;
  },
  async tags() {
    const tags = await api('GET', '/api/tags');
    if (!tags.length) return console.log('(no tags)');
    for (const t of tags) console.log(`${t.tag.padEnd(30)} ${t.count}`);
  },
  async history([name]) {
    if (!name) fail('usage: history NAME');
    const a = await api('GET', `/api/artifacts/${enc(name)}`);
    console.log(`${a.slug} — ${a.title} (owner: ${a.owner})`);
    for (const v of a.versions.slice().reverse()) {
      const when = new Date(v.created_at * 1000).toLocaleString('en-CA', { dateStyle: 'short', timeStyle: 'short' });
      const cur = v.n === a.latest_version ? ' (current)' : '';
      console.log(`  v${String(v.n).padEnd(4)} ${when}  ${v.author.padEnd(16)} ${v.note}${cur}`);
    }
    console.log(`changes: html-server diff ${a.slug} FROM TO   ·   ${SERVER}/history/${enc(a.slug)}`);
  },
  /**
   * Bring a Markdown knowledge base in, one way: Quartz, Obsidian, or any folder of
   * notes. Every .md, .ipynb (and .html) file under DIR becomes a page named after its file the
   * way Quartz does it, so [[wikilinks]] resolve; images and PDFs become assets that
   * notes embed. Unchanged files are skipped and changed ones become new versions, so
   * it's safe to re-run after every edit. Drafts (draft: true / publish: false) are left
   * out. In a git checkout, each new version's note is the last commit to touch it.
   *
   * Given a Quartz repo (a quartz.config.* next to content/), it syncs content/ and
   * honours the config's ignorePatterns. A folder's index.md is that folder's page.
   * --prune trashes pages that came from this folder but whose file is gone (only
   * those: pages uploaded any other way are never touched). --install-hook adds git
   * hooks so every commit and pull re-syncs in the background.
   */
  async sync([dir], opts) {
    if (!dir || !existsSync(dir) || !statSync(dir).isDirectory()) fail('usage: sync DIR [--private] [--prune] [--dry-run] [--install-hook]');
    const { noteSlug, parseFrontmatter, syncedSlug, ASSET_RE } = await import('./markdown.js');
    const { parseNotebook } = await import('./notebook.js');
    let root = resolvePath(dir);
    const quartz = quartzConfig(root);
    if (quartz) {
      root = join(root, 'content');
      console.log(`Quartz repo: syncing content/${quartz.ignore.length ? `, ignoring ${quartz.ignore.join(', ')}` : ''}`);
    }
    if (opts['install-hook']) return installHook(root, opts);
    const ignored = (rel) => (quartz?.ignore ?? []).some((pat) => globMatch(pat, rel));

    const files = [];
    (function walk(d) {
      for (const f of readdirSync(d).sort()) {
        if (f.startsWith('.') || f === 'node_modules') continue; // .obsidian, .git, .trash, …
        const p = join(d, f);
        const rel = p.slice(root.length + 1);
        if (ignored(rel)) continue;
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(md|markdown|html?|ipynb)$/i.test(f) || ASSET_RE.test(f)) files.push(p);
      }
    })(root);
    if (!files.length) fail(`no notes, pages or images under ${root}`);

    let inGit = false;
    try { inGit = execFileSync('git', ['-C', root, 'rev-parse', '--is-inside-work-tree'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() === 'true'; } catch { /* not git */ }
    const commitNote = (rel) => {
      if (!inGit) return '';
      try { return execFileSync('git', ['-C', root, 'log', '-1', '--format=%s', '--', rel], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch { return ''; }
    };

    // A source file keeps its published identity when a user moves it on the server.
    const synced = [];
    for (let offset = 0; ; offset += 500) {
      const batch = await api('GET', `/api/artifacts?source=${enc(root)}&limit=500&offset=${offset}`, { auth: 'required' });
      synced.push(...batch);
      if (batch.length < 500) break;
    }
    const bySource = new Map(synced.filter((p) => p.source_path).map((p) => [p.source_path, p]));
    const count = { new: 0, updated: 0, renamed: 0, unchanged: 0, skipped: 0, failed: 0, trashed: 0 };
    const say = (what, rel, extra = '') => console.log(`${what.padEnd(9)} ${rel}${extra}`);
    const seen = new Map(); // page name (lowercase) → file, to catch two notes that would share a URL
    const known = new Map((await api('GET', '/api/assets', { auth: 'required' })).map((a) => [a.name.toLowerCase(), a.sha256])); // yours

    for (const file of files) {
      const rel = file.slice(root.length + 1);
      const body = readFileSync(file);
      const sha = createHash('sha256').update(body).digest('hex');
      try {
        if (ASSET_RE.test(file)) { // images and PDFs: by file name, replaced when changed
          const name = basename(file).trim().replace(/\s+/g, '-');
          if (known.get(name.toLowerCase()) === sha) { count.unchanged++; continue; }
          const isNew = !known.has(name.toLowerCase());
          if (opts['dry-run']) { count[isNew ? 'new' : 'updated']++; say(isNew ? 'would add' : 'would update', rel, ` → /assets/${name}`); continue; }
          await api('PUT', `/api/assets/${enc(name)}`, { body, auth: 'required' });
          count[isNew ? 'new' : 'updated']++;
          say(isNew ? 'new' : 'updated', rel);
          continue;
        }
        if (/\.(md|markdown|ipynb)$/i.test(file)) { // drafts stay out, for notes and notebooks alike
          const { data } = /\.ipynb$/i.test(file) ? (({ front, metadata }) => ({ data: { ...metadata, ...front } }))(parseNotebook(body.toString('utf8')))
            : parseFrontmatter(body.toString('utf8'));
          if (data.draft === true || data.publish === false) { count.skipped++; say('draft', rel); continue; }
        }
        const parts = rel.split('/');
        const desired = [opts.folder?.replace(/^\/+|\/+$/g, ''), ...parts.map(noteSlug)].filter(Boolean).join('/');
        const previous = bySource.get(rel);
        let name = previous?.slug || desired;
        if (previous && opts['migrate-paths'] && name !== desired) {
          if (opts['dry-run']) say('would move', name, ` → ${desired}`);
          else await api('POST', '/api/moves', { body: JSON.stringify({ moves: [{ from: name, to: desired }] }), auth: 'required', json: true });
          name = desired;
          if (!opts['dry-run']) previous.slug = desired;
        }
        const nameKey = noteSlug(parts.at(-1)).replace(PAGE_EXT_RE, '').toLowerCase();
        if (seen.has(name.toLowerCase())) {
          count.skipped++;
          console.error(`skipped   ${rel}: same page name as ${seen.get(name.toLowerCase())} (${name}); rename one`);
          continue;
        }
        seen.set(name.toLowerCase(), rel);
        if (opts['dry-run'] && previous) seen.set(previous.slug.toLowerCase(), rel);
        // Looking a page up forgives case, so compare the name it comes back with: the same
        // name is this file's page; the same but for case is that page, its file renamed
        // (Notes.md → notes.md), which the upload renames too rather than making a second page.
        let page = null;
        try { page = await api('GET', `/api/artifacts/${enc(opts['dry-run'] && previous ? previous.slug : name)}`); } catch (e) {
          if (e.message !== 'no such artifact') throw e;
        }
        const renamed = page && page.slug !== name && page.slug.toLowerCase() === name.toLowerCase() ? page.slug : null;
        if (page?.slug !== name && !renamed) page = null; // another page answering to the name isn't this file's
        const latest = page?.versions.at(-1);
        if (latest?.sha256 === sha && !renamed) { count.unchanged++; continue; }
        const what = renamed ? 'renamed' : latest ? 'updated' : 'new';
        if (opts['dry-run']) { count[what]++; say(renamed ? 'would rename' : latest ? 'would update' : 'would add', rel, ` → /pages/${name}`); continue; }
        const q = new URLSearchParams({ note: commitNote(rel) || (renamed ? `renamed from ${renamed}` : latest ? 'synced' : 'imported'), source: root, name: nameKey, path: rel });
        if (renamed) q.set('rename_from', renamed);
        if (opts.private && !latest) q.set('visibility', 'private');
        const a = await api('PUT', `/api/artifacts/${enc(name)}?${q}`, { body, auth: 'required' });
        count[what]++;
        say(what, rel, ` → ${SERVER}${a.url}${renamed ? ` (was ${renamed})` : ''}`);
      } catch (e) {
        count.failed++;
        console.error(`failed    ${rel}: ${e.message}`);
      }
    }

    if (opts.prune && count.failed === 0) { // pages synced from this folder whose file is gone → trash (restorable)
      const mine = synced;
      for (const p of mine) {
        if (seen.has(p.slug.toLowerCase())) continue;
        if (opts['dry-run']) { count.trashed++; say('would trash', p.slug); continue; }
        try { await api('DELETE', `/api/artifacts/${enc(p.slug)}`, { auth: 'required' }); count.trashed++; say('trashed', p.slug, ' (its file is gone; restorable)'); } catch (e) {
          count.failed++;
          console.error(`failed    trashing ${p.slug}: ${e.message}`);
        }
      }
    }
    console.log(`${opts['dry-run'] ? '(dry run) ' : ''}${Object.entries(count).filter(([, n]) => n).map(([k, n]) => `${n} ${k}`).join(', ') || 'nothing to do'}`);
    if (count.failed) process.exitCode = 1;
  },
  async ls(args, opts) { printList(await api('GET', `/api/artifacts?limit=500${opts.folder ? `&folder=${enc(opts.folder)}` : ''}${opts.sort ? `&sort=${enc(opts.sort)}` : ''}`)); },
  async search(words, opts) {
    if (!words.length) fail('usage: search WORDS... [--tag TAG] [--json]');
    const q = new URLSearchParams({ q: words.join(' ') });
    if (opts.tag) q.set('tag', opts.tag);
    if (opts.folder) q.set('folder', opts.folder);
    if (opts.sort) q.set('sort', opts.sort);
    const r = await api('GET', `/api/search?${q}`);
    if (opts.json) return console.log(JSON.stringify(r, null, 2));
    if (!r.results.length) return console.log('no matches');
    for (const a of r.results) {
      console.log(`${a.title_highlight || a.title}`);
      console.log(`  ${SERVER}${a.url}  ·  v${a.latest_version}${a.tags.length ? `  ·  ${a.tags.join(', ')}` : ''}`);
      if (a.snippet) console.log(`  ${a.snippet}`);
    }
    console.log(`${r.count} match${r.count === 1 ? '' : 'es'}`);
  },
  async find(words) {
    if (!words.length) fail('usage: find WORDS...');
    printList(await api('GET', `/api/artifacts?q=${enc(words.join(' '))}`));
  },
  async open([name]) { if (!name) fail('usage: open NAME'); openInBrowser(`${SERVER}/pages/${enc(name)}`); },
  async review([name]) { if (!name) fail('usage: review NAME'); openInBrowser(`${SERVER}/review/${enc(name)}`); },
  async diff([name, from, to], opts) {
    if (!name) fail('usage: diff NAME [FROM TO] [--source]');
    const q = new URLSearchParams();
    if (from && to) { q.set('from', from); q.set('to', to); }
    if (opts.source) q.set('of', 'source');
    process.stdout.write((await api('GET', `/api/artifacts/${enc(name)}/diff${q.size ? `?${q}` : ''}`)) || '(no differences)\n');
  },
  async restore([name, n]) {
    if (!name || !/^\d+$/.test(n || '')) fail('usage: restore NAME N');
    const a = await api('POST', `/api/artifacts/${enc(name)}/versions/${n}/restore`, { auth: 'required' });
    console.log(`v${a.latest_version} is now a copy of v${n}`);
  },
  async views([name]) {
    if (!name) fail('usage: views NAME');
    console.log(JSON.stringify(await api('GET', `/api/artifacts/${enc(name)}/views`, { auth: 'required' }), null, 2));
  },
  async rm([name], opts) {
    if (!name) fail('usage: rm NAME [--purge]');
    const a = await api('DELETE', `/api/artifacts/${enc(name)}${opts.purge ? '?purge=1' : ''}`, { auth: 'required' });
    console.log(`${a.slug} → ${a.state}`);
  },
  async whoami() {
    const me = await api('GET', '/api/me', { auth: 'required' });
    console.log(`${me.name}${me.is_admin ? ' (admin)' : ''} on ${SERVER}`);
  },
};

// --- sync helpers -----------------------------------------------------------------------
/** A Quartz repo's settings, if DIR is one: { ignore: [patterns] } from quartz.config.yaml (or .ts), or null. */
function quartzConfig(dir) {
  if (!existsSync(join(dir, 'content')) || !statSync(join(dir, 'content')).isDirectory()) return null;
  const cfg = ['quartz.config.yaml', 'quartz.config.yml', 'quartz.config.default.yaml', 'quartz.config.ts']
    .map((f) => join(dir, f)).find((f) => existsSync(f));
  if (!cfg) return null;
  const text = readFileSync(cfg, 'utf8');
  let ignore = [];
  if (cfg.endsWith('.ts')) {
    const m = text.match(/ignorePatterns\s*:\s*\[([^\]]*)\]/);
    if (m) ignore = [...m[1].matchAll(/["'`]([^"'`]+)["'`]/g)].map((x) => x[1]);
  } else {
    const m = text.match(/^(\s*)ignorePatterns:\s*\n((?:\1\s+-\s*.+\n?)+)/m);
    if (m) ignore = [...m[2].matchAll(/-\s*["']?([^"'\n]+?)["']?\s*$/gm)].map((x) => x[1]);
  }
  return { ignore };
}

/** Quartz-style ignore patterns: a bare name matches that folder or file anywhere; *, ** and ? glob. */
function globMatch(pat, rel) {
  if (!/[*?]/.test(pat)) return rel.split('/').includes(pat.replace(/\/$/, ''));
  const re = pat.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*\/?/g, '\0').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]').replace(/\0/g, '.*');
  return new RegExp(`(^|/)${re}(/|$)`).test(rel);
}

/** Git hooks in the repo holding DIR, so each commit and pull re-syncs it (in the background). */
function installHook(root, opts) {
  let hooks;
  try { hooks = execFileSync('git', ['-C', root, 'rev-parse', '--path-format=absolute', '--git-path', 'hooks'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch {
    fail(`${root} isn't in a git repository`);
  }
  const MARK = '# html-server sync hook';
  const cmd = [process.execPath, fileURLToPath(import.meta.url), 'sync', root, '--prune', ...(opts.private ? ['--private'] : []), ...(opts.folder ? ['--folder', opts.folder] : [])]
    .map((a) => `'${a.replace(/'/g, `'\\''`)}'`).join(' ');
  const script = `#!/bin/sh\n${MARK} (installed by html-server ${VERSION}; delete this file to stop)\n(${cmd} >> '${join(HOME_DIR, 'sync.log')}' 2>&1 &)\n`;
  mkdirSync(hooks, { recursive: true });
  for (const name of ['post-commit', 'post-merge']) {
    const f = join(hooks, name);
    if (existsSync(f) && !readFileSync(f, 'utf8').includes(MARK)) {
      console.error(`${f} already exists and isn't ours; add this line to it yourself:\n  ${cmd} &`);
      process.exitCode = 1;
      continue;
    }
    writeFileSync(f, script, { mode: 0o755 });
    chmodSync(f, 0o755);
    console.log(`installed ${f}`);
  }
  console.log(`Each commit and pull now runs: html-server sync ${root} --prune (log: ${join(HOME_DIR, 'sync.log')})`);
}

export async function main(argv) {
  // A flag given without its value (`--sandbox-allow` alone): say what it takes.
  const bare = argv.findIndex((a, i) => a === '--sandbox-allow' && (i === argv.length - 1 || argv[i + 1].startsWith('-')));
  if (bare !== -1) {
    const { SANDBOX_TOKENS } = await import('./config.js');
    fail(`--sandbox-allow needs a permission, e.g. --sandbox-allow allow-downloads. Valid: ${SANDBOX_TOKENS.join(', ')}.`
      + ' (Links pages open in a new tab, such as Jira, already work without it.)');
  }
  const { values: opts, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      db: { type: 'string', default: DEFAULT_DB },
      host: { type: 'string', default: DEFAULT_HOST },
      'sandbox-allow': { type: 'string', multiple: true },
      sort: { type: 'string' },
      port: { type: 'string', default: String(DEFAULT_PORT) },
      admin: { type: 'boolean', default: false },
      save: { type: 'boolean', default: false },
      private: { type: 'boolean', default: false },
      purge: { type: 'boolean', default: false },
      source: { type: 'boolean', default: false },
      name: { type: 'string' },
      folder: { type: 'string' },
      'migrate-paths': { type: 'boolean', default: false },
      base: { type: 'string' },
      keep: { type: 'string' },
      tag: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      prune: { type: 'boolean', default: false },
      'install-hook': { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
      url: { type: 'string' },
      token: { type: 'string' },
      user: { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
      version: { type: 'boolean', short: 'v', default: false },
    },
  });
  const [cmd, ...args] = positionals;
  if (opts.version || cmd === 'version') return console.log(VERSION);
  const run = serverCommands[cmd] || deployCommands[cmd] || accountCommands[cmd] || mcpCommands[cmd] || clientCommands[cmd];
  if (cmd === 'help' && args[0]) return console.log(commandHelp(args[0]));
  if (run && opts.help) return console.log(commandHelp(cmd));
  if (!run || opts.help) {
    console.log(USAGE);
    if (cmd && !run && cmd !== 'help') process.exitCode = 2;
    return;
  }
  setClient(`cli/${cmd}`); // labels this run's requests for the server's usage stats
  await run(args, opts);
}

/**
 * One command's lines from USAGE (`html-server help sync`, `html-server sync --help`):
 * its usage line, the lines continuing it, and the footer. Unknown: the whole usage.
 */
export function commandHelp(name) {
  const lines = USAGE.split('\n');
  const starts = (l) => new RegExp(`^  (\\S+ \\S+ \\| )?${name.replace(/[^\w-]/g, '')}( |$)`).test(l) || l.includes(`| ${name} `);
  const at = lines.findIndex(starts);
  if (at === -1) return USAGE;
  const out = [`html-server ${lines[at].trim()}`];
  for (let i = at + 1; i < lines.length && /^ {10,}\S/.test(lines[i]); i++) out.push(`  ${lines[i].trim()}`);
  return `${out.join('\n')}\n\nAll commands: html-server --help`;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === (await import('node:fs')).realpathSync(process.argv[1])) {
  main(process.argv.slice(2)).catch((e) => {
    // CLI mistakes and server errors get one line, not a stack trace.
    console.error(`error: ${e instanceof CliError || e.status || e.code?.startsWith('ERR_PARSE_ARGS_') ? e.message : e.stack}`);
    process.exit(1);
  });
}
