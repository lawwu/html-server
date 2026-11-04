// Injected into an HTML page shown inside the site's frame (/pages/<name>?embed=1), so the
// page acts as if it had the tab to itself. It runs sandboxed, in an origin of its own, so
// neither its key presses nor its links reach the tab around it by themselves:
// - ⌘K or Ctrl+K opens the site's search (public/search.js), as on every other page,
//   unless the page uses those keys itself;
// - a link the page follows (no target, or _self, _parent or _top) opens in the tab, so the
//   address, the title bar and the sidebar move with it, instead of the next page loading
//   inside this one's frame. The frame checks the click was the viewer's (pages.js FRAME_SCRIPT).
// Links to a place on the page (#section) are public/in-page-links.js's; modified clicks,
// links to a new window, downloads and other kinds of link (mailto:) are the browser's.
(() => {
  const tell = (type, data) => parent.postMessage({ htmlServer: type, ...data }, '*');
  addEventListener('keydown', (e) => {
    if (e.defaultPrevented || e.key !== 'k' || !(e.metaKey || e.ctrlKey)) return;
    e.preventDefault();
    tell('search');
  });
  addEventListener('click', (e) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const a = e.target.closest?.('a[href], area[href]');
    if (typeof a?.href !== 'string' || a.hasAttribute('download') || a.getAttribute('href').startsWith('#')) return; // (an SVG link's href isn't a string)
    const target = (a.target || document.querySelector('base[target]')?.target || '').toLowerCase();
    if (target && !['_self', '_parent', '_top'].includes(target)) return;
    let url;
    try { url = new URL(a.href); } catch { return; }
    // This page again (href="" or "?embed=1") reloads in the frame, as it always did.
    if (!/^https?:$/.test(url.protocol) || url.href.split('#')[0] === location.href.split('#')[0]) return;
    e.preventDefault();
    tell('go', { href: url.href });
  });
})();
