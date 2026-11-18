# Documentation build and Docker checks

## Interface

| Entry point from the repository root | Result |
| --- | --- |
| `npm run site` or `node scripts/build-site.js DIR` | `buildSite(out)` renders the README, changelog, live documentation, about page and bundled gallery through `handleRequest` using an in-memory store. It writes a static site to `_site/` or the supplied directory. [build-site.js](./build-site.js) |
| `scripts/docker-smoke.sh IMAGE [PLATFORM]` | Exercises an already-built image with SQLite and a separate PostgreSQL 16 container. Checks include publishing and searching, installing the CLI from the server, and preserving SQLite data across a restart. [docker-smoke.sh](./docker-smoke.sh) |

## Invariants

- `prepare` accepts a new or empty output directory. A nonempty directory must contain the previous build's `.html-server-site` marker, in which case **all entries in it are removed** before rebuilding. [build-site.js](./build-site.js)
- `linker` rewrites server URLs for hosting under a subpath. `checkLinks` checks static HTML attributes, CSS URLs, and embedded graph and preview data against the output files and HTML anchors. URLs constructed at runtime by example scripts fall outside that check. [build-site.js](./build-site.js)
- The export writes response bodies to files. The live server's sandbox headers are lost in that conversion, so the GitHub Pages build uses repository-maintained notes and examples. [build-site.js](./build-site.js) · [docs site](../README.md#the-docs-site)
- The smoke test reads the expected version from the checkout's `package.json`. It waits for container health and checks that the service comes back with the same data after Docker restarts the SQLite container. [docker-smoke.sh](./docker-smoke.sh)

## Side Effects

`buildSite` switches the page templates into static mode for the whole process while rendering. Running it as a separate command keeps that setting isolated from a live server or another build. It writes rendered pages, referenced assets and font licences into the output directory. [build-site.js](./build-site.js) · [page templates](../src/pages.js)

The image check creates temporary containers, a named volume and a private Docker network. Its exit trap removes those resources. [docker-smoke.sh](./docker-smoke.sh)

## Verification

Run `node --test test/site.test.js` to exercise the real site build in a temporary directory. To check a locally built image, run `docker build -t html-server:dev .` followed by `scripts/docker-smoke.sh html-server:dev`. [Site tests](../test/site.test.js) · [Docker build](../Dockerfile)
