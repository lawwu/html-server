# Changelog

Versions follow [semantic versioning](https://semver.org). While the version is
`0.x`, commands and the API may still change between minor versions; `1.0.0` will
mark them as stable. The database format is migrated in place on startup, and a
change that couldn't be migrated would be a major version.

## Unreleased

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
