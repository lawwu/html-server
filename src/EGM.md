# Server and clients

## Interface

Follow a publish request across three boundaries. The client chooses the address and sends the source, the HTTP handler authenticates the caller and parses the request, and the store commits a version. Opening the resulting URL takes a separate path through page delivery.

| Boundary | Where to make a change |
| --- | --- |
| Command line | `main(argv)` dispatches commands. Server administration uses `openStore`. Remote commands use `api`, which selects the server and credentials. `usage` supplies both CLI help and the live docs. [cli.js](./cli.js) · [client.js](./client.js) · [usage.js](./usage.js) |
| MCP | `serveStdio` accepts newline-delimited JSON-RPC. `handle` validates tool arguments against `TOOLS` and dispatches the call. Page management operations shared with the CLI live in [manage.js](./manage.js). [mcp.js](./mcp.js) |
| HTTP | `ROUTES` maps a method and path pattern to a handler and feeds the API reference. `makeServer` wraps `handleRequest(store, req, res)` for Node. The Worker calls the same handler. [server.js](./server.js) |
| Persistence and search | `Store` takes a SQLite filename or a synchronous database adapter. It owns authorization for page mutations, version history, links, search indexes and asset grants. `PostgresDatabase` translates the store's SQL and supplies its own search implementation. [store.js](./store.js) · [postgres.js](./postgres.js) |
| Display | `PageDelivery` returns a site page, a sandboxed artifact or a redirect to `Ctx.deliver`. It chooses the version and resolves links and assets. The page templates compose HTML, and the Markdown and notebook renderers turn saved source into content. [page-delivery.js](./page-delivery.js) · [pages.js](./pages.js) · [markdown.js](./markdown.js) · [notebook.js](./notebook.js) |
| Folder sync | `FolderSync.run` discovers files and reconciles them against a remote inventory. `syncRemote(api)` owns the HTTP calls and pagination. [sync.js](./sync.js) · [sync-remote.js](./sync-remote.js) |

## Invariants

- **Page identity survives a move.** `Store.movePages` moves a batch atomically and reserves the old address when the database considers it distinct from the destination. Restoring an earlier version appends a copy. Restoring from trash changes lifecycle state and preserves the version count. [store.js](./store.js) · [lifecycle.js](./lifecycle.js)
- **Publishing defaults depend on the client.** On creation, MCP's `publish_page` defaults to private. A plain HTTP upload, CLI `put` or browser upload defaults to public. Callers can supply a base version to protect an edit. If the existing page has advanced, `Store.putVersion` rejects the stale write with HTTP 409. [mcp.js](./mcp.js) · [cli.js](./cli.js) · [browser upload](../public/upload.js) · [store.js](./store.js) · [config.js](./config.js)
- **A share link has page scope.** On an SSO deployment, the HTTP handler checks sign-in or token credentials before `renderShare` can open the page. The store requires a matching active page. Making a public page private or rotating its share invalidates the old link. `canReadAsset` checks ownership and page grants when resolving an asset. Sandboxed note navigation uses an anonymous view of the collection even when its reader is signed in. [server.js](./server.js) · [store.js](./store.js) · [page-delivery.js](./page-delivery.js)
- **A dry run still reads the server.** `FolderSync.run` uses source paths to recognize previously synced pages after a move. It skips remote mutations in dry-run mode and starts the prune pass only when requested and the preceding file pass recorded zero failures. [sync.js](./sync.js)

## Side Effects

Opening a `Store` creates or upgrades database objects and rebuilds derived indexes when needed. Publishing writes the version and updates search and link data in a transaction. Qualifying page views and API calls can also write to the database. [store.js](./store.js) · [server.js](./server.js)

The CLI can save credentials locally, read a sync folder, create backups or invoke Wrangler for a deployment. MCP tool calls use the configured server over HTTP. The SQLite-to-PostgreSQL importer previews the transfer by default and copies rows when invoked with `--apply`. [client.js](./client.js) · [cli.js](./cli.js) · [deploy.js](./deploy.js) · [import-sqlite.js](./import-sqlite.js)

## Verification

Run `npm test` from the repository root. For a publish or restore change, follow it through the [HTTP tests](../test/server.test.js), [CLI tests](../test/cli.test.js) and [MCP tests](../test/mcp.test.js). Rendering and sync have their own [page delivery](../test/page-delivery.test.js) and [folder sync](../test/sync.test.js) tests.
