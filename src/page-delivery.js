// Page delivery owns the composition and privacy boundary of a displayed page.
// Input supplies viewer lookup and display preferences, never req/res.
// Output is explicitly a trusted site page, a sandboxed artifact, or a redirect.
import { fileText } from './files.js';
import { MAX_INLINE_BYTES, TOC_MIN_HEADINGS } from './config.js';
import { ACTIVE } from './lifecycle.js';
import { diffPage, exampleFramePage, historyPage, htmlFramePage, notePage } from './pages.js';
import { exampleHtml, examples } from './examples.js';
import { ASSET_RE, renderMarkdown, safeDecode } from './markdown.js';
import { encodePath, isPagePath, pageUrl, parentPath } from './paths.js';
import { isNote, isNotebook, parseNotebook, renderNotebook } from './notebook.js';
import { pageMeta, summary } from './store.js';
import { ApiError } from './text.js';

export class PageDelivery {
  #store; #query; #document; #viewerId; #visit; #theme; #sidebar; #sso; #search;

  constructor(store, { query = '', document = false, viewer = null, visit = null, theme, sidebar, sso = false } = {}) {
    this.#store = store;
    this.#query = new URLSearchParams(query);
    this.#search = query ? (String(query).startsWith('?') ? String(query) : `?${query}`) : '';
    this.#document = document;
    this.#viewerId = viewer;
    this.#visit = visit;
    this.#theme = theme;
    this.#sidebar = sidebar;
    this.#sso = sso;
  }

  named(slug) {
    if (!isPagePath(slug)) throw new ApiError(404, 'no such page');
    if (!this.#store.find(slug, { exact: true })) {
      try {
        this.#store.folder(slug, this.#viewer());
        return { kind: 'redirect', location: `/${encodePath(slug)}/${this.#search}` };
      } catch (e) { if (e.status !== 404) throw e; }
    }
    const a = this.#store.readable(slug, this.#viewer());
    const old = this.#store.oldAddress(slug);
    if (old?.artifact_id === a.id && a.state === ACTIVE) {
      return { kind: 'redirect', location: pageUrl(a.slug) + this.#search, noStore: true };
    }
    // Resolve addresses and authorize the page before parsing its version. Old
    // addresses and folders keep the original query through their redirect.
    if (this.#wantsFrame() && a.state === ACTIVE && !isNote(a.slug)) return this.#frame(a);
    const r = this.#store.render(slug, this.#int('v'), this.#viewer(), this.#preview() ? null : this.#visit);
    const path = encodePath(r.slug);
    return this.#artifact(this.#decorate(r, { current: `/pages/${path}`, history: `/history/${path}` }, slug));
  }

  shared(share) {
    // Viewer identity attributes visits only; the share itself authorizes access.
    let viewer = null;
    try { viewer = this.#viewer(); } catch { /* invalid credentials don't invalidate a share */ }
    const r = this.#store.renderShare(share, this.#int('v'), this.#preview() ? null : this.#visit, viewer);
    // A share link may be private, whose history requires signing in.
    return this.#artifact(this.#decorate(r, { current: `/v/${encodeURIComponent(share)}` }));
  }

  example(file) {
    const body = exampleHtml(file);
    if (!body) throw new ApiError(404, 'no such example');
    if (this.#wantsFrame()) return { kind: 'site', body: exampleFramePage(examples().find((e) => e.slug === file), { explorer: this.#store.explorer(this.#viewer()) }) };
    return this.#artifact(this.#decorate({ body }, {}));
  }

  history(slug) {
    return { kind: 'site', body: historyPage(this.#store.describe(slug, this.#viewer()), { explorer: this.#store.explorer(this.#viewer()) }) };
  }

  changes(slug) {
    const [from, to, a, b] = this.#store.diff(slug, this.#viewer(), this.#int('from'), this.#int('to'), this.#query.get('of') || 'text');
    return this.#artifact(diffPage(from, to, a, b, { back: this.#query.get('back') ? `/history/${encodePath(slug)}` : null }));
  }

  // Resolve only when needed: a standalone example needs no viewer, and malformed
  // page paths fail before authentication. HTTP remains responsible for credentials.
  #viewer() { return typeof this.#viewerId === 'function' ? this.#viewerId() : this.#viewerId; }

  #artifact(body) { return { kind: 'artifact', body, preview: this.#preview() }; }

  #int(name) {
    const value = this.#query.get(name);
    if (value == null || value === '') return null;
    if (!/^\d+$/.test(value)) throw new ApiError(400, `${name} must be a number`);
    return Number(value);
  }

  /**
   * A Markdown note as a page: wikilinks resolved against public pages
   * (missing ones shown as such), and "Linked from" backlinks. Title and tags come from
   * the version being shown, so an old version reads as it did.
   */
  #note(page, source, n) {
    // The caller already authorized opening this page. Its scripts can read everything
    // in this document, including navigation and preview JSON: never add private data
    // from the viewer's account. The page's own authorized assets still resolve below.
    const viewer = null;
    const text = source.toString('utf8');
    const basePath = this.#store.versionBase(page, n);
    const meta = pageMeta(page.slug, text, { path: basePath });
    const nb = isNotebook(page.slug) ? parseNotebook(text) : null;
    const opts = { ...this.#resolvers(viewer, { page }), title: meta.title, path: basePath };
    const html = nb ? renderNotebook(nb, opts) : renderMarkdown(text, opts);
    const backlinks = this.#store.backlinks(page, viewer);
    const linked = [...html.matchAll(/href="\/(?:pages\/)?([^"?#]+)/g)].map((m) => safeDecode(m[1])).concat(backlinks.map((b) => b.slug));
    return Buffer.from(notePage({
      slug: page.slug, chrome: !this.#preview(), latest: page.latest_version,
      title: meta.title, description: meta.description, tags: meta.tags, version: n,
      updated: n === page.latest_version ? page.updated_at : null,
      html, backlinks, previews: this.#preview() ? {} : this.#previews(linked, viewer), source: text,
      copyLabel: nb ? 'Copy notebook' : 'Copy markdown',
      extra: nb ? [nb.kernel, `${nb.cells.filter((c) => c.type === 'code').length} code cells`].filter(Boolean).join(' · ') : '',
      theme: this.#theme,
      sidebar: this.#sidebar,
      path: this.#store.presentationPath(page), explorer: this.#preview() ? [] : this.#store.explorer(viewer),
      graph: this.#preview() ? null : this.#store.graph(viewer, { views: false }),
    }));
  }

  /**
   * How note `page` finds what it links to: `resolve` turns a link's name into the page this
   * viewer gets (the store's one resolver; null: drawn as "not written yet"); `asset` finds
   * an image or PDF that the note may show them: the note owner's own, or one that's readable
   * anyway (Store.canReadAsset). Images go in as data: URIs (a sandboxed note may not load
   * files) unless big, or `inline` is off (hover previews, which link to them instead). A
   * private note's links to files carry its share id, which is what lets them load.
   */
  #resolvers(viewer, { inline = true, page } = {}) {
    return {
      resolve: (name) => {
        const a = this.#store.linkTarget(name, viewer);
        return a ? { exists: true, url: pageUrl(a.slug) } : null;
      },
      asset: (name) => {
        const a = this.#store.asset(name);
        if (!a || !this.#store.canReadAsset(a, null, { via: page?.share_id })) return null;
        // With SSO a note's own requests carry no sign-in (it's sandboxed), so its files go by the page's link too.
        const url = `/assets/${encodeURIComponent(a.name)}${page && (page.visibility !== 'public' || this.#sso) ? `?from=${encodeURIComponent(page.share_id)}` : ''}`;
        const small = inline && a.mime.startsWith('image/') && a.size <= MAX_INLINE_BYTES;
        return { mime: a.mime, url, src: small ? `data:${a.mime};base64,${Buffer.from(a.data).toString('base64')}` : url };
      },
    };
  }

  /**
   * Hover previews for the pages a page links to: title, tags and opening text for every
   * page, and for notes the start of the note itself, rendered (Quartz shows the page).
   * The browser cleans that HTML before showing it (public/popover.js).
   */
  #previews(slugs, viewer) {
    const out = this.#store.previews(slugs, viewer);
    for (const slug of Object.keys(out).filter(isNote).slice(0, PREVIEW_NOTES)) {
      // Each note's preview is rendered once per change to the site, not on every page that links to it.
      const html = this.#store.cached(`preview:${viewer ?? ''}:${slug}`, () => {
        try {
          const a = this.#store.readable(slug, viewer);
          const text = this.#store.version(a, a.latest_version).toString('utf8');
          const opts = { ...this.#resolvers(viewer, { inline: false, page: a }), title: out[slug].title, path: a.path };
          const full = isNotebook(slug) ? renderNotebook(parseNotebook(text), opts) : renderMarkdown(text, opts);
          return full.length > PREVIEW_HTML_CHARS ? full.slice(0, full.lastIndexOf('>', PREVIEW_HTML_CHARS) + 1) : full;
        } catch { return null; } // text preview only
      });
      if (html != null) out[slug].html = html;
    }
    return out;
  }

  /**
   * An HTML page opened directly in a browser tab gets the site's frame around it (see
   * frame). Everything else gets the page itself: the frame's own iframe, gallery
   * previews and the review page (all iframe loads), curl and other clients (which send
   * no Sec-Fetch-Dest), and ?raw=1.
   */
  #wantsFrame() {
    return this.#document && !this.#query.get('raw') && !this.#query.get('embed') && !this.#preview();
  }

  /**
   * The frame: the sidebar and explorer, the page's title, tags and links, the page
   * itself in an iframe (where it stays sandboxed and keeps its own design), then its
   * local graph and backlinks. The view is counted when the iframe loads the page.
   */
  #frame(a) {
    const viewer = this.#viewer();
    const n = this.#int('v') ?? a.latest_version;
    this.#store.version(a, n); // 404 for a version that doesn't exist
    const backlinks = this.#store.backlinks(a, viewer);
    return { kind: 'site', body: htmlFramePage({
      page: summary(a, viewer), n, backlinks,
      explorer: this.#store.explorer(viewer), graph: this.#store.graph(viewer, { views: false }),
      previews: this.#previews(backlinks.map((b) => b.slug), viewer),
    }) };
  }

  /** ?preview=1: a gallery-card thumbnail. Not a view, and no sidebar or badge drawn over it. */
  #preview() { return !!this.#query.get('preview'); }

  /**
   * What we add to a page at display time: the contents sidebar, and on an old version a
   * badge. `at`: the path the page was asked for (/pages/<at> or /<at>); none for a share link.
   */
  #decorate({ body, n, latest, page }, links, at = null) {
    const note = page && isNote(page.slug);
    let based = false;
    if (note) body = this.#note(page, body, n);
    else if (page) {
      // Relative links go where they went when this version was written. Shown from
      // another folder (moved since, or a share link), the page gets a <base> there.
      const written = this.#store.versionBase(page, n);
      if (at == null || parentPath(at).toLowerCase() !== parentPath(written).toLowerCase()) {
        const doc = withBase(body, `/pages/${encodePath(written)}${n < latest ? `?v=${n}` : ''}`);
        if (doc) { body = doc; based = true; }
      }
      if (this.#sso) body = withAssetLinks(body, page.share_id);
    }
    if (this.#preview()) return body;
    // In the site's frame the title bar shows the version, and a floating contents box
    // would be pinned to the top of a frame as tall as the page: just size it.
    if (this.#query.get('embed')) return withInFrame(withInPageLinks(note ? body : withEmbedSizing(body)));
    // Notes carry their contents in the right sidebar already.
    let doc = note || this.#query.get('toc') === '0' ? body : withToc(body);
    if (based) doc = withInPageLinks(doc);
    if (n < latest) doc = withVersionBadge(doc, { n, latest, ...links });
    return doc;
  }

}

const TOC_SCRIPT = fileText('public/toc.js');
const VERSION_BADGE_SCRIPT = fileText('public/version-badge.js');
const EMBED_SIZE_SCRIPT = fileText('public/embed-size.js').replace(/^(\/\/.*\n)+/, ''); // without its header comment
const IN_PAGE_LINKS_SCRIPT = fileText('public/in-page-links.js').replace(/^(\/\/.*\n)+/, '');
const IN_FRAME_SCRIPT = fileText('public/in-frame.js').replace(/^(\/\/.*\n)+/, '');

/** Insert a script just before the page's last </body> (or at the end). Display-time only. */
function injectScript(html, attrs, code) {
  // A </script> inside the script would end it early; ours have none, but be safe.
  const tag = `<script ${attrs}>${code.replace(/<\/script/gi, '<\\/script')}</script>`;
  const at = html.search(/<\/body\s*>(?![\s\S]*<\/body\s*>)/i);
  return at === -1 ? html + tag : html.slice(0, at) + tag + html.slice(at);
}

/** Add the contents sidebar to a page with enough headings (see TOC_MIN_HEADINGS). */
function withToc(doc) {
  const html = doc.toString('utf8');
  if ((html.match(/<h[23][\s>]/gi) || []).length < TOC_MIN_HEADINGS) return doc;
  if (/<meta\b[^>]*name\s*=\s*["']?toc["']?[^>]*content\s*=\s*["']?off/i.test(html)) return doc;
  return Buffer.from(injectScript(html, 'data-artifact-toc-script', TOC_SCRIPT));
}

/**
 * An HTML page inside the site's frame (?embed=1): opt it in to responsive iframes
 * (Chrome's frame-sizing: content-height; the meta tag has to be in the page as served,
 * it can't be added later) and add the script that keeps the frame sized everywhere else
 * (public/embed-size.js). A page that says <meta name="html-server-frame" content="window">
 * isn't opted in: it stays at window height.
 */
function withEmbedSizing(doc) {
  let html = doc.toString('utf8');
  if (!/<meta\b[^>]*name\s*=\s*["']?html-server-frame["']?[^>]*content\s*=\s*["']?window/i.test(html)) {
    html = inHead(html, '<meta name="responsive-embedded-sizing" content="allow-origins=*">');
  }
  return Buffer.from(injectScript(html, 'data-html-server-embed', EMBED_SIZE_SCRIPT));
}

/**
 * A page shown away from where it was written (moved since, or a share link): a <base> at
 * its written address, so its relative links reach the pages it was written next to (an
 * old address redirects to where that page is now). A page with a <base> of its own keeps
 * it: null.
 */
function withBase(doc, href) {
  const html = doc.toString('utf8');
  return /<base\b/i.test(html) ? null : Buffer.from(inHead(html, `<base href="${href}">`));
}

/**
 * With single sign-on, a page's own requests carry no sign-in (it's sandboxed, so the browser
 * sends no cookie with them): its links to this server's files (/assets/NAME) go by the page's
 * share link (?from=), as a note's do, which is what lets them load. Only addresses on this
 * server, so a share id never goes to another site; one that has a query of its own is left.
 */
function withAssetLinks(doc, shareId) {
  const html = doc.toString('utf8');
  const from = `from=${encodeURIComponent(shareId)}`;
  let changed = false;
  const out = html.replace(/(?<=["'(\s=,])\/assets\/[^"'\s?#)<>,]+/g, (m, at, all) => {
    if (all[at + m.length] === '?' || !ASSET_RE.test(safeDecode(m))) return m;
    changed = true;
    return `${m}?${from}`;
  });
  return changed ? Buffer.from(out) : doc;
}

/** Keep links to a place on the page (#section) on the page: public/in-page-links.js. */
function withInPageLinks(doc) {
  return Buffer.from(injectScript(doc.toString('utf8'), 'data-html-server-links', IN_PAGE_LINKS_SCRIPT));
}

/** In the site's frame, ⌘K opens the site's search and links the page follows open in the tab: public/in-frame.js. */
function withInFrame(doc) {
  return Buffer.from(injectScript(doc.toString('utf8'), 'data-html-server-in-frame', IN_FRAME_SCRIPT));
}

/** A tag at the start of the <head>; with none, after the doctype, which must stay first (anything before it means quirks mode). */
function inHead(html, tag) {
  if (/<head\b[^>]*>/i.test(html)) return html.replace(/<head\b[^>]*>/i, (m) => m + tag);
  const doctype = html.match(/^(\uFEFF?\s*(?:<!--[^]*?-->\s*)*)<!doctype\b[^>]*>/i);
  return doctype ? html.slice(0, doctype[0].length) + tag + html.slice(doctype[0].length) : tag + html;
}

/** On an old version, a small badge: "v2 of 6", with links to the current version and the history. */
function withVersionBadge(doc, { n, latest, current, history }) {
  const a = (k, v) => (v == null ? '' : ` data-${k}="${String(v).replace(/[&"<>]/g, (c) => `&#${c.charCodeAt(0)};`)}"`);
  const attrs = `data-artifact-version-badge${a('n', n)}${a('latest', latest)}${a('current', current)}${a('history', history)}`;
  return Buffer.from(injectScript(doc.toString('utf8'), attrs, VERSION_BADGE_SCRIPT));
}

const PREVIEW_NOTES = 40; // notes linked from one page that get a rendered preview
const PREVIEW_HTML_CHARS = 6000; // how much of each (the card shows the start)
