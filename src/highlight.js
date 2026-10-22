// Syntax highlighting for code in notebooks and Markdown code blocks, without a
// library: one tokenizer per language family (comments, strings, numbers, keywords,
// builtins, decorators). Enough to read code comfortably, not a full grammar. Unknown
// languages come back escaped and plain. Colours are in public/style.css (--tok-*).
import { escapeHtml as esc } from './text.js';

const words = (s) => new Set(s.split(/\s+/));
const C_LIKE = /\/\/[^\n]*|\/\*[\s\S]*?\*\//;
const HASH = /#[^\n]*/;
const LANGS = {
  python: {
    comment: HASH,
    strings: /[rRbBfFuU]{0,2}(?:"""[\s\S]*?"""|'''[\s\S]*?'''|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*')/,
    keywords: words('and as assert async await break class continue def del elif else except False finally for from global if import in is lambda None nonlocal not or pass raise return True try while with yield match case'),
    builtins: words('print len range dict list set tuple int float str bool open super isinstance enumerate zip map filter sorted min max sum abs type self cls'),
    decorators: true,
  },
  javascript: {
    comment: C_LIKE,
    strings: /`(?:\\.|[^`\\])*`|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'/,
    keywords: words('async await break case catch class const continue debugger default delete do else export extends false finally for from function if import in instanceof let new null of return static super switch this throw true try typeof undefined var void while with yield interface type enum implements'),
    builtins: words('console document window Math JSON Object Array String Number Promise Map Set fetch require module'),
  },
  shell: {
    comment: HASH,
    strings: /"(?:\\.|[^"\\])*"|'[^']*'/,
    keywords: words('if then else elif fi for while until do done case esac function in export local return set unset source alias'),
    builtins: words('echo cd ls cat grep sed awk curl git npm npx node pip python python3 make sudo mkdir rm cp mv'),
  },
  sql: {
    comment: /--[^\n]*|\/\*[\s\S]*?\*\//,
    strings: /'(?:''|[^'])*'/,
    keywords: words('select from where and or not in is null as join left right inner outer full on group by order having limit offset insert into values update set delete create table view index drop alter with distinct union all case when then else end asc desc between like exists primary key'),
    builtins: words('count sum avg min max coalesce cast date now lower upper length round'),
    caseless: true,
  },
  r: {
    comment: HASH,
    strings: /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/,
    keywords: words('if else repeat while function for in next break TRUE FALSE NULL Inf NaN NA return library require'),
    builtins: words('c list data.frame print paste mean sum length vector matrix apply sapply lapply'),
  },
};
const ALIASES = { py: 'python', python3: 'python', ipython: 'python', ipython3: 'python', js: 'javascript', ts: 'javascript', typescript: 'javascript',
  jsx: 'javascript', tsx: 'javascript', node: 'javascript', sh: 'shell', bash: 'shell', zsh: 'shell', console: 'shell', postgres: 'sql', sqlite: 'sql' };

const compiled = new Map();
function grammar(lang) {
  const name = ALIASES[lang?.toLowerCase()] || lang?.toLowerCase();
  const g = LANGS[name];
  if (!g) return null;
  if (!compiled.has(name)) {
    const parts = [`(${g.comment.source})`, `(${g.strings.source})`, '(\\b\\d[\\d_]*\\.?\\d*(?:[eE][+-]?\\d+)?j?\\b|\\b0x[\\da-fA-F]+\\b)',
      g.decorators ? '(@[\\w.]+)' : '((?!))', '([A-Za-z_][\\w.]*)'];
    compiled.set(name, { ...g, re: new RegExp(parts.join('|'), 'g') });
  }
  return compiled.get(name);
}

/** `code` as HTML: escaped, with <span class="tok-…"> around the tokens of `lang`. */
export function highlight(code, lang) {
  const g = grammar(lang);
  if (!g) return esc(code);
  let out = '', at = 0;
  for (const m of code.matchAll(g.re)) {
    out += esc(code.slice(at, m.index));
    const [tok, comment, string, number, decorator, word] = m;
    const key = word && (g.caseless ? word.toLowerCase() : word);
    const cls = comment ? 'comment' : string ? 'string' : number ? 'number' : decorator ? 'decorator'
      : g.keywords.has(key) ? 'keyword' : g.builtins.has(key) ? 'builtin' : null;
    out += cls ? `<span class="tok-${cls}">${esc(tok)}</span>` : esc(tok);
    at = m.index + tok.length;
  }
  return out + esc(code.slice(at));
}
