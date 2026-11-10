// Single sign-on through an OIDC provider (Microsoft Entra, Okta, Google Workspace,
// Keycloak…), as rubiss-projects/agile-tools does it: the authorization code flow with PKCE,
// state and nonce, the provider found by discovery, and its ID token checked by openid-client
// (signature, issuer, audience, expiry, nonce). Nothing of the provider's is kept: the
// server reads who signed in, then runs its own session (a cookie and a row in `sessions`).
// The settings are config.js setSso; README: Single sign-on.
import { Buffer } from 'node:buffer';
import * as oidc from 'openid-client';
import { sso } from './config.js';

const LOGIN_COOKIE = 'html_server_oidc'; // the sign-in under way: state, PKCE verifier, nonce, where to go after
export const SESSION_COOKIE = 'html_server_session';
const LOGIN_MINUTES = 10;

let discovered = null; // { key, config }: the provider's metadata, fetched once per settings

async function configuration(s) {
  const key = `${s.issuer}\n${s.clientId}`;
  if (discovered?.key !== key) {
    const config = await oidc.discovery(new URL(s.issuer), s.clientId, s.clientSecret, undefined,
      s.allowInsecureHttp ? { execute: [oidc.allowInsecureRequests] } : undefined);
    discovered = { key, config };
  }
  return discovered.config;
}

/** Forget the provider's metadata (tests point the same settings at a fresh fake provider). */
export const forgetProvider = () => { discovered = null; };

/** Where to send the browser back to: the setting, or this server's callback as the browser reached it. */
const redirectUri = (s, origin) => s.redirectUri || `${origin}/api/oidc/callback`;

/** Only a path on this server: never another site (an open redirect), nor the sign-in's own addresses. */
export function safeNext(next) {
  const v = String(next ?? '');
  if (!v.startsWith('/') || v.startsWith('//') || v.startsWith('/\\') || /[\u0000-\u001f]/.test(v) || v.startsWith('/api/oidc/')) return '/';
  return v.slice(0, 2000);
}

const cookie = (name, value, { maxAge, path = '/', secure }) =>
  `${name}=${value}; Path=${path}; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;

/** Start signing in: the provider's sign-in address, and the cookie that holds this sign-in's secrets. */
export async function startLogin(origin, next) {
  const s = sso();
  const config = await configuration(s);
  const verifier = oidc.randomPKCECodeVerifier();
  const state = oidc.randomState(), nonce = oidc.randomNonce();
  const url = oidc.buildAuthorizationUrl(config, {
    redirect_uri: redirectUri(s, origin), response_type: 'code', scope: s.scopes, state, nonce,
    code_challenge: await oidc.calculatePKCECodeChallenge(verifier), code_challenge_method: 'S256',
  });
  const value = Buffer.from(JSON.stringify({ state, verifier, nonce, next: safeNext(next) })).toString('base64url');
  return { url: url.href, cookie: cookie(LOGIN_COOKIE, value, { maxAge: LOGIN_MINUTES * 60, path: '/api/oidc', secure: origin.startsWith('https:') }) };
}

/**
 * Back from the provider: check the answer against this browser's sign-in (state, PKCE, nonce)
 * and the ID token, and say who signed in: { issuer, sub, email, emailVerified, username,
 * admin, next }. Throws { status: 400 } when the sign-in didn't start in this browser.
 */
export async function finishLogin(origin, callbackUrl, cookieHeader) {
  const s = sso();
  const raw = String(cookieHeader || '').match(new RegExp(`(?:^|;\\s*)${LOGIN_COOKIE}=([\\w-]+)`))?.[1];
  let started = null;
  try { started = raw && JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')); } catch { /* tampered: as if missing */ }
  if (!started?.state || !started.verifier || !started.nonce) throw Object.assign(new Error("this sign-in didn't start in this browser"), { status: 400 });
  const config = await configuration(s);
  // The token request repeats the redirect address the provider was given, taken from this URL.
  const current = new URL(redirectUri(s, origin));
  current.search = new URL(callbackUrl).search;
  const tokens = await oidc.authorizationCodeGrant(config, current, {
    pkceCodeVerifier: started.verifier, expectedState: started.state, expectedNonce: started.nonce, idTokenExpected: true,
  });
  const claims = tokens.claims();
  const issuer = claims.iss;
  const sub = claims.sub;
  if (!issuer || !sub) throw Object.assign(new Error("the provider didn't say who signed in"), { status: 502 });
  const email = typeof claims.email === 'string' ? claims.email : null;
  const values = (v) => (Array.isArray(v) ? v : v == null ? [] : [v]).map(String);
  // An email the provider says isn't verified (email_verified: false) never makes an admin:
  // on some providers people choose their own. Entra sends no such claim; prefer a role there.
  const admin = (email && claims.email_verified !== false && s.adminEmails.includes(email.toLowerCase()))
    || (s.adminClaim && values(claims[s.adminClaim]).some((v) => s.adminClaimValues.includes(v)));
  return {
    issuer, sub, email, emailVerified: claims.email_verified, admin: !!admin, next: started.next,
    username: [claims.preferred_username, email, claims.name].find((v) => typeof v === 'string' && v) || '',
  };
}

/** Clear the sign-in cookie (after the callback, whatever happened). */
export const clearLoginCookie = (secure) => cookie(LOGIN_COOKIE, '', { maxAge: 0, path: '/api/oidc', secure });

export const sessionCookie = (id, hours, secure) => cookie(SESSION_COOKIE, id, { maxAge: Math.round(hours * 3600), secure });
export const clearSessionCookie = (secure) => cookie(SESSION_COOKIE, '', { maxAge: 0, secure });

/** Where to send someone signing out: the provider's own sign-out (RP-initiated logout), if it has one, then back here. */
export async function logoutUrl(origin) {
  const s = sso();
  const back = s.postLogoutRedirectUri || `${origin}/`;
  try {
    const config = await configuration(s);
    if (config.serverMetadata().end_session_endpoint) {
      return oidc.buildEndSessionUrl(config, { client_id: s.clientId, post_logout_redirect_uri: back }).href;
    }
  } catch { /* the provider is unreachable: signed out here all the same */ }
  return back;
}
