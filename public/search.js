// Search from anywhere, like Quartz: ⌘K or Ctrl+K (or / when not typing), or click the
// sidebar's search box. Results come from /api/search as you type; arrows move, Enter
// opens. Where the page can't fetch (some browsers block a sandboxed note's requests), it
// matches titles from the explorer already on the page, and Enter searches everything.
const box = document.querySelector('.side-search input');
let modal, input, list, status, items = [], at = -1, ctl, timer;
const cache = new Map(); // query → results, for this visit: going back to an earlier query is instant

const go = (url) => { try { window.top.location.href = url; } catch { location.href = url; } };
const marked = (s) => {
  // The API brackets matched words: "the [graph] view" → mark them.
  const frag = document.createDocumentFragment();
  s.split(/(\[[^\]]+\])/).forEach((part) => {
    if (/^\[[^\]]+\]$/.test(part)) { const m = document.createElement('mark'); m.textContent = part.slice(1, -1); frag.append(m); }
    else if (part) frag.append(part);
  });
  return frag;
};

function open() {
  if (!modal) {
    modal = document.createElement('div');
    modal.className = 'search-modal';
    modal.innerHTML = '<div class="search-panel" role="dialog" aria-modal="true" aria-label="Search">'
      + '<input type="search" placeholder="Search for something" aria-label="Search pages" autocomplete="off">'
      + '<p class="search-status" aria-live="polite"></p><ul class="search-results" role="listbox"></ul></div>';
    document.body.append(modal);
    input = modal.querySelector('input');
    list = modal.querySelector('ul');
    status = modal.querySelector('.search-status');
    modal.addEventListener('mousedown', (e) => { if (e.target === modal) close(); });
    // Known results show at once; otherwise wait for a pause in typing, but only a short one.
    input.addEventListener('input', () => { clearTimeout(timer); if (cache.has(input.value.trim())) run(); else timer = setTimeout(run, 60); });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        select(Math.max(0, Math.min(items.length - 1, at + (e.key === 'ArrowDown' ? 1 : -1))));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (items[at]) go(items[at].url);
        else if (input.value.trim()) go(`/?q=${encodeURIComponent(input.value.trim())}`);
      }
    });
  }
  modal.hidden = false;
  document.documentElement.classList.add('searching');
  input.value = box?.value || '';
  input.focus();
  input.select();
  if (input.value) run(); else show([], '');
}

function close() {
  if (!modal || modal.hidden) return;
  modal.hidden = true;
  document.documentElement.classList.remove('searching');
}

function select(i) {
  at = i;
  [...list.children].forEach((li, k) => li.setAttribute('aria-selected', String(k === i)));
  list.children[i]?.scrollIntoView({ block: 'nearest' });
}

function show(results, message) {
  items = results;
  list.replaceChildren(...results.map((r, i) => {
    const li = document.createElement('li');
    li.setAttribute('role', 'option');
    const a = document.createElement('a');
    a.href = r.url;
    a.target = '_top';
    const h = document.createElement('span');
    h.className = 'r-title';
    h.append(marked(r.title_highlight || r.title));
    a.append(h);
    if (r.tags?.length) {
      const t = document.createElement('span');
      t.className = 'r-tags';
      t.textContent = r.tags.slice(0, 4).map((x) => `#${x}`).join(' ');
      a.append(t);
    }
    if (r.snippet || r.description) {
      const p = document.createElement('span');
      p.className = 'r-snip';
      p.append(marked(r.snippet || r.description));
      a.append(p);
    }
    li.append(a);
    li.addEventListener('mousemove', () => { if (at !== i) select(i); });
    return li;
  }));
  status.textContent = message;
  select(results.length ? 0 : -1);
}

async function run() {
  const q = input.value.trim();
  ctl?.abort();
  if (!q) return show([], '');
  if (cache.has(q)) return show(cache.get(q), cache.get(q).length ? '' : 'No matches.');
  ctl = new AbortController();
  try {
    const r = await fetch(`/api/search?q=${encodeURIComponent(q)}&limit=12`, { signal: ctl.signal });
    const data = await r.json();
    if (r.ok) {
      cache.set(q, data.results);
      if (cache.size > 200) cache.delete(cache.keys().next().value);
    }
    show(data.results || [], data.results?.length ? '' : 'No matches.');
  } catch (e) {
    if (e.name === 'AbortError') return;
    const hits = titleMatches(q);
    show(hits, hits.length ? 'Titles only here. Press Enter to search everything.' : 'Press Enter to search all pages.');
  }
}

/** Titles containing every word of the query, or with a word starting with it ("flav" → ObsidianFlavoredMarkdown). */
function titleMatches(q) {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const seen = new Set();
  return [...document.querySelectorAll('.tree a[href^="/pages/"]')].map((a) => ({ title: a.textContent.trim(), url: a.getAttribute('href') }))
    .filter((r) => {
      if (seen.has(r.url)) return false;
      seen.add(r.url);
      const t = r.title.toLowerCase();
      const tw = r.title.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/);
      return words.every((w) => t.includes(w) || tw.some((x) => x.startsWith(w)));
    })
    .slice(0, 12);
}

addEventListener('keydown', (e) => {
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName) || document.activeElement?.isContentEditable;
  if ((e.key === 'k' && (e.metaKey || e.ctrlKey)) || (e.key === '/' && !typing)) {
    // On the home page, its own live search box is the search.
    const home = document.getElementById('q');
    e.preventDefault();
    if (home) { home.focus(); home.select(); } else if (modal && !modal.hidden) close(); else open();
  } else if (e.key === 'Escape') close();
});
box?.addEventListener('focus', () => { box.blur(); open(); });
box?.form?.addEventListener('submit', (e) => { e.preventDefault(); open(); });
