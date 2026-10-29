# Changelog

Versions follow [semantic versioning](https://semver.org). While the version is
`0.x`, commands and the API may still change between minor versions; `1.0.0` will
mark them as stable. The database format is migrated in place on startup, and a
change that couldn't be migrated would be a major version.

## Unreleased

## 0.9.0 (2026-10-28)

Fixes from a review of 0.8.0: a security audit, a code-quality review and a test at 2,000
notes. On the first start, every page's links are read again from its latest version
(about 0.4 s for 2,300 pages). Rolling back to 0.8.0 works and needs no rebuild there;
coming back afterwards reads the links again if 0.8.0 added versions in between.

- **Pages with many notes load in milliseconds.** Every note page, framed HTML page and
  graph worked out every link on the site by matching names when it was read, which took
  seconds and stalled the server for everyone meanwhile. What each link means is now
  worked out when pages change (a new page, a renamed one, new aliases), and the graph,
  the explorer and hover previews are kept until the next change. Uploading a note takes
  about 1 ms longer.

  | 2,000 notes (5 wikilinks each), 300 HTML pages | 0.8.0   | now          |
  | ---------------------------------------------- | ------- | ------------ |
  | A note page                                    | 23.1 s  | 29 ms        |
  | An HTML page in the site's frame               | 16.7 s  | 17 ms        |
  | `/api/graph`                                   | 16.9 s  | 26 ms        |
  | `/graph?page=` (one page's neighbourhood)      | 16.2 s  | 3 ms         |
  | Uploading a note                               | 1.7 ms  | 2.8 ms       |

  At 500 notes and 100 HTML pages a note page took 1.7 s and now takes 15 ms. Medians of
  ten requests each over HTTP (three for 0.8.0), on an M1 Max in everyday use with Node 26,
  the library built through `Store.putVersion` the way `sync` uploads; the first request
  after a change works the graph out again (98 ms at 2,000 notes). Most of what's left
  is compressing the 600 KB page.
- **One way to find a page by name**, for URLs, wikilinks, Markdown links, backlinks and the
  graph alike. A page in the trash, or someone else's private page, no longer hides the
  page a link means (it showed as "not written yet"); aliases count for backlinks and the
  graph; `[[plugins/Backlinks]]` is a backlink of `plugins-Backlinks.md` only, not of every
  note called Backlinks; and `[[tags/x]]` links aren't page links.
- **Markdown links between files of a synced folder work.** `[profile](../finance/profile.md#savings)`
  in `health/README.md` goes to the page made of `finance/profile.md`, `#savings` kept,
  and counts as a link for backlinks and the graph; before, it led to a 404.
- **Changes take a page's exact name.** Uploading, trashing, restoring, purging, tagging,
  featuring and changing visibility no longer guess: `DELETE /api/artifacts/backlinks`
  trashed `plugins-Backlinks.md`, and now says `did you mean 'plugins-Backlinks.md'?`. A
  new name that another page answers to (`report` while `report.html` exists) is refused
  with the same question. Over MCP, `publish_page` with `report` while `report.html`
  existed made a second page, `report`, in public; it now gets that answer, and a new
  version of an existing page keeps its visibility. Reading still forgives case and a
  missing extension.
- **Images and PDFs are private where their pages are.** `/assets/<name>` and the list of
  assets served every file to anyone, including ones only private notes showed. A file is
  now served to whoever uploaded it and to anyone who can see one of the uploader's pages
  that shows it (a private note's share link included); naming someone else's file in your
  own page doesn't publish it. `GET /api/assets` lists your own (an admin's: all).
- **Diffs can't hold up the server.** A diff built a table of every line against every
  line: comparing two 40,000-line versions took 6 GB. Small diffs still do, up to 25
  million cells (50 MB); bigger ones use Myers' diff, which needs memory for the lines
  alone and finds a few edits in 40,000 lines in milliseconds. Versions that differ almost
  everywhere get "too many changes to show" (a 422) after at most about 0.13 s.
- **`sync --prune` sees every page from the folder**, not only the first 500 (`GET
  /api/artifacts` takes `?offset=`). A file renamed only in case (`Notes.md` → `notes.md`)
  now renames its page rather than making a second one.
- **Names in any script.** `Über uns.md` was named `ber-uns.md`, and a Japanese file name
  became `md`; letters and digits of every script now stay, in names, links and URLs.
- **Smaller fixes.** A `%` in a link (`[x](100%.md)`) no longer makes a 500. A new version
  without a name from `sync` (a `put`, or restoring an old version) no longer resets the
  bare name `[[ShortName]]` finds the page by. Headings and wikilinks inside code
  (`df[["a","b"]]`, a `# comment` in a shell block) aren't titles or links. Tagging checks
  the 20-tag limit before adding anything. `/stats` counts its 30 days from midnight, and a
  daylight-saving change no longer repeats or drops a day. Notes' links are read correctly
  when links are rebuilt (they were read as HTML). An HTML page with no `<head>` stays out of
  quirks mode in the site's frame. Uploading to someone else's private page's name says the
  name is taken, not by whom. Text responses carry `X-Content-Type-Options: nosniff`, every
  response `Vary: Accept-Encoding`, and `/favicon.ico` and `/robots.txt` are a 404 straight
  away.
- **The usage chart no longer drops today before noon:** its days were compared as times
  (the fix from the closed #4, on its own).
- **Tests run on GitHub** on every push and pull request: Node 22.16 and the current LTS,
  each in UTC and in Los Angeles time. `npm test` itself works on Node 22 and 24 now: it
  named the test folder, which only Node 26 reads as "the tests in it".
- **Node 22.16 or newer**, not 22.13 as `package.json` said: before 22.16, Node's built-in
  SQLite has no full-text search (FTS5), so the server couldn't start. The first CI run
  found it.

## 0.8.0 (2026-10-28)

The search index is rebuilt once, on the first start (about a second for 2,000 pages),
and takes more room for its prefix lookups (about 11 MB more for 2,000 pages). Rolling
back to 0.7.1 works: it rebuilds its own index the same way.

- **Faster search.** On the home page, live search keeps the cards on show and only
  reorders, hides and re-highlights them, so their live previews no longer reload with
  every key pressed. Results already fetched show at once (backspacing is instant), and
  a new search waits 60 ms after typing stops instead of 120. On the server, matching
  typos is about 15 times faster for the same results and remembers words it has
  already checked, the first one to three letters of a search are looked up from a
  prefix index, and snippets are written for the cards near the top only.
- **Search finds more.** It covers text that pages write with JavaScript (a board's
  tickets, a quiz's questions, a chart's labels), tags (including ones added by hand)
  and aliases, and the words inside joined-up file names ("flavored" finds
  `ObsidianFlavoredMarkdown.md`). Other forms of a word match it ("studies" finds
  "study", "running" finds "run"). Typo matching no longer gives its few slots to words
  the typed word already starts, and no longer matches words two or more letters shorter
  ("rotate" doesn't find "rate"). Pages with the words as typed rank above pages found
  only through a typo or another form of a word.

Measured against 0.7.1, time per key pressed, on the server:

| Typing in              | 0.7.1     | 0.8.0    |
| ---------------------- | --------- | -------- |
| ⌘K box, 300 pages      | 13-54 ms  | 8-13 ms  |
| ⌘K box, 2,000 pages    | 34-147 ms | 8-11 ms  |
| Home page, 300 pages   | 18-55 ms  | 12-16 ms |
| Home page, 2,000 pages | 53-180 ms | 12-27 ms |

Eight searches (two of them misspelt, one just "the") were typed a key at a time
through the requests the browser makes, on libraries of 300 and 2,000 generated pages
plus the 13 bundled ones, on an M1 Max in everyday use with Node 26. Each figure is the
average over one search, the median of five runs with the two versions taking turns;
each range runs from the quickest search to the slowest.

- **The first search after an upload** rebuilds the word list: 106 ms at 2,000 pages
  (271 ms in 0.7.1).
- **Typo matching alone,** against the 300-page library's 49,846 words: 3.2 ms per
  typed word instead of 48, with the same matches for all 7,500 words tried (real words,
  typos of them and partly typed ones).
- **In the browser,** typing "simpsons paradox" on that library's home page: 2-22 ms per
  request on the server instead of 7-112 ms, the count shown kept up with the typing
  (0.7.1's fell a request behind), and no preview reloaded (0.7.1 replaced every card,
  so every preview on show reloaded at each key).
- **Among the 13 bundled pages,** "rotate share link" (a ticket that a script writes)
  and "pipefail sigpipe" (in a script's strings) found nothing in 0.7.1 and now find
  their page, and "studies" now finds the Simpson's paradox page, which says "study".

## 0.7.1 (2026-10-22)

- **Callouts have their colours again.** Since 0.6.0 every callout in a note was blue
  whatever its type, so a warning, a tip and a success looked the same. The per-type
  colours apply again, in notes and in hover previews.

## 0.7.0 (2026-10-22)

Upgrading adds two tables, `api_calls` and `api_calls_daily`; nothing existing changes, so
rolling back to 0.6.2 works (it ignores them).

- **API and MCP usage on `/stats`, for admins:** every `/api` request is recorded (route
  pattern, kind of client, MCP tool or CLI command, status, user; never query strings,
  bodies or tokens) and shown as calls by client (MCP, CLI, browser, other
  HTTP), a stacked chart per day, the most used MCP tools and CLI commands, the busiest
  routes and the error rate, over 30 days, 90 days, a year or all time. Each request's
  details are kept 90 days, then folded into daily totals kept for good, so long-run
  history stays. `GET /api/stats/usage` (`?days=N` or `?days=all`) has the same as JSON. The CLI and MCP
  label their requests (`X-HTML-Server-Client: cli/<command>` or `mcp/<tool>`). Works on
  Cloudflare too.
- **A redesigned stats page:** headline cards (views with a trend line and the change from
  the previous 30 days, pages, versions, visitors), a strip for the smaller counts, chart
  cards with their totals, a timeline of recent uploads, and charts sized to their space.

## 0.6.2 (2026-10-22)

- **HEAD requests work:** every GET route answers HEAD with the same status and headers
  and no body, so `curl -I`, link checkers and uptime monitors see pages that exist
  instead of a 404. HEAD requests don't count as page views.

## 0.6.1 (2026-10-22)

- **Sort pages** by recently updated (the default), newest, most viewed or title: a Sort
  menu on the home page (remembered per browser, `?sort=` in links), `ls --sort`,
  `search --sort`, `?sort=` on `/api/artifacts` and `/api/search`, and the MCP list and
  search tools. Searches sort by best match unless asked otherwise. Featured pages stay
  on top whatever the order, and `ls` marks them `[featured]`.

## 0.6.0 (2026-10-22)

HTML Server becomes a Quartz-style knowledge base: it hosts Markdown notes and Jupyter
notebooks next to HTML pages, syncs a notes repo, links everything together, and can be
used from AI apps over MCP or run on Cloudflare.

**New kinds of page**

- **Markdown notes**, hosted next to HTML pages like Quartz: frontmatter (title, tags,
  description, aliases), `[[wikilinks]]` to notes, notebooks or HTML pages (missing ones
  drawn faded), Obsidian/Quartz callouts, `==highlights==`, task lists, tables, and
  embedded images and PDFs. Versions, search, tags, the graph, comments and featuring all
  work for notes, and diffs show the Markdown. Adds one dependency, `marked` 18.1.0; the
  Quartz and Obsidian extras are our own.
- **Jupyter notebooks**: `.ipynb` pages render from the saved notebook: Markdown cells
  with wikilinks and backlinks, highlighted code with In/Out prompts, and outputs (text,
  HTML tables and charts, images, SVG, Markdown, JSON, errors). Formats 3 and 4;
  frontmatter from a first raw cell or the metadata. Search covers code, diffs compare
  cells, and nothing executes.
- **Syntax highlighting** for code in notebooks and Markdown (Python,
  JavaScript/TypeScript, shell, SQL, R), in light and dark; no library.
- **Images and PDFs** for notes: `/assets/<name>`, and `GET`/`PUT`/`DELETE /api/assets`.

**Sync a notes repo**

- **`html-server sync DIR`**: one-way sync of a Quartz repo, an Obsidian vault or any
  folder of notes, notebooks, HTML pages and images. It detects a Quartz repo, reads
  `content/` and honours `ignorePatterns`; names pages by their Quartz path
  (`plugins/Backlinks.md` → `/pages/plugins-Backlinks.md`, a folder's `index.md` is the
  folder's page); and resolves wikilinks the way Quartz does (by file name, shortest path
  first, by folder path and by `aliases`). Unchanged files are skipped, drafts left out,
  and in a git checkout each version's note is the commit message. `--prune` trashes
  pages whose file is gone, `--install-hook` re-syncs on every commit and pull, and
  `--dry-run` previews. Tested against Quartz's own docs: 111 notes and 15 images, every
  wikilink resolving.
- **Tags:** nested tags (`plugin/emitter`) become `plugin-emitter`, and `[[tags/...]]`
  links go to the tag. Tags a page declares (frontmatter tags, or an HTML page's
  category) are added and removed with it; tags added by hand stay.

**A Quartz-style site**

- **Quartz's default theme** (MIT): its colours, its typefaces (Schibsted Grotesk,
  Source Sans 3, IBM Plex Mono, now served from this server under the SIL Open Font
  License, not Google Fonts) and its three-column layout.
- **Left sidebar** on every page: search, a light/dark switch, the site's sections and an
  **explorer** of folders and pages. The top header bar is gone.
- **⌘K search** from any page (or `/`), with live results. `/api/search` answers
  cross-origin requests so sandboxed notes can use it; where a browser blocks that, it
  matches titles from the explorer.
- **Hover previews** of linked pages: notes and notebooks rendered, HTML pages as their
  title, tags and opening text.
- **Notes** get breadcrumbs, date and reading time, tag pills, and a right sidebar with a
  **live local graph**, the table of contents and **backlinks**. The graph's expand
  button opens the **global graph** over the page.
- **HTML pages in the frame:** a browser tab opening a page gets the sidebar, a title bar
  with tags and links, the page in its own design, and its graph and backlinks. The frame
  grows to the page's full height (natively with responsive iframes, `frame-sizing:
  content-height`, else by a script that reports the height); window-filling pages keep
  window height, and `<meta name="html-server-frame" content="window">` asks for it.
  Iframes, previews, the review page, curl and API clients still get the page itself, as
  does `?raw=1`, and the frame isn't counted as a view.
- **Copy markdown** on notes and the docs page, **Copy notebook** on notebooks, **Copy
  HTML** on framed pages.
- **The `/graph` page** draws tags as nodes joined to their pages, so related pages
  cluster; dots never overlap, unconnected pages settle on an outer ring, and it has
  **Tags**, **Fit** and **Full screen** controls.
- Light/dark is remembered in the browser, and passed to sandboxed notes by a `theme`
  cookie. Responses are gzipped.

**Publishing and tools**

- **MCP server:** `html-server mcp` lets Claude Desktop, Claude Code, Cursor and other
  MCP apps publish (HTML, Markdown or a notebook), search, list, read, diff and restore
  pages, comment, tag and feature. Pages published over MCP are private unless asked
  otherwise.
- **Search everywhere:** `html-server search WORDS [--tag T] [--json]` and
  `GET /api/search?q=` return ranked results with highlighted titles and snippets. Typos
  in the start of a longer word now match ("gardn" finds "gardening").
- **One Docs page** at `/docs` (and `/api`) for the command line, MCP and the HTTP API,
  written as Markdown and built from the CLI's usage text, the MCP tools and the route
  table; the Markdown itself is at `/docs.md`. `docs` is now a reserved page name.
- **CLI help per command:** `html-server help sync` or `html-server sync --help`.
- Page names resolve with `.md` and `.ipynb` as well as `.html` added, and ignoring case.

**Running it**

- **Deploy to Cloudflare** with `html-server deploy cloudflare`: a Worker and one Durable
  Object holding the database in its SQLite, running the same request handler as
  `serve`. It signs in, deploys, creates the first admin from an `ADMIN_TOKEN` secret and
  signs the CLI in. Uploads are limited to 1.9 MB there (2 MB per SQLite row). Node stays
  the main way to run it: the store takes any SQLite database with node:sqlite's small
  interface, the request handler is separate from node:http, and the package's own files
  are read through `src/files.js`.
- A `latest` git tag points at the newest release.

**Upgrading:** the database gains columns and tables on startup and nothing is changed or
removed, so rolling back to 0.5.2 works: HTML pages are unaffected, and notes and
notebooks added under 0.6.0 show as their source until you upgrade again. Take an
`html-server backup` first anyway.

## 0.5.2 (2026-10-22)

- **`--sandbox-allow` without a value** now says what it takes (an example and the valid
  permissions) and that links pages open in a new tab, such as Jira, already work
  without it, instead of printing a stack trace. Other argument mistakes (`--port` with
  no number, say) are one-line errors too.

## 0.5.1 (2026-10-22)

- **Links that pages open in a new tab now load fully.** Rendered pages add
  `allow-popups-to-escape-sandbox` to their sandbox, so a `target="_blank"` link or
  `window.open()` opens an ordinary tab instead of one that inherits the sandbox. Sites
  like Jira only half loaded before. Pages themselves stay sandboxed; no flag needed.
- **`serve --sandbox-allow PERMISSION`** (repeatable) adds sandbox permissions for that
  server instance's pages, e.g. `allow-downloads`. Unknown values stop the server with
  the list of valid ones, and `allow-same-origin` prints a warning about what it opens up.
  See README, "The sandbox".

## 0.5.0 (2026-10-20)

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
