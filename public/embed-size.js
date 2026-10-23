// Injected into an HTML page shown inside the site's frame (/pages/<name>?embed=1), so
// the frame can grow to the page's full height: one scroll, like a note. Where the
// browser has responsive iframes (frame-sizing: content-height, with the page's
// <meta name="responsive-embedded-sizing"> that the server adds), this only asks it to
// re-measure (requestResize) when the content changes. Elsewhere it posts the height to
// the frame. Pages built to fill the window are told to stay at window height instead:
// overflow hidden, content that exactly fills the frame when first measured (height:
// 100% or 100vh layouts), or a height that keeps chasing the frame's; and any page with
// <meta name="html-server-frame" content="window">.
//
// It also makes links and forms leave the frame: a plain link (no target, or _self or
// _parent) opens in the whole tab, as it does on the page's own, rather than inside the
// frame, where most sites (Jira, GitHub) refuse to load. Links within the page (#section),
// downloads and links that already choose a target (_blank, a named window) are left alone.
(() => {
  const post = (msg) => parent.postMessage({ htmlServer: 'size', ...msg }, '*');
  const root = document.documentElement;
  const native = 'requestResize' in window;
  const optOut = /^window$/i.test(document.querySelector('meta[name="html-server-frame"]')?.content || '');
  let last = 0, creeps = 0, done = false, first = true;

  const windowMode = () => { done = true; post({ mode: 'window' }); };
  function contentEnd() {
    const body = document.body;
    if (!body) return 0;
    const bs = getComputedStyle(body);
    let end = 0;
    for (const el of body.children) {
      if (el.tagName === 'SCRIPT' || el.tagName === 'STYLE') continue;
      const cs = getComputedStyle(el);
      if (cs.position === 'fixed' || cs.display === 'none') continue;
      end = Math.max(end, el.getBoundingClientRect().bottom + parseFloat(cs.marginBottom || 0));
    }
    if (!end) end = body.getBoundingClientRect().top; // text directly in <body>: fall back to the body
    if (!body.children.length || [...body.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) {
      end = Math.max(end, body.getBoundingClientRect().bottom - parseFloat(bs.paddingBottom || 0));
    }
    return end + scrollY + parseFloat(bs.paddingBottom || 0) + parseFloat(bs.marginBottom || 0);
  }

  function measure() {
    if (done || innerHeight < 50) return; // not laid out in the frame yet
    const style = getComputedStyle(document.body || root);
    if (optOut || /hidden|clip/.test(getComputedStyle(root).overflowY + style.overflowY)) return windowMode();
    // The content's height, not the frame's: scrollHeight never reports less than the
    // frame, and a body can stretch to fill it (quirks mode, min-height), so a short page
    // is measured by where its content ends.
    const end = contentEnd();
    const h = Math.ceil(root.scrollHeight > innerHeight + 1 ? root.scrollHeight : Math.max(end, 1));
    // First look, at the frame's starting (window) height: content that fills it exactly is sized by it.
    // (Not natively: there the frame starts at the content's height, so it always fits.)
    if (first) { first = false; if (!native && Math.abs(h - innerHeight) <= 1) return windowMode(); }
    // A page that grows by a little every time the frame grows is sized by the frame: stop.
    if (h > last && h - last <= 40 && last) { if (++creeps >= 3) return windowMode(); } else creeps = 0;
    if (h === last) return;
    last = h;
    if (native) window.requestResize(); else post({ mode: 'auto', height: h });
  }
  // Start after the first layout: on the next frame, or a timer (frames pause in background tabs).
  let started = false;
  const start = () => {
    if (started) return;
    started = true;
    measure();
    new ResizeObserver(measure).observe(root);
    if (document.body) new ResizeObserver(measure).observe(document.body);
  };
  requestAnimationFrame(start);
  setTimeout(start, 50);
  addEventListener('load', measure);
})();

(() => {
  const here = location.href.split('#')[0];
  const ownTarget = (t) => !t || t === '_self' || t === '_parent';
  addEventListener('click', (e) => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey) return; // new-tab and new-window clicks do their own thing
    const a = e.target.closest?.('a[href]');
    if (!a || a.hasAttribute('download') || !ownTarget(a.getAttribute('target'))) return;
    if (a.href.split('#')[0] === here) return; // a section of this page
    if (/^(javascript|mailto|tel|sms):/i.test(a.getAttribute('href'))) return;
    a.target = '_top';
  }, true);
  addEventListener('submit', (e) => {
    const f = e.target;
    if (f instanceof HTMLFormElement && ownTarget(f.getAttribute('target')) && (f.method || 'get').toLowerCase() !== 'dialog') f.target = '_top';
  }, true);
})();
