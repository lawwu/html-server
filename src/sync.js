// One-way folder reconciliation. Owns discovery, identity, dry-run decisions and
// failure-aware pruning; remote is the page/asset interface in sync-remote.js.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { noteSlug, pageNameKey, parseFrontmatter, syncedSlug, ASSET_RE } from './markdown.js';
import { parseNotebook } from './notebook.js';
import { pageUrl } from './paths.js';

export class SyncError extends Error {}
const fail = (message) => { throw new SyncError(message); };

export class FolderSync {
  #quartz;
  #remote;
  #emit;

  constructor(dir, { remote, onEvent = () => {} } = {}) {
    if (!dir || !existsSync(dir) || !statSync(dir).isDirectory()) fail('usage: sync DIR [--private] [--folder FOLDER] [--migrate-paths] [--prune] [--dry-run] [--install-hook]');
    this.root = resolve(dir);
    this.#quartz = quartzConfig(this.root);
    if (this.#quartz) {
      this.root = join(this.root, 'content');
      onEvent({ type: 'quartz', ignore: this.#quartz.ignore });
    }
    this.#remote = remote;
    this.#emit = onEvent;
  }

  // Planning is sequential: earlier uploads/moves affect later lookups, just as a
  // real sync does. Dry runs perform the same decisions but never mutate remote.
  async run(opts = {}) {
    const { root } = this, remote = this.#remote, emit = this.#emit, quartz = this.#quartz;
    const ignored = (rel) => (quartz?.ignore ?? []).some((pat) => globMatch(pat, rel));

    const files = [];
    (function walk(d) {
      for (const f of readdirSync(d).sort()) {
        if (f.startsWith('.') || f === 'node_modules') continue; // .obsidian, .git, .trash, …
        const p = join(d, f);
        const rel = p.slice(root.length + 1);
        if (ignored(rel)) continue;
        const entry = lstatSync(p);
        if (entry.isSymbolicLink()) { emit({ type: 'symlink', path: rel }); continue; }
        if (entry.isDirectory()) walk(p);
        else if (/\.(md|markdown|html?|ipynb)$/i.test(f) || ASSET_RE.test(f)) files.push(p);
      }
    })(root);
    if (!files.length && !opts.prune) fail(`no notes, pages or images under ${root}`);

    // Assets share one namespace even when their source files live in different
    // folders. Check the exact upload names before any upload, move or prune.
    const assetName = (file) => basename(file).trim().replace(/\s+/g, '-');
    const assetFiles = new Map();
    for (const file of files.filter((f) => ASSET_RE.test(f))) {
      const name = assetName(file), key = name.toLowerCase();
      const previous = assetFiles.get(key);
      if (previous) fail(`asset name collision: ${previous.slice(root.length + 1)} and ${file.slice(root.length + 1)} use the same asset name (${name}); rename one before syncing`);
      assetFiles.set(key, file);
    }

    let inGit = false;
    try { inGit = execFileSync('git', ['-C', root, 'rev-parse', '--is-inside-work-tree'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() === 'true'; } catch { /* not git */ }
    const commitNote = (rel) => {
      if (!inGit) return '';
      try { return execFileSync('git', ['-C', root, 'log', '-1', '--format=%s', '--', rel], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch { return ''; }
    };

    // A source file keeps its published identity when a user moves it on the server.
    const synced = await remote.listSourcePages(root);
    const bySource = new Map(synced.filter((p) => p.source_path).map((p) => [p.source_path, p]));
    // Synced before folders from another checkout or folder of this vault, a nested file's page
    // has its flat name (source/legacy.md → source-legacy.md) and isn't among this folder's. It's
    // this file's page if it was synced from this file's path, is yours to edit and isn't in
    // the trash (like this folder's pages above); any other page by that name is another page.
    const legacyPage = async (rel) => {
      const flatName = syncedSlug(rel);
      const p = await remote.findPage(flatName, { required: true });
      return p?.slug === flatName && p.source_path === rel && p.can_edit && p.state === 'active' ? p : null;
    };
    const count = { new: 0, updated: 0, renamed: 0, moved: 0, unchanged: 0, skipped: 0, failed: 0, trashed: 0 };
    const changed = (action, path, details = {}) => emit({ type: 'change', action, path, dryRun: !!opts.dryRun, ...details });
    const seen = new Map(); // page name (lowercase) → file, to catch two notes that would share a URL
    const flat = []; // pages still at a flat address from before folders: [address, its file's path]
    const known = new Map((await remote.listAssets()).map((a) => [a.name.toLowerCase(), a.sha256])); // yours

    for (const file of files) {
      const rel = file.slice(root.length + 1);
      const body = readFileSync(file);
      const sha = createHash('sha256').update(body).digest('hex');
      try {
        if (ASSET_RE.test(file)) { // images and PDFs: by file name, replaced when changed
          const name = assetName(file);
          if (known.get(name.toLowerCase()) === sha) { count.unchanged++; continue; }
          const isNew = !known.has(name.toLowerCase());
          if (opts.dryRun) { count[isNew ? 'new' : 'updated']++; changed(isNew ? 'new' : 'updated', rel, { target: `/assets/${name}` }); continue; }
          await remote.putAsset(name, body);
          count[isNew ? 'new' : 'updated']++;
          changed(isNew ? 'new' : 'updated', rel);
          continue;
        }
        if (/\.(md|markdown|ipynb)$/i.test(file)) { // drafts stay out, for notes and notebooks alike
          const { data } = /\.ipynb$/i.test(file) ? (({ front, metadata }) => ({ data: { ...metadata, ...front } }))(parseNotebook(body.toString('utf8')))
            : parseFrontmatter(body.toString('utf8'));
          if (data.draft === true || data.publish === false) { count.skipped++; changed('draft', rel); continue; }
        }
        const parts = rel.split('/');
        const desired = [opts.folder?.replace(/^\/+|\/+$/g, ''), ...parts.map(noteSlug)].filter(Boolean).join('/');
        const previous = bySource.get(rel) ?? (syncedSlug(rel).toLowerCase() !== desired.toLowerCase() ? await legacyPage(rel) : null);
        let name = previous?.slug || desired;
        if (previous && !opts.migratePaths && !name.includes('/') && desired.includes('/')) flat.push([name, desired]);
        if (previous && opts.migratePaths && name !== desired) {
          if (!opts.dryRun) await remote.movePage(name, desired);
          count.moved++;
          changed('moved', name, { target: desired });
          name = desired;
          if (!opts.dryRun) previous.slug = desired;
        }
        const nameKey = pageNameKey(parts.map(noteSlug).join('/')); // an index note goes by its folder's name
        if (seen.has(name.toLowerCase())) {
          count.skipped++;
          emit({ type: 'duplicate', path: rel, previous: seen.get(name.toLowerCase()), name });
          continue;
        }
        seen.set(name.toLowerCase(), rel);
        if (opts.dryRun && previous) seen.set(previous.slug.toLowerCase(), rel);
        // Looking a page up forgives case, so compare the name it comes back with: the same
        // name is this file's page; the same but for case is that page, its file renamed
        // (Notes.md → notes.md), which the upload renames too rather than making a second page.
        const at = opts.dryRun && previous ? previous.slug : name; // a dry run moves nothing: the page is still there
        let page = await remote.findPage(at);
        const renamed = page && page.slug !== at && page.slug.toLowerCase() === at.toLowerCase() ? page.slug : null;
        if (page?.slug !== at && !renamed) page = null; // another page answering to the name isn't this file's
        const latest = page?.versions.at(-1);
        if (latest?.sha256 === sha && !renamed) { count.unchanged++; continue; }
        const what = renamed ? 'renamed' : latest ? 'updated' : 'new';
        if (opts.dryRun) { count[what]++; changed(what, rel, { target: pageUrl(name) }); continue; }
        const metadata = { note: commitNote(rel) || (renamed ? `renamed from ${renamed}` : latest ? 'synced' : 'imported'), source: root, name: nameKey, path: rel };
        if (renamed) metadata.rename_from = renamed;
        if (opts.private && !latest) metadata.visibility = 'private';
        const a = await remote.putPage(name, body, metadata);
        count[what]++;
        changed(what, rel, { url: a.url, renamedFrom: renamed });
      } catch (e) {
        count.failed++;
        emit({ type: 'failure', path: rel, error: e });
      }
    }

    if (opts.prune && count.failed === 0) { // pages synced from this folder whose file is gone → trash (restorable)
      const mine = synced;
      for (const p of mine) {
        if (seen.has(p.slug.toLowerCase())) continue;
        if (opts.dryRun) { count.trashed++; changed('trashed', p.slug); continue; }
        try { await remote.trashPage(p.slug); count.trashed++; changed('trashed', p.slug); } catch (e) {
          count.failed++;
          emit({ type: 'failure', path: p.slug, trashing: true, error: e });
        }
      }
    }
    return { counts: count, flat, dryRun: !!opts.dryRun };
  }
}

/** A Quartz repo's settings, if DIR is one: { ignore: [patterns] } from quartz.config.yaml (or .ts), or null. */
function quartzConfig(dir) {
  if (!existsSync(join(dir, 'content')) || !statSync(join(dir, 'content')).isDirectory()) return null;
  const cfg = ['quartz.config.yaml', 'quartz.config.yml', 'quartz.config.default.yaml', 'quartz.config.ts']
    .map((f) => join(dir, f)).find((f) => existsSync(f));
  if (!cfg) return null;
  const text = readFileSync(cfg, 'utf8');
  let ignore = [];
  try {
    if (cfg.endsWith('.ts')) {
      // Never execute a vault's config. Accept only a literal list of quoted strings;
      // expressions/spreads/unknown syntax must not silently discard privacy rules.
      const code = text.replace(/("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g, (m, quoted) => quoted ?? ' ');
      const literal = /(?:^|[,{])\s*(?:ignorePatterns|"ignorePatterns"|'ignorePatterns')\s*:\s*(\[(?:\s*(?:"[^"\\]*"|'[^'\\]*')\s*,?)*\s*\])\s*(?=[,}])/s.exec(code)?.[1];
      if (!literal || [...code.matchAll(/\bignorePatterns\b/g)].length !== 1) throw new Error('ignorePatterns must be a single explicit literal list of quoted strings');
      ignore = parseYaml(literal);
    } else {
      const config = parseYaml(text, { maxAliasCount: 100 });
      if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('expected a YAML configuration object');
      const settings = config.configuration ?? config;
      if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('expected a configuration object');
      ignore = Object.hasOwn(settings, 'ignorePatterns') ? settings.ignorePatterns : [];
    }
    if (!Array.isArray(ignore) || ignore.some((p) => typeof p !== 'string' || !p.trim())) throw new Error('ignorePatterns must be a list of nonempty strings');
  } catch (e) { fail(`cannot read exclusions from ${cfg}: ${e.message}`); }
  return { ignore };
}

/** Quartz-style ignore patterns: a bare name matches that folder or file anywhere; *, ** and ? glob. */
function globMatch(pat, rel) {
  if (!/[*?]/.test(pat)) return rel.split('/').includes(pat.replace(/\/$/, ''));
  const re = pat.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*\/?/g, '\0').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]').replace(/\0/g, '.*');
  return new RegExp(`(^|/)${re}(/|$)`).test(rel);
}
