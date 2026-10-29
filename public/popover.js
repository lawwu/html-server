// Hover previews, like Quartz's popovers: point at a link to another page here and a
// card shows it: a note rendered (its start), an HTML page as title, tags and opening
// text. The previews are embedded in the page (<script id="page-previews">), so this
// works in a sandboxed note with no requests.
//
// A preview's HTML is another page's content, and framed pages run on the site's own
// origin, so it is rebuilt from an allowlist (clean() below): no scripts, no event
// handlers, no styles, links and images only to safe places.
const data = JSON.parse(document.getElementById('page-previews')?.textContent || '{}');
// A link's preview: by the page's name for /pages/<name>; on the static docs site
// (scripts/build-site.js), whose links are relative, by the link's own address.
const previewOf = (a) => {
  const href = a.getAttribute('href') || '';
  const m = href.match(/^\/pages\/([^?#]+)/);
  let key = href.replace(/#.*/, '');
  try { if (m) key = decodeURIComponent(m[1]); } catch { return null; }
  return Object.hasOwn(data, key) ? data[key] : null;
};
let card = null, showTimer = null, hideTimer = null;

function build(p, href) {
  const el = document.createElement('div');
  el.className = 'popover';
  el.setAttribute('role', 'tooltip');
  const h = document.createElement('a');
  h.className = 'pop-title';
  h.href = href;
  h.target = '_top';
  h.textContent = p.title;
  el.append(h);
  if (p.tags.length) {
    const t = document.createElement('p');
    t.className = 'pop-tags';
    t.textContent = p.tags.map((x) => `#${x}`).join('  ');
    el.append(t);
  }
  const body = p.html ? clean(p.html) : null;
  if (body?.childNodes.length) {
    const div = document.createElement('div');
    div.className = 'pop-body';
    div.append(body);
    el.append(div);
  } else {
    for (const text of [p.description, p.text].filter(Boolean)) {
      const para = document.createElement('p');
      para.textContent = text;
      el.append(para);
    }
  }
  el.addEventListener('mouseenter', () => clearTimeout(hideTimer));
  el.addEventListener('mouseleave', hide);
  return el;
}

const TAGS = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'a', 'strong', 'b', 'em', 'i', 'code', 'pre',
  'blockquote', 'mark', 'img', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'br', 'hr', 'del', 's', 'sup', 'sub', 'span', 'div',
  'details', 'summary', 'figure', 'figcaption', 'kbd']);
const ATTRS = { a: ['href', 'class'], img: ['src', 'alt', 'width', 'height'], '*': ['class'] };
const SAFE_URL = /^(\/(?!\/)|#|https?:)/i;

/** Another page's HTML, rebuilt node by node from the allowlist above. */
function clean(html) {
  const doc = new DOMParser().parseFromString(`<body>${html}`, 'text/html');
  const copy = (node) => {
    if (node.nodeType === Node.TEXT_NODE) return document.createTextNode(node.textContent);
    if (node.nodeType !== Node.ELEMENT_NODE) return null;
    const tag = node.tagName.toLowerCase();
    if (!TAGS.has(tag)) {
      // Unknown wrappers keep their text; dangerous ones go entirely.
      if (/^(script|style|iframe|object|embed|template|svg|math|form|input|button|textarea|select)$/.test(tag)) return null;
      const frag = document.createDocumentFragment();
      for (const c of node.childNodes) { const x = copy(c); if (x) frag.append(x); }
      return frag;
    }
    const out = document.createElement(tag);
    for (const name of [...(ATTRS[tag] || []), ...ATTRS['*']]) {
      const v = node.getAttribute(name);
      if (v == null) continue;
      if ((name === 'href' || name === 'src') && !SAFE_URL.test(v.trim())) continue;
      out.setAttribute(name, v);
    }
    if (tag === 'a') out.target = '_top';
    if (tag === 'img') out.loading = 'lazy';
    for (const c of node.childNodes) { const x = copy(c); if (x) out.append(x); }
    return out;
  };
  const frag = document.createDocumentFragment();
  for (const c of doc.body.childNodes) { const x = copy(c); if (x) frag.append(x); }
  return frag;
}

function place(el, link) {
  const r = link.getBoundingClientRect();
  const w = Math.min(380, innerWidth - 24);
  el.style.width = `${w}px`;
  const left = Math.min(Math.max(12, r.left), innerWidth - w - 12);
  document.body.append(el);
  const below = r.bottom + 8, h = el.offsetHeight;
  const top = below + h > innerHeight - 8 && r.top - h - 8 > 8 ? r.top - h - 8 : below;
  el.style.left = `${left + scrollX}px`;
  el.style.top = `${top + scrollY}px`;
}

function hide() {
  clearTimeout(showTimer);
  hideTimer = setTimeout(() => { card?.remove(); card = null; }, 120);
}

document.addEventListener('mouseover', (e) => {
  const link = e.target.closest?.('a[href]');
  if (!link || link.closest('.popover, .tree, .graph-box, .side-nav')) return;
  const p = previewOf(link);
  if (!p) return;
  clearTimeout(hideTimer);
  clearTimeout(showTimer);
  showTimer = setTimeout(() => {
    card?.remove();
    card = build(p, link.getAttribute('href'));
    place(card, link);
  }, 250);
  link.addEventListener('mouseleave', hide, { once: true });
});
addEventListener('scroll', () => { if (card) { card.remove(); card = null; } }, { passive: true });
