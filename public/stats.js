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
