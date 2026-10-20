#!/usr/bin/env node
// html-server: one command line for running the server and for using it.
//
// Server commands work on the database directly (no token needed; you need shell
// access to the machine). Client commands talk to a running server over HTTP.
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { createInterface } from 'node:readline/promises';
import { basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { CREDENTIALS_FILE, DEFAULT_DB, DEFAULT_HOST, DEFAULT_PORT, FALLBACK_URL, HOME_DIR } from './config.js';

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

const USAGE = `html-server — store, version, search and render HTML pages

Run the server (on this machine, straight to the database):
  serve [--port ${DEFAULT_PORT}] [--host ${DEFAULT_HOST}] [--db PATH]
  create-user NAME [--admin] [--save]    print a new user's token once (--save: also keep it for this CLI)
  reset-token NAME [--save]              new token for a user who lost theirs; pages are kept
  config [usernames name|email]          show or change this deployment's settings

Sign this CLI in to a server (saved, so there's nothing to add to your shell profile):
  login [--url URL] [--token TOKEN]     asks for anything missing; checks it before saving
  logout

Use a running server:
  put FILE [NOTE] [--private] [--name NAME]   upload; the page lives at /<file name>
  ls                                    your pages and everyone's public ones
  find WORDS...                         search (typos are fine)
  open NAME | review NAME               open the page, or its review page, in a browser
  diff NAME [FROM TO] [--source]        what changed (default: previous vs latest)
  restore NAME N                        make version N current again (adds a copy)
  views NAME                            page views report
  rm NAME [--purge]                     trash; --purge deletes for good (trash first)
  whoami

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
    const store = await openStore(opts.db);
    bootstrap(store, opts);
    const { makeServer } = await import('./server.js');
    makeServer(store).listen(Number(opts.port), opts.host, () =>
      console.error(`html-server on http://${opts.host}:${opts.port}  (db: ${opts.db})`));
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
  async config([key, value], opts) {
    const store = await openStore(opts.db);
    if (key === 'usernames' && value) store.setUsernames(value);
    else if (key) fail('usage: config [usernames name|email]');
    console.log(`usernames: ${store.usernames}`);
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
async function api(method, path, { body, auth = 'optional' } = {}) {
  const t = token();
  if (auth === 'required' && !t) fail('not signed in: run `html-server login` (or set HTML_SERVER_TOKEN)');
  let r;
  try {
    r = await fetch(SERVER + path, { method, body, headers: t ? { Authorization: `Bearer ${t}` } : {} });
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
    if (!file || !existsSync(file)) fail('usage: put FILE [NOTE] [--private] [--name NAME]');
    const name = opts.name || basename(file); // upload to the base name, so out/page.html works
    // The name is in the URL, so options can ride in the query string (any characters, unlike headers).
    const q = new URLSearchParams();
    if (note) q.set('note', note);
    if (opts.private) q.set('visibility', 'private');
    const a = await api('PUT', `/api/artifacts/${enc(name)}${q.size ? `?${q}` : ''}`, { body: readFileSync(file), auth: 'required' });
    console.log(`published v${a.latest_version}: ${SERVER}${a.url}`);
    console.log(`review:       ${SERVER}/review/${enc(a.slug)}`);
    if (a.visibility === 'private') console.log(`share link:   ${SERVER}${a.share_url}`);
  },
  async ls() { printList(await api('GET', '/api/artifacts?limit=500')); },
  async find(words) {
    if (!words.length) fail('usage: find WORDS...');
    printList(await api('GET', `/api/artifacts?q=${enc(words.join(' '))}`));
  },
  async open([name]) { if (!name) fail('usage: open NAME'); openInBrowser(`${SERVER}/${enc(name)}`); },
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
  const { values: opts, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      db: { type: 'string', default: DEFAULT_DB },
      host: { type: 'string', default: DEFAULT_HOST },
      port: { type: 'string', default: String(DEFAULT_PORT) },
      admin: { type: 'boolean', default: false },
      save: { type: 'boolean', default: false },
      private: { type: 'boolean', default: false },
      purge: { type: 'boolean', default: false },
      source: { type: 'boolean', default: false },
      name: { type: 'string' },
      url: { type: 'string' },
      token: { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  const [cmd, ...args] = positionals;
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
    console.error(`error: ${e instanceof CliError || e.status || e.code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION' ? e.message : e.stack}`);
    process.exit(1);
  });
}
