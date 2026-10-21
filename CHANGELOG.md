# Changelog

Versions follow [semantic versioning](https://semver.org). While the version is
`0.x`, commands and the API may still change between minor versions; `1.0.0` will
mark them as stable. The database format is migrated in place on startup, and a
change that couldn't be migrated would be a major version.

## Unreleased

- **Featured pages:** pin pages to a "Featured" section at the top of the home page,
  in the order pinned (`html-server pin NAME` / `unpin`, `POST|DELETE
  /api/artifacts/<name>/pin`, or the selection bar). The page's owner or an admin can
  pin. This replaces the old rule that the "featured" category sorted first.
- **Tags:** pages carry server-side tags, any number each. A page's
  `<meta name="category">` becomes a tag automatically, and existing categories were
  converted on startup. The chips filter by tag. **Tag many pages at once** with
  **Select** on the home page (tick pages, then Add tag / Remove tag / Feature /
  Unfeature), `html-server tag add|rm TAG NAME...`, or `POST /api/tags`. Each page is
  checked on its own, and pages you can't edit are reported rather than failing the
  rest. `html-server tags` and `/api/tags` list them.
- **Stats** at `/stats`: totals (pages, versions, views, tags, comments, authors,
  size), views per day for 30 days, versions uploaded per week for 12 weeks, the most
  viewed and most edited pages, pages per tag, and recent uploads. Every chart has a
  hover tooltip and a table view, and the data is at `/api/stats`.
- **Page count** on the home page ("17 pages · 2 featured"), switching to the match
  count while searching. The gallery shows its own count.
- **GitHub button** at the right of the header, with the running version, linking to
  its release.
- **More readable graph:** pages without links sit in their own "Not linked" section;
  labels are on but never overlap (busier pages win, and hover shows the rest);
  arrowheads show link direction; dots are bigger and spaced further apart; the
  legend is clickable to highlight a category. It uses the validated 8-colour
  palette, with extra categories folded into "Other".

## 0.4.0 (2026-10-20)

- **Search ranks titles first:** pages whose title contains the whole query come
  first, then results ranked with title hits weighted 10x and file-name hits 5x over
  body text. File names are searchable now ("household" finds
  `household-budget.html`). The search index is rebuilt automatically on first start.
  Matched words are highlighted in titles as well as in the text snippet, typo matches
  included. The API adds `title_highlight`, with matched words in `[brackets]`.
- **Gallery** at `/gallery`: the example pages that ship with HTML Server, served
  from the package (read-only, not mixed with your pages), with the same categories,
  search, grid/list and previews.
- **Site header** on the server's own pages: HTML Server · Pages · Gallery · API. The
  home page is titled "HTML Server", and its search box says "Search pages".
- **Previews on cards:** each card shows the real page scaled down, loaded as you
  scroll. Previews (`?preview=1`) don't count as views and skip the sidebar.
- **Graph** at `/graph`: your pages as dots and the links between them as lines, in
  the spirit of Quartz's graph view. Live layout: drag a dot or the background, scroll
  to zoom, and labels fade in as you zoom. Hovering highlights a page's neighbours,
  and clicking opens the page. `/graph?page=<name>` is one page's neighbourhood
  (`&depth=2` for more), linked from its History page. `/api/graph` returns the data.
  Links are read from each page's latest version (`/pages/x`, `/x`, or a relative
  `x.html`); existing pages are scanned once on startup.
- **Footer** on the server's own pages: the running version, linking to its GitHub
  release, plus the repository. The API docs link to both, and give the install command.
- **Category chips** on cards are now small pills beside the title, in grid and list
  view, instead of a full-width label.
- **Old-version badge:** a page shown at an old version (`?v=2`) gets a small "Old
  version: v2 of 6" badge with links to the current version and the history.

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
