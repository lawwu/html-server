// html-server as an MCP server (Model Context Protocol), so Claude Desktop, Claude
// Code, Cursor and other MCP clients can publish and manage pages. Started by the
// client as `html-server mcp`; speaks JSON-RPC 2.0 over stdin/stdout, one message per
// line, and talks to the HTML Server the CLI is signed in to (credentials.json, or
// HTML_SERVER_URL / HTML_SERVER_TOKEN). Plain JSON-RPC: no MCP SDK needed.
//
// Safety default: pages published through MCP are private unless the call says
// public: true, so a model can't put something in a public gallery by accident.
import { SERVER, api } from './client.js';
import { VERSION } from './config.js';

const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05']; // newest first
const MAX_SOURCE_CHARS = 200_000; // get_page truncates past this, so one call can't flood the context

const enc = encodeURIComponent;
const pageArg = { type: 'string', description: 'The page name (its file name, e.g. "trip-plan.html"; ".html" is optional)' };

/** Each tool: JSON Schema for its arguments, and a handler returning text (or an object, sent as JSON). */
export const TOOLS = [
  {
    name: 'publish_page',
    title: 'Publish an HTML page',
    description: 'Upload a single-file HTML page, or a Markdown note (name ending in .md, content in `markdown`; a Jupyter notebook: .ipynb, its JSON in `notebook`; frontmatter title/tags/description, [[wikilinks]] to other pages, > [!note] callouts). If the name is new it creates the page; if it exists (and you may edit it) it adds a new version, keeping every old one. Returns the page URL. Pages are PRIVATE by default (only the owner and people with the share link can open them); set public: true to list it in the gallery. Add <meta name="description"> and <meta name="category"> to the HTML for a good gallery card, and use h2/h3 headings for a contents sidebar.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'File name to publish as, which becomes the URL: lowercase-with-dashes, e.g. "q3-report.html"' },
        html: { type: 'string', description: 'The complete, self-contained HTML document (for .html names)' },
        markdown: { type: 'string', description: 'The note\'s Markdown, including any frontmatter (for .md names)' },
        notebook: { type: 'string', description: 'A Jupyter notebook\'s JSON, as saved (for .ipynb names); its saved outputs are shown, nothing runs' },
        note: { type: 'string', description: 'One line on what changed in this version' },
        public: { type: 'boolean', description: 'List the page publicly (default false: private)' },
        base_version: { type: 'integer', description: 'The version you started from; the upload is refused if someone has added a newer one since' },
      },
      required: ['name'],
    },
    annotations: { destructiveHint: false, idempotentHint: false },
    async run({ name, html, markdown, notebook, note = '', public: isPublic = false, base_version: baseVersion }) {
      const q = new URLSearchParams();
      if (note) q.set('note', note);
      // A new page gets the requested visibility; an existing page keeps its own unless asked to go public.
      let exists = false;
      try { await api('GET', `/api/artifacts/${enc(name)}`, { auth: 'required' }); exists = true; } catch { /* new page */ }
      if (!exists || isPublic) q.set('visibility', isPublic ? 'public' : 'private');
      if (baseVersion != null) q.set('base', String(baseVersion));
      const content = notebook ?? markdown ?? html;
      if (typeof content !== 'string' || !content) throw new Error('give the page content as `html` (`markdown` for a .md note, `notebook` for an .ipynb)');
      const a = await api('PUT', `/api/artifacts/${enc(name)}?${q}`, { body: content, auth: 'required' });
      return {
        published: `v${a.latest_version} of ${a.slug}`,
        visibility: a.visibility,
        url: `${SERVER}${a.url}`,
        ...(a.visibility === 'private' ? { share_url: `${SERVER}${a.share_url}`, note: 'Private: send the share_url to let someone else open it.' } : {}),
        review_url: `${SERVER}/review/${enc(a.slug)}`,
      };
    },
  },
  {
    name: 'search_pages',
    title: 'Search pages',
    description: 'Search page titles, file names and text. Typo-tolerant; pages whose title contains the query rank first. Returns matches with highlighted snippets.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Words to search for' },
        tag: { type: 'string', description: 'Only pages with this tag' },
        limit: { type: 'integer', description: 'Most results to return (default 10, max 50)' },
      },
      required: ['query'],
    },
    annotations: { readOnlyHint: true },
    async run({ query, tag, limit = 10 }) {
      const q = new URLSearchParams({ q: query, limit: String(Math.min(Math.max(limit, 1), 50)) });
      if (tag) q.set('tag', tag);
      const r = await api('GET', `/api/search?${q}`);
      return { count: r.count, results: r.results.map(brief) };
    },
  },
  {
    name: 'list_pages',
    title: 'List pages',
    description: 'List pages, featured first, then newest. Optionally only those with a tag.',
    inputSchema: {
      type: 'object',
      properties: { tag: { type: 'string', description: 'Only pages with this tag' }, limit: { type: 'integer', description: 'Default 25, max 200' } },
    },
    annotations: { readOnlyHint: true },
    async run({ tag, limit = 25 }) {
      const q = new URLSearchParams({ limit: String(Math.min(Math.max(limit, 1), 200)) });
      if (tag) q.set('category', tag);
      return (await api('GET', `/api/artifacts?${q}`)).map(brief);
    },
  },
  {
    name: 'get_page',
    title: 'Read a page',
    description: 'Get a page\'s HTML source (latest version, or a given one) with its details and version list. Use it before editing a page, then publish_page with base_version.',
    inputSchema: { type: 'object', properties: { name: pageArg, version: { type: 'integer', description: 'Version number (default: latest)' } }, required: ['name'] },
    annotations: { readOnlyHint: true },
    async run({ name, version }) {
      const a = await api('GET', `/api/artifacts/${enc(name)}`);
      const n = version || a.latest_version;
      let html = await api('GET', `/api/artifacts/${enc(a.slug)}/versions/${n}`);
      const truncated = html.length > MAX_SOURCE_CHARS;
      if (truncated) html = html.slice(0, MAX_SOURCE_CHARS);
      return { ...brief(a), version: n, latest_version: a.latest_version, can_edit: a.can_edit, truncated, html };
    },
  },
  {
    name: 'page_history',
    title: 'Page history',
    description: 'Every version of a page: number, date, author and note.',
    inputSchema: { type: 'object', properties: { name: pageArg }, required: ['name'] },
    annotations: { readOnlyHint: true },
    async run({ name }) {
      const a = await api('GET', `/api/artifacts/${enc(name)}`);
      return {
        page: a.slug, title: a.title, owner: a.owner, history_url: `${SERVER}/history/${enc(a.slug)}`,
        versions: a.versions.map((v) => ({ version: v.n, uploaded: iso(v.created_at), author: v.author, note: v.note, bytes: v.size })),
      };
    },
  },
  {
    name: 'diff_versions',
    title: 'Compare versions',
    description: 'What changed between two versions of a page, as a unified diff of the visible text (or of the HTML source). Default: previous version vs latest.',
    inputSchema: {
      type: 'object',
      properties: { name: pageArg, from: { type: 'integer' }, to: { type: 'integer' }, source: { type: 'boolean', description: 'Diff the HTML source instead of visible text' } },
      required: ['name'],
    },
    annotations: { readOnlyHint: true },
    async run({ name, from, to, source = false }) {
      const q = new URLSearchParams();
      if (from) q.set('from', String(from));
      if (to) q.set('to', String(to));
      if (source) q.set('of', 'source');
      const diff = await api('GET', `/api/artifacts/${enc(name)}/diff${q.size ? `?${q}` : ''}`);
      return diff || 'No differences.';
    },
  },
  {
    name: 'restore_version',
    title: 'Restore a version',
    description: 'Make an old version current again. This adds a new version that copies it; nothing is deleted.',
    inputSchema: { type: 'object', properties: { name: pageArg, version: { type: 'integer' } }, required: ['name', 'version'] },
    annotations: { destructiveHint: false },
    async run({ name, version }) {
      const a = await api('POST', `/api/artifacts/${enc(name)}/versions/${version}/restore`, { auth: 'required' });
      return { restored: `v${a.latest_version} is now a copy of v${version}`, url: `${SERVER}${a.url}` };
    },
  },
  {
    name: 'list_comments',
    title: 'Read comments',
    description: 'Reviewers\' comments on a page, oldest first, with replies and whether each is resolved.',
    inputSchema: { type: 'object', properties: { name: pageArg, version: { type: 'integer', description: 'Only comments on this version' } }, required: ['name'] },
    annotations: { readOnlyHint: true },
    async run({ name, version }) {
      const list = await api('GET', `/api/artifacts/${enc(name)}/comments${version ? `?version=${version}` : ''}`);
      return list.map((c) => ({ id: c.id, version: c.version, reply_to: c.parent, author: c.author, at: iso(c.created_at), resolved: !!c.resolved_at, body: c.body }));
    },
  },
  {
    name: 'add_comment',
    title: 'Comment on a page',
    description: 'Add a comment to a page (latest version by default), or reply to a comment.',
    inputSchema: {
      type: 'object',
      properties: { name: pageArg, body: { type: 'string' }, version: { type: 'integer' }, reply_to: { type: 'integer', description: 'Comment id to reply to' } },
      required: ['name', 'body'],
    },
    async run({ name, body, version, reply_to: parent }) {
      const c = await api('POST', `/api/artifacts/${enc(name)}/comments`, { body: JSON.stringify({ body, version, parent }), auth: 'required', json: true });
      return { id: c.id, version: c.version, posted: true };
    },
  },
  {
    name: 'tag_pages',
    title: 'Tag pages',
    description: 'Add and/or remove tags on one or more pages at once. Reports the result for each page; pages you can\'t edit are skipped, not fatal.',
    inputSchema: {
      type: 'object',
      properties: {
        pages: { type: 'array', items: { type: 'string' }, description: 'Page names' },
        add: { type: 'array', items: { type: 'string' } },
        remove: { type: 'array', items: { type: 'string' } },
      },
      required: ['pages'],
    },
    async run({ pages, add = [], remove = [] }) {
      return (await api('POST', '/api/tags', { body: JSON.stringify({ pages, add, remove }), auth: 'required', json: true })).results;
    },
  },
  {
    name: 'feature_page',
    title: 'Feature or unfeature a page',
    description: 'Pin a page to the Featured section at the top of the home page, or unpin it. Needs the page\'s owner or an admin.',
    inputSchema: { type: 'object', properties: { name: pageArg, featured: { type: 'boolean' } }, required: ['name', 'featured'] },
    async run({ name, featured }) {
      const a = await api(featured ? 'POST' : 'DELETE', `/api/artifacts/${enc(name)}/pin`, { auth: 'required' });
      return { page: a.slug, featured: a.pinned };
    },
  },
  {
    name: 'server_info',
    title: 'Which server, as whom',
    description: 'The HTML Server this connects to, the signed-in user, and the tags in use.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true },
    async run() {
      const me = await api('GET', '/api/me', { auth: 'required' }).catch(() => null);
      const tags = await api('GET', '/api/tags').catch(() => []);
      return { server: SERVER, signed_in_as: me ? `${me.name}${me.is_admin ? ' (admin)' : ''}` : null, client_version: VERSION, tags };
    },
  },
];

const iso = (t) => new Date(t * 1000).toISOString();
function brief(a) {
  return {
    name: a.slug, title: a.title, url: `${SERVER}${a.url}`, owner: a.owner, tags: a.tags, version: a.latest_version,
    visibility: a.visibility, featured: a.pinned, updated: iso(a.updated_at),
    ...(a.description ? { description: a.description } : {}),
    ...(a.snippet ? { snippet: a.snippet, title_highlight: a.title_highlight } : {}),
  };
}

/** Handle one JSON-RPC request; returns the response object, or null for a notification. */
export async function handle(msg) {
  const reply = (result) => ({ jsonrpc: '2.0', id: msg.id, result });
  const error = (code, message) => ({ jsonrpc: '2.0', id: msg.id ?? null, error: { code, message } });
  if (msg.id === undefined) return null; // notifications (initialized, cancelled, …) need no answer
  switch (msg.method) {
    case 'initialize': {
      const asked = msg.params?.protocolVersion;
      return reply({
        protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'html-server', title: 'HTML Server', version: VERSION },
        instructions: `Publish and manage single-file HTML pages on ${SERVER}. Pages are versioned (nothing is overwritten), `
          + 'searchable, and private unless published with public: true. Before changing an existing page, read it with '
          + 'get_page and pass its version as base_version to publish_page.',
      });
    }
    case 'ping': return reply({});
    case 'tools/list':
      return reply({ tools: TOOLS.map(({ name, title, description, inputSchema, annotations }) => ({ name, title, description, inputSchema, ...(annotations ? { annotations } : {}) })) });
    case 'tools/call': {
      const tool = TOOLS.find((t) => t.name === msg.params?.name);
      if (!tool) return error(-32602, `unknown tool: ${msg.params?.name}`);
      try {
        const out = await tool.run(msg.params.arguments ?? {});
        const text = typeof out === 'string' ? out : JSON.stringify(out, null, 2);
        return reply({ content: [{ type: 'text', text }], ...(typeof out === 'object' && !Array.isArray(out) ? { structuredContent: out } : {}) });
      } catch (e) {
        // Tool failures go back to the model as a result it can read and act on, not a protocol error.
        return reply({ content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true });
      }
    }
    default: return error(-32601, `method not found: ${msg.method}`);
  }
}

/** Serve over stdio until the client closes stdin. Logs go to stderr; stdout carries only protocol. */
export function serveStdio() {
  const rl = process.getBuiltinModule('node:readline').createInterface({ input: process.stdin });
  const queue = [];
  let busy = false;
  const pump = async () => {
    if (busy) return;
    busy = true;
    while (queue.length) {
      const line = queue.shift();
      let msg;
      try { msg = JSON.parse(line); } catch {
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }) + '\n');
        continue;
      }
      const res = await handle(msg);
      if (res) process.stdout.write(JSON.stringify(res) + '\n');
    }
    busy = false;
  };
  rl.on('line', (line) => { if (line.trim()) { queue.push(line); pump(); } });
  // The app closed the connection: finish what's queued, then exit.
  rl.on('close', async () => { await pump(); while (busy) await new Promise((r) => setTimeout(r, 10)); process.exit(0); });
  process.stderr.write(`html-server MCP ${VERSION}: serving ${SERVER} over stdio\n`);
}
