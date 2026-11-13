# Changelog

Versions follow [semantic versioning](https://semver.org). While the version is
`0.x`, commands and the API may still change between minor versions; `1.0.0` will
mark them as stable. The README's [Stability](README.md#stability) section lists what
that covers. The database format is migrated in place on startup, and a change that
couldn't be migrated would be a major version.

## Unreleased

- CLI and MCP now support trash recovery, share-link retrieval/rotation, asset management and comment resolution. The CLI also downloads versioned source and provides consistent `--json` output for remote read commands.

- Change existing page visibility without re-uploading content: `html-server visibility NAME public|private` and MCP `set_page_visibility`. Owner-only access and share-link revocation use the existing server behavior.

- Browser sign-in, folder sync and page delivery now have dedicated modules. Browser
  forms share credential selection and identity caching, so single sign-on works even
  when the top bar script hasn't run. Sync decisions and failure-aware pruning can be
  tested independently of HTTP; page delivery keeps trusted site chrome and sandboxed
  documents explicit. Existing command output, page modes and database behavior are
  preserved, with additional regression coverage for these boundaries.

## 0.18.2 (2026-11-12)

- **Security: notes and notebooks no longer receive the viewer's unrelated private data.**
  Their scripts could read private navigation, graph data, hover previews and inline assets
  added to the document for a signed-in viewer. Surrounding content is now public only;
  assets must be authorized for the page itself or already public. Private notes and share
  links still show their own content and authorized assets.
- **Security: incomplete single sign-on configuration refuses startup.** Setting only some
  of the three required OIDC credentials, or leaving one blank, no longer silently turns
  sign-in off. The error names missing settings without printing secrets, before opening
  the database or creating the first admin.
- **PostgreSQL recovers after a failed commit.** Transaction depth is restored once even
  when commit or savepoint release fails. A rollback failure preserves the original error
  and discards the connection, so the next transaction can start cleanly.
- **Sync refuses duplicate asset names before changing the server.** Images or PDFs in
  different folders that map to one upload name no longer silently overwrite each other.
  Case and whitespace normalization are checked too, including in dry runs.
- **People usage stats count authenticated browser sessions and token rotation.** The
  request keeps the identity it actually authenticated, including permission errors;
  rejected or expired credentials are not attributed to a user.
- **The browser sign-in test tolerates the review's version query.** It verifies the
  destination path after the review has added `?v=1`, making the former CI race reproducible
  and testing the fix without relying on timing.

## 0.18.1 (2026-11-12)

- **The home page and folders show 48 pages at a time.** Previous and Next under the cards
  (`?page=N`) keep the search, tag, order and layout; a new search or order starts again at
  page 1, and every card on show now has its snippet. Before, a listing drew up to 500 cards
  at once, and only the first 48 had snippets. `/api/artifacts` is unchanged.
- **No GitHub links in the site's frame.** The top bar's version badge (with the GitHub
  mark) and the footer's "Source on GitHub" are gone; the footer still names the running
  version, linked to its release notes, and `/about` and `/docs` still say where the code is.
## 0.18.0 (2026-11-12)

- **People, in the admins' usage stats.** `/stats` shows admins each signed-in user's API
  calls (by kind of client), errors, pages viewed and when they were last seen; a name opens
  their activity, with the pages they viewed and the MCP tools and CLI commands they used
  most (`GET /api/stats/usage/people/NAME`). Who viewed which pages is recorded only after
  `html-server config track-people on` (off unless turned on): a view made while signed in
  then keeps its viewer, for as long as the view is kept, and each person's API calls are
  kept as daily totals past the 90 days of details. Anonymous visitors stay anonymous, and
  the Account page tells users when it's on. The database gains a `views.viewer_id` column
  and an `api_calls_user_daily` table on startup; nothing existing changes, and 0.17 runs
  on the upgraded database unchanged. `import-sqlite` copies both, and the setting.
- **Under the hood: the workflows' actions are locked.** Each workflow names exact action
  versions, and `.github/workflows/actions.lock` (GitHub's gh-actions-lock) records each
  one's commit, actions they use in turn included; CI fails if a workflow and the lock file
  disagree or a locked commit stops matching upstream. CI also runs zizmor, a security
  linter for workflows: following it, checkouts no longer leave the token in `.git/config`
  (but for the one that pushes the `latest` tag), the tests' workflow can only read the
  repository, and only the Pages deploy job may publish.
- **The install commands take the newest release.** The README's `npm install -g` lines,
  and the PostgreSQL driver's error message, now use `github:lawwu/html-server#latest`
  instead of `main`. Dependabot's patch and minor updates merge into `main` by themselves
  once CI passes, so `main` can carry an update no release has shipped yet; `#latest` only
  moves when a release is cut. The README also lists `openid-client` among the runtime
  dependencies, and `actions.yml` among the workflows.
- **Fixed: shell code blocks no longer grey out text after a `#` inside a word.** In
  Markdown and notebook code marked `bash`, `sh` or `zsh`, `#` now starts a comment only
  at the start of a word, as in a shell, so `pkg#v1`, `$#` and `${#var}` keep their colours.

## 0.17.1 (2026-11-09)

Fixes from a review of the whole app. Upgrade before turning single sign-on on for everyone.

- **Security: a page's category could run script on the graph page.** `/graph` drew each
  page's category (an HTML page's `<meta name="category">`, as written) into its legend as
  markup, so a page could run script as whoever opened the graph, with their saved token or
  their session. It's text now.
- **Security, single sign-on: a made-up token got past the sign-in.** Any `Authorization`
  header skipped it, and some pages (the home page's cards and search, share links) don't
  check a token themselves. A token is now checked before anything else, and a claims-only
  token goes only where it may.
- **Security, single sign-on: a public page's files without signing in.** `/assets/NAME?from=`
  with any value at all gave out any file a public page shows. Not signed in, a file now
  comes only through the page whose share link `from` is.
- **Security, single sign-on: an unverified email made an admin.** `OIDC_ADMIN_EMAILS` now
  counts an email only if the provider doesn't say it's unverified (`email_verified: false`).
- **Security: a GitHub claim link could take over an account that signs in with single
  sign-on** of the same name (a GitHub account called `alee` and Ann, `alee` through SSO). It's
  refused: they make their token on Account.
- **Security: share links' ids were in the server's log.** Logged as `/v/…` now, as claim
  links' codes already were.
- **Single sign-on: commenting in the browser works with the session alone.** The review
  page still asked for a pasted token. A token saved in the browser from before is also
  forgotten once signed in, so a replaced one no longer makes every change fail.
- **Single sign-on: an HTML page's images** (`/assets/NAME`) load, by its share link as a
  note's do; they were refused, since a sandboxed page's requests carry no sign-in.
- **Single sign-on: back to a page whose name isn't ASCII** after signing in, rather than an
  internal error.
- **Behind a reverse proxy:** `HTML_SERVER_PUBLIC_URL` gives the server its public address
  when the proxy changes what it sees, which signed-in browsers' changes were refused over
  (README: Behind a reverse proxy). Page views count each client by `X-Forwarded-For`, where
  everyone behind a proxy counted as one visitor a day.
- **PostgreSQL: a dropped connection is opened again** (a database restart, a failover, an
  idle connection closed on the way); every query failed until the server was restarted.
  A read that found it gone runs again; a change fails once.
- **The token page after GitHub sign-in** gives this server's install command, as the
  other claim page does, not GitHub's.
- **Copy HTML** says it couldn't load the page, rather than copying an error as the page.
- **Dark mode: tags and the "current" badge** are easier to read (the accent is a little
  lighter, for 4.5:1 contrast on their tint).

## 0.17.0 (2026-11-09)

- **Install the command line from your own server:** `npm install -g https://YOUR-SERVER/api/cli/html-server.tgz`
  installs the version that server runs, so nobody needs access to GitHub. The server packs
  itself (the files `npm pack` would ship, without the optional PostgreSQL driver) the first
  time someone asks. `GET /api/cli` says how; the address needs no sign-in, even with single
  sign-on. The **Account** page, a claim link's token page and `/docs` show the command with
  the server's address, and `html-server login` says when the command line and the server
  are different versions. Not on Cloudflare, where `/api/cli` gives the GitHub command.

## 0.16.0 (2026-11-09)

- **Claim links with GitHub sign-in take Enterprise Managed Users' logins,** which have an
  underscore before the enterprise's shortcode (`jdoe_acme`); a link for one was refused.
  The 39-character limit on logins is now enforced, as the error said it was.
- **Single sign-on through any OIDC provider** (Microsoft Entra ID, Okta, Google Workspace,
  Keycloak…), modelled on agile-tools'. With `OIDC_ISSUER`, `OIDC_CLIENT_ID` and
  `OIDC_CLIENT_SECRET` set, nothing is reachable without signing in: every page, share links
  and the API need a browser session or an API token. People make their own token on a new
  **Account** page (`/account`): one each, replaced by a new one, and an SSO user's token
  stops working after 30 days without signing in (`OIDC_TOKEN_IDLE_DAYS`). Admins come from
  `OIDC_ADMIN_EMAILS` or a role claim, on first sign-in only. The session cookie is ignored on
  requests an uploaded page makes, and on changes that don't come from the site's own pages.
  The README walks through Microsoft Entra. New: `openid-client` (MIT), a `sessions` table,
  and users' `oidc_issuer`, `oidc_sub`, `email` and `last_sso_at` columns, made on startup.
  `account` is now a reserved page name.
## 0.15.0 (2026-11-09)

- **GitHub sign-in for claim links.** Set a GitHub OAuth app's `GITHUB_CLIENT_ID` and
  `GITHUB_CLIENT_SECRET` on the server and a claim link is for a GitHub account: the page
  asks to **Continue with GitHub**, and only someone signed in as that account gets the
  token. Anyone else is refused, and the link stays good for its owner. The sign-in has to
  come back to the browser that started it. GitHub's token is revoked straight after; the
  server keeps the GitHub account's numeric id, in a new `users.github_id` column (unique),
  so each GitHub account has one account here however its login or email changes. On a
  server with email usernames, the username is the person's verified GitHub email, and the
  account is renamed if that changes. The README has the app's setup.
- **PostgreSQL: servers starting together no longer collide.** Getting the database ready
  checked for a function and then made it, so two connections starting at the same moment
  could both make it, and one failed. That setup now holds a database lock.
- **`config email-domains company.com`:** where email usernames may be, for every way a user
  is made. `config email-domains any` lifts it.
## 0.14.0 (2026-11-09)

- **Tokens from a GitHub workflow, never in its log.** `POST /api/users/NAME/claim` (admin)
  makes the user if needed and returns a one-time **claim link**, not a token. Opening it
  and pressing **Show my token** makes the token and shows it once, with **Sign in here**
  for that browser. It works once, for 15 minutes; a new link replaces an unused one, and
  the old token works until the link is used. The claim pages are never cached or sent as a
  Referer, and the server's log leaves the code out. The README has a workflow to copy that
  takes the username from the GitHub login running it; `html-server claim-link NAME` makes
  a link by hand. Links are kept in a new `token_claims` table, made on startup.
- **Claims-only users,** for that workflow's secret: `create-user NAME --claims-only` (or
  `"claims_only": true` on `POST /api/users`) makes a token that can only make claim links
  and replace itself. It can't publish, read, or manage users, and it can't make links for
  admins or other claims-only users. Admins' tokens can still make links. `GET /api/users`
  shows `claims_only`; a new `users.claims_only` column is added on startup.
## 0.13.0 (2026-11-07)

- **Upload from the browser.** The home page has an **Upload** button, and files dropped
  anywhere on it open the same dialog: HTML pages, Markdown notes and notebooks, and the
  images and PDFs notes embed. Choose the folder (a folder's page starts there), add a
  version note, tick Private; names come from the files, spaces as dashes, and can be
  changed first. It signs in with the token the site already keeps for comments, so
  publishing needs nothing installed. The CLI is unchanged, and `sync` is still the way to
  bring over a folder. On a phone, the home page's controls now wrap instead of running off
  the edge.
- **Sign out in the browser.** When this browser has your token saved (for uploads,
  comments, Select or Move), the top bar says who you're signed in as, with **Sign out** to
  forget it. Sandboxed note pages, which can't read the token, don't show it.
- **A bar across the top of every page,** with the site's name and version, its sections
  (Pages, Graph, Stats, Gallery, Docs, About), search, the light/dark switch and who's
  signed in; the current section is underlined. The left sidebar is your pages' explorer,
  on every page: the same frame everywhere, so moving between pages shifts nothing. Hiding
  the sidebar no longer hides the navigation, and the review page gets the same links as
  the rest of the site. The Random link is gone; `/random` still opens a random page.
- **About** (`/about`, in the top bar): why HTML, from Thariq Shihipar's essay "The
  unreasonable effectiveness of HTML", why a server for it, and effective-html's eight
  skills with the gallery's examples of each. It replaces the sidebar's Skills section;
  each of those examples still names its skill, linked, at the top. `about` is now a
  reserved page name: move a page or folder called `about` before updating.
- **A long explorer no longer runs over the next section** in the sidebar. With more pages than fit on
  screen, the explorer was squeezed to the window's height and its list drew on top of the
  next section; now the sidebar scrolls instead. The same goes for the contents and
  backlinks in a note's right sidebar.
- **A Docker image for each release,** `ghcr.io/lawwu/html-server`: Debian 13 (trixie) and
  Node 24, for amd64 and arm64, with the PostgreSQL driver built in and the data in a
  `/data` volume. Each one is run on both architectures, with SQLite and with PostgreSQL,
  before it's published. 0.12.0 is published too, built from its tag. See the README's
  Docker section.

## 0.12.0 (2026-11-06)

- **Node 24 or newer is required** (it was 22.16), so if you run HTML Server on Node 22,
  upgrade Node before you update. CI now tests one version, Node 24, and time zones moved
  from CI into the tests: each test that counts the server's local days (stats, usage,
  visits) runs itself in UTC, Los Angeles and Auckland, on any machine, where CI only
  reran everything in Los Angeles time. New ones cover the counts that had none:
  visitor-days, a page's views per day, uploads per week, and API calls folded into daily
  totals.
- **A page's views report covers the last 30 days on the calendar.** `html-server views`
  and `/api/artifacts/<name>/views` counted back 30 × 24 hours from now, so `last_30_days`
  could include part of a 31st day or, after the clocks went back, miss up to an hour of
  the oldest one. The report now starts at midnight 29 days ago, the way `/stats` does.
- **What 1.0 will promise.** A Stability section in the README lists the public interface
  (page addresses, the documented HTTP API, the command line, MCP tools, in-place data
  upgrades, Cloudflare deploys and the reserved names) and what isn't part of it, such as
  the site's look, undocumented API fields, the database tables and the code under `src/`.
- **Dependabot keeps dependencies current.** Each week it opens one pull request for npm
  (`marked`) and one for the GitHub Actions the workflows use. Patch and minor updates
  merge themselves once the tests pass; majors wait for review, since a new `marked` major
  can change every rendered page. A version is only proposed once it's a week old, so a
  hijacked release is likely pulled before it reaches `main`; security fixes don't wait.
- **"Open page" on the review page opens a private page too.** It linked to the page's own
  address, which needs a token a new tab doesn't send, so a private page opened as "not
  found". For the page's owner it now goes through the share link (the only people who get
  one, below), for the version on show; for anyone else, the page's address. It also gets
  `rel="noopener"`.
- **`[[topics]]` finds `guide/topics/index.md`.** A folder's index note answered to its
  folder's name only at the top level; deeper down a wikilink needed the whole path. `sync`
  now names an index note after its folder, and an upload or move without a name does too.
- **PostgreSQL storage, optional.** Set `DATABASE_URL` to a `postgres://` URI and the
  server and its server-side commands keep everything in PostgreSQL instead of SQLite:
  pages, versions, users, comments, tags, assets, usage. SQLite stays the default, and
  Cloudflare is unchanged. The driver, `pg-native`, is an optional dependency, loaded only
  when PostgreSQL is chosen. Search uses PostgreSQL's full-text search, with the same
  prefix, word-form and typo matching. Names compare as the database compares them:
  PostgreSQL folds the case of every letter (SQLite only ASCII's), and moves, old
  addresses and backlinks follow it. On PostgreSQL the first run makes no admin, and
  `backup` points to `pg_dump`. Queries are synchronous and one server process per
  database is assumed; see the README's PostgreSQL section.
- **`html-server import-sqlite PATH`** moves a SQLite database into the PostgreSQL that
  `DATABASE_URL` names. It previews by default, checking both sides and importing nothing,
  and imports with `--apply`. It works from a private, upgraded snapshot (the file is only
  ever read) and refuses reserved or ambiguous addresses and NUL characters. It never
  merges into a database already in use, and replaces usage records from before the move
  only with `--replace-telemetry`. It copies everything in one transaction, keeping ids
  and bytes, rebuilds search and links, and checks each table by count and SHA-256 before
  keeping any of it.
- **`/healthz`** answers `{"status":"ok"}` (GET or HEAD) once the database answers, and a
  503 otherwise, for load balancers and uptime monitors. It isn't counted as API use.
  `healthz` is now a reserved page name.
- **The tests run on PostgreSQL too** (`TEST_DATABASE_URL`), and CI runs them there as
  well as on SQLite.
- **Tests leave your git setup alone.** The sync tests' throwaway repositories ignore your
  global and system git config, so a global `core.hooksPath` no longer receives (or runs)
  their hooks.
- **Privacy boundaries:** share URLs are owner-only; public-to-private changes revoke old
  capabilities, and owners can explicitly rotate a share link. Open editors cannot grant
  access to an owner's private or future assets. Existing owner-authored asset references
  are migrated to explicit grants, including readable history.
- **Server and storage:** malformed request targets return 400 without terminating Node;
  column migrations and backfills commit together; caches notice other SQLite writers;
  large hover-preview queries stay within Cloudflare's binding limit.
- **Safer publishing:** sync parses YAML exclusions (including inline lists), refuses
  unsupported exclusion configs, skips symlinks and prunes an empty source folder. MCP
  validates argument types before side effects. Failed deploy verification preserves the
  existing login and keeps separate private recovery credentials.
- **Browser behavior:** review links navigate out of their sandboxed frame; graph links
  work with Enter; search and graph dialogs contain and restore focus. Contrast and view
  toggle semantics are corrected, and code/table overflow regions support keyboard focus.
- **Static site:** browser-parsed attribute syntax and fragment checks catch broken links;
  preview fragments point to their source page. Example bytes and metadata use one snapshot.
  Added browser regression tests and CI coverage; YAML is a second runtime dependency.

## 0.11.0 (2026-11-04)

- **Random page.** A Random link in the sidebar opens a random page you can see, never the
  one you're on (unless it's the only one). `/random?folder=…` or `?category=…` picks one
  in a folder or with a tag. `random` is now a reserved page name.
- **Popular pages on `/stats`,** in place of the all-time most viewed: the pages with the
  most visits over the last 2 weeks, or the period picked beside the list (1 week to a year,
  or all time; `?weeks=` takes any number up to 520). A visit counts each visitor once a day
  per page, so reloading a page while you edit it doesn't make it popular. Hover a page for
  its visits and views. `/api/stats` has the list as `popular`; `most_viewed` stays, all time.
- **⌘K works inside HTML pages in the frame.** A framed page runs sandboxed, so once you had
  clicked into it, its key presses never reached the search. Now ⌘K and Ctrl+K open it from
  there too, unless the page uses those keys itself.
- **Links in a framed HTML page open in the tab.** Following a link from one page to another
  loaded the next page inside the first one's frame, under its title, address and sidebar;
  `target="_top"` links did nothing, and other sites opened inside the frame. Now the tab
  goes there, as it would without the frame. The frame follows a link only just after a
  click or key press in the page, so a page still can't send the tab anywhere by itself.
  Links to a place on the page, new-tab links and ⌘-clicks work as before.
- **Hide the sidebar.** A button at the sidebar's top left hides it and brings it back from
  the same place, and the choice is kept like light/dark (sandboxed notes get it by
  cookie). On a phone the sidebar stays above the page.
- **HTML pages in the frame use the whole width** beside the sidebar (all of it with the
  sidebar hidden), instead of the 750px that notes keep for reading.
- **Skills in the sidebar, with 16 new gallery examples.** A Skills section lists the eight
  skills of [effective-html](https://github.com/plannotator/effective-html) (MIT), each with
  two examples in the gallery, one on data, data science or machine learning and one on
  Claude Code (drawn from its docs), and a link to the skill. The gallery groups them as
  Effective HTML, and each example's title bar names the skill it shows, linked to it.
- **Two showcases and three maps in the gallery.** With the `html` skill: Google's
  [Rules of Machine Learning](https://developers.google.com/machine-learning/guides/rules-of-ml)
  (CC BY 4.0) as a field reference you can search and filter, and a tour of the
  [Agentic ML plugin](https://github.com/lawwu/agentic-ml-plugin). Maps of content for machine
  learning, Claude Code and effective-html link the related gallery pages, in their own
  Maps of content group, which the gallery shows right after Featured.
- **Gallery examples open in the site's frame,** like your own pages: the sidebar, a title
  bar, ⌘K, and links that move the tab. `?raw=1` is the example alone.

## 0.10.1 (2026-10-30)

- **A malformed link no longer stops a note publishing, or the server starting.** A
  Markdown link to `/pages/` and something no page could be called (`[x](/pages/[y)`,
  `/pages/%5By`) failed the upload with an internal error; a note with one from before
  0.10.0 stopped the server starting, since links are read again then. Such a link is now
  an ordinary link, not one to a page, and a link kept as a list of names is read with care.
- **`[[features]]` finds `features/index.md` again.** Before folders, sync named a folder's
  `index.md` after the folder (`features.md`), so `[[features]]` found it; synced at its
  folder path, or moved there, it went unfound. A folder's name now also means its index
  note, after any page actually called that.
- **Syncing a vault from another checkout keeps its pages.** Sync knew the pages it made
  only by the folder it ran in, so from another checkout or folder of the same vault, a
  nested file that an older sync had published under a flat name (`notes/plan.md` →
  `notes-plan.md`) got a second page at its folder path. Now that page is the file's again
  when it was synced from that file's path and is yours to edit; another page that just
  has the name is left alone.
- **A page in a folder needs its file extension.** `/api/artifacts/plan/comments` is
  `plan`'s comments, but 0.10.0 also let a page be called `plan/comments`, which its own
  routes could never reach (nor `…/pin`, `…/restore`, `…/views`). Names in folders now end
  in `.html`, `.md` or `.ipynb`. Top-level names may still leave it off, reading still
  forgives a missing one, and folders browse as before. A page named without one takes
  `.html` when moved into a folder, and one already named that way can be moved to a name
  with one.
- **Listings count everything, and say when they stop.** The home page, a folder and a
  search of either show up to 500 cards, and their count stopped there too: a folder of 800
  pages said "500 pages". They now count every page or match you can see, add "showing the
  first 500" when that's fewer, and live search keeps the count as you type, in the folder
  you're in.
- **The review page shows history in place, and a private page's changes.** History and
  **Show changes** were plain links, which a browser follows without the saved token, so a
  private page's were "not found". The review page now asks with the token: **History**
  opens the version table and Compare in place, and changes show in a sandboxed frame (no
  scripts, no way to the token), as the page does.
- **Gallery previews can only draw.** A card's preview ran with the page's whole sandbox,
  so a page could show alerts or open windows over the gallery, or, with `serve
  --sandbox-allow allow-top-navigation`, send the gallery's tab elsewhere. A preview now
  runs the page's scripts and nothing else. Category chips leave ⌘-, Ctrl- and
  Shift-clicks to the browser, which opens them in a new tab or window.
- **Pasted SVGs in notebooks show.** An SVG attachment kept as its text, as some tools save
  it, was read as base64 and showed as a broken image.
- **On Cloudflare, an oversized upload is refused before it's read.** The Worker read a
  whole request into memory before the size check, so one far over the 1.9 MB limit could
  run the Durable Object out of memory. It now refuses a `Content-Length` over the limit
  unread, and stops reading a chunked upload at the limit.
- **`deploy cloudflare` never guesses about the admin token.** When it couldn't read the
  Worker's secrets (a network error, unexpected output), it took the deployment for a new
  one: it replaced the `ADMIN_TOKEN` secret and signed this CLI in with a token the server
  didn't know. Now it stops and says so; the new code is deployed, and nothing else changes.
- **`#latest` follows every release.** A workflow moves the `latest` tag to the newest
  `vX.Y.Z` whenever a release tag is pushed, so `npm install -g
  github:lawwu/html-server#latest` installs the newest release. Moved by hand, it stayed at
  0.7.1 through 0.9.1.

## 0.10.0 (2026-10-30)

- **Folders, and moving pages without breaking links.** Publish into folders
  (`put --folder research`, or `--name research/report.html`): a nested page opens at
  `/research/report.html`, and `/research/` lists its pages and subfolders, with search
  and sorting. Folders show in the explorer and breadcrumbs. Move pages with
  `html-server mv`, **Move…** on a page or on a selection, `POST /api/moves` or MCP's
  `move_pages`; a bulk move happens entirely or not at all. A moved page keeps its
  versions, comments, tags, views and share link, its old addresses redirect, and its
  relative links still go where they went when it was written. `sync` publishes new
  files at their folder paths (`plugins/Backlinks.md` → `/plugins/Backlinks.md`);
  pages it published before keep their flat addresses until
  `sync --migrate-paths` (see first with `--dry-run`), and sync mentions them until then.
- **Contents links in HTML pages work in the site's frame.** A link to a `#section` of a
  page shown in the frame did nothing: the frame is as tall as the page, so the page
  itself never scrolls. Now the window scrolls there.
- **A docs site, drawn by HTML Server itself:** the Docs page, the README, the changelog
  and the example gallery as static pages on GitHub Pages, at
  https://lawwu.github.io/html-server/. `npm run site` builds them into `_site/`, and
  `.github/workflows/pages.yml` publishes them on every push to `main`. Each page is what
  the server's own request handler answers, so the site can't drift from the code. Links
  are made relative, and a link the static site can't follow fails the build. Search,
  history, comments and the Graph and Stats pages need a server, so the site leaves them
  out. Hover previews now also work on links that aren't `/pages/…`, as the site's aren't.
- **The Docs page's link to its own Markdown works.** "This page is Markdown: /docs.md"
  led to `/pages/docs.md`, a 404: a link to `/docs.md` was read as a link to a page. The
  docs site's link check found it.
- The README no longer says the repo is private.

## 0.9.1 (2026-10-28)

- **Search puts title matches first, whatever the order.** Pages whose title holds the
  whole query come first, then pages whose title has every word typed (`ACC 18`,
  `[ACC-18]`), and only then the rest, also when results are sorted by date, views or title.
  The home page remembers the sort you last picked, so a search there sorted by Recently
  updated put the ticket called ACC-18 eighth, below each newer page that mentioned it.

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
