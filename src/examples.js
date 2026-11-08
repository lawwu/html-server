// The example pages that ship with html-server (the package's gallery/ folder),
// shown at /gallery. Served straight from the package, read-only: they are not in
// the database, so they never mix with anyone's own pages, and every install has them.
import { Buffer } from 'node:buffer';
import { fileBytes, fileMtime, listFiles } from './files.js';
import { extractText, metaContent, scriptText } from './text.js';

export const EXAMPLE_FILE_RE = /^[A-Za-z0-9][\w.-]*\.html$/;

// The skills in plannotator/effective-html (MIT), what each is for, and the gallery's examples
// of each: at least one on data, data science or machine learning, one on Claude Code (built
// from its docs). Each example names its skill (pages.js skillLine); /about lists them all;
// the examples' category is effective-html.
export const SKILLS_REPO = 'https://github.com/plannotator/effective-html';
export const SKILLS = [
  { name: 'html', use: 'Reports, explainers, data stories and small tools',
    examples: [['ab-test-readout.html', 'A/B test readout'], ['claude-code-settings-precedence.html', 'Claude Code settings precedence'], ['rules-of-ml.html', 'Rules of ML'], ['agentic-ml-plugin.html', 'Agentic ML plugin']] },
  { name: 'big-pics-little-words', use: 'Explain a subject with big pictures and few words',
    examples: [['precision-recall-threshold.html', 'Precision and recall'], ['claude-code-context-window.html', "Claude Code's context window"]] },
  { name: 'one-pager', use: 'One page that shares an idea early, or recaps work',
    examples: [['churn-model-v3-recap.html', 'Churn model v3 recap'], ['claude-code-team-setup-one-pager.html', 'Claude Code team setup']] },
  { name: 'design-artifact', use: 'A visual direction drawn from the subject itself',
    examples: [['model-card-birdsong-classifier.html', 'Birdsong model card'], ['claude-code-pocket-reference.html', 'Claude Code pocket reference']] },
  { name: 'html-wireframe', use: 'Low-fidelity layouts that test structure and flow',
    examples: [['model-monitoring-wireframes.html', 'Model monitoring'], ['claude-code-permissions-wireframes.html', 'Claude Code permissions']] },
  { name: 'html-prototype', use: 'Working prototypes with real states and keyboard support',
    examples: [['review-labeling-prototype.html', 'Review labeling queue'], ['claude-code-permission-prompt-prototype.html', 'Claude Code permission prompts']] },
  { name: 'html-plan', use: 'Plans and rollouts that keep their source commitments',
    examples: [['realtime-fraud-scoring-rollout-plan.html', 'Real-time fraud scoring'], ['claude-code-rollout-plan.html', 'Claude Code team rollout']] },
  { name: 'html-diagram', use: 'Architecture, sequence, process and state diagrams',
    examples: [['rag-pipeline-diagram.html', 'RAG pipeline'], ['claude-code-hooks-lifecycle.html', 'Claude Code hooks']] },
];

// Featured first, then the maps of content (each links a topic's examples), then the rest.
const rank = (category) => ['featured', 'moc'].indexOf(category) >>> 0;

let cache = null;
const bodies = new Map();

/** [{ slug, url, title, description, category, size, updated_at, body }], newest first; read once. */
export function examples() {
  if (cache) return cache;
  let files = [];
  try { files = listFiles('gallery').filter((f) => EXAMPLE_FILE_RE.test(f)); } catch { /* no gallery folder */ }
  cache = files.map((f) => {
    const bytes = fileBytes(`gallery/${f}`);
    bodies.set(f, bytes);
    const html = bytes.toString('utf8');
    const { title, body } = extractText(html);
    return {
      slug: f,
      url: `/gallery/${f}`,
      title: title || f,
      description: metaContent(html, 'description'),
      category: metaContent(html, 'category').toLowerCase(),
      updated_at: fileMtime(`gallery/${f}`) / 1000,
      example: true,
      text: `${title} ${f.replace(/\.html$/, '').replace(/[-_.]+/g, ' ')} ${metaContent(html, 'description')} ${body} ${scriptText(html)}`.toLowerCase(),
    };
  }).sort((a, b) => rank(a.category) - rank(b.category) || a.title.localeCompare(b.title));
  return cache;
}

/** The raw HTML of one example, or null. */
export function exampleHtml(file) {
  if (!examples().some((e) => e.slug === file)) return null;
  return Buffer.from(bodies.get(file)); // bytes and metadata are one immutable process snapshot
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
    .sort((a, b) => rank(a.category) - rank(b.category) || a.category.localeCompare(b.category));
}

