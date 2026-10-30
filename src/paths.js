import { PAGE_EXT_RE, RESERVED_SLUGS, SLUG_RE } from './config.js';
import { ApiError } from './text.js';

export const encodePath = (path) => path.split('/').map(encodeURIComponent).join('/');
export const pageUrl = (path) => path.includes('/') ? `/${encodePath(path)}` : `/pages/${path}`;
export const parentPath = (path) => path.split('/').slice(0, -1).join('/');

/** Could this be a page's or a folder's path here: file-name segments, under no reserved top-level name? */
export const isPagePath = (path) => typeof path === 'string' && path.length <= 500
  && path.split('/').every((p) => SLUG_RE.test(p)) && !RESERVED_SLUGS.has(path.split('/')[0].toLowerCase());

/**
 * Published paths are names, never filesystem paths. Validate each segment before use. A
 * page in a folder ends in its extension (research/report.html), so its name can't be read
 * as one of another page's routes (/api/artifacts/plan/comments is plan's comments, not a
 * page called plan/comments); a top-level name may leave it off ("trip-plan"). A folder is
 * any path of segments.
 */
export function validatePath(path, { folder = false } = {}) {
  if (folder && path === '') return path;
  if (!isPagePath(path)) {
    throw new ApiError(400, 'use a path of letters, digits, dots, dashes or underscores; no empty segments or reserved top-level names');
  }
  if (!folder && path.includes('/') && !PAGE_EXT_RE.test(path)) {
    throw new ApiError(400, `a page in a folder needs its file extension (.html, .md or .ipynb), as in '${path}.html'`);
  }
  return path;
}

/** Resolve local links against the address at which this version was authored. */
export function linkPath(href, base = '') {
  if (!href || /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(href)) return null;
  try {
    const url = new URL(href, `https://pages.invalid/${encodePath(base)}`);
    const path = decodeURIComponent(url.pathname).replace(/^\/pages\//, '/').slice(1);
    return path || null;
  } catch { return null; }
}
