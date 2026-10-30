import { RESERVED_SLUGS, SLUG_RE } from './config.js';
import { ApiError } from './text.js';

export const encodePath = (path) => path.split('/').map(encodeURIComponent).join('/');
export const pageUrl = (path) => path.includes('/') ? `/${encodePath(path)}` : `/pages/${path}`;
export const parentPath = (path) => path.split('/').slice(0, -1).join('/');

/** Published paths are names, never filesystem paths. Validate each segment before use. */
export function validatePath(path, { folder = false } = {}) {
  if (folder && path === '') return path;
  if (typeof path !== 'string' || path.length > 500 || !path.split('/').every((p) => SLUG_RE.test(p))
      || RESERVED_SLUGS.has(path.split('/')[0].toLowerCase())) {
    throw new ApiError(400, 'use a path of letters, digits, dots, dashes or underscores; no empty segments or reserved top-level names');
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
