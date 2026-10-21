// Injected into a page shown at an old version (?v=n): a small badge in the bottom
// left, "v2 of 6", with links to the current version and the page's history. Drawn in
// a shadow root, so the page's styles and ours can't touch each other.
(() => {
  const d = document.currentScript?.dataset;
  if (!d) return;
  const host = document.createElement('div');
  host.setAttribute('data-artifact-version-badge', '');
  const root = host.attachShadow({ mode: 'open' });
  const link = (href, text) => (href ? `<a href="${href}" target="_top">${text}</a>` : '');
  root.innerHTML = `<style>
    :host { all: initial; }
    div { position: fixed; left: 1rem; bottom: 1rem; z-index: 2147483000; display: flex; gap: .7rem; align-items: center;
      font: 600 13px ui-sans-serif, system-ui, -apple-system, sans-serif; padding: .5rem .85rem; border-radius: 999px;
      color: #fff; background: #b4532a; box-shadow: 0 4px 16px rgba(0,0,0,.25); }
    a { color: inherit; font-weight: 500; text-underline-offset: 2px; }
  </style>
  <div role="status">Old version: v${d.n} of ${d.latest} ${link(d.current, 'View current')} ${link(d.history, 'History')}</div>`;
  document.body.append(host);
})();
