# Changelog

Versions follow [semantic versioning](https://semver.org). While the version is
`0.x`, commands and the API may still change between minor versions; `1.0.0` will
mark them as stable. The database format is migrated in place on startup, and a
change that couldn't be migrated would be a major version.

## Unreleased

## 0.3.0 (2026-10-20)

- **Open editing:** `html-server config editing open` lets any signed-in user upload
  new versions of, or restore old versions of, public pages. Only the owner can still
  trash, delete, change visibility or edit private pages. Off by default.
- **Version authors:** every version records who uploaded it, shown in the history,
  the review page and `html-server history`. On upgrade, existing versions are
  credited to their page's owner.
- **History page** at `/history/<name>`: every version with its date, author, note
  and size, links to view each one and its changes, and a picker to compare any two
  (visible text or HTML source). Linked from gallery cards and the review page.
- **Overwrite guard:** `put --base N` (or `?base=N` / `X-Base`) refuses the upload if
  someone added a version after vN.
- `html-server history NAME` lists a page's versions.
- **`html-server backup [PATH] [--keep N]`:** a checked snapshot of the database, safe
  while the server is running, written to `~/.html-server/backups/` by default and
  readable only by you. `--keep N` prunes older timestamped backups. The README
  now has steps for updating a deployment.

## 0.2.0 (2026-10-20)

- **`/pages/{slug}` is the canonical page URL**, so this server can replace a service
  that already served pages there without breaking links. `.html` is optional
  (`/pages/showstopper-timeline` finds `showstopper-timeline.html`), `?v=n` works, and
  the gallery, the review page, `open` and the API's `url` field all use it. The short
  `/{slug}` form still works as an alias. `pages` is now a reserved name.
- **`html-server import DIR`** uploads every `.html` file in a folder under its own
  name. Re-running it skips unchanged files and adds a new version for changed ones.

## 0.1.0 (2026-10-20)

The first tagged release.

- **Pages:** upload single-file HTML with `html-server put` or `curl -T`. Each upload is
  an immutable version, served at the page's file name (`/<name>`, `?v=n` for old
  versions) in a sandbox, so a page's scripts can't reach the server.
- **Lifecycle:** pages move active → trashed → purged through a transition table; any
  other move is refused with the allowed actions.
- **Gallery:** the home page lists public pages as cards or a compact list, filtered by
  category (from `<meta name="category">`), with live search that tolerates typos.
- **Contents sidebar:** pages with at least three `h2`/`h3` headings get a table of
  contents, pinned in the margin or behind a button, with the current section
  highlighted.
- **Review:** `/review/<name>` shows a page with its comments underneath, a version
  picker, side-by-side changes, and "make this version current" (which appends a
  copy, so history is never rewritten).
- **Views:** page views per day, version and link, counted without storing IP
  addresses or browsers.
- **Users:** bearer tokens; admins create, delete and reset users. Usernames can be
  short names or email addresses (`config usernames email`), with email addresses
  masked for visitors who aren't signed in.
- **CLI:** one `html-server` command runs the server and uses it. Data lives in
  `~/.html-server`. `login` saves the server URL and token, and the first `serve`
  on an empty database makes you an admin and signs the CLI in.
- **Docs:** an API reference at `/api`, generated from the route table.
