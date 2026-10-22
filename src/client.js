// Talking to a running server, for the CLI's client commands and the MCP server:
// which server, as whom, and one request helper. Env vars win, then the login saved
// in credentials.json, then the local default.
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { CREDENTIALS_FILE, FALLBACK_URL, HOME_DIR } from './config.js';

export function readCredentials() {
  try { return JSON.parse(readFileSync(CREDENTIALS_FILE, 'utf8')); } catch { return {}; }
}
export const creds = readCredentials();
export const SERVER = (process.env.HTML_SERVER_URL || creds.url || FALLBACK_URL).replace(/\/+$/, '');
export const token = () => (process.env.HTML_SERVER_TOKEN || creds.token || '').trim();

export function saveCredentials(url, tok) {
  mkdirSync(HOME_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(CREDENTIALS_FILE, JSON.stringify({ url, token: tok }, null, 2) + '\n', { mode: 0o600 });
  chmodSync(CREDENTIALS_FILE, 0o600);
}

/** A mistake the user can fix (bad input, not signed in, server unreachable): one line, no stack. */
export class ClientError extends Error {}

/**
 * Call the API. Returns parsed JSON, or the text of a non-JSON response.
 * `auth: 'required'` fails early, with a hint, when there's no token.
 */
export async function api(method, path, { body, auth = 'optional', json = false } = {}) {
  const t = token();
  if (auth === 'required' && !t) throw new ClientError('not signed in: run `html-server login` (or set HTML_SERVER_TOKEN)');
  let r;
  try {
    r = await fetch(SERVER + path, {
      method, body, headers: { ...(t ? { Authorization: `Bearer ${t}` } : {}), ...(json ? { 'Content-Type': 'application/json' } : {}) },
    });
  } catch {
    throw new ClientError(`can't reach ${SERVER} (is the server running?)`);
  }
  const text = await r.text();
  const data = r.headers.get('content-type')?.includes('json') ? JSON.parse(text) : null;
  if (!r.ok) throw new ClientError(data?.error || `HTTP ${r.status}`);
  return data ?? text;
}
