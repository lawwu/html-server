// Text helpers: HTML → visible text (for search and diffs), fuzzy word matching,
// FTS5 query building, and line diffs (unified + grouped for the side-by-side view).
import { DIFF_CONTEXT_LINES, FUZZY_CUTOFF, FUZZY_MAX_EXPANSIONS, FUZZY_MIN_LEN } from './config.js';

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// --- HTML → text --------------------------------------------------------------
// A regex pass, not a full parser: good enough to index and diff what a reader
// sees. Script/style/noscript bodies are dropped; block elements become line breaks.
const BLOCK = new Set(['p', 'div', 'li', 'br', 'tr', 'td', 'th', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'section',
  'article', 'header', 'footer', 'table', 'ul', 'ol', 'pre', 'blockquote', 'hr', 'dt', 'dd', 'title']);
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–',
  hellip: '…', rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”', middot: '·', bull: '•', copy: '©', times: '×' };

function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      try { return String.fromCodePoint(code); } catch { return m; }
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

function visibleText(doc) {
  return decodeEntities(doc
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<[!?][^>]*>/g, ' ')
    .replace(/<\/?([a-zA-Z][\w-]*)\b[^>]*>/g, (_, tag) => (BLOCK.has(tag.toLowerCase()) ? '\n' : '')));
}

/** { title from <title>, visible text on one line } for indexing. */
export function extractText(doc) {
  const m = doc.match(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i);
  const title = m ? decodeEntities(m[1]).replace(/\s+/g, ' ').trim() : '';
  return { title, body: visibleText(doc).replace(/\s+/g, ' ').trim() };
}

/** Visible text, one line per block element: what a reader would call "the content". */
export function extractLines(doc) {
  return visibleText(doc).split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
}

// --- Fuzzy matching -------------------------------------------------------------
// Ratcliff/Obershelp similarity, as in Python's difflib.SequenceMatcher.ratio():
// 2 * matching characters / total characters, where matches are found by taking
// the longest common substring and recursing on both sides of it.
function matching(a, b) {
  if (!a.length || !b.length) return 0;
  let best = 0, ai = 0, bi = 0;
  let prev = new Uint16Array(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    const cur = new Uint16Array(b.length + 1);
    for (let j = 1; j <= b.length; j++) {
      if (a[i - 1] === b[j - 1]) {
        cur[j] = prev[j - 1] + 1;
        if (cur[j] > best) { best = cur[j]; ai = i - best; bi = j - best; }
      }
    }
    prev = cur;
  }
  if (!best) return 0;
  return best + matching(a.slice(0, ai), b.slice(0, bi)) + matching(a.slice(ai + best), b.slice(bi + best));
}

export function similarity(a, b) {
  return a.length + b.length ? (2 * matching(a, b)) / (a.length + b.length) : 1;
}

/** Up to n words from vocab at least `cutoff` similar to word, best first. */
export function closeMatches(word, vocab, n = FUZZY_MAX_EXPANSIONS, cutoff = FUZZY_CUTOFF) {
  const hits = [];
  for (const w of vocab) {
    // Cheap upper bound first: the ratio can't beat 2*min(len)/total.
    if ((2 * Math.min(w.length, word.length)) / (w.length + word.length) < cutoff) continue;
    const r = similarity(word, w);
    if (r >= cutoff) hits.push([r, w]);
  }
  return hits.sort((x, y) => y[0] - x[0] || (y[1] > x[1] ? 1 : -1)).slice(0, n).map(([, w]) => w);
}

/**
 * Plain words in, an FTS5 query out (user input is never FTS syntax).
 * Every word must match (AND): as a prefix ("ube" → "uber"), or as any indexed
 * word close enough to be a typo of it ("sheling" → "shelling").
 */
export function ftsQuery(q, vocab = []) {
  const terms = (q.toLowerCase().match(/[\p{L}\p{N}_]+/gu) || []);
  if (!terms.length) throw new ApiError(400, 'empty search');
  return terms.map((t) => {
    const alts = [`"${t}"*`];
    if (t.length >= FUZZY_MIN_LEN) {
      for (const w of closeMatches(t, vocab)) if (!w.startsWith(t)) alts.push(`"${w}"`);
    }
    return `(${alts.join(' OR ')})`;
  }).join(' AND ');
}

// --- Line diffs -------------------------------------------------------------------
/** difflib-style opcodes: [tag, i1, i2, j1, j2] with tag equal|replace|delete|insert. */
export function opcodes(a, b) {
  // Trim the common prefix and suffix first: usually most of the document.
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const A = a.slice(pre, a.length - suf), B = b.slice(pre, b.length - suf);
  // LCS table over what's left.
  const n = A.length, m = B.length, w = m + 1;
  const L = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      L[i * w + j] = A[i] === B[j] ? L[(i + 1) * w + j + 1] + 1 : Math.max(L[(i + 1) * w + j], L[i * w + j + 1]);
    }
  }
  const steps = []; // 'e' | 'd' | 'i'
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) { steps.push('e'); i++; j++; }
    else if (L[(i + 1) * w + j] >= L[i * w + j + 1]) { steps.push('d'); i++; }
    else { steps.push('i'); j++; }
  }
  while (i++ < n) steps.push('d');
  while (j++ < m) steps.push('i');

  const codes = [];
  const push = (tag, i1, i2, j1, j2) => {
    if (i1 === i2 && j1 === j2) return;
    const last = codes.at(-1);
    if (last && last[0] === tag) { last[2] = i2; last[4] = j2; return; }
    if (last && tag !== 'equal' && last[0] !== 'equal') { last[0] = 'replace'; last[2] = i2; last[4] = j2; return; }
    codes.push([tag, i1, i2, j1, j2]);
  };
  push('equal', 0, pre, 0, pre);
  let x = pre, y = pre;
  for (const s of steps) {
    if (s === 'e') { push('equal', x, x + 1, y, y + 1); x++; y++; }
    else if (s === 'd') { push('delete', x, x + 1, y, y); x++; }
    else { push('insert', x, x, y, y + 1); y++; }
  }
  push('equal', x, x + suf, y, y + suf);
  return codes;
}

/** Hunks of opcodes with `n` lines of context, as difflib.get_grouped_opcodes. */
export function groupedOpcodes(a, b, n = DIFF_CONTEXT_LINES) {
  let codes = opcodes(a, b);
  if (!codes.length) codes = [['equal', 0, 1, 0, 1]];
  codes = codes.map((c) => [...c]);
  if (codes[0][0] === 'equal') {
    const [t, i1, i2, j1, j2] = codes[0];
    codes[0] = [t, Math.max(i1, i2 - n), i2, Math.max(j1, j2 - n), j2];
  }
  const last = codes.length - 1;
  if (codes[last][0] === 'equal') {
    const [t, i1, i2, j1, j2] = codes[last];
    codes[last] = [t, i1, Math.min(i2, i1 + n), j1, Math.min(j2, j1 + n)];
  }
  const groups = [];
  let group = [];
  for (let [t, i1, i2, j1, j2] of codes) {
    if (t === 'equal' && i2 - i1 > 2 * n) {
      group.push([t, i1, Math.min(i2, i1 + n), j1, Math.min(j2, j1 + n)]);
      groups.push(group);
      group = [];
      i1 = Math.max(i1, i2 - n);
      j1 = Math.max(j1, j2 - n);
    }
    group.push([t, i1, i2, j1, j2]);
  }
  if (group.length && !(group.length === 1 && group[0][0] === 'equal')) groups.push(group);
  return groups;
}

function unifiedRange(start, stop) {
  let begin = start + 1;
  const len = stop - start;
  if (len === 1) return `${begin}`;
  if (!len) begin -= 1;
  return `${begin},${len}`;
}

/** A unified diff (empty string when nothing changed), like `diff -u`. */
export function unifiedDiff(a, b, fromLabel, toLabel, n = DIFF_CONTEXT_LINES) {
  const out = [];
  for (const group of groupedOpcodes(a, b, n)) {
    if (!out.length) out.push(`--- ${fromLabel}`, `+++ ${toLabel}`);
    const first = group[0], lastOp = group.at(-1);
    out.push(`@@ -${unifiedRange(first[1], lastOp[2])} +${unifiedRange(first[3], lastOp[4])} @@`);
    for (const [t, i1, i2, j1, j2] of group) {
      if (t === 'equal') { for (const l of a.slice(i1, i2)) out.push(' ' + l); continue; }
      if (t === 'replace' || t === 'delete') for (const l of a.slice(i1, i2)) out.push('-' + l);
      if (t === 'replace' || t === 'insert') for (const l of b.slice(j1, j2)) out.push('+' + l);
    }
  }
  return out.length ? out.join('\n') + '\n' : '';
}

export const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
