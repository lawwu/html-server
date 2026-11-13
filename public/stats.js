// /stats hover: every chart mark carries data-tip; show it in one floating tooltip
// that follows the pointer (and keyboard focus, for the linked rows).
import { browserSignIn } from './signin.js';
const tip = document.getElementById('tip');
const show = (mark, x, y) => {
  tip.textContent = mark.dataset.tip;
  tip.hidden = false;
  const r = tip.getBoundingClientRect();
  tip.style.left = `${Math.min(x + 12, innerWidth - r.width - 8)}px`;
  tip.style.top = `${Math.max(y - r.height - 10, 8)}px`;
};
let current = null;
document.addEventListener('pointermove', (e) => {
  const mark = e.target.closest?.('.mark');
  if (current && current !== mark) current.classList.remove('hover');
  current = mark;
  if (!mark) { tip.hidden = true; return; }
  mark.classList.add('hover');
  show(mark, e.clientX, e.clientY);
});
document.addEventListener('focusin', (e) => {
  const mark = e.target.closest?.('.mark');
  if (!mark) return;
  const r = mark.getBoundingClientRect();
  show(mark, r.left + r.width / 2, r.top);
});
document.addEventListener('focusout', () => { tip.hidden = true; });

// API & MCP usage, for admins: fetched with the token this browser saved (the review
// page's "Sign in to comment" and the home page's Select both save it), or one pasted
// here. The server checks it's an admin's; nobody else gets the numbers.
const usageBody = document.getElementById('usage-body');
const form = document.getElementById('usage-signin');
const msg = document.getElementById('usage-msg');
const auth = browserSignIn();
const saved = () => auth.token;

async function loadUsage(token, { fromForm = false, days = new URLSearchParams(location.search).get('days') || '' } = {}) {
  if (!token && !auth.signedIn) { form.hidden = false; return; }
  let r;
  try { r = await auth.request(`/stats/usage${days ? `?days=${encodeURIComponent(days)}` : ''}`, { token }); }
  catch { msg.textContent = 'Couldn’t reach the server.'; return; }
  if (r.ok) {
    if (fromForm && token) auth.save(token);
    usageBody.innerHTML = await r.text();
    if (days) history.replaceState(null, '', `?days=${encodeURIComponent(days)}#usage`);
    return;
  }
  form.hidden = false;
  msg.textContent = r.status === 403 ? 'That token isn’t an admin’s.' : r.status === 401 && fromForm ? 'That token isn’t valid here.' : '';
}

form?.addEventListener('submit', (e) => {
  e.preventDefault();
  loadUsage(document.getElementById('usage-token').value.trim(), { fromForm: true });
});
if (usageBody) loadUsage(saved());

// The usage section's period (30 days, 90 days, 1 year, all time): reload just that section.
usageBody?.addEventListener('click', (e) => {
  const a = e.target.closest('.range-picker a');
  if (!a) return;
  e.preventDefault();
  loadUsage(saved() || document.getElementById('usage-token')?.value.trim(), { days: a.dataset.days });
});

// People: a name opens that person's activity, for the period shown, under the table.
usageBody?.addEventListener('click', async (e) => {
  const close = e.target.closest('.person-close');
  const panel = document.getElementById('person-detail');
  if (close && panel) {
    panel.hidden = true;
    const open = usageBody.querySelector('.person-link[aria-expanded="true"]');
    open?.setAttribute('aria-expanded', 'false');
    open?.focus();
    return;
  }
  const link = e.target.closest('.person-link');
  if (!link || !panel) return;
  const token = saved() || document.getElementById('usage-token')?.value.trim();
  const days = usageBody.querySelector('.range-picker a.on')?.dataset.days || '';
  for (const other of usageBody.querySelectorAll('.person-link')) other.setAttribute('aria-expanded', String(other === link));
  panel.hidden = false;
  panel.innerHTML = '<p class="meta">Loading…</p>';
  try {
    const r = await auth.request(`/stats/usage/people/${encodeURIComponent(link.dataset.person)}${days ? `?days=${encodeURIComponent(days)}` : ''}`, { token });
    panel.innerHTML = r.ok ? await r.text() : `<p class="meta">Couldn’t load it (HTTP ${r.status}).</p>`;
  } catch { panel.innerHTML = '<p class="meta">Couldn’t reach the server.</p>'; }
  panel.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
});

// The Popular list's period: swap in that period's list (from this page at ?weeks=) and keep
// the choice in the address. Without scripts, the form's Show button loads the page so.
let asked = 0;
document.addEventListener('change', async (e) => {
  if (!e.target.matches?.('#popular select')) return;
  const url = `/stats?weeks=${encodeURIComponent(e.target.value)}`;
  const n = ++asked;
  try {
    const r = await fetch(url);
    const next = new DOMParser().parseFromString(await r.text(), 'text/html').getElementById('popular');
    if (!r.ok || !next) throw new Error(`HTTP ${r.status}`);
    if (n !== asked) return; // a later choice is on its way
    document.getElementById('popular').replaceWith(next);
    next.querySelector('select').focus(); // arrow keys keep choosing
    history.replaceState(null, '', `${url}#popular`);
  } catch { location.href = `${url}#popular`; }
});
