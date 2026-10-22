// Jupyter notebooks: parsing (formats 4 and 3), rendering cells and saved outputs,
// the Markdown reading used for search, links and diffs, highlighting, and the server
// hosting them as pages of the site.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { highlight } from '../src/highlight.js';
import { notebookMarkdown, parseNotebook, renderNotebook } from '../src/notebook.js';
import { makeServer } from '../src/server.js';
import { Store } from '../src/store.js';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

export const sampleNotebook = (extra = {}) => JSON.stringify({
  nbformat: 4,
  nbformat_minor: 5,
  metadata: { kernelspec: { name: 'python3', display_name: 'Python 3', language: 'python' }, tags: ['analysis'], ...extra },
  cells: [
    { cell_type: 'raw', metadata: {}, source: ['---\n', 'description: Rides per day\n', 'tags: [trips, analysis]\n', '---\n'] },
    { cell_type: 'markdown', metadata: {}, source: ['# Ride analysis\n', '\n', 'Built on [[Trip Plan]]. ![chart](attachment:c.png)'],
      attachments: { 'c.png': { 'image/png': PNG } } },
    { cell_type: 'code', execution_count: 1, metadata: {}, source: ['import pandas as pd\n', 'print("rides")  # count'],
      outputs: [{ output_type: 'stream', name: 'stdout', text: ['rides\n'] }] },
    { cell_type: 'code', execution_count: 2, metadata: {}, source: 'df.head()',
      outputs: [{ output_type: 'execute_result', execution_count: 2, metadata: {},
        data: { 'text/html': '<table class="dataframe"><tr><td>42</td></tr></table>', 'text/plain': '   n\n0  42' } }] },
    { cell_type: 'code', execution_count: 3, metadata: {}, source: 'plot()',
      outputs: [{ output_type: 'display_data', metadata: {}, data: { 'image/png': PNG, 'text/plain': '<Figure>' } }] },
    { cell_type: 'code', execution_count: 4, metadata: {}, source: '1/0',
      outputs: [{ output_type: 'error', ename: 'ZeroDivisionError', evalue: 'division by zero',
        traceback: ['\u001b[0;31mZeroDivisionError\u001b[0m: division by zero'] }] },
  ],
});

test('a notebook parses: cells, frontmatter cell, kernel', () => {
  const nb = parseNotebook(sampleNotebook());
  assert.equal(nb.kernel, 'Python 3');
  assert.equal(nb.language, 'python');
  assert.deepEqual(nb.front, { description: 'Rides per day', tags: ['trips', 'analysis'] });
  assert.deepEqual(nb.cells.map((c) => c.type), ['markdown', 'code', 'code', 'code', 'code']); // the frontmatter cell is consumed
  assert.equal(parseNotebook('not json').invalid, true);
});

test('format 3 notebooks (worksheets, prompt_number, one key per output type) read the same', () => {
  const nb = parseNotebook(JSON.stringify({
    nbformat: 3, metadata: { name: 'old' },
    worksheets: [{ cells: [
      { cell_type: 'heading', level: 1, source: 'Old one' },
      { cell_type: 'code', language: 'python', input: 'x', prompt_number: 7, outputs: [{ output_type: 'pyout', text: '1', png: PNG }] },
    ] }],
  }));
  assert.equal(nb.cells[0].source, '# Old one');
  const html = renderNotebook(nb);
  assert.match(html, /In \[7\]:/);
  assert.match(html, /<img src="data:image\/png;base64,/);
});

test('rendering: Markdown cells, highlighted code, every kind of output', () => {
  const html = renderNotebook(parseNotebook(sampleNotebook()), { title: 'Ride analysis' });
  assert.doesNotMatch(html, /<h1/); // the title opens the page, not the first cell again
  assert.match(html, /<img src="data:image\/png;base64,iVBOR[^"]*" alt="chart"/); // a pasted (attachment:) image
  assert.match(html, /<span class="nb-prompt" aria-hidden="true">In \[1\]:<\/span><pre><code class="language-python"><span class="tok-keyword">import<\/span>/);
  assert.match(html, /<span class="tok-comment"># count<\/span>/);
  assert.match(html, /<pre class="nb-out nb-stream">rides\n<\/pre>/);
  assert.match(html, /Out \[2\]:<\/span><div class="nb-html"><table class="dataframe">/); // HTML preferred over plain text
  assert.match(html, /<div class="nb-image"><img src="data:image\/png;base64,/);
  assert.match(html, /<pre class="nb-out nb-error">ZeroDivisionError: division by zero<\/pre>/); // terminal colours removed
});

test('the Markdown reading: what search, links and diffs see', () => {
  const md = notebookMarkdown(parseNotebook(sampleNotebook()));
  assert.match(md, /```python\nimport pandas as pd\nprint\("rides"\)  # count\n```\n\n```text\nrides\n```/);
  assert.match(md, /\[\[Trip Plan\]\]/);
  assert.match(md, /ZeroDivisionError: division by zero/);
});

test('highlighting: tokens per language, unknown languages escaped', () => {
  assert.equal(highlight('def f(): return "x"', 'py'),
    '<span class="tok-keyword">def</span> f(): <span class="tok-keyword">return</span> <span class="tok-string">&quot;x&quot;</span>');
  assert.equal(highlight('SELECT 1 -- c', 'sql'), '<span class="tok-keyword">SELECT</span> <span class="tok-number">1</span> <span class="tok-comment">-- c</span>');
  assert.equal(highlight('<b>', 'cobol'), '&lt;b&gt;');
});

// --- hosted ----------------------------------------------------------------------------
let server, base, admin, dir;
before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'nb-'));
  const store = new Store(join(dir, 'a.db'));
  admin = store.createUser('ann', true);
  server = makeServer(store).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.close(); rmSync(dir, { recursive: true, force: true }); });
const put = async (name, body) => (await fetch(`${base}/api/artifacts/${name}`, { method: 'PUT', body, headers: { Authorization: `Bearer ${admin}` } })).json();

test('a notebook is a page of the site: title, tags, search, links, diffs, copy', async () => {
  await put('Trip-Plan.md', '# Trip Plan\n\nThe numbers: [[rides]].');
  const a = await put('rides.ipynb', sampleNotebook());
  assert.deepEqual([a.title, a.description, a.tags], ['Ride analysis', 'Rides per day', ['analysis', 'trips']]);

  const page = await (await fetch(`${base}/pages/rides`)).text(); // found by its bare name
  assert.match(page, /<h1 class="article-title">Ride analysis<\/h1>/);
  assert.match(page, /Python 3 · 4 code cells/);
  assert.match(page, /<a class="wikilink" href="\/pages\/Trip-Plan.md">Trip Plan<\/a>/);
  assert.match(page, /<section class="backlinks"><h3>Backlinks<\/h3><ul><li><a href="\/pages\/Trip-Plan.md"/); // [[rides]] from the note
  assert.match(page, /<span>Copy notebook<\/span>/);
  assert.equal(JSON.parse(JSON.parse(page.match(/<script id="page-source" type="application\/json">([^<]*)<\/script>/)[1])).nbformat, 4);
  assert.doesNotMatch(page, /class="page-frame/); // rendered by the server, not framed

  const found = await (await fetch(`${base}/api/search?q=pandas`)).json(); // code is searchable
  assert.deepEqual(found.results.map((r) => r.slug), ['rides.ipynb']);

  await put('rides.ipynb', sampleNotebook().replace('import pandas as pd', 'import polars as pl'));
  const diff = await (await fetch(`${base}/api/artifacts/rides.ipynb/diff`)).text();
  assert.match(diff, /^-import pandas as pd$/m); // cell by cell, not raw JSON
  assert.match(diff, /^\+import polars as pl$/m);
});
