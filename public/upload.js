// Upload from the browser: the home page's Upload button, or files dropped on it. The same
// requests as `html-server put` (PUT /api/artifacts/<name>) and, for images and PDFs, as
// `curl -T diagram.png …/api/assets/`, signed in with the token this site's other forms
// save. This module runs only in trusted site UI, never inside uploaded content.
import { browserSignIn } from './signin.js';
const PAGE_RE = /\.(html?|md|markdown|ipynb)$/i; // config.js PAGE_EXT_RE
const ASSET_RE = /\.(png|jpe?g|gif|webp|avif|svg|pdf)$/i; // config.js ASSET_TYPES
const encodePath = (p) => p.split('/').map(encodeURIComponent).join('/');

/** A file name the server takes (config.js SLUG_RE): spaces become dashes, other characters go. */
export function cleanName(name) {
  const clean = name.trim().replace(/\s+/g, '-').replace(/[^\p{L}\p{N}\p{M}._-]/gu, '').replace(/^[^\p{L}\p{N}]+/u, '');
  if (!clean) return 'page.html';
  const ext = clean.match(/\.[\p{L}\p{N}]{1,10}$/u)?.[0] || ''; // a long name keeps its extension
  return clean.length <= 100 ? clean : clean.slice(0, 100 - ext.length) + ext;
}

const kindOf = (name) => (PAGE_RE.test(name) ? 'page' : ASSET_RE.test(name) ? 'asset' : null);
const size = (n) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

let current = null; // the open dialog's add(), so files dropped while it's open join it

/**
 * Open the upload dialog, with `files` (a FileList or File[]) already in it if given.
 * `folder` is where pages go unless changed; `onUploaded` runs after a batch that
 * published anything (to redraw the cards behind it).
 */
export function openUpload({ files = [], folder = '', onUploaded = () => {} } = {}) {
  const auth = browserSignIn();
  if (current) return current(files);
  const dialog = document.createElement('dialog');
  dialog.className = 'move-dialog upload-dialog';
  dialog.setAttribute('aria-labelledby', 'upload-title');
  dialog.innerHTML = `<form><h2 id="upload-title">Upload</h2>
    <div class="drop-zone"><p>Drop files here, or <button type="button" data-choose>choose files</button></p>
      <p class="meta">Pages: HTML, Markdown (.md) and notebooks (.ipynb). A page you already have gets a new version.
      Images and PDFs are kept by file name, for notes to embed.</p></div>
    <input type="file" multiple hidden accept=".html,.htm,.md,.markdown,.ipynb,.png,.jpg,.jpeg,.gif,.webp,.avif,.svg,.pdf">
    <ul class="upload-list" aria-label="Files to upload"></ul>
    <label>Folder for pages <input name="folder" list="upload-folders" placeholder="leave empty for the top level" autocomplete="off"></label>
    <datalist id="upload-folders"></datalist>
    <label>Version note <input name="note" placeholder="optional: what changed" autocomplete="off"></label>
    <label class="upload-private"><input type="checkbox" name="private"> Private: only you, and whoever you send its share link.
      Otherwise a new page is public, and a new version keeps its page's setting.</label>
    <label class="move-signin">Sign-in token <input name="token" type="password" autocomplete="off"></label>
    <p class="upload-status" role="status"></p>
    <div class="move-buttons"><button type="button" data-cancel>Close</button><button type="submit">Upload</button></div>
    </form>`;
  const form = dialog.querySelector('form');
  const list = dialog.querySelector('.upload-list');
  const picker = dialog.querySelector('input[type="file"]');
  const submit = form.querySelector('[type="submit"]');
  const status = dialog.querySelector('.upload-status');
  const signin = dialog.querySelector('.move-signin');
  const tokenInput = form.elements.token;
  const rows = []; // { file, kind, li, name (input), state: 'ready' | 'done' | 'skip' }
  let busy = false;

  form.elements.folder.value = folder;
  tokenInput.value = auth.token;
  signin.hidden = auth.signedIn;

  const say = (text, isError = false) => { status.textContent = text; status.classList.toggle('err', isError); };
  const pending = () => rows.filter((r) => r.state === 'ready');
  const sync = () => {
    const n = pending().length;
    submit.disabled = busy || !n;
    submit.textContent = n > 1 ? `Upload ${n} files` : 'Upload';
    dialog.querySelector('.upload-private').hidden = !rows.some((r) => r.kind === 'page');
  };

  function add(files) {
    for (const file of files) {
      const kind = kindOf(file.name);
      const li = document.createElement('li');
      const row = { file, kind, li, state: kind ? 'ready' : 'skip' };
      const what = document.createElement('span');
      what.className = 'meta';
      what.textContent = kind ? `${kind === 'page' ? 'page' : 'image or PDF'} · ${size(file.size)}` : `${file.name}: not a page, image or PDF`;
      if (kind) {
        row.name = Object.assign(document.createElement('input'), { value: cleanName(file.name), autocomplete: 'off', spellcheck: false });
        row.name.setAttribute('aria-label', `Name for ${file.name}`);
        const remove = Object.assign(document.createElement('button'), { type: 'button', textContent: '×', className: 'ghost' });
        remove.setAttribute('aria-label', `Remove ${file.name}`);
        remove.onclick = () => { rows.splice(rows.indexOf(row), 1); li.remove(); sync(); };
        row.remove = remove;
        li.append(row.name, what, remove);
      } else {
        li.className = 'skip';
        li.append(what);
      }
      row.out = Object.assign(document.createElement('span'), { className: 'upload-out' });
      li.append(row.out);
      rows.push(row);
      list.append(li);
    }
    sync();
    if (pending().length) submit.focus();
  }

  async function send(row, token) {
    const name = row.name.value.trim();
    let path;
    if (row.kind === 'page') {
      const dir = form.elements.folder.value.trim().replace(/^\/+|\/+$/g, '');
      const q = new URLSearchParams();
      if (form.elements.note.value.trim()) q.set('note', form.elements.note.value.trim());
      if (form.elements.private.checked) q.set('visibility', 'private');
      path = `/api/artifacts/${encodePath([dir, name].filter(Boolean).join('/'))}${q.size ? `?${q}` : ''}`;
    } else {
      path = `/api/assets/${encodeURIComponent(name)}`;
    }
    const r = await auth.request(path, { method: 'PUT', body: row.file, token });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(data.error || `${r.status} ${r.statusText}`), { status: r.status });
    return data;
  }

  function done(row, data) {
    row.state = 'done';
    row.name.readOnly = true;
    row.remove.remove();
    const link = Object.assign(document.createElement('a'), { textContent: 'open', target: '_blank', rel: 'noopener' });
    let what;
    if (row.kind === 'page') {
      // A private page's own address needs the sign-in header, which a new tab doesn't send.
      link.href = data.visibility === 'private' && data.share_url ? data.share_url : data.url;
      link.setAttribute('aria-label', `Open ${data.slug}`);
      what = `${data.latest_version === 1 ? 'new page' : `version ${data.latest_version}`}${data.visibility === 'private' ? ', private' : ''}`;
    } else {
      link.href = data.url;
      link.setAttribute('aria-label', `Open ${data.name}`);
      what = 'uploaded';
    }
    row.out.className = 'upload-out ok';
    row.out.replaceChildren(`${what} · `, link);
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const token = tokenInput.value.trim();
    if (!token && !auth.session) { signin.hidden = false; tokenInput.focus(); return say('Paste your sign-in token first.', true); }
    busy = true; sync(); say('Uploading…');
    let ok = 0, failed = 0;
    for (const row of pending()) {
      row.out.className = 'upload-out';
      row.out.textContent = 'uploading…';
      try {
        done(row, await send(row, token));
        ok++;
        if (token) auth.save(token);
      } catch (err) {
        failed++;
        row.out.className = 'upload-out err';
        row.out.textContent = err.message;
        if (err.status === 401) {
          signin.hidden = false;
          tokenInput.focus();
          busy = false; sync();
          return say('That token isn’t valid here. Paste yours and upload again.', true);
        }
      }
    }
    busy = false; sync();
    say(failed ? `Uploaded ${ok} of ${ok + failed}. Fix what's marked and upload again.` : `Uploaded ${ok}.`, !!failed);
    if (ok) { signin.hidden = true; onUploaded(); }
    (failed ? submit : dialog.querySelector('[data-cancel]')).focus();
  });

  dialog.querySelector('[data-choose]').onclick = () => picker.click();
  picker.onchange = () => { add(picker.files); picker.value = ''; };
  dialog.querySelector('[data-cancel]').onclick = () => dialog.close();
  dialog.addEventListener('close', () => { current = null; dialog.remove(); });
  current = add;
  document.body.append(dialog);
  dialog.showModal();
  add(files);
  if (!rows.length) dialog.querySelector('[data-choose]').focus();

  auth.request('/api/folders', { token: tokenInput.value })
    .then((r) => (r.ok ? r.json() : []))
    .then((names) => dialog.querySelector('datalist').append(...names.map((value) => Object.assign(document.createElement('option'), { value }))))
    .catch(() => { /* typing a new folder still works */ });
}

/**
 * Files dragged anywhere onto the page open the dialog with them. Card previews don't
 * take pointer events, so a drop over one lands here too. Folders are refused: `sync`
 * is the way to bring one over.
 */
export function acceptDrops(open) {
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  let depth = 0;
  const off = () => { depth = 0; document.body.classList.remove('dropping'); };
  document.addEventListener('dragenter', (e) => { if (hasFiles(e) && !depth++) document.body.classList.add('dropping'); });
  document.addEventListener('dragleave', (e) => { if (hasFiles(e) && --depth <= 0) off(); });
  document.addEventListener('dragover', (e) => { if (hasFiles(e)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } });
  document.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    off();
    // A dropped folder arrives as a "file" that can't be read; its entry says what it is.
    const items = [...(e.dataTransfer.items || [])].filter((i) => i.kind === 'file');
    const isDir = (i) => !!i.webkitGetAsEntry?.()?.isDirectory;
    const folders = items.filter(isDir).length;
    open(items.length ? items.filter((i) => !isDir(i)).map((i) => i.getAsFile()).filter(Boolean) : [...e.dataTransfer.files]);
    if (folders) {
      const status = document.querySelector('.upload-dialog .upload-status');
      if (status) {
        status.textContent = `${folders === 1 ? 'A folder was' : `${folders} folders were`} left out: upload its files, or bring a whole folder over with html-server sync.`;
        status.classList.add('err');
      }
    }
  });
}
