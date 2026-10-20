# html-server

A small self-hosted server for HTML artifacts: push them with curl, and every push
becomes a new version. You can render any version in a browser, search the whole set
by text, give each person their own token, and delete artifacts (trash first, then
purge). Everything is public unless you mark it private, and a page's URL is its
file name. The home page is a gallery, filterable by category. It runs on Node.js
(22.13 or newer) with zero dependencies, on Node's built-in SQLite, in one database
file.

```bash
node src/server.js create-user alice --admin    # prints alice's token once
node src/server.js serve                        # http://127.0.0.1:8765
export ARTIFACT_TOKEN=...                       # the token from create-user
./art put page.html "first draft"               # → http://127.0.0.1:8765/page.html
```

| File | What |
| --- | --- |
| `src/server.js` | HTTP routes (the table that also generates `/api` docs), handlers, and the `serve` / `create-user` CLI |
| `src/store.js` | All database access, with the schema |
| `src/lifecycle.js` | The active → trashed → purged state machine |
| `src/text.js` | HTML to text, fuzzy matching (the same similarity measure as Python's difflib), search query building, line diffs |
| `src/pages.js` | Server-rendered pages: gallery, docs, review shell, side-by-side diff |
| `src/config.js` | Every tunable constant, with the reason for its value |
| `public/` | Browser code and styles: `gallery.js` (live search), `review.js`, `toc.js` (contents sidebar, added to pages), `style.css` |
| `gallery/` | Seed pages for the gallery (explain-diff, architecture, data science, ML, data viz, featured) |
| `art` | The CLI: `art put page.html "note"`, `ls`, `find`, `diff`, `restore`, `views`, `rm`, `review`. Run `art help` |
| `test/` | `npm test`: unit tests for lifecycle, fuzzy matching, extraction and diffs, plus the HTTP API end to end with a fresh database per test |
| `artifacts.db` | All data, created on first run (or wherever `--db` points). Gitignored, so back it up separately |
| `.token` | Optional: `art` reads the token from here if `ARTIFACT_TOKEN` isn't set. Gitignored |

## Run

Requires Node.js 22.13 or newer. There is nothing to install.

```bash
node src/server.js create-user alice --admin
```

```bash
node src/server.js serve --port 8765 --db /path/to/artifacts.db
```

```bash
npm test
```

The `create-user` command prints the token **once**, and only its hash is stored.
Save the token as `ARTIFACT_TOKEN` in your shell profile. The server binds to
127.0.0.1 by default; pass `--host 0.0.0.0` only behind something like Tailscale.

In Claude Code, `.claude/launch.json` has an `html-server` entry that starts it in the browser pane.

## Publishing from an AI agent

Coding agents are good at writing single-file HTML pages, and `art` gives them a
one-line way to publish one: `./art put report.html "what changed"` prints the page
link and its review link. A Claude Code skill or a line in your `CLAUDE.md` that says
"publish HTML pages with `./art put`" is enough to wire it up. Decide there which
kinds of content the agent may publish publicly, and which only with `--private`.

## Gallery

The home page shows every public page as a card, filterable by category chips,
with live, typo-tolerant search. The grid/list toggle switches to one compact row per
page; the choice is remembered in that browser, and `?view=list` puts it in a link. A card's text and category come from the page
itself:

```html
<meta name="description" content="One sentence for the card.">
<meta name="category" content="data-viz">
```

The categories in use are `featured`, `explain-diff`, `architecture`, `data-science`,
`machine-learning`, `data-viz`, `code-review`, `editor` and `prototype`. Any other kebab-case value creates a new chip.
Descriptions are searchable. The seed pages live in `gallery/`; publish them with
`for f in gallery/*.html; do ./art put "$f" "gallery seed"; done`.

## Contents sidebar

Any page with at least 3 `<h2>`/`<h3>` headings gets a table of contents when it is
displayed, like the one on the "unreasonable effectiveness of HTML" article:

- **Pinned in the left margin** when the window is at least 1100px wide and the page
  leaves 230px or more of free space beside its headings. A centred, readable-width
  article gets this.
- **A "Contents" button otherwise** (bottom right), which opens the list as a panel.
  Full-width pages and phones get this.
- **Highlights the section you're reading** as you scroll. Clicking jumps there.
  Headings without an `id` get one, so sections can be linked to.

It is added only when the page is displayed (`public/toc.js`, drawn in a shadow root
so page styles and its styles can't affect each other). Stored versions, raw source,
diffs and search never include it. To turn it off for a page, add
`<meta name="toc" content="off">`; for one view, add `?toc=0`. Pages that already
have a `<nav class="toc">` are left alone. To get the pinned version, write pages
with a centred content column (`max-width` around 40–48rem) and `h2` sections.

## Reviewing: `/review/<name>`

The page fills the width at the top, and its comments for that version sit underneath.
Drag the page's bottom edge to make it taller or shorter. The header has a version picker,
**Show changes** (a side-by-side diff against the previous version) and **Make this
version current**. Anyone can read a public page's comments; commenting needs a
token, which the reviewer pastes once and which is saved in that browser only. To
give a reviewer access, create a user for them (below) and send them their token. A comment's author or the page's owner can resolve or delete it, and replies
go one level deep.

## curl API

The full API reference is served at **`/api`**. It is generated from the route table
in `src/server.js`, so it stays current; the table below is a summary.

The examples below assume `A=http://127.0.0.1:8765` and `H="Authorization: Bearer $ARTIFACT_TOKEN"`.

**Everything is public by default.** Anyone can browse `$A/`, open pages, list and
search without a token. Writes need a token, and only the owner can change or delete
an artifact.

**The URL is the file name.** `curl -T trip-plan.html $A/api/artifacts/` serves the
page at `$A/trip-plan.html` (`$A/trip-plan` works too). Names are shared across the
whole server, so the first user to upload a name owns it, and a second user gets
a 409 and has to pick another name.

| Do | curl |
| --- | --- |
| Upload, or add a new version | `curl -T trip-plan.html -H "$H" $A/api/artifacts/` (curl adds the file name because the URL ends in `/`) |
| Add a version note | add `-H "X-Note: drop rental car"` |
| Upload under a different name | `curl -T page.html -H "$H" $A/api/artifacts/other-name.html` |
| Upload as private | add `-H "X-Visibility: private"` |
| View | `$A/trip-plan.html` in a browser · an old version: `$A/trip-plan.html?v=1` |
| Browse and search in a browser | `$A/` |
| List or search | `curl $A/api/artifacts` · `curl "$A/api/artifacts?q=beach+shelling"` · `&owner=alice` |
| Metadata and version history | `curl $A/api/artifacts/trip-plan.html` |
| Raw source of version n | `curl $A/api/artifacts/trip-plan.html/versions/2` |
| Make private or public | `curl -X POST -H "$H" "$A/api/artifacts/trip-plan.html/visibility?to=private"` |
| Share a private page | send the `share_url` (`/v/<random id>`) from any response; `?v=n` works there too |
| What changed | `curl $A/api/artifacts/trip-plan.html/diff` (previous vs latest, visible text) · `?from=1&to=3` · `?of=source` |
| Make an old version current | `curl -X POST -H "$H" $A/api/artifacts/trip-plan.html/versions/2/restore` (adds a copy as a new version) |
| Comments | `curl $A/api/artifacts/trip-plan.html/comments` · add: `curl -X POST -H "$H" -d '{"body":"..."}' $A/api/artifacts/trip-plan.html/comments` |
| Page views (owner) | `curl -H "$H" $A/api/artifacts/trip-plan.html/views`: total, visitors, per day for 30 days, per version, URL vs share link |
| Trash | `curl -X DELETE -H "$H" $A/api/artifacts/trip-plan.html` |
| List your trash | `curl -H "$H" "$A/api/artifacts?state=trashed"` |
| Restore | `curl -X POST -H "$H" $A/api/artifacts/trip-plan.html/restore` |
| Purge (permanent, trashed only) | `curl -X DELETE -H "$H" "$A/api/artifacts/trip-plan.html?purge=1"` |
| Who am I | `curl -H "$H" $A/api/me` |
| Add a user (admin) | `curl -X POST -H "$H" -d '{"name":"bob"}' $A/api/users` |
| List or delete users (admin) | `curl -H "$H" $A/api/users` · `curl -X DELETE -H "$H" $A/api/users/bob`. Deleting a user also deletes all of their artifacts |

## Design notes

- **Lifecycle state machine.** An artifact is `active`, `trashed` or `purged`. Every
  mutation goes through `transition(state, event)`, a lookup in one table, and any
  pair missing from the table returns a 409 that names the allowed events. Because
  of this, a trashed artifact can't take new versions and an active one can't be
  purged by accident. To add a lifecycle state such as `archived`, add rows to the
  table; the test that walks every illegal pair will then cover it.
- **Visibility is a separate setting, not a lifecycle state.** Public and private can
  each be active or trashed, so visibility is a column on the artifact and is left
  out of the transition table.
- **Search** only indexes the *latest* version: its title and visible text, with
  script and style stripped. It is live on `/` (results update as you type) and
  fuzzy: every word must match, either as a prefix (`ube` finds "uber") or as a
  close misspelling of an indexed word (`sheling` finds "shelling", `ubr` finds
  "uber"). How close is close is set by the `FUZZY_*` constants in `src/config.js`.
  Words of one or two letters only match as prefixes.
- **Rendered pages are sandboxed.** They are sent with
  `Content-Security-Policy: sandbox …`, which still lets artifact JavaScript run, but
  in an opaque origin, so it can't reach the API or any other artifact.
- **Pass options as headers with `curl -T`.** curl only appends the file name when
  the URL ends in `/`, so `.../api/artifacts/?note=x` arrives without a name and gets
  a 400 that explains this. Query parameters still work when the name is spelled out
  in the URL.
- **Page views** count each time a page is opened at `/<name>` or its share link.
  Reading the source through the API doesn't count, and neither do crawlers,
  link-preview bots (iMessage, Slack) or `curl`. A visitor is a hash of a server
  secret, the day, the IP address and the browser, so one person counts once per
  day and no IP address or browser string is stored. As a result `visitor_days` is
  "distinct people per day, summed", not distinct people ever. Your own visits
  count too, because a browser carries no token. Every listing shows a `views`
  total; the per-day report is owner-only.
- **Diffs compare visible text by default**, one line per paragraph, heading or list
  item, so a regenerated report shows "what a reader would notice changed". Use
  `?of=source` for the raw HTML.
- **Restore never rewrites history.** Making v2 current appends a v4 that is a copy
  of v2, with the note "restored from v2". Comments stay on the version they were
  written about.
- **Reserved names:** `api`, `v`, `review`, `favicon.ico` and `robots.txt` can't be used as
  artifact names, because the server uses those top-level paths itself.
- **Versions are immutable** and keep a sha256 and an optional note. Nothing is
  overwritten except by purge.

## Not built (yet)

Per-version deletion, rotating a share link, an MCP server (the CLI covers
this for coding agents), and per-user
folders (`/alice/x.html`) if one shared namespace for names gets crowded. Each of these is small to add on top of the store.

## License

MIT, see [`LICENSE`](LICENSE). The explain-diff gallery page follows Geoffrey Litt's explain-diff format, and
the featured page summarizes and links to Thariq Shihipar's article. Both are credited
on the pages, and neither copies the original.
