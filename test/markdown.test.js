// The Markdown module: frontmatter, wikilinks, callouts, highlights, anchors.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  noteAssets, noteLinks, noteSlug, noteTags, noteTitle, pageHref, parseFrontmatter, renderMarkdown, safeDecode, syncedSlug, wikiTarget, wikiTargets,
} from '../src/markdown.js';

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
    ['Weekly-Review', 'b', 'c.md', 'sub/d'].sort()); // images aren't page links; a link is kept once, as written
  assert.deepEqual(wikiTargets('sub/d'), ['sub-d', 'd']); // which means its exact path, then its name
});

test('names keep letters and digits of any script', () => {
  assert.equal(noteSlug('Über uns.md'), 'Über-uns.md');
  assert.equal(noteSlug('日本語 メモ.md'), '日本語-メモ.md');
  assert.equal(noteSlug('Cafe\u0301.md'), 'Café.md'); // one form (NFC), however the file system spelled it
  assert.deepEqual(noteLinks('[[Über uns]] and [[Ελληνικά]]'), ['Über-uns', 'Ελληνικά']);
});

test('code is not links or titles: fenced blocks and `inline` spans', () => {
  const md = '```python\n# load the data\ndf[["a", "b"]]\n```\n\n~~~\n[[Not a link]]\n~~~\n\nUse `[[x]]` for links. # Not a title\n\n# Real title\n\n[[Real link]]';
  assert.equal(noteTitle({}, md, 'x.md'), 'Real title');
  assert.deepEqual(noteLinks(md), ['Real-link']);
  assert.equal(noteTitle({}, '# The `foo` function', 'x.md'), 'The `foo` function'); // code in a heading is still its text
});

test('Markdown links: read from where the note lives, the way sync names files', () => {
  const at = 'health/notes/README.md';
  assert.deepEqual(pageHref('../../finance/profile.md#savings', at), { name: 'finance-profile.md', hash: '#savings' });
  assert.deepEqual(pageHref('/finance/profile.md', at), { name: 'finance-profile.md', hash: '' }); // from the top of the folder
  assert.deepEqual(pageHref('other.md', at), { name: 'health-notes-other.md', hash: '' });
  assert.deepEqual(pageHref('../index.md', at), { name: 'health.md', hash: '' }); // a folder's index is the folder's page
  assert.deepEqual(pageHref('My%20Note.md', ''), { name: 'My-Note.md', hash: '' });
  assert.deepEqual(pageHref('/pages/x.md?v=2#top', at), { name: 'x.md', hash: '#top' });
  assert.deepEqual(pageHref('budget', at), { name: 'budget', hash: '' }); // a name, found as URLs find pages
  for (const href of ['https://x.y/a.md', 'mailto:a@b.c', '#top', 'img/a.png', '/assets/a.pdf', '/api/artifacts', '../folder/', 'data.csv']) {
    assert.equal(pageHref(href, at), null, href);
  }
  assert.equal(syncedSlug('plugins/Back links.md'), 'plugins-Back-links.md');
  assert.deepEqual(noteLinks('[a](../finance/profile.md) [b](../finance/profile.md "Profile")', { path: 'health/README.md' }), ['finance-profile.md']);
  const html = renderMarkdown('[a](../finance/profile.md#x) [b](https://x.y/q.md) [c](100%.md)',
    { path: 'health/README.md', resolve: (n) => (n === 'finance-profile.md' ? { exists: true, url: '/pages/finance-profile.md' } : null) });
  assert.match(html, /<a href="\/pages\/finance-profile.md#x">a<\/a>/);
  assert.match(html, /<a href="https:\/\/x.y\/q.md">b<\/a>/);
  assert.match(html, /<a href="\/pages\/health-100.md">c<\/a>/); // a stray % is text, not an error
});

test('percent signs that aren\'t escapes never throw', () => {
  assert.equal(safeDecode('100%.md'), '100%.md');
  assert.equal(safeDecode('a%20b'), 'a b');
  assert.doesNotThrow(() => noteLinks('[x](50%.md) ![y](a%zz.png) [[c%d]]'));
  assert.match(renderMarkdown('![y](a%zz.png)', { asset: () => null }), /embed missing/);
});

test('the images and PDFs a note shows, by asset name', () => {
  assert.deepEqual(noteAssets('![[chart.png|300]] ![a](img/My%20Photo.png) [pdf](../docs/report.pdf) <img src="/assets/raw.png">'
    + ' `![[code.png]]` ![w](https://x.y/a.png) ![att](attachment:x.png)').sort(), ['My-Photo.png', 'chart.png', 'raw.png', 'report.pdf']);
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
