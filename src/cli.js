#!/usr/bin/env node
// html-server: one command line for running the server and for using it.
//
// Server commands work on the database directly (no token needed; you need shell
// access to the machine). Client commands talk to a running server over HTTP.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { createInterface } from 'node:readline/promises';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { VERSION } from './config.js';
import { BACKUP_DIR, CREDENTIALS_FILE, DEFAULT_DB, DEFAULT_HOST, DEFAULT_PORT, FALLBACK_URL, HOME_DIR } from './config.js';


// --- who and where: env vars win, then credentials.json, then the local default ---
function readCredentials() {
  try { return JSON.parse(readFileSync(CREDENTIALS_FILE, 'utf8')); } catch { return {}; }
}
const creds = readCredentials();
const SERVER = (process.env.HTML_SERVER_URL || creds.url || FALLBACK_URL).replace(/\/+$/, '');
const token = () => (process.env.HTML_SERVER_TOKEN || creds.token || '').trim();

function saveCredentials(url, tok) {
  mkdirSync(HOME_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(CREDENTIALS_FILE, JSON.stringify({ url, token: tok }, null, 2) + '\n', { mode: 0o600 });
  chmodSync(CREDENTIALS_FILE, 0o600);
}

const USAGE = `html-server ${VERSION} — store, version, search and render HTML pages

Run the server (on this machine, straight to the database):
  serve [--port ${DEFAULT_PORT}] [--host ${DEFAULT_HOST}] [--db PATH] [--sandbox-allow PERMISSION]...
                                        --sandbox-allow adds a sandbox permission for pages, e.g. allow-downloads
  create-user NAME [--admin] [--save]    print a new user's token once (--save: also keep it for this CLI)
  reset-token NAME [--save]              new token for a user who lost theirs; pages are kept
  backup [PATH] [--keep N]               snapshot the database (safe while serving); default: ${BACKUP_DIR}
                                        --keep N: then delete all but the newest N backups there
  config [usernames name|email] [editing owner|open]
                                        show or change this deployment's settings

Sign this CLI in to a server (saved, so there's nothing to add to your shell profile):
  login [--url URL] [--token TOKEN]     asks for anything missing; checks it before saving
  logout

Use a running server:
  put FILE [NOTE] [--private] [--name NAME] [--base N]
                                        upload; the page lives at /pages/<file name>.
                                        --base N: refuse if someone added a version after vN
  history NAME                          every version, with date, author and note
  pin NAME | unpin NAME                 feature a page at the top of the home page (owner or admin)
  tag add TAG NAME... | tag rm TAG NAME...   tag or untag many pages at once
  tags                                  every tag in use, with counts
  import DIR [--private]                upload every .html file in DIR (re-runnable: unchanged files are skipped)
  ls                                    your pages and everyone's public ones
  find WORDS...                         search (typos are fine)
  open NAME | review NAME               open the page, or its review page, in a browser
  diff NAME [FROM TO] [--source]        what changed (default: previous vs latest)
  restore NAME N                        make version N current again (adds a copy)
  views NAME                            page views report
  rm NAME [--purge]                     trash; --purge deletes for good (trash first)
  whoami
  --version                             print the version

Data lives in ${HOME_DIR} (HTML_SERVER_HOME moves it).
Client commands use the server and token saved by login (or by the first serve on
this machine). HTML_SERVER_URL and HTML_SERVER_TOKEN override them for one shell.
Currently: ${SERVER}`;

class CliError extends Error {}
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
async function api(method, path, { body, auth = 'optional', json: sendJson = false } = {}) {
  const t = token();
  if (auth === 'required' && !t) fail('not signed in: run `html-server login` (or set HTML_SERVER_TOKEN)');
  let r;
  try {
    r = await fetch(SERVER + path, { method, body, headers: { ...(t ? { Authorization: `Bearer ${t}` } : {}), ...(sendJson ? { 'Content-Type': 'application/json' } : {}) } });
  } catch {
    fail(`can't reach ${SERVER} (is the server running?)`);
  }
  const text = await r.text();
  const json = r.headers.get('content-type')?.includes('json') ? JSON.parse(text) : null;
  if (!r.ok) fail(json?.error || `HTTP ${r.status}`);
  return json ?? text;
}

const enc = encodeURIComponent;
const day = (t) => new Date(t * 1000).toLocaleDateString('en-CA');

function printList(items) {
  if (!items.length) return console.log('(nothing)');
  for (const a of items) {
    const lock = a.visibility === 'private' ? ' [private]' : '';
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
    if (!file || !existsSync(file)) fail('usage: put FILE [NOTE] [--private] [--name NAME] [--base N]');
    const name = opts.name || basename(file); // upload to the base name, so out/page.html works
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
  async ls() { printList(await api('GET', '/api/artifacts?limit=500')); },
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
      port: { type: 'string', default: String(DEFAULT_PORT) },
      admin: { type: 'boolean', default: false },
      save: { type: 'boolean', default: false },
      private: { type: 'boolean', default: false },
      purge: { type: 'boolean', default: false },
      source: { type: 'boolean', default: false },
      name: { type: 'string' },
      base: { type: 'string' },
      keep: { type: 'string' },
      url: { type: 'string' },
      token: { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
      version: { type: 'boolean', short: 'v', default: false },
    },
  });
  const [cmd, ...args] = positionals;
  if (opts.version || cmd === 'version') return console.log(VERSION);
  const run = serverCommands[cmd] || accountCommands[cmd] || clientCommands[cmd];
  if (!run || opts.help) {
    console.log(USAGE);
    if (cmd && !run && cmd !== 'help') process.exitCode = 2;
    return;
  }
  await run(args, opts);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === (await import('node:fs')).realpathSync(process.argv[1])) {
  main(process.argv.slice(2)).catch((e) => {
    // CLI mistakes and server errors get one line, not a stack trace.
    console.error(`error: ${e instanceof CliError || e.status || e.code?.startsWith('ERR_PARSE_ARGS_') ? e.message : e.stack}`);
    process.exit(1);
  });
}
