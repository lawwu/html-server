// The package's own files (stylesheets, scripts, fonts, the example gallery,
// package.json), read by their path from the package root. Under Node they come from
// disk. Where there is no disk of ours (Cloudflare Workers), the deploy bundles them
// (cloudflare/bundle-files.js) into globalThis.__HTML_SERVER_FILES__ before anything
// reads them: { "public/style.css": { data: base64, mtime: ms }, ... }.
import { Buffer } from 'node:buffer';
import { readdirSync, readFileSync, statSync } from 'node:fs';

const bundled = () => globalThis.__HTML_SERVER_FILES__;
const onDisk = (rel) => new URL(`../${rel}`, import.meta.url);

function entry(rel) {
  const e = bundled()[rel];
  if (!e) throw Object.assign(new Error(`ENOENT: no such file, ${rel}`), { code: 'ENOENT' });
  return e;
}

export function fileBytes(rel) {
  return bundled() ? Buffer.from(entry(rel).data, 'base64') : readFileSync(onDisk(rel));
}

export const fileText = (rel) => fileBytes(rel).toString('utf8');

/** Last modified, in ms. */
export function fileMtime(rel) {
  return bundled() ? entry(rel).mtime : statSync(onDisk(rel)).mtimeMs;
}

/** The names of the files directly in a folder of the package, e.g. listFiles('gallery'). */
export function listFiles(dir) {
  const b = bundled();
  if (!b) return readdirSync(onDisk(`${dir}/`));
  const prefix = `${dir}/`;
  return Object.keys(b).filter((k) => k.startsWith(prefix) && !k.slice(prefix.length).includes('/')).map((k) => k.slice(prefix.length));
}
