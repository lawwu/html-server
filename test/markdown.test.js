// The Markdown module: frontmatter, wikilinks, callouts, highlights, anchors.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { noteLinks, noteSlug, noteTags, noteTitle, parseFrontmatter, renderMarkdown, wikiTarget } from '../src/markdown.js';

test('frontmatter: scalars, inline and block lists, no frontmatter', () => {
  const { data, body } = parseFrontmatter('---\ntitle: "Weekly review"\ntags: [planning, Weekly]\ndraft: false\nweight: 3\naliases:\n  - wr\n  - review\n---\n# Body\n');
  assert.deepEqual(data, { title: 'Weekly review', tags: ['planning', 'Weekly'], draft: false, weight: 3, aliases: ['wr', 'review'] });
  assert.equal(body, '# Body\n');
  assert.deepEqual(parseFrontmatter('# No frontmatter').data, {});
  assert.deepEqual(noteTags({ tags: '#a, b' }), ['a', 'b']);
  assert.equal(noteTitle({}, '# The Heading\ntext', 'x.md'), 'The Heading');
  assert.equal(noteTitle({}, 'no heading', 'my-note.md'), 'my note');
});

test('names: Quartz-style slugs and wikilink targets', () => {
  assert.equal(noteSlug('Weekly Review.md'), 'Weekly-Review.md');
  assert.equal(noteSlug('  Q&A notes (draft).md'), 'QA-notes-draft.md');
  assert.equal(wikiTarget('folder/Weekly Review'), 'folder-Weekly-Review'); // Quartz paths: folder-qualified first
  assert.deepEqual(noteLinks('---\ntags: [x]\n---\n[[Weekly Review]] and [[b#sec|B]] and ![[img.png]] and [c](c.md) and [[sub/d]] and [web](https://x.y)').sort(),
    ['Weekly-Review', 'b', 'c.md', 'sub-d', 'd'].sort()); // images aren't page links; [[sub/d]] → exact path, then name
});

test('rendering: wikilinks (found and missing), callouts, highlights, heading anchors, GFM', () => {
  const resolve = (n) => (n === 'Weekly-Review' ? { exists: true, url: '/pages/Weekly-Review.md' } : null);
  const html = renderMarkdown([
    '## Plans & Goals', '', 'See [[Weekly Review#Next steps|the review]] and [[Ghost Note]]. ==Important== bit.', '',
    '> [!warning] Mind the gap', '> Second line', '', '> [!tip]', '> Just a body', '', '> plain quote', '',
    '- [x] done', '', '| a | b |', '|---|---|', '| 1 | 2 |',
  ].join('\n'), { resolve });
  assert.match(html, /<h2 id="plans-goals">Plans &amp; Goals<\/h2>/);
  assert.match(html, /<a class="wikilink" href="\/pages\/Weekly-Review.md#next-steps">the review<\/a>/);
  assert.match(html, /<a class="wikilink missing" title="Not written yet">Ghost Note<\/a>/);
  assert.match(html, /<mark>Important<\/mark>/);
  assert.match(html, /<div class="callout callout-warning"><div class="callout-title">Mind the gap<\/div><div class="callout-body"><p>Second line<\/p>/);
  assert.match(html, /<div class="callout callout-tip"><div class="callout-title">Tip<\/div><div class="callout-body"><p>Just a body/);
  assert.match(html, /<blockquote>\n<p>plain quote<\/p>/);
  assert.match(html, /<input checked="" disabled="" type="checkbox">/);
  assert.match(html, /<table>/);
});

test('a leading # heading that repeats the title is dropped (the page shows the title)', () => {
  assert.doesNotMatch(renderMarkdown('# Home\n\nHello', { title: 'Home' }), /<h1/);
  assert.match(renderMarkdown('# Something else\n\nHello', { title: 'Home' }), /<h1 id="something-else">/);
});

test('[[tags/...]] links go to the tag (Quartz tag pages), nested tags flattened with dashes', () => {
  assert.match(renderMarkdown('See [[tags/plugin/emitter|Emitters]].'), /<a class="tag" href="\/\?category=plugin-emitter" target="_top">Emitters<\/a>/);
});
