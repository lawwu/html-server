// /stats hover: every chart mark carries data-tip; show it in one floating tooltip
// that follows the pointer (and keyboard focus, for the linked rows).
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
const KEY = 'artifact_token';
const saved = () => { try { return localStorage.getItem(KEY) || ''; } catch { return ''; } };

async function loadUsage(token, { fromForm = false, days = new URLSearchParams(location.search).get('days') || '' } = {}) {
  if (!token) { form.hidden = false; return; }
  let r;
  try { r = await fetch(`/stats/usage${days ? `?days=${encodeURIComponent(days)}` : ''}`, { headers: { Authorization: `Bearer ${token}` } }); }
  catch { msg.textContent = 'Couldn’t reach the server.'; return; }
  if (r.ok) {
    if (fromForm) { try { localStorage.setItem(KEY, token); } catch { /* this visit only */ } }
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
