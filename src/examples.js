// The example pages that ship with html-server (the package's gallery/ folder),
// shown at /gallery. Served straight from the package, read-only: they are not in
// the database, so they never mix with anyone's own pages, and every install has them.
import { fileBytes, fileMtime, fileText, listFiles } from './files.js';
import { extractText, metaContent } from './text.js';

export const EXAMPLE_FILE_RE = /^[A-Za-z0-9][\w.-]*\.html$/;

let cache = null;

/** [{ slug, url, title, description, category, size, updated_at, body }], newest first; read once. */
export function examples() {
  if (cache) return cache;
  let files = [];
  try { files = listFiles('gallery').filter((f) => EXAMPLE_FILE_RE.test(f)); } catch { /* no gallery folder */ }
  cache = files.map((f) => {
    const html = fileText(`gallery/${f}`);
    const { title, body } = extractText(html);
    return {
      slug: f,
      url: `/gallery/${f}`,
      title: title || f,
      description: metaContent(html, 'description'),
      category: metaContent(html, 'category').toLowerCase(),
      updated_at: fileMtime(`gallery/${f}`) / 1000,
      example: true,
      text: `${title} ${f.replace(/\.html$/, '').replace(/[-_.]+/g, ' ')} ${metaContent(html, 'description')} ${body}`.toLowerCase(),
    };
  }).sort((a, b) => (b.category === 'featured') - (a.category === 'featured') || a.title.localeCompare(b.title));
  return cache;
}

/** The raw HTML of one example, or null. */
export function exampleHtml(file) {
  if (!examples().some((e) => e.slug === file)) return null;
  return fileBytes(`gallery/${file}`);
}

/** Filter examples by category and by every typed word appearing somewhere in them. */
export function findExamples({ q = '', category = '' } = {}) {
  const words = q.toLowerCase().match(/[\p{L}\p{N}_]+/gu) || [];
  return examples().filter((e) => (!category || e.category === category) && words.every((w) => e.text.includes(w)));
}

export function exampleCategories() {
  const counts = new Map();
  for (const e of examples()) if (e.category) counts.set(e.category, (counts.get(e.category) || 0) + 1);
  return [...counts].map(([category, count]) => ({ category, count }))
    .sort((a, b) => (b.category === 'featured') - (a.category === 'featured') || a.category.localeCompare(b.category));
}

