# html-server

A small self-hosted server for HTML artifacts: push them with curl, and every push
becomes a new version. You can render any version in a browser, search the whole set
by text, give each person their own token, and delete artifacts (trash first, then
purge). Everything is public unless you mark it private, and a page's URL is its
file name. The home page is a gallery, filterable by category. It runs on Node.js
(22.13 or newer) with zero dependencies, on Node's built-in SQLite, in one database
file.

```bash
npm install -g github:lawwu/html-server   # puts `html-server` on your PATH
html-server serve                         # first run: makes you an admin and signs the CLI in
html-server put page.html "first draft"   # → http://127.0.0.1:8765/pages/page.html
```

| File | What |
| --- | --- |
| `src/cli.js` | The `html-server` command: `serve`, `create-user`, `reset-token`, `config`, plus `put`, `ls`, `find`, `diff`, `restore`, `views`, `rm`, `open`, `review`, `whoami`. Run `html-server help` |
| `src/server.js` | HTTP routes (the table that also generates `/api` docs) and their handlers |
| `src/store.js` | All database access, with the schema |
| `src/lifecycle.js` | The active → trashed → purged state machine |
| `src/text.js` | HTML to text, fuzzy matching (the same similarity measure as Python's difflib), search query building, line diffs |
| `src/pages.js` | Server-rendered pages: gallery, docs, review shell, side-by-side diff |
| `src/config.js` | Every tunable constant, with the reason for its value |
| `public/` | Browser code and styles: `gallery.js` (live search), `review.js`, `toc.js` (contents sidebar, added to pages), `style.css` |
| `gallery/` | Seed pages for the gallery (explain-diff, architecture, data science, ML, data viz, featured) |
| `CHANGELOG.md` | What each release changed |
| `test/` | `npm test`: unit tests for lifecycle, fuzzy matching, extraction and diffs, plus the HTTP API end to end with a fresh database per test |
| `~/.html-server/artifacts.db` | All data, created on first run, outside the code so reinstalling or `npx` can't lose it. `HTML_SERVER_HOME` moves the folder; `--db` uses another file. Back it up separately |
| `~/.html-server/credentials.json` | Which server the CLI uses and its token. Written by `login`, or by the first `serve`; only you can read it |

## Install and run

Requires Node.js 22.13 or newer. There are no dependencies to install.

```bash
npm install -g github:lawwu/html-server
```

From a clone, `npm link` does the same. While the GitHub repo is private, installing
from it needs your GitHub SSH access.

**On the machine that runs the server**, start it:

```bash
html-server serve
```

The first time, with an empty database, it creates an admin named after your
computer account and signs the CLI in, so `html-server put page.html` works right
away. Nothing goes in your shell profile. The server binds to 127.0.0.1 by default;
pass `--host 0.0.0.0` only behind something like Tailscale.

**On any other machine,** or as another user, sign in once:

```bash
html-server login
```

It asks for the server's URL and your token (typing is hidden), checks them against
the server and saves them to `~/.html-server/credentials.json`, readable only by you.
`html-server logout` forgets them. For scripts and CI, `login --url URL --token TOKEN`
skips the questions, or `HTML_SERVER_URL` and `HTML_SERVER_TOKEN` override the saved
login for one shell. Run the tests with `npm test`.

In Claude Code, `.claude/launch.json` has an `html-server` entry that starts it in the browser pane.

## Backups and updating

**Back up** with one command. It's safe while the server is running, because
SQLite takes a consistent snapshot without writing to the live file, and the copy is
checked before it reports success:

```bash
html-server backup                  # → ~/.html-server/backups/artifacts-<date-time>.db
html-server backup /mnt/nas/        # or any folder or file path; never overwrites
html-server backup --keep 14        # then keep only the newest 14 in the backups folder
```

Backups are readable only by you. `--keep` deletes only its own timestamped files.
For a nightly backup, run `html-server backup --keep 14` from cron or launchd.
**Restore** by stopping the server, copying a backup over `~/.html-server/artifacts.db`,
and starting it again.

**Update a deployment:**

1. `html-server backup`
2. `npm install -g github:lawwu/html-server#vX.Y.Z` (or `git checkout vX.Y.Z` in an
   `npm link`ed clone).
3. Restart the server with the same flags. On startup it upgrades the database in
   place; so far every change has only added columns.
4. `html-server --version`, then open a few pages.

To roll back, reinstall the previous tag and restart. Older versions ignore columns
they don't know about. Restore the backup only if the data itself went wrong.

## Users and admins

Every user has one bearer token. It is shown once, at creation or reset, and the
server stores only its hash.

| Who | Can |
| --- | --- |
| Anyone (no token) | Browse, search and read public pages, their history and their comments |
| User | Upload pages, then change, trash or delete **their own**; comment; rotate their own token. Under open editing, also add versions to anyone's public pages |
| Admin | Everything a user can, plus create, list and delete users and reset their tokens |
| Shell access to the server | `html-server create-user NAME [--admin]` and `reset-token NAME`, with no token needed. This is how the first admin is made, and how a lost admin token is recovered |

**Usernames: handles or emails, per deployment.** By default usernames are short
handles (`alice`). For a deployment where they should be email addresses, run
`html-server config usernames email` once (add `--db` if needed). From then
on, new users must be valid addresses. Addresses are trimmed and lowercased, and
user routes accept them (`/api/users/bob@example.com/token`). Existing users keep
their names. `config` alone shows the current setting.

Because pages and comments are public by default, **email addresses are masked for
anyone not signed in**. Gallery cards, page metadata and comment authors show
`bob@…`; signed-in users see the full address. Turn this off with
`MASK_EMAILS_FOR_ANONYMOUS` in `src/config.js`.

**Signing in.** There are no passwords or login screen; the token is the credential.
- **The CLI** keeps it in `~/.html-server/credentials.json` after `login` (or after
  the first `serve` on the server's own machine).
- **curl, scripts and agents** send it as `Authorization: Bearer <token>`.
- **In a browser,** reading needs no sign-in. To comment, a reviewer opens a page's
  review screen, clicks **Sign in to comment** and pastes their token once. It is
  kept in that browser's local storage for this site only; sandboxed pages can't
  read it.
- **Giving someone access:** an admin creates their user and sends them the token
  over a private channel. If it leaks, `POST /api/me/token` replaces it; if it's
  lost, an admin resets it.

Admin is a user-management role only: admins can't edit, delete or see other people's
private pages. A new admin is made by an existing admin (`"admin": true` when
creating) or from the shell. There is no way yet to promote or demote an existing
user, and there is no admin UI; user management goes through the API (table below).

**A new user:** an admin runs `html-server create-user bob` (on the server) or
`POST /api/users`, and sends bob the token; bob runs `html-server login` once.

**A lost token:** an admin runs `POST /api/users/NAME/token`, or anyone with shell
access runs `reset-token NAME`. Both issue a new token and keep the user's pages.
Deleting the user instead would delete their pages too.

## Publishing from an AI agent

Coding agents are good at writing single-file HTML pages, and the CLI gives them a
one-line way to publish one: `html-server put report.html "what changed"` prints the page
link and its review link. A Claude Code skill or a line in your `CLAUDE.md` that says
"publish HTML pages with `html-server put`" is enough to wire it up. Decide there which
kinds of content the agent may publish publicly, and which only with `--private`.

## Pages and the gallery

The home page (**Pages**) shows every public page as a card, with a live preview of
the page, filterable by category chips,
with live, typo-tolerant search. The grid/list toggle switches to one compact row per
page; the choice is remembered in that browser, and `?view=list` puts it in a link. A card's text and category come from the page
itself:

```html
<meta name="description" content="One sentence for the card.">
<meta name="category" content="data-viz">
```

The categories in use are `featured`, `explain-diff`, `architecture`, `data-science`,
`machine-learning`, `data-viz`, `code-review`, `editor` and `prototype`. Any other kebab-case value creates a new chip.
Descriptions and file names are searchable, but the title counts most: pages whose
title contains the whole query come first. Previews are the real page scaled down,
loaded as you scroll. They don't count as views.

**Gallery** (`/gallery`, linked at the top of every page) shows the example pages that
ship in this package's `gallery/` folder, served read-only from the package, so every
install has them and they never mix with your own pages. To make one your own, copy it
and `html-server put` it.

**Featured pages** sit in their own section at the top of the home page, in the order
they were pinned. Pin with `html-server pin NAME` (`unpin` to undo), or tick pages
under **Select** and press Feature. A page's owner or an admin can pin it.

**Tags** label pages, any number each. A page's `<meta name="category">` becomes its
first tag automatically, and the chips filter by tag. To tag many pages at once, press
**Select** on the home page, tick the pages, type a tag, and press Add tag or Remove
tag. Or use `html-server tag add trips plan.html notes.html` (`tag rm` to remove,
`tags` to list them). You need edit rights on each page; any you can't edit are listed
and skipped.

**Stats** (`/stats`) shows totals, views per day, uploads per week, the most viewed
and most edited pages, pages per tag and recent uploads, all counted over the pages
you can see. Hover any bar for its value, or open "Show as table".

**Graph** (`/graph`) draws your pages as dots and the links between them as lines, in
the spirit of Quartz's graph view. Links are read from each page's latest version:
`/pages/x`, `/x`, or a relative `x.html`. Drag dots or the background, scroll to zoom
(labels fade in), and hover to see a page's neighbours. `/graph?page=<name>` shows one
page's neighbourhood, and is linked from its History page. The data is at `/api/graph`.

**Old versions** are always reachable at `/pages/<name>?v=n`, from the History page
(below) and from the review page's version picker. When you're looking at one, a small
badge says "Old version: v2 of 6", with links to the current version and the history.

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

## Replacing an existing page service

If pages are already being served at `/pages/{slug}` by another service, this server
can take over without breaking any links:

1. **Import the existing pages.** Point `import` at a folder of the current `.html`
   files. Each keeps its file name, so `/pages/showstopper-timeline` serves
   `showstopper-timeline.html` exactly as before. Re-running is safe: unchanged files
   are skipped and changed ones become new versions, so you can import once to test
   and again just before switching over.

   ```bash
   html-server import /path/to/current/pages
   ```

2. **Try it on a spare port** while the current service keeps running, and check a
   few old links (`http://HOST:8766/pages/<slug>`):

   ```bash
   html-server serve --host 0.0.0.0 --port 8766
   ```

3. **Switch over.** Stop the current service, then start this one on the same host
   and port it used, e.g. `html-server serve --host 0.0.0.0 --port 8080`. Use
   `--host 127.0.0.1` instead if a reverse proxy in front of it forwards to that
   port; the proxy config doesn't change.

New uploads land at the same `/pages/{slug}` URLs. Pages are rendered sandboxed, so
a page that relied on reading cookies or local storage, or on calling its old
service's API, will need a look. Plain HTML, CSS and JavaScript pages behave the same.

## Open editing

By default only a page's owner can upload new versions of it. To let any signed-in
user add versions to public pages, like a wiki:

```bash
html-server config editing open
```

`config editing owner` turns it back off; `config` shows the current setting.

- **Who can do what:** with editing open, anyone signed in can upload a new version
  of a **public, active** page, or restore an old one. Only the owner can trash or
  delete a page, change its visibility, or touch a private page.
- **Every version records who uploaded it**, shown in the history, the review
  page's version picker and `html-server history`. Versions from before 0.3.0 are
  credited to the page's owner, since nobody else could have made them.
- **Nothing is ever overwritten.** A bad edit is undone by restoring the previous
  version, which appends a copy.
- **To avoid stepping on someone else's edit,** upload with `--base N`, the version
  you started from (`?base=N` or `X-Base: N` over the API). If someone added a version
  since, the upload is refused with "at v5 now, but you started from v4", so you can
  look at what changed and redo yours on top.

## History: `/history/<name>`

Every version of a page, newest first, with its date, author, note and size. Each
row links to that version (`/pages/<name>?v=n`), its changes from the previous
version, and the review page at that version. The **Compare** picker diffs any
two versions side by side, as visible text or, with "HTML source" ticked, as raw
HTML. Gallery cards and the review page link here. In the terminal,
`html-server history NAME` lists the same versions, and `html-server diff NAME FROM TO`
shows a diff.

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

The examples below assume `A=http://127.0.0.1:8765` and `H="Authorization: Bearer $HTML_SERVER_TOKEN"`.

**Everything is public by default.** Anyone can browse `$A/`, open pages, list and
search without a token. Writes need a token, and only the owner can change or delete
an artifact.

**The URL is the file name.** `curl -T trip-plan.html $A/api/artifacts/` serves the
page at `$A/pages/trip-plan.html`; `$A/pages/trip-plan` works too, and so does the short
alias `$A/trip-plan.html`. API responses give the `/pages/` form as `url`. Names are shared across the
whole server, so the first user to upload a name owns it, and a second user gets
a 409 and has to pick another name.

| Do | curl |
| --- | --- |
| Upload, or add a new version | `curl -T trip-plan.html -H "$H" $A/api/artifacts/` (curl adds the file name because the URL ends in `/`) |
| Add a version note | add `-H "X-Note: drop rental car"` |
| Upload under a different name | `curl -T page.html -H "$H" $A/api/artifacts/other-name.html` |
| Upload as private | add `-H "X-Visibility: private"` |
| View | `$A/pages/trip-plan` in a browser · an old version: `$A/pages/trip-plan?v=1` |
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
| Reset a user's lost token (admin) | `curl -X POST -H "$H" $A/api/users/bob/token` |
| Replace your own token | `curl -X POST -H "$H" $A/api/me/token` |
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
- **Page views** count each time a page is opened at `/pages/<name>`, its `/<name>` alias, or its share link.
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

## Versioning

Releases are git tags, `vX.Y.Z`, following semantic versioning; [`CHANGELOG.md`](CHANGELOG.md)
says what each one changed, and `html-server --version` says which one you're on.
Install a specific release with `npm install -g github:lawwu/html-server#v0.4.0`;
without the `#…` you get the latest `main`.

To cut a release, add its notes to the changelog's "Unreleased" section, then:

```bash
npm version minor          # or patch / major: bumps package.json, commits, tags
git push --follow-tags
```

## License

MIT, see [`LICENSE`](LICENSE). The explain-diff gallery page follows Geoffrey Litt's explain-diff format, and
the featured page summarizes and links to Thariq Shihipar's article. Both are credited
on the pages, and neither copies the original.
