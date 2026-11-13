// Shared remote operations for the CLI and MCP. File access stays in the CLI;
// permissions and lifecycle transitions remain owned by the server.
import { api, ClientError, SERVER } from './client.js';
const enc = encodeURIComponent;
export async function listTrash() {
  const pages = [];
  for (let offset = 0; ; offset += 500) {
    const batch = await api('GET', `/api/artifacts?state=trashed&limit=500&offset=${offset}`, { auth: 'required' });
    pages.push(...batch);
    if (batch.length < 500) return pages;
  }
}
export const restorePage = (name) => api('POST', `/api/artifacts/${enc(name)}/restore`, { auth: 'required' });
export async function sharePage(name, rotate = false) {
  const page = await api(rotate ? 'POST' : 'GET', `/api/artifacts/${enc(name)}${rotate ? '/share' : ''}`, { auth: 'required' });
  if (!page.share_url) throw new ClientError('only the owner can retrieve a share link');
  return { name: page.slug, share_url: SERVER + page.share_url };
}
export async function readPage(name, version) {
  if (version != null && (!/^\d+$/.test(String(version)) || !Number.isSafeInteger(Number(version)) || Number(version) < 1)) throw new ClientError('version must be a positive integer');
  const page = await api('GET', `/api/artifacts/${enc(name)}`);
  const n = version == null ? page.latest_version : Number(version);
  const source = await api('GET', `/api/artifacts/${enc(page.slug)}/versions/${n}`);
  return { name: page.slug, version: n, source };
}
export const listAssets = () => api('GET', '/api/assets', { auth: 'required' });
export const putAsset = (name, body) => api('PUT', `/api/assets/${enc(name)}`, { body, auth: 'required' });
export const deleteAsset = (name) => api('DELETE', `/api/assets/${enc(name)}`, { auth: 'required' });
export function resolveComment(id, reopen = false) {
  if (!/^\d+$/.test(String(id)) || !Number.isSafeInteger(Number(id)) || Number(id) < 1) throw new ClientError('comment id must be a positive integer');
  return api('POST', `/api/comments/${id}/resolve${reopen ? '?undo=1' : ''}`, { auth: 'required' });
}
