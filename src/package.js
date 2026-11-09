// This server's own package as an npm tarball, so people can install the command line
// from the server they use (`npm install -g https://SERVER/api/cli/html-server.tgz`)
// rather than from GitHub, and always get the version the server runs. Built from the
// files on disk the first time someone asks, then kept in memory: the same files
// `npm pack` would ship (package.json's "files", plus package.json, README and LICENSE),
// under package/, with a fixed date so the same files always make the same bytes.
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { gzipSync } from 'node:zlib';

const ROOT = new URL('..', import.meta.url);
/** What goes in, as package.json's "files" says (test/package.test.js checks it against `npm pack`). */
export const INCLUDE = ['src', 'public', 'gallery', 'wrangler.toml', 'package.json', 'README.md', 'LICENSE'];
const SKIP = [/(^|\/)\./, /^cloudflare\/files\.generated\.js$/];
const CLOUDFLARE = /^cloudflare\/[^/]+\.js$/; // "cloudflare/*.js"
const MTIME = 499162500; // 1985-10-26T08:15:00Z, the date npm gives every file it packs
const EXECUTABLE = new Set(['src/cli.js']); // the `html-server` bin

/** The package's files, relative to its root, sorted. Whatever of them this install has. */
export function packageFiles() {
  const out = [];
  const walk = (rel) => {
    if (SKIP.some((re) => re.test(rel)) || !existsSync(new URL(rel, ROOT))) return;
    if (statSync(new URL(rel, ROOT)).isDirectory()) return readdirSync(new URL(`${rel}/`, ROOT)).forEach((f) => walk(`${rel}/${f}`));
    out.push(rel);
  };
  INCLUDE.forEach(walk);
  if (existsSync(new URL('cloudflare/', ROOT))) {
    readdirSync(new URL('cloudflare/', ROOT)).map((f) => `cloudflare/${f}`).filter((rel) => CLOUDFLARE.test(rel)).forEach(walk);
  }
  return out.sort();
}

/** One ustar header. A long path is split between the prefix field (155) and the name (100). */
function header(path, size, mode) {
  let name = path, prefix = '';
  if (Buffer.byteLength(name) > 100) {
    const cut = path.lastIndexOf('/', path.length - 1);
    for (let i = cut; i > 0; i = path.lastIndexOf('/', i - 1)) {
      if (Buffer.byteLength(path.slice(i + 1)) <= 100 && Buffer.byteLength(path.slice(0, i)) <= 155) { prefix = path.slice(0, i); name = path.slice(i + 1); break; }
    }
    if (!prefix) throw new Error(`path too long for a tarball: ${path}`);
  }
  const h = Buffer.alloc(512);
  const put = (s, at, len) => h.write(s, at, len, 'utf8');
  const octal = (n, at, len) => put(`${n.toString(8).padStart(len - 1, '0')}\0`, at, len);
  put(name, 0, 100);
  octal(mode, 100, 8); octal(0, 108, 8); octal(0, 116, 8); // mode, uid, gid
  octal(size, 124, 12); octal(MTIME, 136, 12);
  h.fill(' ', 148, 156); // the checksum counts its own field as spaces
  put('0', 156, 1); // a regular file
  put('ustar\0', 257, 6); put('00', 263, 2);
  put(prefix, 345, 155);
  let sum = 0;
  for (const b of h) sum += b;
  put(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8);
  return h;
}

/** A gzipped tar of these files ([path, bytes, mode]), the format npm installs from. */
export function tarball(entries) {
  const parts = [];
  for (const [path, data, mode] of entries) {
    parts.push(header(path, data.length, mode), data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  parts.push(Buffer.alloc(1024)); // two empty blocks end the archive
  return gzipSync(Buffer.concat(parts), { level: 9 });
}

/**
 * package.json as served: without the PostgreSQL driver (pg-native, optional), which only a
 * server on PostgreSQL needs. It's native code, so installing it wants a compiler and libpq,
 * and npm 11 warns about its build script on every install. A server on PostgreSQL installs
 * from GitHub or runs the Docker image, as before.
 */
export function forTheCli(manifest) {
  const { optionalDependencies, allowScripts, devDependencies, ...rest } = manifest;
  return rest;
}

let cached = null;
/**
 * The tarball, its sha256 (for an ETag) and the version inside, or null where the
 * package's code isn't on a disk of ours to read (Cloudflare Workers).
 */
export function cliPackage() {
  if (globalThis.__HTML_SERVER_FILES__) return null;
  if (!cached) {
    const files = packageFiles();
    if (!files.includes('package.json') || !files.includes('src/cli.js')) return null;
    const manifest = JSON.parse(readFileSync(new URL('package.json', ROOT), 'utf8'));
    const bytes = (rel) => (rel === 'package.json' ? Buffer.from(`${JSON.stringify(forTheCli(manifest), null, 2)}\n`) : readFileSync(new URL(rel, ROOT)));
    const data = tarball(files.map((rel) => [`package/${rel}`, bytes(rel), EXECUTABLE.has(rel) ? 0o755 : 0o644]));
    const { version } = manifest;
    cached = { data, version, sha256: createHash('sha256').update(data).digest('hex') };
  }
  return cached;
}
