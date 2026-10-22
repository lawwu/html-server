// `html-server deploy cloudflare`: put this HTML Server on Cloudflare Workers in one
// command, using Cloudflare's own CLI (Wrangler, pinned below, fetched by npx on first
// use) with the wrangler.toml and cloudflare/ folder in this package.
//
//   1. Sign in to Cloudflare if needed (Wrangler opens the browser; you approve there).
//   2. Deploy the Worker and its Durable Object (the database).
//   3. First deploy only: make an admin token, store it as the Worker's ADMIN_TOKEN
//      secret (the Worker creates its first admin from it), and sign this CLI in with it.
//   4. Check the server answers with that token.
//
// Running it again deploys the new code; the data, users and tokens stay.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { saveCredentials } from './client.js';

export const WRANGLER = 'wrangler@4.147.0';
const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** Run Wrangler in the package folder. `input` goes to its stdin; output is shown unless `quiet`, and returned. */
function wrangler(args, { input, quiet = false, interactive = false } = {}) {
  return new Promise((resolve) => {
    const child = spawn('npx', ['--yes', WRANGLER, ...args], { cwd: ROOT, stdio: interactive ? 'inherit' : ['pipe', 'pipe', 'pipe'] });
    let out = '';
    if (!interactive) {
      for (const s of [child.stdout, child.stderr]) {
        s.on('data', (d) => { out += d; if (!quiet) process.stdout.write(d); });
      }
      child.stdin.end(input ?? '');
    }
    child.on('close', (code) => resolve({ code, out }));
  });
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
  let hasToken = false;
  try { hasToken = JSON.parse(secrets.out.slice(secrets.out.indexOf('['))).some((s) => s.name === 'ADMIN_TOKEN'); } catch { /* none yet */ }

  if (hasToken) {
    console.log(`\nUpdated ${url || 'the deployment'}. Its data, users and tokens are unchanged.`);
    if (url) console.log(`To use it from another machine: html-server login --url ${url}`);
    return;
  }

  console.log('\nFirst deploy: creating the admin token…');
  const token = `ak_${randomBytes(32).toString('base64url')}`;
  const admin = (user || 'admin').toLowerCase();
  for (const [key, value] of [['ADMIN_NAME', admin], ['ADMIN_TOKEN', token]]) {
    const r = await wrangler(['secret', 'put', key, ...named], { input: value, quiet: true });
    if (r.code !== 0) { process.stdout.write(r.out); fail(`couldn't store the ${key} secret`); }
  }
  if (!url) {
    console.log(`Deployed, but Wrangler didn't print a URL. Sign in with: html-server login --url YOUR-URL --token ${token}`);
    return;
  }
  saveCredentials(url, token);

  // The new secret restarts the Worker; give it a moment, then check the token works.
  for (let i = 0; i < 30; i++) {
    try {
      const r = await fetch(`${url}/api/me`, { headers: { Authorization: `Bearer ${token}` } });
      if (r.ok) {
        console.log(`\nHTML Server is live at ${url}`);
        console.log(`Signed this CLI in as '${admin}' (admin). Try: html-server put page.html`);
        console.log('The admin token is saved in your credentials file. Keep it; it is not shown again.');
        return;
      }
    } catch { /* still starting */ }
    await new Promise((r) => setTimeout(r, 2000));
  }
  console.log(`\nDeployed to ${url} and signed this CLI in, but it didn't answer yet. Try html-server whoami in a minute.`);
}
