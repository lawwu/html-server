// Focus and background isolation for the search and graph overlays. Kept inline with
// their scripts in sandboxed notes, which cannot import same-origin modules.
export function trapModal(modal, close, invoker = document.activeElement) {
  const background = [...document.body.children].filter((el) => el !== modal && !el.contains(modal));
  const inert = background.map((el) => el.inert);
  background.forEach((el) => { el.inert = true; });
  const items = () => [...modal.querySelectorAll('a[href], button, input, select, textarea, [tabindex]')]
    .filter((el) => !el.matches(':disabled, [tabindex="-1"]') && el.getClientRects().length);
  const focus = () => (items()[0] || modal).focus();
  const keydown = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
    if (e.key === 'Tab') {
      e.preventDefault();
      const all = items(), at = all.indexOf(document.activeElement);
      if (all.length) all[(at + (e.shiftKey ? -1 : 1) + all.length) % all.length].focus();
      else focus();
    }
  };
  const focusin = (e) => { if (!modal.contains(e.target)) focus(); };
  document.addEventListener('keydown', keydown, true);
  document.addEventListener('focusin', focusin);
  focus();
  return () => {
    document.removeEventListener('keydown', keydown, true);
    document.removeEventListener('focusin', focusin);
    background.forEach((el, i) => { el.inert = inert[i]; });
    if (invoker?.isConnected) invoker.focus();
  };
}
