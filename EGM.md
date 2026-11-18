# HTML Server architecture

## System overview

HTML Server publishes HTML pages, Markdown notes and Jupyter notebooks. When a client publishes a page, the HTTP handler passes its source to `Store`, which appends a version. When a reader opens that page, `PageDelivery` chooses how to show it. This split lets rendering change while the original source remains available to download or restore. [Server and clients](./src/EGM.md)

## Component boundaries

| When changing… | Start here |
| --- | --- |
| An HTTP route, CLI command, MCP tool, storage rule or page renderer | [Server and clients](./src/EGM.md) |
| Gallery uploads, sign-in, review controls or communication with an embedded page | [Browser interactions](./public/EGM.md) |
| Worker requests, upload limits or Durable Object storage | [Cloudflare runtime](./cloudflare/EGM.md) |
| The static documentation site or checks on a built Docker image | [Documentation build and Docker checks](./scripts/EGM.md) |

The bundled gallery is also an input to the server and documentation build. `examples()` reads the HTML files and caches their metadata and source bytes together. Restart the development server to pick up edits to an example. [Gallery loader](./src/examples.js)

## Global invariants

- **A page keeps its identity across versions and moves.** An edit appends a version. A move preserves the history. A distinct old address redirects to the current one, while a case-only rename that the database treats as equivalent resolves through ordinary lookup. [Store](./src/store.js) · [state machines](./STATE-MACHINES.md)
- **Page access and deployment access are separate checks.** A share link grants access to one active page and its authorized assets. On a deployment with SSO, opening the shared page also requires sign-in or a valid token. The HTTP layer gives the surrounding site access to the viewer's identity and serves published content under its sandbox policy. [Page delivery](./src/page-delivery.js) · [HTTP handler](./src/server.js) · [glossary](./GLOSSARY.md)
- **Both deployments use the same request handler.** Node supplies an HTTP server and a SQLite or PostgreSQL store. Cloudflare adapts Fetch and Durable Object SQLite to the interfaces that `handleRequest` and `Store` expect. [Node entry point](./src/cli.js) · [Worker entry point](./cloudflare/worker.js)

## Global side effects

Publishing changes the deployment's database, including version history and derived search and link data. CLI and MCP clients send requests to the configured server. Building the documentation site writes local files using a separate in-memory store. [Store](./src/store.js) · [client](./src/client.js) · [site build](./scripts/build-site.js)

## System verification

From the repository root, run `npm test` for the Node suite. To exercise PostgreSQL, set `TEST_DATABASE_URL` to a database where the test user can create and drop isolated schemas. CI also sets `REQUIRE_POSTGRES=1` so a missing URL fails that job. `npm run test:browser` runs the separate Chromium checks. [Test fixture](./test/fixture.js) · [development checks](./README.md#development-checks)

## Using this map for a design review

For a change such as adding a new publish option, the Elephant uses the relevant component contracts and source to draft the intended behavior. The draft should say which clients expose the option, what happens to existing pages, and how a reviewer could verify the result. Give a fresh Goldfish reviewer the draft and its referenced files, without the planning conversation. Resolve the reviewer's findings and approve the design before implementation. [Elephant & Goldfish workflow](https://github.com/google/elephant-goldfish-model)
