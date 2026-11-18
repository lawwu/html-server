// A published folder is one prebuilt static site. Paths are relative to its index.html.
import { ASSET_TYPES } from './config.js';
import { ApiError } from './text.js';

export const MAX_BUNDLE_FILES = 512;
const types = {
  ...ASSET_TYPES, html: 'text/html', htm: 'text/html', css: 'text/css', js: 'text/javascript', mjs: 'text/javascript',
  json: 'application/json', geojson: 'application/geo+json', map: 'application/json', wasm: 'application/wasm',
  txt: 'text/plain', csv: 'text/csv', xml: 'application/xml', ico: 'image/x-icon',
  woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf', webmanifest: 'application/manifest+json',
  mp3: 'audio/mpeg', mp4: 'video/mp4', webm: 'video/webm', ogg: 'audio/ogg', vtt: 'text/vtt',
};
export function bundleMime(path) {
  const extension = path.split('.').pop().toLowerCase();
  const type = Object.hasOwn(types, extension) ? types[extension] : 'application/octet-stream';
  return type.startsWith('text/') ? type + '; charset=utf-8' : type;
}

export function decodeBundle(bytes) {
  let input;
  try { input = JSON.parse(bytes); } catch { throw new ApiError(400, 'send a JSON object containing files'); }
  if (!Array.isArray(input?.files) || !input.files.length || input.files.length > MAX_BUNDLE_FILES) {
    throw new ApiError(400, `give 1–${MAX_BUNDLE_FILES} files including index.html`);
  }
  const files = new Map();
  for (const file of input.files) {
    const { path, base64 } = file ?? {};
    if (typeof path !== 'string' || path.length > 1024 || !path.split('/').every((p) =>
      p.length && !p.startsWith('.') && p !== 'node_modules' && !/[\\\u0000-\u001f\u007f]/u.test(p))) {
      throw new ApiError(400, 'use relative file paths without hidden or parent directories');
    }
    if (files.has(path)) throw new ApiError(400, `duplicate bundle path: ${path}`);
    if (typeof base64 !== 'string') throw new ApiError(400, `missing base64 data for ${path}`);
    const data = Buffer.from(base64, 'base64');
    if (data.toString('base64') !== base64) throw new ApiError(400, `invalid base64 data for ${path}`);
    files.set(path, data);
  }
  if (!files.get('index.html')?.length) throw new ApiError(400, 'the folder needs a nonempty index.html at its root');
  return files;
}
