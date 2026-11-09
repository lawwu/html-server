// A fake OIDC provider for the tests, doing what Entra, Okta or Keycloak do: discovery, the
// authorize redirect (signing in whoever `st.next` is, without asking), the code exchange
// with PKCE and client authentication, an RS256 ID token, its keys, and RP-initiated sign-out.
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { createServer } from 'node:http';

const b64 = (x) => Buffer.from(typeof x === 'string' ? x : JSON.stringify(x)).toString('base64url');

/** Start one on a free port. Returns { issuer, st, close }; set st.next to who signs in next. */
export async function fakeProvider({ clientId = 'html-server', clientSecret = 'shh' } = {}) {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' };
  const st = { next: null, codes: new Map(), authorize: null };
  let issuer;
  const srv = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const url = new URL(req.url, issuer);
    const json = (status, obj) => res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(obj));
    if (url.pathname === '/.well-known/openid-configuration') {
      return json(200, {
        issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks`,
        end_session_endpoint: `${issuer}/logout`, response_types_supported: ['code'], subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'], code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'], scopes_supported: ['openid', 'profile', 'email'],
      });
    }
    if (url.pathname === '/jwks') return json(200, { keys: [jwk] });
    if (url.pathname === '/authorize') {
      const p = Object.fromEntries(url.searchParams);
      st.authorize = p;
      const code = `code-${Math.random().toString(36).slice(2)}`;
      st.codes.set(code, { ...p, who: st.next });
      return res.writeHead(302, { Location: `${p.redirect_uri}?code=${code}&state=${encodeURIComponent(p.state)}` }).end();
    }
    if (url.pathname === '/logout') return res.writeHead(302, { Location: url.searchParams.get('post_logout_redirect_uri') || '/' }).end();
    if (url.pathname === '/token' && req.method === 'POST') {
      const p = Object.fromEntries(new URLSearchParams(body));
      const basic = (req.headers.authorization || '').startsWith('Basic ') ? Buffer.from(req.headers.authorization.slice(6), 'base64').toString() : '';
      const [id, secret] = basic ? basic.split(':').map(decodeURIComponent) : [p.client_id, p.client_secret];
      if (id !== clientId || secret !== clientSecret) return json(401, { error: 'invalid_client' });
      const c = st.codes.get(p.code);
      st.codes.delete(p.code);
      if (!c || c.redirect_uri !== p.redirect_uri) return json(400, { error: 'invalid_grant' });
      if (createHash('sha256').update(p.code_verifier || '').digest('base64url') !== c.code_challenge) return json(400, { error: 'invalid_grant', error_description: 'PKCE' });
      const now = Math.floor(Date.now() / 1000);
      const head = b64({ alg: 'RS256', kid: 'k1', typ: 'JWT' });
      const payload = b64({ iss: issuer, aud: clientId, iat: now, exp: now + 300, nonce: c.nonce, ...c.who });
      const sig = sign('sha256', Buffer.from(`${head}.${payload}`), privateKey).toString('base64url');
      return json(200, { access_token: 'at', token_type: 'Bearer', expires_in: 300, id_token: `${head}.${payload}.${sig}` });
    }
    json(404, {});
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  issuer = `http://127.0.0.1:${srv.address().port}`;
  return { issuer, st, close: () => new Promise((r) => srv.close(r)) };
}
