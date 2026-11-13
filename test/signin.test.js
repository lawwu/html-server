import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSignIn } from '../public/signin.js';

function storage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return { getItem: (k) => values.get(k), setItem: (k, v) => values.set(k, v), removeItem: (k) => values.delete(k) };
}
const ok = (name) => Response.json({ name });

test('every request chooses the current credential, with SSO taking precedence even before the top bar loads', async () => {
  for (const session of ['', 'ann']) {
    const saved = storage({ artifact_token: 'obsolete', artifact_user: '{"name":"old"}' });
    const calls = [];
    const auth = createSignIn({ session, storage: saved, fetch: async (url, opts) => { calls.push([url, opts]); return ok('ann'); } });
    await auth.request('/api/folders', { headers: { Authorization: 'Bearer bypass', 'X-Test': 'kept' } });
    await auth.request('/api/moves', { token: 'candidate', method: 'POST', body: 'moves' });
    auth.save('replacement');
    await auth.request('/api/artifacts');
    assert.deepEqual(calls.map(([, o]) => o.headers.get('Authorization')), session ? [null, null, null] : ['Bearer obsolete', 'Bearer candidate', 'Bearer replacement']);
    assert.equal(calls[0][1].headers.get('X-Test'), 'kept');
    assert.equal(calls[1][1].body, 'moves');
    assert.equal(auth.signedIn, true);
    if (session) {
      assert.equal(saved.getItem('artifact_token'), undefined);
      assert.equal(saved.getItem('artifact_user'), undefined);
      assert.deepEqual(await auth.identity(), { name: 'ann' });
      assert.equal(calls.length, 3);
    }
  }
});

test('identity requests are shared, cached across pages, and invalidated only when the token changes', async () => {
  const saved = storage({ artifact_token: 'first-token' });
  let finish, requests = 0, changes = 0;
  const fetch = () => { requests++; return new Promise((resolve) => { finish = resolve; }); };
  const auth = createSignIn({ storage: saved, fetch });
  const unsubscribe = auth.subscribe(() => changes++);
  const a = auth.identity(), b = auth.identity();
  assert.equal(requests, 1);
  finish(ok('alice'));
  assert.deepEqual(await Promise.all([a, b]), [{ name: 'alice' }, { name: 'alice' }]);
  auth.save('first-token');
  assert.equal(changes, 0);
  assert.deepEqual(await createSignIn({ storage: saved, fetch }).identity(), { name: 'alice' });
  assert.equal(requests, 1);
  auth.save('second-token');
  assert.equal(changes, 1);
  const old = auth.identity();
  auth.save('third-token');
  finish(ok('bob'));
  await old;
  assert.equal(saved.getItem('artifact_user'), undefined, 'late response cannot restore the previous identity');
  unsubscribe();
  auth.save('fourth-token');
  assert.equal(changes, 2);
});

test('blocked storage still permits sign-in for this visit, and sign-out clears that credential', async () => {
  const unavailable = () => { throw new Error('blocked'); };
  let left;
  const auth = createSignIn({ storage: { getItem: unavailable, setItem: unavailable, removeItem: unavailable }, fetch: async () => ok('alice'), leave: (session) => { left = session; } });
  assert.equal(auth.signedIn, false);
  assert.equal(auth.save(' token '), false);
  assert.equal(auth.token, 'token');
  assert.deepEqual(await auth.identity(), { name: 'alice' });
  auth.signOut();
  assert.equal(auth.signedIn, false);
  assert.equal(await auth.identity(), null);
  assert.equal(left, false);
});

test('a rejected identity remains retryable and sign-out forgets both saved fields', async () => {
  const saved = storage({ artifact_token: 'revoked' });
  let calls = 0, left;
  const auth = createSignIn({ storage: saved, fetch: async () => { calls++; return new Response('', { status: 401 }); }, leave: (session) => { left = session; } });
  for (let i = 0; i < 2; i++) await assert.rejects(auth.identity(), { status: 401 });
  assert.equal(calls, 2);
  saved.setItem('artifact_user', 'cached');
  auth.signOut();
  assert.equal(saved.getItem('artifact_token'), undefined);
  assert.equal(saved.getItem('artifact_user'), undefined);
  assert.equal(left, false);
  createSignIn({ session: 'alice', storage: saved, leave: (session) => { left = session; } }).signOut();
  assert.equal(left, true);
});
