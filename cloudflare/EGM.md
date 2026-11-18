# Cloudflare runtime

## Interface

The Worker's default `fetch` forwards every request to the `HTML_SERVER` Durable Object named `main`. Its `HtmlServer.fetch` adapts a Fetch request to the shared `handleRequest` interface, then translates the response back. The binding and SQLite migration live in the Wrangler configuration. [worker.js](./worker.js) · [wrangler.toml](../wrangler.toml) · [server contract](../src/EGM.md)

`DurableSqlite` supplies the synchronous database operations used by `Store`. Prepared statements expose `get`, `all` and `run`. Transactions use the platform's `transactionSync`. [sqlite.js](./sqlite.js)

## Invariants

- **Bounded uploads.** `ROW_LIMIT` sets the page body and asset limits below the Durable Object's row limit. `readBody` checks a declared length before reading, counts bytes as they arrive, and cancels a stream that crosses the limit. The caller returns HTTP 413 on overflow. [body.js](./body.js) · [worker.js](./worker.js)
- **Compatible results.** The database adapter converts BLOB results to Buffers. Its `changes` count includes index writes, so callers can use it to distinguish zero writes from some writes. The HTTP adapter preserves repeated response headers, including cookies, and emits an empty body for 204 and 304. [sqlite.js](./sqlite.js) · [worker.js](./worker.js)

## Side Effects

Wrangler's build command packs `package.json` and files from `public/` and `gallery/` into `cloudflare/files.generated.js`. It skips dot paths and text files ending in `.txt`. The Worker loads that generated module before the application's file readers run. [bundle-files.js](./bundle-files.js) · [files.js](../src/files.js)

The Durable Object opens persistent SQLite storage. On an empty users table, it creates the first administrator if `ADMIN_TOKEN` is configured, using `ADMIN_NAME` or the default name `admin`. [worker.js](./worker.js)

## Verification

From the repository root, run `node --test test/cloudflare.test.js` for the database adapter and body limit. The test uses a SQLite-backed stand-in for Durable Object storage. `npm run cf:dev` starts the Worker locally in Wrangler. [Adapter tests](../test/cloudflare.test.js) · [package scripts](../package.json)
