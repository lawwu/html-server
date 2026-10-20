// Pure-function tests: the lifecycle table, fuzzy matching, text extraction, diffs.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ACTIVE, EVENTS, InvalidTransition, NONE, PURGED, TRANSITIONS, TRASHED, transition } from '../src/lifecycle.js';
import { closeMatches, extractLines, extractText, ftsQuery, similarity, unifiedDiff } from '../src/text.js';

test('lifecycle happy path', () => {
  let s = transition(NONE, 'create');
  s = transition(transition(transition(s, 'update'), 'trash'), 'restore');
  assert.equal(transition(transition(s, 'trash'), 'purge'), PURGED);
});

test('every pair not in the table is refused', () => {
  for (const state of [NONE, ACTIVE, TRASHED, PURGED]) {
    for (const event of EVENTS) {
      if (TRANSITIONS.has(`${state}:${event}`)) continue;
      assert.throws(() => transition(state, event), InvalidTransition, `${state} + ${event}`);
    }
  }
});

test('similarity matches difflib ratios', () => {
  assert.equal(similarity('ubr', 'uber'), 6 / 7);
  assert.equal(similarity('plna', 'plan'), 0.75);
  assert.ok(similarity('sheling', 'shells') < 0.75);
  assert.deepEqual(closeMatches('sheling', ['shelling', 'shells', 'uber']), ['shelling']);
});

test('fuzzy FTS query: prefix plus close words; 2 letters prefix only', () => {
  assert.equal(ftsQuery('Sheling ubr xl', ['shelling', 'shells', 'uber', 'bus', 'xl']),
    '("sheling"* OR "shelling") AND ("ubr"* OR "uber") AND ("xl"*)');
});

test('user input is never FTS syntax', () => {
  assert.equal(ftsQuery('a" OR title:*'), '("a"*) AND ("or"*) AND ("title"*)');
  assert.throws(() => ftsQuery('  "* '), /empty search/);
});

test('text extraction drops scripts and styles, keeps block lines', () => {
  const doc = '<!doctype html><title>T &amp; U</title><style>p{}</style><h1>Head</h1><p>One <b>bold</b> line</p>'
    + '<script>var x = "<p>no</p>";</script><ul><li>a</li><li>b&nbsp;c</li></ul>';
  assert.deepEqual(extractText(doc), { title: 'T & U', body: 'T & U Head One bold line a b c' });
  assert.deepEqual(extractLines(doc), ['T & U', 'Head', 'One bold line', 'a', 'b c']);
});

test('unified diff matches Python difflib output', () => {
  const split = (s) => [...s];
  // Expected strings generated with difflib.unified_diff(a, b, 'v1', 'v2', lineterm='').
  assert.equal(unifiedDiff(split('abcdefghij'), [...split('abcDefghij'), 'k'], 'v1', 'v2'),
    '--- v1\n+++ v2\n@@ -1,10 +1,11 @@\n a\n b\n c\n-d\n+D\n e\n f\n g\n h\n i\n j\n+k\n'); // 6-line gap: one hunk
  assert.equal(unifiedDiff(split('abcdefghijklmn'), [...split('abcDefghijklmn'), 'o'], 'v1', 'v2'),
    '--- v1\n+++ v2\n@@ -1,7 +1,7 @@\n a\n b\n c\n-d\n+D\n e\n f\n g\n@@ -12,3 +12,4 @@\n l\n m\n n\n+o\n');
  assert.equal(unifiedDiff(split('abc'), split('abc'), 'v1', 'v2'), '');
});
