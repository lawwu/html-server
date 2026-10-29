// Pure-function tests: the lifecycle table, fuzzy matching, text extraction, diffs.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ACTIVE, EVENTS, InvalidTransition, NONE, PURGED, TRANSITIONS, TRASHED, transition } from '../src/lifecycle.js';
import {
  closeMatches, extractLines, extractText, ftsQuery, queryWords, scriptText, searchName, similarity, snippet, unifiedDiff,
} from '../src/text.js';

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

test('extractLinks: links to pages on this server, in the forms people write them', async () => {
  const { extractLinks } = await import('../src/text.js');
  const doc = `<a href="/pages/plan.html">a</a> <a href='/budget'>b</a> <a href=notes.html>c</a> <a href="./faq.html#q2">d</a>
    <a href="https://example.com/x.html">e</a> <a href="mailto:a@b.c">f</a> <a href="/api/artifacts">g</a> <a href="#top">h</a>
    <a href="/pages/plan.html?v=2">dup</a> <a href="sub/dir.html">i</a>`;
  assert.deepEqual(extractLinks(doc), ['plan.html', 'budget', 'notes.html', 'faq.html']);
});

test('a typo near the start of a longer word still finds it', () => {
  assert.deepEqual(closeMatches('gardn', ['garden', 'gardening', 'grocery']), ['garden', 'gardening']);
  assert.deepEqual(closeMatches('archtect', ['architecture', 'banana']), ['architecture']); // typo mid-word, 4+ letters
  assert.deepEqual(closeMatches('cat', ['catalog']), []); // too short to guess
});

test('words a typed word starts leave the typo slots to real typos', () => {
  // The prefix query covers "graphs" and "graphic", so they mustn't use up the few close words.
  assert.deepEqual(closeMatches('graph', ['graphs', 'graphic', 'graphite', 'grape', 'grapy'], 2, 0.75, (w) => w.startsWith('graph')), ['grapy', 'grape']);
  assert.equal(ftsQuery('graph', ['graphs', 'graphic', 'graphite', 'grape']), '("graph"* OR "grape")');
  assert.equal(ftsQuery('rotate share', ['rate', 'are', 'shore']), '("rotate"*) AND ("share"* OR "shore")'); // two letters short is no typo
});

test('other forms of a word match it, when some page uses them', () => {
  assert.equal(ftsQuery('studies', ['study', 'studied', 'student']), '("studies"* OR "study" OR "studied")');
  assert.equal(ftsQuery('running', ['run', 'runs', 'ran']), '("running"* OR "run" OR "runs")');
  assert.equal(ftsQuery('policy', ['policies']), '("policy"* OR "policies")');
  assert.equal(ftsQuery('thing', ['the', 'thin']), '("thing"* OR "thin")'); // "th" + ing isn't a word: no "the"
  assert.equal(ftsQuery('studies', ['study'], { typos: false }), '("studies"*)'); // as typed only
});

test('snippets: the stretch with the most of the query, centred, matches marked', () => {
  const show = (s) => s.replace(/\u0001/g, '[').replace(/\u0002/g, ']');
  const fox = queryWords('fox dog', []);
  assert.equal(show(snippet('Lorem ipsum dolor sit amet, the quick brown fox jumps over the lazy dog near the riverbank today.', fox, 8)),
    '…brown [fox] jumps over the lazy [dog] near…');
  assert.equal(snippet('Nothing to see here at all, just words that go on.', fox, 6), 'Nothing to see here at all…'); // no match: the opening
  assert.equal(show(snippet('[Draft] Family budget: monthly budget review.', queryWords('budgt', ['budget']))),
    '[Draft] Family [budget]: monthly [budget] review.'); // a typo's match, and the whole text when it's short
  assert.equal(show(snippet('Ünïcödé café crème brûlée', queryWords('creme cafe', []))), 'Ünïcödé [café] [crème] brûlée'); // accents fold
});

test('text that scripts write is searchable; code, comments and one-word strings are not', () => {
  const doc = `<script>
    const tickets = [{ title: 'Rotate a share link', state: 'open' }]; // it's a comment, not a "string"
    el.innerHTML = \`<h2>Weekly totals</h2><p>Spent \${n} dollars</p>\`;
    css = 'color: red; margin: 0'; sel = '.controls button'; ns = 'http://www.w3.org/2000/svg';
  </script><script src="lib.js">'Not this one'</script>
  <script type="text/babel">const App = () => <div className="p-4"><h1>Support queue</h1></div>;</script>`;
  assert.deepEqual(scriptText(doc).split('\n'), ['Rotate a share link', 'Weekly totals', 'Spent dollars', 'Support queue']);
});

test('a page is also found by its name: file name, its words apart and together, aliases and tags', () => {
  assert.equal(searchName('ObsidianFlavoredMarkdown.md', 'OFM', ['ofm syntax', 'markdown']),
    'ObsidianFlavoredMarkdown Obsidian Flavored Markdown ofm syntax markdown');
  assert.equal(searchName('kmeans-step-through.html', 'k-means, one step at a time'), 'kmeans step through kmeans');
});
