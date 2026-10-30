// Jupyter notebooks (.ipynb), hosted like Markdown notes: the server renders them in
// the site's layout. A notebook is JSON: cells (Markdown, code with their saved
// outputs, raw) plus metadata. Markdown cells render as notes do (wikilinks, callouts,
// backlinks); code cells get highlighting and In [n] prompts; outputs show as saved:
// text, HTML (pandas tables, and charts whose JavaScript travels in the output),
// images, SVG, Markdown, JSON and errors. Nothing runs: there's no kernel, so widgets
// that need one show as their saved fallback.
//
// For search, titles, links and diffs a notebook is also read as Markdown
// (notebookMarkdown): Markdown cells as they are, code cells as fenced blocks.
import { highlight } from './highlight.js';
import { isMarkdown, parseFrontmatter, renderMarkdown, safeDecode } from './markdown.js';
import { escapeHtml as esc } from './text.js';

export const NOTEBOOK_RE = /\.ipynb$/i;
export const isNotebook = (slug) => NOTEBOOK_RE.test(slug);
/** Pages the server renders itself in the site's layout: Markdown notes and notebooks. */
export const isNote = (slug) => isMarkdown(slug) || isNotebook(slug);

const OUTPUT_TEXT_CHARS = 2000; // per output, in the Markdown reading (search and diffs)
const join = (v) => (Array.isArray(v) ? v.join('') : v == null ? '' : String(v));
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g; // terminal colours in tracebacks and some streams
const clean = (s) => join(s).replace(ANSI, '');

/**
 * { cells, metadata, front, language, kernel }. Format 4, and format 3 (worksheets).
 * A first raw or Markdown cell that is a YAML block (--- … ---, as Quarto and Jupytext
 * write) is the notebook's frontmatter: title, tags, description, aliases.
 */
export function parseNotebook(source) {
  let nb;
  try { nb = JSON.parse(source); } catch { return { cells: [], metadata: {}, front: {}, language: '', kernel: '', invalid: true }; }
  if (!nb || typeof nb !== 'object') return { cells: [], metadata: {}, front: {}, language: '', kernel: '', invalid: true };
  const raw = nb.cells || (nb.worksheets || []).flatMap((w) => w.cells || []);
  const cells = raw.map((c) => ({
    type: c.cell_type === 'heading' ? 'markdown' : c.cell_type,
    source: c.cell_type === 'heading' ? `${'#'.repeat(c.level || 1)} ${join(c.source)}` : join(c.source ?? c.input),
    n: c.execution_count ?? c.prompt_number ?? null,
    outputs: (c.outputs || []).map(output),
    attachments: c.attachments || {},
  }));
  const metadata = nb.metadata || {};
  let front = {};
  const first = cells[0];
  if (first && (first.type === 'raw' || first.type === 'markdown') && /^---\r?\n/.test(first.source)) {
    const { data, body } = parseFrontmatter(first.source);
    if (Object.keys(data).length) {
      front = data;
      first.source = body;
      if (!body.trim()) cells.shift();
    }
  }
  const language = metadata.kernelspec?.language || metadata.language_info?.name || metadata.language || 'python';
  const kernel = metadata.kernelspec?.display_name || metadata.language_info?.name || '';
  return { cells, metadata, front, language, kernel };
}

/** One output, in format 4's shape whatever the notebook's format. */
function output(o) {
  const type = { pyout: 'execute_result', pyerr: 'error' }[o.output_type] || o.output_type;
  let data = o.data;
  if (!data && (type === 'execute_result' || type === 'display_data')) { // format 3: one key per type
    data = {};
    for (const [k, mime] of [['png', 'image/png'], ['jpeg', 'image/jpeg'], ['svg', 'image/svg+xml'], ['html', 'text/html'],
      ['latex', 'text/latex'], ['markdown', 'text/markdown'], ['json', 'application/json'], ['text', 'text/plain']]) {
      if (o[k] != null) data[mime] = o[k];
    }
  }
  return { type, name: o.name || o.stream || 'stdout', text: join(o.text), data: data || {}, ename: o.ename, evalue: o.evalue, traceback: o.traceback || [] };
}

/** The notebook as Markdown: what search indexes, links are read from, and diffs compare. */
export function notebookMarkdown(nb) {
  return nb.cells.map((c) => {
    if (c.type !== 'code') return c.source;
    const outs = c.outputs.map(outputText).filter(Boolean).map((t) => t.slice(0, OUTPUT_TEXT_CHARS));
    return `\`\`\`${nb.language}\n${c.source}\n\`\`\`${outs.length ? `\n\n\`\`\`text\n${outs.join('\n')}\n\`\`\`` : ''}`;
  }).join('\n\n');
}

function outputText(o) {
  if (o.type === 'stream') return clean(o.text).trimEnd();
  if (o.type === 'error') return `${o.ename}: ${o.evalue}`;
  const plain = join(o.data['text/plain']);
  if (plain) return plain.trimEnd();
  const img = Object.keys(o.data).find((m) => m.startsWith('image/'));
  return img ? `[${img}]` : '';
}

/** Just the Markdown cells: where the title (first # heading) and wikilinks come from. */
export const markdownCells = (nb) => nb.cells.filter((c) => c.type === 'markdown').map((c) => c.source).join('\n\n');

/**
 * The notebook as HTML, for the note page. `resolve`, `asset` and `path` as for
 * renderMarkdown; `title` is dropped from the first Markdown cell when it opens with it
 * (the page shows it).
 */
export function renderNotebook(nb, { resolve, asset, title, path } = {}) {
  if (nb.invalid) return '<p class="nb-invalid">This file isn\'t a notebook HTML Server can read (not valid JSON).</p>';
  let first = true;
  const cells = nb.cells.map((c) => {
    if (c.type === 'markdown') {
      const html = renderMarkdown(withAttachments(c.source, c.attachments), { resolve, asset, path, title: first ? title : undefined });
      first = false;
      return html.trim() ? `<div class="nb-cell nb-md">${html}</div>` : '';
    }
    if (c.type === 'code') {
      const n = c.n ?? ' ';
      const outs = c.outputs.map((o) => renderOutput(o, n, { resolve, asset, path })).join('');
      return `<div class="nb-cell nb-code"><div class="nb-in"><span class="nb-prompt" aria-hidden="true">In [${esc(String(n))}]:</span>`
        + `<pre><code class="language-${esc(nb.language)}">${highlight(c.source, nb.language)}</code></pre></div>${outs ? `<div class="nb-outs">${outs}</div>` : ''}</div>`;
    }
    return c.source.trim() ? `<div class="nb-cell nb-raw"><pre>${esc(c.source)}</pre></div>` : '';
  });
  return `<div class="notebook">${cells.join('\n')}</div>`;
}

/**
 * Markdown cells refer to pasted images as attachment:name; those live in the cell, in
 * base64, except that an SVG may be kept as its text (it's XML, as SVG outputs are).
 */
function withAttachments(src, attachments) {
  return src.replace(/attachment:([^\s)"']+)/g, (m, name) => {
    const bundle = attachments[name] || attachments[safeDecode(name)];
    const mime = bundle && Object.keys(bundle).find((k) => k.startsWith('image/'));
    if (!mime) return m;
    const data = join(bundle[mime]);
    const svgText = mime === 'image/svg+xml' && /^\s*</.test(data);
    return `data:${mime};base64,${svgText ? Buffer.from(data).toString('base64') : data.replace(/\s/g, '')}`;
  });
}

// The richest form each output offers, in this order.
const PREFERRED = ['text/html', 'image/svg+xml', 'image/png', 'image/jpeg', 'image/gif', 'text/markdown', 'text/latex', 'application/json', 'text/plain'];

function renderOutput(o, n, opts) {
  if (o.type === 'stream') {
    const text = clean(o.text);
    return text ? `<pre class="nb-out nb-stream${o.name === 'stderr' ? ' nb-stderr' : ''}">${esc(text)}</pre>` : '';
  }
  if (o.type === 'error') {
    const tb = o.traceback.length ? o.traceback.map(clean).join('\n') : `${o.ename}: ${o.evalue}`;
    return `<pre class="nb-out nb-error">${esc(tb)}</pre>`;
  }
  const mime = PREFERRED.find((m) => o.data[m] != null) || Object.keys(o.data).find((m) => m.startsWith('image/'));
  if (!mime) return '';
  const v = o.data[mime];
  let body;
  if (mime === 'text/html') body = `<div class="nb-html">${join(v)}</div>`;
  else if (mime === 'image/svg+xml') body = `<div class="nb-image">${join(v)}</div>`;
  else if (mime.startsWith('image/')) body = `<div class="nb-image"><img src="data:${mime};base64,${join(v).replace(/\s/g, '')}" alt="Output ${esc(String(n))}"></div>`;
  else if (mime === 'text/markdown') body = `<div class="nb-md-out">${renderMarkdown(join(v), opts)}</div>`;
  else if (mime === 'application/json') body = `<pre>${esc(typeof v === 'string' ? v : JSON.stringify(v, null, 2))}</pre>`;
  else body = `<pre>${esc(clean(v))}</pre>`;
  const prompt = o.type === 'execute_result' ? `<span class="nb-prompt nb-out-prompt" aria-hidden="true">Out [${esc(String(n))}]:</span>` : '';
  return `<div class="nb-out nb-result">${prompt}${body}</div>`;
}
