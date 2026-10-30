import { linkPath } from './paths.js';
// Text helpers: HTML → visible text (for search and diffs), fuzzy word matching,
// FTS5 query building, search snippets, and line diffs (unified + grouped for the
// side-by-side view).
import {
  RESERVED_SLUGS, DIFF_CONTEXT_LINES, DIFF_MAX_CELLS, DIFF_MAX_STEPS, FUZZY_CUTOFF, FUZZY_MAX_EXPANSIONS, FUZZY_MIN_LEN, MAX_WORD_FORMS, PAGE_EXT_RE, SCRIPT_TEXT_CHARS,
  SNIPPET_WORDS,
} from './config.js';

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

/** The content of <meta name="NAME" content="...">, or ''. */
export function metaContent(doc, name) {
  for (const tag of doc.match(/<meta\b[^>]*>/gi) || []) {
    if (new RegExp(`\\bname\\s*=\\s*["']?${name}["'\\s>/]`, 'i').test(tag)) {
      const m = tag.match(/\bcontent\s*=\s*(?:"([^"]*)"|'([^']*)')/i);
      if (m) return (m[1] ?? m[2]).trim();
    }
  }
  return '';
}

/**
 * The pages a page links to on this server: href values like "/pages/x.html",
 * "/x.html" or a bare relative "x.html" / "./x". Returns candidate slugs (deduplicated);
 * whether each one exists is decided when the graph is drawn, so a link to a page
 * uploaded later starts counting then.
 */
export function extractLinks(doc, { isSlug = () => true, basePath = '' } = {}) {
  const out = new Set();
  for (const m of doc.matchAll(/\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)) {
    let href = (m[1] ?? m[2] ?? m[3] ?? '').trim().replace(/[?#].*$/, '');
    if (!href || /^[a-z][a-z0-9+.-]*:|^\/\//i.test(href)) continue; // other sites, mailto:, data:, …
    try { href = decodeURIComponent(href); } catch { continue; }
    const slug = linkPath(href, basePath);
    if (slug && !RESERVED_SLUGS.has(slug.split('/')[0].toLowerCase()) && isSlug(slug)) out.add(slug);
  }
  return [...out];
}

/** Visible text, one line per block element: what a reader would call "the content". */
export function extractLines(doc) {
  return visibleText(doc).split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
}

// Pages that draw themselves (a board of tickets, a quiz, a chart's messages) keep much
// of their text in their scripts. The string literals there that read as prose (two or
// more words, not CSS, markup or code) are kept for search; one-word strings are mostly
// keys, classes and event names, so they're left out. Comments are matched first, so a
// quote inside one doesn't start a string. A script past LIBRARY_BYTES is taken to be a
// library pasted in, whose messages aren't the page's.
const JS_STRINGS = /\/\*[\s\S]*?\*\/|\/\/[^\n]*|(["'`])((?:\\[\s\S]|(?!\1)[^\\])*)\1/g;
const CODE_LIKE = new RegExp([
  /^[.#[(:@/]|^(?:px|r?em)\b|[{};=<>|\\]|&&|=>/, // selectors, markup, code
  /\[[\w-]+[\]=~|^$*]|\p{L},\p{L}|\d(?:px|r?em|v[hw]|ms|deg)\b|^[\w-]+:\s*\S+$/, // attribute selectors, font lists, lengths, declarations
  /\b(?:rgba?|hsla?|calc|var|url|translate\w*|rotate|scale|cubic-bezier)\(/,
].map((r) => r.source).join('|'), 'u');
const LIBRARY_BYTES = 100 * 1024;
const unescapeJs = (s) => s.replace(/\\(?:u\{([0-9a-f]+)\}|u([0-9a-f]{4})|x([0-9a-f]{2})|([\s\S]))/gi, (_, u1, u2, x, c) => {
  if (c != null) return 'nrtfvb'.includes(c) ? ' ' : c;
  try { return String.fromCodePoint(parseInt(u1 ?? u2 ?? x, 16)); } catch { return ' '; }
});
const prose = (s, minWords) => (s.match(/(?:^|\s)\S*\p{L}{2}/gu) || []).length >= minWords && !CODE_LIKE.test(s)
  && (s.match(/[\p{L}\s]/gu) || []).length >= s.length * 0.7;

/** Prose from a page's inline scripts, one string per line (and JSX text, in text/babel ones). */
export function scriptText(doc) {
  const out = new Set();
  let size = 0;
  const keep = (s, minWords = 2) => {
    s = s.replace(/\s+/g, ' ').trim();
    if (size < SCRIPT_TEXT_CHARS && !out.has(s) && prose(s, minWords)) { out.add(s); size += s.length; }
  };
  for (const [, attrs, code] of doc.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
    if (/\bsrc\s*=/i.test(attrs) || code.length > LIBRARY_BYTES) continue;
    const type = (attrs.match(/\btype\s*=\s*["']?([^"'\s>]+)/i)?.[1] || '').toLowerCase();
    if (/template|html/.test(type)) { visibleText(code).split('\n').forEach((l) => keep(l, 1)); continue; }
    if (/babel|jsx/.test(type)) for (const [, t] of code.matchAll(/>([^<>{}]+)</g)) keep(decodeEntities(t), 1);
    for (const [, quote, body] of code.matchAll(JS_STRINGS)) {
      if (!quote) continue; // a comment
      const text = quote === '`' ? body.replace(/\$\{[^}]*\}/g, ' ') : body; // `${n} pages` reads as " pages"
      visibleText(unescapeJs(text)).split('\n').forEach((l) => keep(l));
    }
  }
  return [...out].join('\n');
}

/**
 * What a page is called, for the search index: its file name as words
 * ("kmeans-step-through.html" → "kmeans step through"), joined-up words also apart
 * ("ObsidianFlavoredMarkdown" → "Obsidian Flavored Markdown"), hyphenated title words
 * also together ("k-means" → "kmeans"), then `more` (its aliases and tags).
 */
export function searchName(slug, title, more = []) {
  const name = slug.replace(PAGE_EXT_RE, '').replace(/[-_.]+/g, ' ');
  const apart = `${name} ${title}`.split(/\s+/).map((w) => [w, w.replace(/(\p{Ll}|\p{N})(?=\p{Lu})|(\p{Lu})(?=\p{Lu}\p{Ll})/gu, '$1$2 ')])
    .filter(([w, split]) => split !== w).map(([, split]) => split);
  const joined = (title.match(/\p{L}+(?:-\p{L}+)+/gu) || []).map((w) => w.replace(/-/g, ''));
  return [name, ...apart, ...joined, ...more].join(' ');
}

// --- Fuzzy matching -------------------------------------------------------------
// Ratcliff/Obershelp similarity, as in Python's difflib.SequenceMatcher.ratio():
// 2 * matching characters / total characters, where matches are found by taking
// the longest common substring and recursing on both sides of it.
let rowA = new Uint16Array(64), rowB = new Uint16Array(64); // reused: this runs for many words per search
function matching(a, b) {
  if (!a.length || !b.length) return 0;
  if (rowA.length <= b.length) [rowA, rowB] = [new Uint16Array(b.length + 1), new Uint16Array(b.length + 1)];
  let best = 0, ai = 0, bi = 0, prev = rowA, cur = rowB;
  prev.fill(0, 0, b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    cur[0] = 0;
    for (let j = 1; j <= b.length; j++) {
      if (a[i - 1] !== b[j - 1]) { cur[j] = 0; continue; }
      cur[j] = prev[j - 1] + 1;
      if (cur[j] > best) { best = cur[j]; ai = i - best; bi = j - best; }
    }
    [prev, cur] = [cur, prev];
  }
  if (!best) return 0;
  return best + matching(a.slice(0, ai), b.slice(0, bi)) + matching(a.slice(ai + best), b.slice(bi + best));
}

export function similarity(a, b) {
  return a.length + b.length ? (2 * matching(a, b)) / (a.length + b.length) : 1;
}

// Per call to closeMatches: how many of each character the typed word has, and how many
// of those the word being tried has used.
const NEED = new Int32Array(65536), USED = new Int32Array(65536);

/**
 * Up to n words from vocab at least `cutoff` similar to word, best first, leaving out any
 * that `skip` says to. A word also counts if its *beginning* is close to what was typed,
 * so a typo while still typing ("gardn") finds the longer word ("gardening"); those rank
 * just below whole-word matches. Most words are ruled out without working out the ratio:
 * the characters it matches can't outnumber the characters the two words share.
 */
export function closeMatches(word, vocab, n = FUZZY_MAX_EXPANSIONS, cutoff = FUZZY_CUTOFF, skip = null) {
  const len = word.length, hits = [];
  for (let i = 0; i < len; i++) NEED[word.charCodeAt(i)]++;
  for (const w of vocab) {
    let shared = 0, sharedStart = 0;
    for (let i = 0; i < w.length; i++) {
      const c = w.charCodeAt(i);
      if (USED[c] < NEED[c]) { USED[c]++; shared++; }
      if (i === len - 1) sharedStart = shared;
    }
    for (let i = 0; i < w.length; i++) USED[w.charCodeAt(i)] = 0;
    const whole = (2 * shared) / (len + w.length) >= cutoff;
    const start = w.length > len && len >= 4 && ((2 * sharedStart) / (2 * len)) * 0.98 >= cutoff;
    if ((!whole && !start) || skip?.(w)) continue;
    let r = whole ? similarity(word, w) : 0;
    if (r < cutoff && start) r = similarity(word, w.slice(0, len)) * 0.98;
    if (r >= cutoff) hits.push([r, w]);
  }
  for (let i = 0; i < len; i++) NEED[word.charCodeAt(i)] = 0;
  return hits.sort((x, y) => y[0] - x[0] || (y[1] > x[1] ? 1 : -1)).slice(0, n).map(([, w]) => w);
}

/**
 * Other forms of an English word, by rule rather than from a dictionary: "studies" →
 * study, studied; "running" → run; "make" → making. Most aren't words; callers keep the
 * ones some page uses.
 */
export function wordForms(word) {
  const stems = new Set([word]);
  if (word.length >= 4) {
    if (word.endsWith('ies')) stems.add(word.slice(0, -3) + 'y');
    if (word.endsWith('es')) stems.add(word.slice(0, -2));
    if (word.endsWith('s') && !word.endsWith('ss')) stems.add(word.slice(0, -1));
    if (word.endsWith('ied')) stems.add(word.slice(0, -3) + 'y');
    if (word.endsWith('ed') && !word.endsWith('eed')) stems.add(word.slice(0, -2)).add(word.slice(0, -1));
    if (word.endsWith('ing')) stems.add(word.slice(0, -3)).add(word.slice(0, -3) + 'e');
  }
  for (const s of [...stems]) if (/([^aeiouslz])\1$/.test(s)) stems.add(s.slice(0, -1)); // plott → plot, runn → run
  const forms = new Set();
  for (const s of stems) {
    if (s.length < 3 || !/[aeiouy]/.test(s.slice(0, -1))) continue; // "thing" isn't "th" + ing
    forms.add(s).add(`${s}s`).add(`${s}es`).add(`${s}ed`).add(`${s}ing`);
    if (s.endsWith('e')) forms.add(`${s}d`).add(`${s.slice(0, -1)}ing`);
    if (/[^aeiou]y$/.test(s)) forms.add(`${s.slice(0, -1)}ies`).add(`${s.slice(0, -1)}ied`);
    if (/^[^aeiou]*[aeiou][^aeiouwxy]$/.test(s)) forms.add(`${s}${s.at(-1)}ing`).add(`${s}${s.at(-1)}ed`); // plot → plotting
  }
  forms.delete(word);
  return [...forms];
}

/**
 * The words in the search index, for matching typos and other forms of a word. Built
 * again whenever the index changes; it remembers its answers, because live search asks
 * about the same words with every key pressed.
 */
export class Vocabulary {
  constructor(terms) {
    this.terms = terms;
    this.known = null; // a Set of the terms, made when first needed
    this.memo = new Map();
  }

  has(word) { return (this.known ??= new Set(this.terms)).has(word); }

  /**
   * Indexed words a typed word matches besides the ones it starts: its other forms,
   * then close misspellings. A misspelling may be a letter short, not more: "rotate"
   * holds "rate", and "share" holds "are", but nobody typing those meant them.
   */
  alternatives(word) {
    let alts = this.memo.get(word);
    if (!alts) {
      const forms = wordForms(word).filter((w) => !w.startsWith(word) && this.has(w)).slice(0, MAX_WORD_FORMS);
      const skip = (w) => w.length < word.length - 1 || w.startsWith(word) || forms.includes(w);
      alts = [...forms, ...closeMatches(word, this.terms, FUZZY_MAX_EXPANSIONS, FUZZY_CUTOFF, skip)];
      if (this.memo.size >= 1000) this.memo.clear();
      this.memo.set(word, alts);
    }
    return alts;
  }
}

/**
 * The words of a query, lowercased, each with `also`: the indexed words it matches
 * besides those it's a prefix of (none with `typos: false`, or for 1-2 letter words).
 */
export function queryWords(q, vocab = [], { typos = true } = {}) {
  const v = vocab instanceof Vocabulary ? vocab : new Vocabulary(vocab);
  const words = q.toLowerCase().match(/[\p{L}\p{N}_]+/gu) || [];
  if (!words.length) throw new ApiError(400, 'empty search');
  return words.map((word) => ({ word, also: typos && word.length >= FUZZY_MIN_LEN ? v.alternatives(word) : [] }));
}

/** queryWords as an FTS5 query: every word must match, as a prefix or as one of its alternatives. */
export const ftsMatch = (words) => words.map(({ word, also }) => `(${[`"${word}"*`, ...also.map((w) => `"${w}"`)].join(' OR ')})`).join(' AND ');

/**
 * Plain words in, an FTS5 query out (user input is never FTS syntax).
 * Every word must match (AND): as a prefix ("ube" → "uber"), as another form of it
 * that a page uses ("studies" → "study"), or as an indexed word close enough to be a
 * typo of it ("sheling" → "shelling").
 */
export const ftsQuery = (q, vocab = [], opts) => ftsMatch(queryWords(q, vocab, opts));

// --- Search snippets ----------------------------------------------------------------
// The few words of a page around what matched, matches marked. Made here from the
// indexed text, not with FTS5's snippet(): that runs the query again for each page,
// which for a short prefix ("th" covers thousands of words) costs more than the search.
const WORD = /[\p{L}\p{N}\p{Co}]+/gu; // what FTS5's unicode61 tokenizer counts as a word
const fold = (s) => (/[^\x00-\x7f]/.test(s) ? s.normalize('NFD').replace(/\p{M}/gu, '') : s).toLowerCase();

/**
 * About `size` words of `text` with as many of the query's words (from queryWords) as it
 * can hold, matches between \u0001 and \u0002 and '…' where it was cut, as FTS5's
 * snippet() gives. Where nothing matches, its opening words.
 */
export function snippet(text, words, size = SNIPPET_WORDS) {
  const at = [], hit = [];
  for (const m of text.matchAll(WORD)) {
    const t = fold(m[0]);
    at.push(m.index, m.index + m[0].length);
    hit.push(words.findIndex(({ word, also }) => t.startsWith(word) || also.includes(t)));
  }
  const n = hit.length;
  if (!n) return '';
  // The window holding the most different words, then the most matches; the first such.
  const count = words.map(() => 0);
  let start = 0, bestScore = 0, distinct = 0, total = 0;
  for (let i = 0; i < n; i++) {
    if (hit[i] >= 0) { if (!count[hit[i]]++) distinct++; total++; }
    const out = i - size;
    if (out >= 0 && hit[out] >= 0) { if (!--count[hit[out]]) distinct--; total--; }
    const score = distinct * (size + 1) + total;
    if (score > bestScore) { bestScore = score; start = Math.max(0, i - size + 1); }
  }
  if (bestScore) { // centre the matches in it
    let first = -1, last = -1;
    for (let i = start; i < Math.min(n, start + size); i++) if (hit[i] >= 0) { if (first < 0) first = i; last = i; }
    start = Math.max(0, Math.min(n - size, first - Math.floor((size - (last - first + 1)) / 2)));
  }
  const end = Math.min(n, start + size);
  let s = start ? '…' : text.slice(0, at[0]);
  for (let i = start; i < end; i++) {
    if (i > start) s += text.slice(at[2 * i - 1], at[2 * i]);
    const w = text.slice(at[2 * i], at[2 * i + 1]);
    s += hit[i] >= 0 ? `\u0001${w}\u0002` : w;
  }
  return s + (end < n ? '…' : text.slice(at[2 * n - 1]));
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
  // What's left: a table of longest common subsequences when it's small enough, else Myers'
  // diff, which takes time in proportion to how much changed and memory to the lines alone.
  const steps = A.length * B.length <= DIFF_MAX_CELLS ? lcsSteps(A, B) : myersSteps(A, B);

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

/** The steps ('e' keep, 'd' delete, 'i' insert) from A to B, read off a table of longest common subsequences. */
export function lcsSteps(A, B) {
  const n = A.length, m = B.length, w = m + 1;
  const L = new (Math.min(n, m) < 65536 ? Uint16Array : Uint32Array)((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      L[i * w + j] = A[i] === B[j] ? L[(i + 1) * w + j + 1] + 1 : Math.max(L[(i + 1) * w + j], L[i * w + j + 1]);
    }
  }
  const steps = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) { steps.push('e'); i++; j++; }
    else if (L[(i + 1) * w + j] >= L[i * w + j + 1]) { steps.push('d'); i++; }
    else { steps.push('i'); j++; }
  }
  while (i++ < n) steps.push('d');
  while (j++ < m) steps.push('i');
  return steps;
}

/**
 * The same steps by Myers' O(ND) diff, in linear space (Myers 1986, "An O(ND) Difference
 * Algorithm and Its Variations", section 4b): find the middle snake of the shortest edit
 * script, then solve each side of it the same way. Past `budget` steps of work it gives up:
 * versions that far apart get "too many changes to show" rather than holding up the server.
 */
export function myersSteps(A, B, budget = DIFF_MAX_STEPS) {
  const steps = [], size = A.length + B.length + 2;
  const vf = new Int32Array(2 * size + 1), vb = new Int32Array(2 * size + 1);
  let spent = 0;

  // The middle snake of A[a0, a1) and B[b0, b1), both non-empty: [x, y, u, v], where it runs
  // from (x, y) to (u, v) along matching lines.
  function middle(a0, a1, b0, b1) {
    const n = a1 - a0, m = b1 - b0, delta = n - m, odd = (delta & 1) === 1;
    vf[size + 1] = 0;
    vb[size + 1] = 0;
    for (let d = 0; d <= Math.ceil((n + m) / 2); d++) {
      for (let k = -d; k <= d; k += 2) { // forward, from the start
        let x = k === -d || (k !== d && vf[size + k - 1] < vf[size + k + 1]) ? vf[size + k + 1] : vf[size + k - 1] + 1;
        let y = x - k;
        const x0 = x, y0 = y;
        while (x < n && y < m && A[a0 + x] === B[b0 + y]) { x++; y++; }
        vf[size + k] = x;
        if ((spent += 1 + x - x0) > budget) tooMany();
        if (odd && k >= delta - (d - 1) && k <= delta + (d - 1) && x + vb[size + delta - k] >= n) return [a0 + x0, b0 + y0, a0 + x, b0 + y];
      }
      for (let k = -d; k <= d; k += 2) { // backward, from the end
        let x = k === -d || (k !== d && vb[size + k - 1] < vb[size + k + 1]) ? vb[size + k + 1] : vb[size + k - 1] + 1;
        let y = x - k;
        const x0 = x, y0 = y;
        while (x < n && y < m && A[a1 - 1 - x] === B[b1 - 1 - y]) { x++; y++; }
        vb[size + k] = x;
        if ((spent += 1 + x - x0) > budget) tooMany();
        if (!odd && k >= delta - d && k <= delta + d && x + vf[size + delta - k] >= n) return [a1 - x, b1 - y, a1 - x0, b1 - y0];
      }
    }
    throw new Error('no middle snake'); // unreachable: the two searches always meet
  }

  (function solve(a0, a1, b0, b1) {
    while (a0 < a1 && b0 < b1 && A[a0] === B[b0]) { steps.push('e'); a0++; b0++; }
    let suffix = 0;
    while (a1 > a0 && b1 > b0 && A[a1 - 1] === B[b1 - 1]) { a1--; b1--; suffix++; }
    if (a0 === a1) for (let j = b0; j < b1; j++) steps.push('i');
    else if (b0 === b1) for (let i = a0; i < a1; i++) steps.push('d');
    else {
      const [x, y, u, v] = middle(a0, a1, b0, b1);
      solve(a0, x, b0, y);
      for (let i = x; i < u; i++) steps.push('e');
      solve(u, a1, v, b1);
    }
    for (let i = 0; i < suffix; i++) steps.push('e');
  })(0, A.length, 0, B.length);
  return steps;
}

const tooMany = () => { throw new ApiError(422, 'too many changes to show: these versions differ almost everywhere; compare their sources instead'); };

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

// Search highlighting. SQLite marks matched words with \u0001…\u0002 (characters that
// never appear in page text), and cards turn them into <mark>, so a title like
// "[Draft] plan" can't be mistaken for a highlight. The API spells them [ and ].
export const HIT = Symbol('search hits'); // on a search result: { title, snippet } with raw markers
export const markHits = (escaped) => escaped.replace(/\u0001/g, '<mark>').replace(/\u0002/g, '</mark>');
export const bracketHits = (s) => s.replace(/\u0001/g, '[').replace(/\u0002/g, ']');

export const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
