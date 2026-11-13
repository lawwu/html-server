// HTTP adapter for FolderSync. Missing pages and pagination are protocol details;
// the workflow sees complete source inventories and null for an absent page.
export function syncRemote(api) {
  const enc = encodeURIComponent;
  return {
    async listSourcePages(source) {
      const pages = [];
      for (let offset = 0; ; offset += 500) {
        const batch = await api('GET', `/api/artifacts?source=${enc(source)}&limit=500&offset=${offset}`, { auth: 'required' });
        pages.push(...batch);
        if (batch.length < 500) return pages;
      }
    },
    listAssets: () => api('GET', '/api/assets', { auth: 'required' }),
    async findPage(name, { required = false } = {}) {
      try { return await api('GET', `/api/artifacts/${enc(name)}`, { auth: required ? 'required' : 'optional' }); }
      catch (e) { if (e.message === 'no such artifact') return null; throw e; }
    },
    putAsset: (name, body) => api('PUT', `/api/assets/${enc(name)}`, { body, auth: 'required' }),
    movePage: (from, to) => api('POST', '/api/moves', { body: JSON.stringify({ moves: [{ from, to }] }), auth: 'required', json: true }),
    putPage: (name, body, metadata) => api('PUT', `/api/artifacts/${enc(name)}?${new URLSearchParams(metadata)}`, { body, auth: 'required' }),
    trashPage: (name) => api('DELETE', `/api/artifacts/${enc(name)}`, { auth: 'required' }),
  };
}
