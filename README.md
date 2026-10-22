# HTML Server

Host, version, search and link **HTML pages, Markdown notes and Jupyter notebooks** in one
place, with a site that looks and works like [Quartz](https://quartz.jzhao.xyz): a sidebar
explorer, ⌘K search, hover previews, backlinks and a graph of how everything links.

Push a file and it becomes a page, and every push is a new version you can view, diff and
restore. Publish from the command line, from Claude and other AI apps over MCP, or with
curl, or sync a whole notes repo on every git commit. Everything is public unless you mark
it private, and a page's URL is its file name.

It runs on Node.js 22.13 or newer, on Node's built-in SQLite, with one dependency
(`marked`, for Markdown), or on Cloudflare Workers with one command.

```bash
npm install -g github:lawwu/html-server   # puts `html-server` on your PATH
html-server serve                         # first run: makes you an admin and signs the CLI in
html-server put page.html "first draft"   # → http://127.0.0.1:8765/pages/page.html
```

Every running server documents itself at **`/docs`**: the command line, MCP and the HTTP
API on one page (the same page as Markdown at `/docs.md`).

## Contents

- [Install and run](#install-and-run)
- [Publishing: CLI, AI apps, curl](#publishing-cli-ai-apps-curl)
- [What you can host](#what-you-can-host): [HTML pages](#html-pages), [Markdown notes](#markdown-notes), [Jupyter notebooks](#jupyter-notebooks), [syncing a folder or Quartz repo](#syncing-a-folder-or-quartz-repo)
- [The site](#the-site)
- [Versions, history and review](#versions-history-and-review)
- [Users and admins](#users-and-admins)
- [Deploy to Cloudflare](#deploy-to-cloudflare)
- [Backups and updating](#backups-and-updating)
- [Replacing an existing page service](#replacing-an-existing-page-service)
- [HTTP API](#http-api)
- [Design notes](#design-notes) · [The sandbox](#the-sandbox) · [Files](#files) · [Versioning](#versioning) · [License](#license)

## Install and run

```bash
npm install -g github:lawwu/html-server
```

From a clone, `npm link` does the same. While the GitHub repo is private, installing
from it needs your GitHub SSH access.

**On the machine that runs the server**, start it:

```bash
html-server serve
```

The first time, with an empty database, it creates an admin named after your computer
account and signs the CLI in, so `html-server put page.html` works right away. Nothing
goes in your shell profile. The server binds to 127.0.0.1 by default; pass
`--host 0.0.0.0` only behind something like Tailscale. Its data lives in
`~/.html-server/artifacts.db` (`HTML_SERVER_HOME` moves the folder, `--db` uses another
file), outside the code, so reinstalling can't lose it.

**On any other machine,** or as another user, sign in once:

```bash
html-server login
```

It asks for the server's URL and your token (typing is hidden), checks them and saves
them to `~/.html-server/credentials.json`, readable only by you. `html-server logout`
forgets them. For scripts and CI, `login --url URL --token TOKEN` skips the questions,
or `HTML_SERVER_URL` and `HTML_SERVER_TOKEN` override the saved login for one shell.

`html-server --help` lists every command, and `html-server help sync` (or
`sync --help`) shows one. Rather not run a server? [Deploy to Cloudflare](#deploy-to-cloudflare).
In Claude Code, `.claude/launch.json` has an `html-server` entry that starts it in the
browser pane.

## Publishing: CLI, AI apps, curl

**The CLI:**

```bash
html-server put trip-plan.html "drop the rental car"   # a page; the note goes with the version
html-server put weekly-review.md                         # a Markdown note
html-server put analysis.ipynb --private                 # a notebook, private
html-server sync ~/github/my-garden --install-hook       # a folder or Quartz repo, on every commit
```

`put` prints the page's link and its review link. `--base N` refuses the upload if
someone added a version after vN (see [Open editing](#open-editing)).

**Claude and other AI apps (MCP).** `html-server mcp` runs HTML Server as an MCP server;
apps start it themselves and it uses the same login as the CLI, so sign in (or run the
first `serve`) once beforehand.

```bash
claude mcp add html-server -- html-server mcp
```

For Claude Desktop (Settings → Developer → Edit Config, then restart the app), use full
paths, because apps don't see your shell's PATH:

```json
{
  "mcpServers": {
    "html-server": { "command": "/opt/homebrew/bin/node", "args": ["/Users/you/github/html-server/src/cli.js", "mcp"] }
  }
}
```

Tools: `publish_page` (HTML, Markdown or a notebook), `search_pages`, `list_pages`,
`get_page`, `page_history`, `diff_versions`, `restore_version`, `list_comments`,
`add_comment`, `tag_pages`, `feature_page` and `server_info`. **Pages published over MCP
are private unless the call says `public: true`**, so a chat can't put something in the
public gallery by accident; a private page comes back with its share link. Editing goes
`get_page`, then `publish_page` with `base_version`, so two agents can't silently
overwrite each other.

**Coding agents** can also just use the CLI: a line in your `CLAUDE.md` (or a skill) saying
"publish HTML pages with `html-server put`" is enough. Decide there which kinds of content
the agent may publish publicly, and which only with `--private`.

**curl** works too: `curl -T trip-plan.html -H "Authorization: Bearer $HTML_SERVER_TOKEN" $A/api/artifacts/`.
See [HTTP API](#http-api).

## What you can host

Every page, whatever its kind, gets versions, search, tags, comments, views, the graph,
featuring and a stable URL: `/pages/<file name>`, with the extension optional
(`/pages/trip-plan` finds `trip-plan.html`).

### HTML pages

Any single-file HTML page: reports, explainers, dashboards, small tools. A page's
JavaScript runs, in a sandbox that keeps it away from the API and your sign-in.

**In a browser tab** a page sits in the site's frame: the sidebar, a title bar with its
tags, history, comments, **Copy HTML** and "full page ↗", then the page itself in its own
design, then its local graph and backlinks. The frame grows to the page's full height, so
the whole thing scrolls as one page: natively with [responsive
iframes](https://developer.chrome.com/blog/responsive-iframes) (`frame-sizing:
content-height`; the server adds the page's opt-in meta tag) where the browser has them,
otherwise by a small script that reports the page's height. Pages built to fill the window
(100vh or `height: 100%` layouts, `overflow: hidden`) stay at window height, as does any
page with `<meta name="html-server-frame" content="window">`.

Only browser tabs get the frame. Iframes, gallery previews, the review page, curl and
other clients get the page itself, as does `?raw=1`, and the frame isn't counted as a view.

**Gallery cards** take their text and first tag from the page:

```html
<meta name="description" content="One sentence for the card.">
<meta name="category" content="data-viz">
```

**Contents sidebar.** Opened on its own (`?raw=1`, or a share link), a page with at least
3 `<h2>`/`<h3>` headings gets a table of contents: pinned in the left margin when there's
room (a centred, readable-width article), otherwise a "Contents" button. It highlights the
section you're reading, and headings without an `id` get one. It's added only at display
time (`public/toc.js`, in a shadow root so styles can't clash); stored versions, source,
diffs and search never include it. `<meta name="toc" content="off">` turns it off for a
page, `?toc=0` for one view, and pages with their own `<nav class="toc">` are left alone.

### Markdown notes

Upload a `.md` file and the server renders it as a page of the site, laid out like a
Quartz page: breadcrumbs, date and reading time, tag pills, then the note, with a right
sidebar holding a live local graph, the table of contents and **backlinks** (every page
linking here, Markdown or HTML).

- **Frontmatter** sets the title, `tags`, `description` and `aliases` (`draft: true` or
  `publish: false` keeps a note out of `sync`). Without a title, the first `# heading` or
  the file name is used.
- **`[[Wikilinks]]`** (`[[Note]]`, `[[Note|text]]`, `[[Note#Heading]]`) resolve by name to
  notes, notebooks **or** HTML pages, ignoring case. A link to a page that doesn't exist yet
  is drawn faded, as in Quartz. Ordinary Markdown links to other pages count too.
- **Obsidian/Quartz callouts** (`> [!warning] Title`, foldable with `-` or `+`),
  `==highlights==`, task lists, tables, and code blocks with syntax highlighting.
- **Images and PDFs** are assets, embedded with `![[diagram.png]]`, `![[diagram.png|800]]`
  or `![](img/diagram.png)` (uploaded by `sync`, or `PUT /api/assets/<name>`). Images over
  3 MB link instead of embedding.
- **Copy markdown** copies the note's source. Diffs show the Markdown; frontmatter tags
  follow the note, and tags you add by hand stay.

### Jupyter notebooks

Upload an `.ipynb` and it becomes a page like a note, rendered from the notebook as saved:

- **Markdown cells** render as notes do: wikilinks, callouts, headings in the contents
  sidebar, backlinks, and pasted (`attachment:`) images.
- **Code cells** are highlighted (Python, JavaScript/TypeScript, shell, SQL and R; other
  languages plain), with their `In [n]` prompts. The meta line shows the kernel and
  number of code cells.
- **Saved outputs:** printed text, `Out [n]` results, HTML (pandas tables; charts like
  Plotly or Bokeh whose JavaScript is in the output), PNG/JPEG/SVG images, Markdown, JSON,
  and errors (tracebacks without their terminal colours).
- **Title, tags and description** come from a first raw cell of YAML frontmatter (as
  Quarto and Jupytext write it), or the notebook's metadata, else the first `#` heading.
- **Search** covers Markdown cells, code and short text outputs; **diffs** compare cells,
  not JSON; **Copy notebook** copies the `.ipynb`. Notebook formats 3 and 4 are read.
- **Nothing runs:** there's no kernel. Widgets that need one (ipywidgets) show their saved
  fallback, outputs that load their library from the web when the page opens may not draw
  inside the sandbox, and LaTeX shows as text.

### Syncing a folder or Quartz repo

`sync` uploads a Quartz repo, an Obsidian vault or any folder of notes, notebooks, HTML
pages and images, one way:

```bash
html-server sync ~/github/my-garden --dry-run        # see what would happen
html-server sync ~/github/my-garden --prune          # upload new and changed files; trash deleted ones
html-server sync ~/github/my-garden --install-hook   # re-sync on every git commit and pull
```

- **A Quartz repo is recognised** by its `quartz.config.yaml` (or `.ts`) next to
  `content/`. Sync then reads `content/` and honours the config's `ignorePatterns`. Any
  other folder is read as is, skipping hidden folders (`.obsidian`, `.git`,
  `.ipynb_checkpoints`).
- **Pages are named like Quartz's paths:** `plugins/Backlinks.md` becomes
  `/pages/plugins-Backlinks.md`, so notes sharing a file name in different folders stay
  separate. A folder's `index.md` is that folder's page. Where each file lives drives the
  explorer and breadcrumbs.
- **`[[Wikilinks]]` resolve the way Quartz does:** `[[Backlinks]]` finds the note named
  Backlinks wherever it lives (the shortest path wins if several do), `[[plugins/Backlinks]]`
  goes exactly there, `aliases` work, and `[[tags/plugin/emitter]]` goes to that tag.
  Nested tags (`plugin/emitter`) become `plugin-emitter`.
- **Re-runnable:** unchanged files are skipped, changed ones become new versions, and
  drafts stay out. In a git checkout, each new version's note is the commit message that
  last touched the file.
- **`--prune`** trashes pages that came from this folder but whose file is gone (they can
  be restored); pages uploaded any other way are never touched.
- **`--install-hook`** adds `post-commit` and `post-merge` hooks, so every commit and every
  `git pull` re-syncs in the background (with `--prune`); output goes to
  `~/.html-server/sync.log`. Delete the hook files to stop. An existing hook of your own is
  left alone, and you're shown the line to add.

The repo stays where you write; the server keeps a versioned, searchable, linked copy.
Tested against Quartz's own documentation: 111 notes and 15 images, every wikilink
resolving.

## The site

The pages the server draws borrow Quartz's default theme (MIT): its colours, its
typefaces (Schibsted Grotesk, Source Sans 3, IBM Plex Mono, served from this server under
the SIL Open Font License, licences in `public/fonts`) and its three-column layout.

- **Left sidebar** on every page: the title, the running version (linking to its
  release), search, a light/dark switch, the site's sections (Pages, Graph, Stats,
  Gallery, Docs) and an **explorer** of folders and pages. On a phone it collapses
  above the page.
- **Search from anywhere:** ⌘K, Ctrl+K or `/` opens a search box with live results;
  arrows move, Enter opens. On the home page the same keys go to its own search box,
  which filters the cards instead. Search is typo-tolerant (including in the start of a
  longer word: "gardn" finds "gardening"), ranks title matches first and marks the
  matched words. From the terminal: `html-server search WORDS` (`--tag`, `--json`).
- **Hover previews:** point at a link to another page here to see it: a note or notebook
  rendered, an HTML page as its title, tags and opening text.
- **Graph view:** on notes and pages, a live local graph of the pages linked to or from
  this one (drag, zoom, hover for neighbours, click to open); its expand button opens the
  graph of every page over the current one.
- **Light and dark:** follows the system unless you pick one with the switch.

**Pages** (`/`) shows every page as a card with a live preview, filterable by tag chips,
with live search; the grid/list toggle switches to one compact row per page (remembered in
that browser; `?view=list` puts it in a link). Previews don't count as views.

**Featured pages** sit in their own section at the top, in the order they were pinned.
Pin with `html-server pin NAME` (`unpin` to undo), or tick pages under **Select** and press
Feature. A page's owner or an admin can pin it.

**Tags** label pages, any number each. An HTML page's `category` and a note's or
notebook's frontmatter tags are added automatically, and the chips filter by tag. To tag many pages at once, press
**Select**, tick the pages, type a tag, and press Add tag or Remove tag; or
`html-server tag add trips plan.html notes.md` (`tag rm` to remove, `tags` to list them).
Pages you can't edit are listed and skipped.

**Graph** (`/graph`) is the full graph page: pages as dots sized by their links, links as
arrows, and tags as small rings joined to their pages, so pages that share a tag cluster
(switch them off with **Tags**); unconnected pages wait on an outer ring. **Fit** and
**Full screen** are in the corner. `/graph?page=<name>` shows one page's neighbourhood.
Links are read from each page's latest version: wikilinks, `/pages/x`, `/x` or a relative
`x.html`.

**Stats** (`/stats`): totals, views per day, uploads per week, the most viewed and most
edited pages, pages per tag and recent uploads, counted over the pages you can see. Hover
any bar for its value, or open "Show as table".

**Gallery** (`/gallery`) shows the example pages that ship in this package's `gallery/`
folder, read-only, so every install has them and they never mix with your own. To make one
your own, copy it and `html-server put` it.

**Docs** (`/docs`, also `/api`): the command line, MCP and the HTTP API on one page, built
from the CLI's own usage text, the MCP tool definitions and the route table, so it stays
current. It's Markdown, with **Copy markdown**, and at `/docs.md` as is.

## Versions, history and review

**Old versions** are always reachable at `/pages/<name>?v=n`. Looking at one, the title bar
(or, on the raw page, a small badge) says "v2 of 6", with links to the current version and
the history.

**History** (`/history/<name>`): every version, newest first, with its date, author, note
and size. Each row links to that version, its changes from the previous one, and the
review page at that version. **Compare** diffs any two versions side by side: by visible
text (for notes and notebooks, the Markdown and cells), or the raw source. In the
terminal: `html-server history NAME` and `html-server diff NAME FROM TO`.

**Review** (`/review/<name>`): the page at the top (drag its bottom edge to resize) and its
comments for that version underneath, with a version picker, **Show changes** and **Make
this version current**. Anyone can read a public page's comments; commenting needs a
token, pasted once and saved in that browser only. A comment's author or the page's owner
can resolve or delete it; replies go one level deep.

**Restore never rewrites history:** making v2 current appends a new version that's a copy
of v2, noted "restored from v2".

### Open editing

By default only a page's owner can upload new versions of it. To let any signed-in user
add versions to public pages, like a wiki:

```bash
html-server config editing open
```

`config editing owner` turns it back off; `config` shows the current setting.

- **Who can do what:** with editing open, anyone signed in can upload a new version of a
  **public, active** page, or restore an old one. Only the owner can trash or delete a
  page, change its visibility, or touch a private page.
- **Every version records who uploaded it**, shown in the history, the review page and
  `html-server history`.
- **Nothing is ever overwritten.** A bad edit is undone by restoring the previous version.
- **To avoid stepping on someone else's edit,** upload with `--base N`, the version you
  started from (`?base=N` or `X-Base: N` over the API). If someone added a version since,
  the upload is refused with "at v5 now, but you started from v4".

## Users and admins

Every user has one bearer token. It's shown once, at creation or reset, and the server
stores only its hash.

| Who | Can |
| --- | --- |
| Anyone (no token) | Browse, search and read public pages, their history and their comments |
| User | Upload pages, then change, trash or delete **their own**; comment; rotate their own token. Under open editing, also add versions to anyone's public pages |
| Admin | Everything a user can, plus create, list and delete users and reset their tokens |
| Shell access to the server | `html-server create-user NAME [--admin]` and `reset-token NAME`, with no token needed: how the first admin is made, and how a lost admin token is recovered |

**Signing in.** There are no passwords or login screen; the token is the credential.
- **The CLI** keeps it in `~/.html-server/credentials.json` after `login` (or after the
  first `serve` on the server's own machine).
- **curl, scripts and agents** send it as `Authorization: Bearer <token>`.
- **In a browser,** reading needs no sign-in. To comment, a reviewer clicks **Sign in to
  comment** on the review page and pastes their token once; it's kept in that browser's
  storage for this site only, out of reach of the sandboxed pages.

**A new user:** an admin runs `html-server create-user bob` (on the server) or
`POST /api/users`, and sends bob the token over a private channel; bob runs
`html-server login` once. **A lost token:** an admin runs `POST /api/users/NAME/token`, or
anyone with shell access runs `reset-token NAME`; the user's pages are kept. If a token
leaks, `POST /api/me/token` replaces it.

Admin is a user-management role only: admins can't edit, delete or see other people's
private pages. A new admin is made by an existing admin (`"admin": true` when creating) or
from the shell. There's no admin UI and no way yet to promote an existing user; user
management goes through the API.

**Usernames: handles or emails, per deployment.** By default usernames are short handles
(`alice`). For a deployment where they should be email addresses, run
`html-server config usernames email` once; new users must then be valid addresses
(trimmed and lowercased). Because pages are public by default, **email addresses are
masked for anyone not signed in** (`bob@…`); turn that off with `MASK_EMAILS_FOR_ANONYMOUS`
in `src/config.js`.

## Deploy to Cloudflare

HTML Server runs anywhere Node 22 runs. It can also run on **Cloudflare Workers**, with no
server to look after: one command from a clone of the repo (Node 22 and a Cloudflare
account; the free plan is fine):

```bash
html-server deploy cloudflare
```

That signs you in to Cloudflare if needed (Wrangler, Cloudflare's CLI, opens the browser;
you approve there), deploys, and on the first deploy creates the admin (your login name,
or `--user NAME`) with a fresh token, stores it as the Worker's `ADMIN_TOKEN` secret, and
signs this CLI in to the new URL. Run it again to deploy a new version: data, users and
tokens stay. `--name NAME` deploys a second, separate server. Everything else (the CLI,
MCP, the API, `sync`) works the same against the `https://….workers.dev` URL; on another
machine, `html-server login --url URL`.

How it fits: a Worker hands every request to one Durable Object that keeps the whole
database in its built-in SQLite (with the same full-text search) and runs the same request
handler as `serve`. The Cloudflare parts are only `cloudflare/` and `wrangler.toml`; the
rest of the code doesn't depend on Cloudflare.

- **Limit:** a Durable Object's SQLite holds up to 2 MB per row, so on Cloudflare each
  upload (a page version, notebook or image) is limited to 1.9 MB, with a clear error
  over it. The Node server takes 16 MB.
- **Dates** are formatted in UTC there.
- **Your own domain:** add `routes` to `wrangler.toml` (Cloudflare's docs: Custom Domains).
- **Try it locally first:** `npm run cf:dev` runs it in Cloudflare's local runtime.
- **Moving data:** `sync` and `import` re-upload a folder to any server, so moving between
  a Node server and Cloudflare is a re-sync.

## Backups and updating

**Back up** with one command. It's safe while the server is running (SQLite takes a
consistent snapshot without writing to the live file), and the copy is checked before it
reports success:

```bash
html-server backup                  # → ~/.html-server/backups/artifacts-<date-time>.db
html-server backup /mnt/nas/        # or any folder or file path; never overwrites
html-server backup --keep 14        # then keep only the newest 14 in the backups folder
```

Backups are readable only by you, and `--keep` deletes only its own timestamped files. For
a nightly backup, run `html-server backup --keep 14` from cron or launchd. **Restore** by
stopping the server, copying a backup over `~/.html-server/artifacts.db`, and starting it
again.

**Update a deployment:**

1. `html-server backup`
2. `npm install -g github:lawwu/html-server#vX.Y.Z` (or `git checkout vX.Y.Z` in an
   `npm link`ed clone; `html-server deploy cloudflare` again for Cloudflare).
3. Restart the server with the same flags. On startup it upgrades the database in place;
   so far every change has only added columns and tables.
4. `html-server --version`, then open a few pages.

To roll back, reinstall the previous tag and restart. Older versions ignore columns they
don't know about. Restore the backup only if the data itself went wrong.

## Replacing an existing page service

If pages are already being served at `/pages/{slug}` by another service, this server can
take over without breaking any links:

1. **Import the existing pages.** Each keeps its file name, so `/pages/showstopper-timeline`
   serves `showstopper-timeline.html` exactly as before. Re-running is safe: unchanged
   files are skipped and changed ones become new versions.

   ```bash
   html-server import /path/to/current/pages
   ```

2. **Try it on a spare port** while the current service keeps running, and check a few old
   links:

   ```bash
   html-server serve --host 0.0.0.0 --port 8766
   ```

3. **Switch over.** Stop the current service, then start this one on the same host and
   port, e.g. `html-server serve --host 0.0.0.0 --port 8080` (or `--host 127.0.0.1` behind
   a reverse proxy; the proxy config doesn't change).

Pages are rendered sandboxed, so a page that relied on reading cookies or local storage,
or on calling its old service's API, will need a look. Plain HTML, CSS and JavaScript pages
behave the same.

## HTTP API

The full reference is the server's own **Docs** page (`/docs`, or `/docs.md`), generated
from the route table. A summary, with `A=http://127.0.0.1:8765` and
`H="Authorization: Bearer $HTML_SERVER_TOKEN"`:

**Everything is public by default.** Anyone can browse, open pages, list and search without
a token. Writes need a token, and only the owner can change or delete a page (unless
[open editing](#open-editing) is on).

**The URL is the file name.** `curl -T trip-plan.html $A/api/artifacts/` serves the page at
`$A/pages/trip-plan.html`; `$A/pages/trip-plan` works too, and so does the short alias
`$A/trip-plan.html`. Names are shared across the whole server: the first user to upload a
name owns it, and a second user gets a 409.

| Do | curl |
| --- | --- |
| Upload, or add a new version | `curl -T trip-plan.html -H "$H" $A/api/artifacts/` (curl adds the file name because the URL ends in `/`; `.md` and `.ipynb` work the same) |
| Add a version note | add `-H "X-Note: drop rental car"` |
| Upload under a different name | `curl -T page.html -H "$H" $A/api/artifacts/other-name.html` |
| Upload as private | add `-H "X-Visibility: private"` |
| View | `$A/pages/trip-plan` · an old version: `?v=1` · the page alone: `?raw=1` |
| Search | `curl "$A/api/search?q=beach+shelling"` (`&tag=`, `&limit=`) |
| List | `curl $A/api/artifacts` · `?q=`, `&owner=alice`, `&category=` |
| Metadata and version history | `curl $A/api/artifacts/trip-plan.html` |
| Source of version n | `curl $A/api/artifacts/trip-plan.html/versions/2` |
| What changed | `curl $A/api/artifacts/trip-plan.html/diff` (previous vs latest) · `?from=1&to=3` · `?of=source` |
| Make an old version current | `curl -X POST -H "$H" $A/api/artifacts/trip-plan.html/versions/2/restore` |
| Make private or public | `curl -X POST -H "$H" "$A/api/artifacts/trip-plan.html/visibility?to=private"` |
| Share a private page | send the `share_url` (`/v/<random id>`) from any response; `?v=n` works there too |
| Tag or feature | `POST /api/tags` with `{"pages": [...], "add": [...], "remove": [...]}` · `POST /api/artifacts/<name>/pin` |
| Images and PDFs for notes | `curl -T diagram.png -H "$H" $A/api/assets/` · served at `/assets/diagram.png` |
| Comments | `curl $A/api/artifacts/trip-plan.html/comments` · add: `curl -X POST -H "$H" -d '{"body":"..."}' $A/api/artifacts/trip-plan.html/comments` |
| Page views (owner) | `curl -H "$H" $A/api/artifacts/trip-plan.html/views` |
| Graph, stats | `curl $A/api/graph` · `curl $A/api/stats` |
| Trash, restore, purge | `curl -X DELETE -H "$H" $A/api/artifacts/trip-plan.html` · `POST …/restore` · `DELETE …?purge=1` (trashed only) |
| Your trash | `curl -H "$H" "$A/api/artifacts?state=trashed"` |
| Who am I · replace your token | `curl -H "$H" $A/api/me` · `curl -X POST -H "$H" $A/api/me/token` |
| Users (admin) | `POST /api/users` `{"name":"bob"}` · `GET /api/users` · `POST /api/users/bob/token` · `DELETE /api/users/bob` (deletes their pages too) |

Pass options as headers with `curl -T`: curl only appends the file name when the URL ends
in `/`, so `.../api/artifacts/?note=x` arrives without a name and gets a 400 that explains
this. Query parameters work when the name is spelled out in the URL. Errors are JSON:
`{"error": "..."}`.

## Design notes

- **Lifecycle state machine.** A page is `active`, `trashed` or `purged`. Every mutation
  goes through `transition(state, event)`, a lookup in one table, and any pair missing from
  it returns a 409 naming the allowed events, so a trashed page can't take new versions and
  an active one can't be purged by accident. Visibility (public or private) is a separate
  column, not a state.
- **Versions are immutable** and keep a sha256, size, author and optional note. Nothing is
  overwritten except by purge.
- **Pages run sandboxed** (see [The sandbox](#the-sandbox)): every page, note and
  notebook's JavaScript runs, but in an opaque origin, so it can't reach the API, your
  sign-in or another page. That's why notes carry their styles,
  fonts and scripts inline, and why the frame around HTML pages is an iframe. Hover
  previews of another page's HTML are rebuilt from an allowlist before they're shown.
- **Search** indexes each page's latest version (title, file name, description and visible
  text; for notebooks, cells and short outputs) in SQLite's FTS5, ranked with title and
  file-name hits weighted above body text, and fuzzy: every word must match, as a prefix
  (`ube` finds "uber") or as a close misspelling of an indexed word (`sheling` finds
  "shelling"). The `FUZZY_*` constants in `src/config.js` set how close.
- **Diffs compare what a reader sees** by default: one line per paragraph, heading or list
  item for HTML; the Markdown for notes; the cells for notebooks. `?of=source` gives the
  raw source.
- **Page views** count each time a page is opened at `/pages/<name>`, its `/<name>` alias
  or its share link (for a framed page, when the frame loads it). The API, crawlers,
  link-preview bots, `curl` and gallery previews don't count. A visitor is a hash of a
  server secret, the day, the IP address and the browser, so one person counts once per
  day and no IP address or browser string is stored.
- **One codebase, two runtimes.** The store takes any SQLite database with node:sqlite's
  small interface, the request handler is separate from node:http, and the package's own
  files are read through one module, so the same code serves from Node or from a
  Cloudflare Durable Object.
- **Reserved names:** `api`, `v`, `review`, `pages`, `history`, `gallery`, `graph`, `stats`,
  `assets`, `docs`, `favicon.ico` and `robots.txt` can't be page names, because the server
  uses those paths itself.

Not built yet: per-version deletion, rotating a share link, promoting a user to admin, and
per-user folders (`/alice/x.html`) if one shared namespace for names gets crowded.

## The sandbox

Every rendered page (HTML pages, notes, notebooks, old versions, share links, gallery
examples, diffs) is sent with this header by default:

```
Content-Security-Policy: sandbox allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals
```

- **The page runs in an opaque origin.** Its scripts, forms, `alert()`/`confirm()` and
  popups work, but it can't read this site's cookies or local storage (where a reviewer's
  token is saved) or call the API as the viewer, and pages can't reach each other.
- **Links it opens in a new tab are not sandboxed** (`allow-popups-to-escape-sandbox`).
  A link with `target="_blank"` or a `window.open()` gets an ordinary tab, so sites like
  Jira or Google Docs load fully. Without it the new tab inherited the sandbox and such
  sites only half loaded.

**Adding permissions.** `serve --sandbox-allow` adds a permission for every page on that
server, and can be repeated. It applies to that server process only; other servers and
other runs keep the default.

```bash
html-server serve --sandbox-allow allow-downloads
html-server serve --sandbox-allow allow-downloads --sandbox-allow allow-top-navigation-by-user-activation
```

Values are the sandbox's own `allow-*` tokens (`allow-downloads`, `allow-forms`,
`allow-modals`, `allow-orientation-lock`, `allow-pointer-lock`, `allow-popups`,
`allow-popups-to-escape-sandbox`, `allow-presentation`, `allow-same-origin`,
`allow-scripts`, `allow-storage-access-by-user-activation`, `allow-top-navigation`,
`allow-top-navigation-by-user-activation`, `allow-top-navigation-to-custom-protocols`).
Anything else stops the server at startup with an error listing them. What the common
ones change:

- **`allow-downloads`:** a page can save files (`<a download>`, generated CSVs).
  Reasonable for trusted pages.
- **`allow-top-navigation-by-user-activation`:** a link the reader clicks can replace the
  whole tab. `allow-top-navigation` lets a page do it without a click, which a hostile
  page can use to send readers elsewhere.
- **`allow-same-origin`: avoid it.** Together with `allow-scripts`, which every page has,
  it puts each page's scripts in this site's origin: they can read the token a reviewer
  saved in the browser, call the API as that reviewer (edit, delete, comment), read
  other pages, and remove their own sandbox. The server prints a warning when it's used.
  Only consider it on a server whose every page you wrote and trust.



Per-version deletion, rotating a share link, an MCP server (the CLI covers
this for coding agents), and per-user
folders (`/alice/x.html`) if one shared namespace for names gets crowded. Each of these is small to add on top of the store.

## Files

| File | What |
| --- | --- |
| `src/cli.js` | The `html-server` command (`html-server --help`); its usage text is in `src/usage.js` |
| `src/server.js` | HTTP routes (the table that also generates the Docs page) and their handlers |
| `src/store.js` | All database access, with the schema and its in-place upgrades |
| `src/pages.js` | Server-rendered pages: the site frame, home, notes, history, stats, graph, docs, review, diffs |
| `src/markdown.js` | Markdown notes: frontmatter, wikilinks, callouts, rendering |
| `src/notebook.js` | Jupyter notebooks: parsing, rendering cells and outputs |
| `src/highlight.js` | Syntax highlighting for code in notes and notebooks |
| `src/mcp.js` | The MCP server and its tools |
| `src/client.js` | How the CLI and MCP reach a server: saved login, one request helper |
| `src/text.js` | HTML to text, fuzzy matching (the same similarity measure as Python's difflib), search queries, line diffs |
| `src/lifecycle.js` | The active → trashed → purged state machine |
| `src/files.js` | Reads the package's own files: from disk under Node, from the deploy bundle on Cloudflare |
| `src/deploy.js` | `html-server deploy cloudflare` |
| `src/config.js` | Every tunable constant, with the reason for its value |
| `cloudflare/`, `wrangler.toml` | The Cloudflare Worker and Durable Object, its SQLite adapter, and the file bundler |
| `public/` | Browser code and styles: search, previews, graphs, the contents sidebar, frame sizing, copy buttons; `fonts/` with their licences |
| `gallery/` | The example pages shown at `/gallery` |
| `test/` | `npm test`: units, the HTTP API end to end with a fresh database per test, the CLI, MCP, Markdown, notebooks and the Cloudflare adapter |
| `CHANGELOG.md` | What each release changed |
| `~/.html-server/` | Your data (`artifacts.db`), the CLI's login (`credentials.json`), backups and the sync log. Not in the repo |

## Versioning

Releases are git tags, `vX.Y.Z`, following semantic versioning; [`CHANGELOG.md`](CHANGELOG.md)
says what each one changed, and `html-server --version` says which one you're on. Install a
specific release with `npm install -g github:lawwu/html-server#vX.Y.Z`, or the newest with
`#latest`; without the `#…` you get the latest `main`.

To cut a release, add its notes to the changelog's "Unreleased" section, then:

```bash
npm version minor          # or patch / major: bumps package.json, commits, tags
git push --follow-tags
```

Then move the `latest` tag to it. It doesn't move on its own, and existing installs update
only when the install is re-run:

```bash
git tag -fa latest -m "Moving tag: the newest release (currently vX.Y.Z)" "vX.Y.Z^{commit}"
git push -f origin refs/tags/latest
```

## License

MIT, see [`LICENSE`](LICENSE). The site's look follows [Quartz](https://github.com/jackyzha0/quartz)'s
default theme (MIT). The fonts are under the SIL Open Font License (licences in
`public/fonts`). The explain-diff gallery page follows Geoffrey Litt's explain-diff format,
and the featured page summarizes and links to Thariq Shihipar's article; both are credited
on the pages, and neither copies the original.
