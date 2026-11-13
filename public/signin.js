// Sign-in for trusted site pages. Callers never choose between a browser session
// and a saved token, or depend on the top bar having cleared old credentials first.
const TOKEN = 'artifact_token', USER = 'artifact_user';

export function createSignIn({ session = '', storage, fetch: send, leave = () => {} }) {
  let memory = '', volatile = false, pending = null;
  const listeners = new Set();
  const read = (key, fallback = '') => { try { return storage.getItem(key) || ''; } catch { return fallback; } };
  const remove = (key) => { try { storage.removeItem(key); } catch { /* storage unavailable */ } };
  const token = () => session ? '' : volatile ? memory : read(TOKEN, memory);
  const notify = () => listeners.forEach((fn) => fn());
  if (session) { remove(TOKEN); remove(USER); }

  const auth = {
    get session() { return session; },
    get token() { return token(); },
    get signedIn() { return !!session || !!token(); },
    save(value) {
      if (session) return true; // a pasted or obsolete token never overrides SSO
      const next = String(value || '').trim(), changed = next !== token();
      memory = next;
      try { storage.setItem(TOKEN, memory); volatile = false; } catch { volatile = true; }
      if (changed) { remove(USER); pending = null; notify(); }
      return !volatile;
    },
    signOut() {
      memory = ''; volatile = true; pending = null;
      remove(TOKEN); remove(USER);
      leave(!!session);
    },
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    request(path, { token: candidate, ...options } = {}) {
      const headers = new Headers(options.headers);
      headers.delete('Authorization');
      const credential = session ? '' : candidate === undefined ? token() : String(candidate).trim();
      if (credential) headers.set('Authorization', `Bearer ${credential}`);
      return send(path, { ...options, headers });
    },
    async identity() {
      if (session) return { name: session };
      const current = token();
      if (!current) return null;
      const tail = current.slice(-8);
      try {
        const saved = JSON.parse(read(USER));
        if (saved?.tail === tail && saved.name) return { name: saved.name };
      } catch { /* no cached name */ }
      if (pending?.token === current) return pending.promise;
      const promise = (async () => {
        const r = await auth.request('/api/me');
        if (!r.ok) throw Object.assign(new Error(r.statusText || 'Sign-in failed'), { status: r.status });
        const me = await r.json();
        // A response for an earlier token must not poison the next token's cache.
        if (token() === current) try { storage.setItem(USER, JSON.stringify({ tail, name: me.name })); } catch { /* this visit only */ }
        return me;
      })();
      pending = { token: current, promise };
      try { return await promise; } finally { if (pending?.promise === promise) pending = null; }
    },
  };
  return auth;
}

let browser;
export function browserSignIn() {
  return browser ??= createSignIn({
    session: document.body.dataset.ssoUser || '',
    // Getting localStorage itself may throw; defer access into the guarded methods.
    storage: {
      getItem: (key) => localStorage.getItem(key),
      setItem: (key, value) => localStorage.setItem(key, value),
      removeItem: (key) => localStorage.removeItem(key),
    },
    fetch: (...args) => fetch(...args),
    leave: (session) => {
      if (!session) return location.reload();
      const form = document.createElement('form');
      form.method = 'post'; form.action = '/api/oidc/logout';
      document.body.append(form); form.submit();
    },
  });
}
