// `html-server deploy cloudflare`: put this HTML Server on Cloudflare Workers in one
// command, using Cloudflare's own CLI (Wrangler, pinned below, fetched by npx on first
// use) with the wrangler.toml and cloudflare/ folder in this package.
//
//   1. Sign in to Cloudflare if needed (Wrangler opens the browser; you approve there).
//   2. Deploy the Worker and its Durable Object (the database).
//   3. First deploy only: make an admin token, store it as the Worker's ADMIN_TOKEN
//      secret (the Worker creates its first admin from it).
//   4. Check the server answers with that token, then save the new CLI sign-in.
//
// Running it again deploys the new code; the data, users and tokens stay.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { HOME_DIR } from './config.js';
import { fileURLToPath } from 'node:url';
import { saveCredentials } from './client.js';

export const WRANGLER = 'wrangler@4.147.0';
const ROOT = fileURLToPath(new URL('..', import.meta.url));

/**
 * Run Wrangler in the package folder. `input` goes to its stdin; output is shown unless
 * `quiet`, and returned: `out`, all of it; `stdout` without the warnings and notices on stderr.
 */
function wrangler(args, { input, quiet = false, interactive = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('npx', ['--yes', WRANGLER, ...args], { cwd: ROOT, stdio: interactive ? 'inherit' : ['pipe', 'pipe', 'pipe'] });
    let out = '', stdout = '';
    if (!interactive) {
      child.stdout.on('data', (d) => { stdout += d; });
      for (const s of [child.stdout, child.stderr]) {
        s.on('data', (d) => { out += d; if (!quiet) process.stdout.write(d); });
      }
      child.stdin.end(input ?? '');
    }
    child.on('error', reject);
    if (!interactive) child.stdin.on('error', reject);
    child.on('close', (code) => resolve({ code, out, stdout }));
  });
}

/**
 * The names of a Worker's secrets, from what `wrangler secret list --format json` printed
 * (`{ code, stdout }`); null when that can't be read. Only a list read in full says there's
 * no admin token yet: guessed, a deploy would replace the token, and this CLI's sign-in with it.
 */
export function secretNames({ code, stdout }) {
  const at = stdout.search(/^\[/m); // the JSON, after anything printed before it
  if (code !== 0 || at === -1) return null;
  try {
    const list = JSON.parse(stdout.slice(at));
    return Array.isArray(list) && list.every((x) => typeof x?.name === 'string') ? list.map((x) => x.name) : null;
  } catch { return null; }
}

export async function deployCloudflare({ name, user, fail }) {
  if (!existsSync(new URL('../wrangler.toml', import.meta.url))) fail('this install has no wrangler.toml; deploy from a clone of the repo');
  const named = name ? ['--name', name] : [];

  console.log(`Using Cloudflare's CLI (${WRANGLER}).`);
  const who = await wrangler(['whoami'], { quiet: true });
  if (who.code !== 0 || /not authenticated|You are not logged in/i.test(who.out)) {
    console.log('Signing in to Cloudflare: approve the request in the browser window that opens.');
    if ((await wrangler(['login'], { interactive: true })).code !== 0) fail('Cloudflare sign-in did not finish');
  }

  console.log('\nDeploying…');
  const dep = await wrangler(['deploy', ...named]);
  if (dep.code !== 0) fail('the deploy failed (Wrangler\'s output is above)');
  const url = (dep.out.match(/https:\/\/[\w.-]+\.workers\.dev/) || dep.out.match(/https:\/\/[\w.-]+\.[a-z]{2,}(?=\s)/) || [])[0];

  const secrets = await wrangler(['secret', 'list', '--format', 'json', ...named], { quiet: true });
  const names = secretNames(secrets);
  if (!names) {
    process.stdout.write(secrets.out);
    fail("deployed, but couldn't read the Worker's secrets (Wrangler's output is above), so can't tell whether it has an admin token yet; "
      + 'nothing else was changed. Run deploy again; if this is the first deploy and it keeps failing, check `npx wrangler secret list`');
  }

  if (names.includes('ADMIN_TOKEN')) {
    console.log(`\nUpdated ${url || 'the deployment'}. Its data, users and tokens are unchanged.`);
    if (url) console.log(`To use it from another machine: html-server login --url ${url}`);
    return;
  }

  console.log('\nFirst deploy: creating the admin token…');
  const token = `ak_${randomBytes(32).toString('base64url')}`;
  const admin = (user || 'admin').toLowerCase();
  // Keep a recoverable token even when setup only partly succeeds, without replacing
  // the working sign-in. This file is removed only once the new login is verified.
  const pending = join(HOME_DIR, 'deploy-credentials.json');
  mkdirSync(HOME_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(pending, JSON.stringify({ url: url || '', token }, null, 2) + '\n', { mode: 0o600 });
  chmodSync(pending, 0o600);
  for (const [key, value] of [['ADMIN_NAME', admin], ['ADMIN_TOKEN', token]]) {
    const r = await wrangler(['secret', 'put', key, ...named], { input: value, quiet: true });
    if (r.code !== 0) { process.stdout.write(r.out); fail(`couldn't store the ${key} secret`); }
  }
  if (!url) {
    fail(`deployed, but Wrangler didn't print a URL to verify; your sign-in is unchanged. Recovery credentials: ${pending}`);
  }

  // The new secret restarts the Worker; give it a moment, then check the token works.
  for (let i = 0; i < 30; i++) {
    let verified = false;
    try {
      const r = await fetch(`${url}/api/me`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5000) });
      verified = r.ok;
    } catch { /* still starting */ }
    if (verified) {
      saveCredentials(url, token);
      rmSync(pending, { force: true });
      console.log(`\nHTML Server is live at ${url}`);
      console.log(`Signed this CLI in as '${admin}' (admin). Try: html-server put page.html`);
      console.log('The admin token is saved in your credentials file. Keep it; it is not shown again.');
      return;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  fail(`deployed to ${url}, but could not verify the new admin token; your sign-in is unchanged. Recovery credentials: ${pending}`);
}
