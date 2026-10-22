// HTML Server on Cloudflare: a Worker that hands every request to one Durable Object,
// which holds the whole database in its built-in SQLite and runs the same request
// handler as `html-server serve` (src/server.js). Deploy with `html-server deploy
// cloudflare` (or `npx wrangler deploy`); see README "Deploy to Cloudflare".
//
// One Durable Object, so every request sees one consistent database, like the single
// Node process. Its SQLite holds at most 2 MB per row, so uploads are capped below that.
import './files.generated.js'; // first: the package's own files, before anything reads them
import { Buffer } from 'node:buffer';
import { Readable } from 'node:stream';
import { DurableObject } from 'cloudflare:workers';
import { setUploadLimits } from '../src/config.js';
import { handleRequest } from '../src/server.js';
import { Store } from '../src/store.js';
import { DurableSqlite } from './sqlite.js';

const ROW_LIMIT = Math.floor(1.9 * 1024 * 1024); // under the 2 MB row limit, leaving room for the row's other columns
setUploadLimits({ body: ROW_LIMIT, asset: ROW_LIMIT });

export class HtmlServer extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.store = new Store(new DurableSqlite(ctx.storage));
    // The first admin: on a new deployment, the user named ADMIN_NAME (default "admin")
    // gets the token in the ADMIN_TOKEN secret (`html-server deploy cloudflare` sets both).
    if (env.ADMIN_TOKEN && !this.store.one('SELECT 1 AS x FROM users LIMIT 1')) {
      this.store.createUser(env.ADMIN_NAME || 'admin', true, { token: env.ADMIN_TOKEN });
    }
  }

  async fetch(request) {
    const url = new URL(request.url);
    const body = request.body ? Buffer.from(await request.arrayBuffer()) : Buffer.alloc(0);
    const req = Readable.from(body.length ? [body] : []);
    Object.assign(req, {
      method: request.method,
      url: url.pathname + url.search,
      headers: Object.fromEntries(request.headers),
      socket: { remoteAddress: request.headers.get('cf-connecting-ip') || '' },
    });
    delete req.headers['accept-encoding']; // Cloudflare compresses responses itself
    return new Promise((resolve) => {
      let status = 200, headers = {};
      const res = {
        headersSent: false,
        writeHead(s, h = {}) { status = s; headers = h; this.headersSent = true; return this; },
        end(chunk) {
          this.headersSent = true;
          const h = new Headers();
          for (const [k, v] of Object.entries(headers)) if (k.toLowerCase() !== 'content-length') h.set(k, String(v));
          resolve(new Response(status === 204 || status === 304 ? null : chunk ?? null, { status, headers: h }));
        },
      };
      handleRequest(this.store, req, res).catch((e) => {
        console.error(e);
        if (!res.headersSent) resolve(Response.json({ error: 'internal error' }, { status: 500 }));
      });
    });
  }
}

export default {
  fetch(request, env) {
    return env.HTML_SERVER.get(env.HTML_SERVER.idFromName('main')).fetch(request);
  },
};
