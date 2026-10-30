// This module runs only in trusted site UI, never inside uploaded content.
export async function openMove(pages, onMoved) {
  if (document.querySelector('dialog.move-dialog')) return;
  const dialog = document.createElement('dialog');
  dialog.className = 'move-dialog';
  dialog.innerHTML = `<form><h2>Move ${pages.length === 1 ? 'page' : 'pages'}</h2>
    <label>Folder <input name="folder" list="move-folders" placeholder="research/experiments (leave empty for root)"></label>
    <datalist id="move-folders"></datalist>
    ${pages.length === 1 ? '<label>File name <input name="filename" required></label>' : ''}
    <label class="move-signin">Sign-in token <input name="token" type="password" autocomplete="off"></label>
    <p class="meta">History and share links stay intact. Old addresses will redirect.</p>
    <ul class="move-preview"></ul><p class="move-error" role="status"></p>
    <div class="move-buttons"><button type="button" data-cancel>Cancel</button><button type="submit">Move</button></div>
    </form>`;
  const form = dialog.querySelector('form');
  const folder = form.elements.folder, filename = form.elements.filename;
  const tokenInput = form.elements.token, error = dialog.querySelector('.move-error');
  try { tokenInput.value = localStorage.getItem('artifact_token') || ''; } catch { /* this visit only */ }
  dialog.querySelector('.move-signin').hidden = !!tokenInput.value;
  if (pages.length === 1) {
    folder.value = pages[0].split('/').slice(0, -1).join('/');
    filename.value = pages[0].split('/').at(-1);
  }
  const moves = () => pages.map((from) => ({ from, to: [folder.value.trim().replace(/^\/+|\/+$/g, ''), filename ? filename.value.trim() : from.split('/').at(-1)].filter(Boolean).join('/') }));
  const preview = () => {
    dialog.querySelector('.move-preview').replaceChildren(...moves().map(({ from, to }) => {
      const li = document.createElement('li'); li.textContent = `${from} → /${to}`; return li;
    }));
  };
  form.addEventListener('input', preview);
  dialog.querySelector('[data-cancel]').onclick = () => dialog.close();
  dialog.addEventListener('close', () => dialog.remove());
  document.body.append(dialog); preview(); dialog.showModal(); folder.focus();
  form.onsubmit = async (e) => {
    e.preventDefault();
    const button = form.querySelector('[type="submit"]'); button.disabled = true; error.textContent = '';
    try {
      const token = tokenInput.value.trim();
      const r = await fetch('/api/moves', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ moves: moves() }) });
      const data = await r.json();
      if (!r.ok) {
        if (r.status === 401) { dialog.querySelector('.move-signin').hidden = false; tokenInput.focus(); }
        throw new Error(data.error || 'Move failed');
      }
      try { localStorage.setItem('artifact_token', token); } catch { /* this visit only */ }
      dialog.close(); onMoved(data.results);
    } catch (err) { error.textContent = err.message; }
    finally { button.disabled = false; }
  };
  try {
    const r = await fetch('/api/folders', { headers: tokenInput.value ? { Authorization: `Bearer ${tokenInput.value}` } : {} });
    if (r.ok) for (const name of await r.json()) {
      const opt = document.createElement('option'); opt.value = name; dialog.querySelector('datalist').append(opt);
    }
  } catch { /* choosing a new path still works */ }

}
