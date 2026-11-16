import assert from 'node:assert/strict';
import { test } from 'node:test';
import { latestRequest, singleAction } from '../public/async-state.js';

test('a superseded read cannot publish or finish a newer read, even if abort is ignored', () => {
  const reads = latestRequest();
  const first = reads.start(), second = reads.start();
  assert.equal(first.signal.aborted, true);
  assert.equal(first.current, false);
  first.finish();
  assert.equal(second.current, true);
  assert.equal(reads.pending, true);
  reads.cancel();
  assert.equal(second.current, false);
  assert.equal(second.signal.aborted, true);
  const reopened = reads.start();
  second.finish();
  assert.equal(reopened.current, true);
  reopened.finish();
  assert.equal(reads.pending, false);
});

test('writes run once while pending, then allow an explicit retry after failure', async () => {
  const states = [], action = singleAction((pending) => states.push(pending));
  let calls = 0, reject;
  const first = action.run(() => { calls++; return new Promise((_, fail) => { reject = fail; }); });
  await action.run(() => { calls++; });
  assert.equal(calls, 1);
  assert.equal(action.pending, true);
  reject(new Error('offline'));
  await assert.rejects(first, /offline/);
  assert.equal(action.pending, false);
  assert.equal(await action.run(() => { calls++; return 'saved'; }), 'saved');
  assert.deepEqual(states, [true, false, true, false]);
  assert.equal(calls, 2);
  await assert.rejects(action.run(() => { throw new Error('invalid'); }), /invalid/);
  assert.equal(action.pending, false);
});
