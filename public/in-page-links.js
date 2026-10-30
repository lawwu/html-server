// Injected into an HTML page where a link to a place on the same page (#section, as in
// a table of contents) would otherwise go wrong:
// - the page is shown away from where it was written (moved since, or a share link), so
//   the server gave it a <base> for its relative links; the browser reads "#section"
//   against that too, and would load the page again from its old address;
// - the page is in the site's frame (?embed=1), as tall as the page, so the page itself
//   never scrolls: the window around the frame has to.
// Such a link stays on this page: the address gets the #section (:target styles and
// hashchange listeners see it, as they would have), and the target scrolls into view,
// which in the frame scrolls the window around it.
addEventListener('click', (e) => {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  const a = e.target.closest?.('a[href], area[href]');
  const href = a?.getAttribute('href') || '';
  if (!href.startsWith('#') || (a.target && !/^_self$/i.test(a.target))) return;
  e.preventDefault();
  let id = href.slice(1);
  try { id = decodeURIComponent(id); } catch { /* as written */ }
  location.hash = href;
  const el = id && (document.getElementById(id) || document.querySelector(`a[name="${CSS.escape(id)}"]`));
  if (el) el.scrollIntoView();
  else if (/^top$/i.test(id)) document.documentElement.scrollIntoView();
});
