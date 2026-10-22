// Markdown notes, Quartz/Obsidian style: frontmatter, [[wikilinks]] that resolve to
// Markdown or HTML pages on this server, callouts (> [!note]), ==highlights==, heading
// anchors, and a reading-page template with backlinks. Rendering uses `marked`
// (GitHub-flavoured Markdown); everything Quartz-specific is ours, below.
import { Marked } from 'marked';
import { highlight } from './highlight.js';
import { escapeHtml as esc } from './text.js';

export const MARKDOWN_RE = /\.(md|markdown)$/i;
export const isMarkdown = (slug) => MARKDOWN_RE.test(slug);

/** A note's file name → its page name: "Weekly Review.md" → "Weekly-Review.md" (as Quartz slugs paths). */
export function noteSlug(fileName) {
  return fileName.trim().replace(/\s+/g, '-').replace(/[^A-Za-z0-9._-]/g, '').replace(/^[^A-Za-z0-9]+/, '').replace(/-+/g, '-');
}

/** A note's folder path and file name → its page name, the way Quartz paths become slugs: "plugins/Back links.md" → "plugins-Back-links.md". */
export const notePathSlug = (rel) => rel.split('/').map((p) => noteSlug(p)).filter(Boolean).join('-');

/**
 * A wikilink target → the page name(s) it may mean, most specific first:
 * "plugins/Backlinks" → ["plugins-Backlinks", "Backlinks"]; "Weekly Review" → ["Weekly-Review"].
 * The bare file name is the fallback Quartz calls "shortest path".
 */
export function wikiTargets(target) {
  const t = target.trim().replace(/^\/+|\/+$/g, '');
  const base = noteSlug(t.split('/').pop());
  return t.includes('/') ? [notePathSlug(t), base] : [base];
}
export const wikiTarget = (target) => wikiTargets(target)[0];

/** Heading text → anchor id; the same rule the contents sidebar uses, so #links agree. */
export const headingId = (text) =>
  text.toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '').slice(0, 60) || 'section';

// --- frontmatter --------------------------------------------------------------------
/**
 * The YAML subset notes actually use: `key: value`, `key: [a, b]`, and block lists
 * (`key:` then `  - a`). Quoted strings, numbers and true/false are understood;
 * anything fancier is kept as a string. Returns { data, body }.
 */
export function parseFrontmatter(md) {
  const m = md.match(/^﻿?---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
  if (!m) return { data: {}, body: md };
  const data = {};
  let listKey = null;
  const scalar = (v) => {
    v = v.trim();
    if (/^(['"]).*\1$/.test(v)) return v.slice(1, -1);
    if (v === 'true' || v === 'false') return v === 'true';
    if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
    return v;
  };
  for (const raw of m[1].split(/\r?\n/)) {
    if (!raw.trim() || raw.trim().startsWith('#')) continue;
    const item = raw.match(/^\s*-\s+(.*)$/);
    if (item && listKey) { data[listKey].push(scalar(item[1])); continue; }
    const kv = raw.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (!kv) continue;
    const [, key, value] = kv;
    if (value === '') { data[key] = []; listKey = key; continue; }
    listKey = null;
    data[key] = /^\[.*\]$/.test(value.trim())
      ? value.trim().slice(1, -1).split(',').map(scalar).filter((x) => x !== '')
      : scalar(value);
  }
  return { data, body: md.slice(m[0].length) };
}

/** Frontmatter tags in either form ("a, b", [a, b], a list), without leading #. */
export function noteTags(data) {
  const t = data.tags ?? data.tag ?? [];
  return (Array.isArray(t) ? t : String(t).split(/[,\s]+/)).map((x) => String(x).replace(/^#/, '').trim()).filter(Boolean);
}

/** Title: frontmatter, else the first # heading, else the file name. */
export function noteTitle(data, body, slug) {
  if (data.title) return String(data.title);
  const h1 = body.match(/^#\s+(.+?)\s*#*\s*$/m);
  return h1 ? h1[1].replace(/\[\[([^\]|]+)\|?([^\]]*)\]\]/g, (_, a, b) => b || a) : slug.replace(MARKDOWN_RE, '').replace(/-/g, ' ');
}

/** Every page a note links to: wikilinks, plus Markdown links to other pages here. */
export function noteLinks(md) {
  const { body } = parseFrontmatter(md);
  const out = new Set();
  for (const m of body.matchAll(/!?\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g)) {
    if (!ASSET_RE.test(m[1].replace(/\\$/, ''))) for (const t of wikiTargets(m[1].replace(/\\$/, ''))) out.add(t);
  }
  for (const m of body.matchAll(/\]\((?!https?:|mailto:|#)([^)\s]+)\)/g)) {
    const href = m[1].replace(/[?#].*$/, '').replace(/^\/pages\//, '').replace(/^\.?\//, '');
    if (href && !href.includes('/')) out.add(noteSlug(decodeURIComponent(href)));
  }
  return [...out].filter(Boolean);
}

// --- rendering ---------------------------------------------------------------------
const CALLOUTS = { note: 'Note', info: 'Info', tip: 'Tip', hint: 'Tip', important: 'Important', success: 'Success', check: 'Success',
  done: 'Success', question: 'Question', help: 'Question', faq: 'Question', warning: 'Warning', caution: 'Warning',
  attention: 'Warning', failure: 'Failure', fail: 'Failure', missing: 'Failure', danger: 'Danger', error: 'Danger', bug: 'Bug',
  example: 'Example', quote: 'Quote', cite: 'Quote', abstract: 'Summary', summary: 'Summary', tldr: 'Summary', todo: 'To do' };

/**
 * Markdown → HTML. `resolve(target)` turns a page name into { url, exists } (or null);
 * missing targets render as dashed "not yet written" links, like Quartz.
 */
export const ASSET_RE = /\.(png|jpe?g|gif|webp|avif|svg|pdf)$/i;

/**
 * Markdown → HTML. `resolve(name)` → { url, exists } finds pages; `asset(name)` →
 * { src, mime } finds images/PDFs (src may be a data: URI). Missing pages render as
 * dashed "not yet written" links, like Quartz; missing images as a muted note.
 */
export function renderMarkdown(md, { resolve = () => null, asset = () => null, title } = {}) {
  let { body } = parseFrontmatter(md);
  // Notes often open with their title as a # heading; the page already shows the title.
  const first = body.match(/^\s*#\s+(.+?)\s*#*\s*(?:\r?\n|$)/);
  if (title && first && first[1].trim().toLowerCase() === title.trim().toLowerCase()) body = body.slice(first[0].length);
  const marked = new Marked({ gfm: true });
  marked.use({
    extensions: [
      {
        name: 'wikilink',
        level: 'inline',
        start: (src) => src.match(/!?\[\[/)?.index,
        tokenizer(src) {
          const m = src.match(/^(!?)\[\[([^\]|#]+)(#[^\]|]*)?(?:\|([^\]]*))?\]\]/);
          // Inside tables, Obsidian/Quartz write the pipe escaped: [[pic.png\|800]].
          if (m) return { type: 'wikilink', raw: m[0], embed: !!m[1], target: m[2].trim().replace(/\\$/, ''), heading: m[3]?.slice(1).trim(), alias: m[4]?.trim() };
          return undefined;
        },
        renderer(t) {
          if (ASSET_RE.test(t.target)) return assetHtml(t.target, t.alias, t.embed);
          // [[tags/plugin/emitter]] → Quartz's tag page → here, the home page filtered by that tag.
          if (/^tags\//i.test(t.target)) {
            const tag = t.target.slice(5).toLowerCase().replace(/[\s_/]+/g, '-').replace(/[^a-z0-9-]/g, '');
            return `<a class="tag" href="/?category=${encodeURIComponent(tag)}" target="_top">${esc(t.alias || `#${tag}`)}</a>`;
          }
          const text = esc(t.alias || (t.heading ? `${t.target} › ${t.heading}` : t.target.split('/').pop()));
          const hit = wikiTargets(t.target).map(resolve).find((h) => h?.exists);
          if (t.embed) return `<a class="embed" href="${esc(hit?.url ?? '#')}" title="Embedded notes show as links">↪ ${text}</a>`;
          if (!hit?.exists) return `<a class="wikilink missing" title="Not written yet">${text}</a>`;
          return `<a class="wikilink" href="${esc(hit.url)}${t.heading ? `#${headingId(t.heading)}` : ''}">${text}</a>`;
        },
      },
      {
        name: 'highlight',
        level: 'inline',
        start: (src) => src.indexOf('=='),
        tokenizer(src) {
          const m = src.match(/^==(?=\S)([\s\S]*?\S)==/);
          if (m) return { type: 'highlight', raw: m[0], tokens: this.lexer.inlineTokens(m[1]) };
          return undefined;
        },
        renderer(t) { return `<mark>${this.parser.parseInline(t.tokens)}</mark>`; },
      },
    ],
    renderer: {
      // Relative images point at uploaded assets, found by file name.
      image({ href, title: t, text }) {
        if (!/^[a-z][a-z0-9+.-]*:|^\/\//i.test(href)) {
          const name = decodeURIComponent(href.split(/[?#]/)[0]).split('/').pop();
          if (ASSET_RE.test(name)) return assetHtml(name, text, true, t);
        }
        return `<img src="${esc(href)}" alt="${esc(text)}"${t ? ` title="${esc(t)}"` : ''}>`;
      },
      // Code blocks get the same highlighting as notebook code (src/highlight.js).
      code({ text, lang }) {
        const l = (lang || '').trim().split(/\s+/)[0];
        return `<pre><code${l ? ` class="language-${esc(l)}"` : ''}>${highlight(text, l)}</code></pre>\n`;
      },
      heading({ tokens, depth }) {
        const inner = this.parser.parseInline(tokens);
        const plain = inner.replace(/<[^>]+>/g, '').replace(/&[a-z#0-9]+;/gi, ' ');
        return `<h${depth} id="${headingId(plain)}">${inner}</h${depth}>\n`;
      },
      // Obsidian/Quartz callouts: "> [!warning] Title" (with + or - for folding).
      blockquote({ tokens }) {
        const inner = this.parser.parse(tokens);
        const m = inner.match(/^<p>\[!([A-Za-z-]+)\]([+-]?)[ \t]*([^\n<]*)(\n|<\/p>\n?)/);
        if (!m) return `<blockquote>\n${inner}</blockquote>\n`;
        const type = m[1].toLowerCase(), kind = CALLOUTS[type] ? type : 'note';
        const title = m[3].trim() || CALLOUTS[type] || m[1];
        const rest = m[4] === '\n' ? `<p>${inner.slice(m[0].length)}` : inner.slice(m[0].length);
        const body = rest.trim() ? `<div class="callout-body">${rest}</div>` : '';
        const tag = m[2] ? 'details' : 'div', head = m[2] ? 'summary' : 'div';
        return `<${tag} class="callout callout-${esc(kind)}"${m[2] === '+' ? ' open' : ''}><${head} class="callout-title">${title}</${head}>${body}</${tag}>\n`;
      },
    },
  });
  return marked.parse(body);

  // An embedded image (sized by "800" or "800x600" after the pipe), or a link to a PDF.
  function assetHtml(name, alias, embed, imgTitle) {
    const a = asset(name);
    const label = esc(alias && !/^\d+(x\d+)?$/.test(alias) ? alias : name.split('/').pop());
    if (!a) return `<span class="embed missing" title="Not uploaded">${label}</span>`;
    if (!embed || a.mime === 'application/pdf') return `<a href="${esc(a.url)}" target="_top">${label}</a>`;
    const [w, h] = (alias?.match(/^(\d+)(?:x(\d+))?$/) || []).slice(1);
    return `<img src="${esc(a.src)}" alt="${label}"${w ? ` width="${w}"` : ''}${h ? ` height="${h}"` : ''}${imgTitle ? ` title="${esc(imgTitle)}"` : ''} loading="lazy">`;
  }
}

/** Plain text for search and diffs: the source minus frontmatter, one line per line. */
export function noteLines(md) {
  return parseFrontmatter(md).body.split(/\r?\n/).map((l) => l.trimEnd()).filter((l) => l.trim());
}
