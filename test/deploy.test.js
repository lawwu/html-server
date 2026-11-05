import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

for (const scenario of ['list-failure', 'list-invalid', 'verification-failure', 'missing-url', 'success']) {
  test(`deploy ${scenario}: only a verified token replaces the working login`, () => {
    const dir = mkdtempSync(join(tmpdir(), 'html-deploy-'));
    try {
      const bin = join(dir, 'bin'), home = join(dir, 'home'), trace = join(dir, 'trace');
      mkdirSync(bin); mkdirSync(home);
      const previous = { url: 'https://existing.workers.dev', token: 'synthetic-working-token' };
      writeFileSync(join(home, 'credentials.json'), JSON.stringify(previous));
      writeFileSync(join(bin, 'npx'), `#!${process.execPath}
const fs = require('node:fs'); const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(trace)}, JSON.stringify(args) + '\\n');
if (args.includes('deploy')) console.log(${JSON.stringify(scenario)} === 'missing-url' ? 'deployed' : 'https://fixture.workers.dev');
else if (args.includes('list')) {
  if (${JSON.stringify(scenario)} === 'list-failure') process.exitCode = 1;
  else console.log(${JSON.stringify(scenario)} === 'list-invalid' ? '{broken' : '[]');
} else if (args.includes('put')) process.stdin.resume();
`, { mode: 0o700 });
      const script = `globalThis.fetch = async () => ({ ok: ${scenario === 'success'} });
globalThis.setTimeout = (fn) => queueMicrotask(fn);
const {deployCloudflare} = await import(${JSON.stringify(new URL('../src/deploy.js', import.meta.url).href)});
try { await deployCloudflare({fail: (s) => {throw new Error(s)}}); } catch(e) { console.error(e.message); process.exitCode=1; }`;
      const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, HTML_SERVER_HOME: home }, encoding: 'utf8', timeout: 15000,
      });
      assert.equal(r.status, scenario === 'success' ? 0 : 1, r.stderr);
      const saved = JSON.parse(readFileSync(join(home, 'credentials.json')));
      if (scenario === 'success') {
        assert.equal(saved.url, 'https://fixture.workers.dev');
        assert.match(saved.token, /^ak_/);
        assert.ok(!existsSync(join(home, 'deploy-credentials.json')));
      } else assert.deepEqual(saved, previous);
      const commands = readFileSync(trace, 'utf8');
      if (scenario.startsWith('list-')) assert.doesNotMatch(commands, /"put"/);
      if (['verification-failure', 'missing-url'].includes(scenario)) {
        assert.equal(statSync(join(home, 'deploy-credentials.json')).mode & 0o777, 0o600);
        assert.match(r.stderr, /sign-in is unchanged/);
        const pending = JSON.parse(readFileSync(join(home, 'deploy-credentials.json')));
        assert.ok(!r.stdout.includes(pending.token));
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}
