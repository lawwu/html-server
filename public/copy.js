// "Copy markdown" / "copy HTML" buttons: copy the page's source to the clipboard.
// data-copy-source names a <script type="application/json"> in the page holding it
// (notes, the API page: it works in a sandbox with no requests); data-src is a URL to
// fetch it from (framed HTML pages). Falls back to execCommand where the clipboard API
// isn't allowed.
const flash = (b, msg) => {
  const label = b.querySelector('span') || b;
  b.dataset.label ??= label.textContent;
  label.textContent = msg;
  clearTimeout(b.timer);
  b.timer = setTimeout(() => { label.textContent = b.dataset.label; }, 1600);
};

document.addEventListener('click', async (e) => {
  const b = e.target.closest('.copy-source');
  if (!b) return;
  e.preventDefault();
  let text;
  try {
    const held = b.dataset.copySource && document.getElementById(b.dataset.copySource);
    if (b.dataset.embed) {
      const url = new URL(b.dataset.embed, location.href);
      url.searchParams.set('embed', 'external');
      const version = b.parentElement.querySelector('select').value;
      if (version) url.searchParams.set('v', version);
      const frame = document.createElement('iframe');
      frame.src = url.href;
      frame.title = b.dataset.title;
      frame.style.width = '100%';
      frame.height = '480';
      frame.loading = 'lazy';
      frame.referrerPolicy = 'no-referrer';
      text = frame.outerHTML;
    } else if (held) text = JSON.parse(held.textContent);
    else {
      const r = await fetch(b.dataset.src);
      if (!r.ok) throw new Error(r.statusText); // signed out, or the page has gone: never its error, as if it were the page
      text = await r.text();
    }
  } catch { return flash(b, 'Couldn’t load it'); }
  try {
    await navigator.clipboard.writeText(text);
    return flash(b, 'Copied');
  } catch { /* not allowed here: the old way */ }
  const area = Object.assign(document.createElement('textarea'), { value: text });
  area.style.cssText = 'position:fixed;opacity:0;pointer-events:none';
  document.body.append(area);
  area.select();
  const ok = document.execCommand('copy');
  area.remove();
  flash(b, ok ? 'Copied' : 'Copy failed');
});
