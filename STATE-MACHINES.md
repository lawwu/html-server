# State machines in HTML Server

Workflows here include persisted lifecycles, asynchronous operations, browser interaction
modes and resource lifetimes. A state machine exists whenever the next event means
something different because of what happened before. A boolean is sufficient for some
of these; a transition table is useful when several events have different legal states.

The implementation decision is to retain the existing domain rules and extract the two
repeated asynchronous rules into [public/async-state.js](public/async-state.js). This
keeps behavior local without adding a framework, changing storage or changing the HTTP,
CLI and MCP contracts. The inventory below covers application code in `src/`, `public/`,
`cloudflare/` and `scripts/`; the gallery's independent demonstrations are listed separately.

## Shared asynchronous rules

| Workflow | States and events | Interface and invariant |
| --- | --- | --- |
| Replaceable read | Idle → pending on `start`; pending → new pending on another `start`; pending → idle on `finish` or `cancel` | `latestRequest()` creates an owner with `pending`, `start()` and `cancel()`. Each `owner.start()` returns a distinct request handle with `signal`, the boolean getter `current`, and `finish()`. Only the current handle may update UI, caches, focus or location. Check after the response body has been read, including on failures. Finishing an obsolete handle cannot finish its successor. |
| User initiated write | Idle → pending on `run`; pending → idle on success or failure | `singleAction(onChange)` ignores repeated events while pending and releases the guard in `finally`. Controls reflect pending state. It never queues, aborts or automatically retries writes. |

Cancel reads when intent changes, including during a debounce, on modal close and before
loading a different version. Query equality does not identify a request: search A, then
B, then A must invalidate the first A. An abort signal alone is insufficient because
the response or its body may already be available.

Create one owner for each independently replaceable read, such as the selected version's
metadata. Start each attempt with `const request = owner.start()`, pass `request.signal`
to the request, and check `if (!request.current) return` after reading its body. Guard
error handling the same way and call `request.finish()` in cleanup. Use `owner.cancel()`
when closing the view or abandoning the request without starting a replacement.
Cancellation must also settle its visible state: remove a loading panel, restore the
previous content, or show an error with a recovery action. Clear `aria-busy` when an
operation stops without a replacement. Stale request cleanup cannot do that for its successor.

Capture write inputs before awaiting anything. A rejected connection does not prove
that a server write failed to commit. The browser prevents overlapping submissions
within an operation; it does not promise exactly-once delivery across reloads, tabs or
manual retries. Upload and move dialogs remain open while a write is pending, because
closing a dialog cannot undo that write.

Tests: [async-state.test.js](test/async-state.test.js) checks ownership and release;
[browser.check.js](test/browser.check.js) deliberately delivers stale reads despite
cancellation and submits forms again while a write is pending.

## Browser workflows

| Workflow and owner | States and transitions | Decision and safeguards |
| --- | --- | --- |
| Gallery reads — `public/gallery.js` | Showing results → waiting for typing → loading → results or error; cache hit skips loading | Shared read ownership; invalidate immediately on typing. Current failures preserve the cards and show a retry message. Query, category, sort, page and view are independent dimensions; a changed query or sort resets pagination. |
| Gallery selection and bulk edits — `public/gallery.js` | Browsing ↔ selecting; selection → submitting → results, partial failure or sign-in needed | Shared write guard; snapshot selected page names. Refresh after partial success as well as success. Rejected credentials reopen sign-in. Selection remains independent of filtering and layout. |
| Upload dialog — `public/upload.js` | Closed → editing → uploading → editing → closed | Native dialog owns open/closed state; shared write guard owns uploading. Snapshot names, folder, note, privacy and token before sending. Disable edits and dismissal while pending. New drops join the next batch. |
| Upload rows — `public/upload.js` | `queued` → `uploading` → `done` or `failed`; `failed` → `uploading`; unsupported files → `skip` | Explicit row states. Retry only queued/failed rows. A 401 stops the batch, preserves remaining rows and refreshes successful uploads. Done rows keep their result links. |
| File drag overlay — `public/upload.js` | Outside → inside nested drag targets → outside/drop | Keep the depth counter: a simple boolean would clear the overlay when crossing children. Drop resets depth and rejects folders with guidance to use sync. |
| Move dialog — `public/move.js` | Closed → editing/previewing → submitting → closed on success, editing on failure | Shared write guard; controls and Escape cannot dismiss an uncertain write. Existing server transaction still makes bulk moves atomic. Folder suggestions are optional. |
| Global search — `public/search.js` | Closed ↔ open; empty → waiting → loading → results, no matches or local-title fallback; keyboard selection | Shared read ownership. Closing clears the timer and invalidates the read. New typing clears selectable stale results. HTTP failures use the same title fallback as unavailable network access. |
| Review version — `public/review.js` | Loading → selected version or load error; changing version restarts loading | Separate read ownership for metadata, comments, diffs and identity. A version change invalidates comments and diffs immediately. If the metadata read fails after cancelling a comparison, restore the previously selected page instead of leaving an abandoned diff loading screen. A stale metadata response cannot change the version, URL or frame. |
| Review presentation — `public/review.js` | Page ↔ diff; diff loading → rendered diff or error; history hidden ↔ shown | `view` names the mode. Each diff has unique ownership, including repeated requests for the same comparison. History visibility remains a native DOM state. |
| Review comments and restore — `public/review.js` | Ready → submitting → refreshed comments or error; restore success → newly appended version selected | Shared write guard prevents duplicate comments and restores. A successful restore reloads metadata, selects and displays the appended version, updates its URL and controls, and loads its comments. Version and editing controls reflect pending writes. Comment fetch errors are displayed instead of becoming unhandled rejections. |
| Usage and person details — `public/stats.js` | Usage loading → displayed/sign-in/error; person closed → loading → displayed/error → closed | Separate read ownership for usage and person detail. New periods invalidate person reads, hide the detail panel and reset its expanded link; explicit close does the same and returns focus to that link. A failed refresh can reattach the sign-in form after successful rendering replaced it. Cancelling sign-in with an empty token clears the usage region's busy state. |
| Popular period — `public/stats.js` | Showing → loading → showing, or full-page navigation after current failure | Shared read ownership also guards the navigation fallback. An older failure must never navigate away from the latest choice. |
| Browser credentials — `public/signin.js`, `public/session.js` | Guest, saved token or SSO session; persistent/volatile token storage; identity uncached → pending → cached/rejected | Keep the existing deep module. SSO takes precedence, failed storage has an in-memory fallback, identical identity reads share a promise, token changes invalidate identity, and the top bar uses a revision guard. Tests: `signin.test.js`, `sso.check.js`. |
| Modal focus — `public/modal.js`, search and minigraph callers | Released → trapped → released | Keep the existing module. Preserve background inert values, trap Tab, restore the invoker, and release on close. Search's restoring-focus flag prevents immediately reopening itself. Browser focus tests cover this. |
| Graph interaction — `public/graph.js`, `public/minigraph.js` | Idle ↔ hover/focus; idle → node drag or pan → idle; local ↔ expanded; normal ↔ fullscreen | Keep the local interaction models. Pointer movement distinguishes clicking from dragging; category/tag filters and zoom are independent values. Expanded graph close releases focus and stops its simulation. |
| Graph simulation — `public/graph.js`, `public/minigraph.js` | Warm/running → cooling → settled; interaction reheats; minigraph unmount stops | Keep numerical simulation state separate from interaction state. Heat, positions and velocities are continuous data, not a finite set of application states. |
| Hover previews — `public/popover.js` | Hidden → show timer → visible → hide timer → hidden; entering preview cancels hide | Keep local timers and allowlisted preview construction. Scroll removes a shown preview. |
| Statistics tooltip — `public/stats.js` | Hidden ↔ pointer/focus target | Keep local DOM state; pointer movement changes the current mark and focus-out hides the tooltip. |
| Contents — `public/toc.js` | Docked or drawer; drawer closed ↔ open; active heading changes with scroll | Keep presentation choices local. Resize chooses layout; Escape closes the drawer; navigation and scroll choose the highlighted heading. |
| Embedded sizing — `public/embed-size.js`, frame script in `src/pages.js` | Not started → measuring → content-height sizing or window-height sizing | Native browser sizing or script-reported height makes the embedded frame fit its content. Viewport-filling pages or repeated growth instead keep the frame at window height; this does not open a new window, and lasts until the containing page reloads or the iframe element is recreated. Reloading or navigating the embedded document within that iframe does not reset its sizing mode. Frame and timer may both start measurement, but only once. |
| Copy feedback — `public/copy.js`, account/claim scripts in `src/pages.js` | Ready → source loading → clipboard/fallback → copied/error → label reset | Keep clipboard permission handling local. A failed source read is never copied as content. Feedback timers are replaced on subsequent attempts. |
| Theme, sidebar and token buttons — `src/pages.js` | System/manual theme; sidebar visible/hidden; token rotation ready/pending/result; claim token unsaved/saved | Keep these small local models. Rotation disables its button; storage writes are guarded. These do not need a general state-machine engine. |

The browser regression suite exercises the changed reads and writes, ordinary upload and
move flows, search/graph focus, mobile layouts, accessibility and SSO isolation. Graph
simulation, hover timers and clipboard permission paths retain their existing designs;
the inventory is not a claim of exhaustive transition testing for every row.

## Persisted domain workflows

| Workflow and owner | States and transitions | Existing invariant and tests |
| --- | --- | --- |
| Page lifecycle — `src/lifecycle.js`, `Store.apply` | None → active; active update → active; active → trashed; trashed → active or purged | Already an explicit transition table. Purge is terminal for that identity; forbidden pairs return 409 with allowed events. `units.test.js`, `server.test.js`. |
| Version editing — `Store.putVersion`, `restoreVersion`, MCP `publish_page` | Missing → first version; current base → appended version; stale base → conflict; restore → appended copy | History is immutable. Optimistic concurrency protects agents using `base_version`; an old version never becomes an overwrite. `server.test.js`, `mcp.test.js`. |
| Address ownership — `Store.movePages`, address lookups | Current address → reserved redirect; destination → current; purge releases addresses | Moves are atomic and preserve page identity and history. An occupied address is refused; writes to old addresses are refused. `server.test.js`, `cli.test.js`. |
| Visibility and sharing — `Store.setVisibility`, `rotateShare`, render/access methods | Public ↔ private; current share → rotated/revoked; active share becomes unusable when trashed/purged | Visibility is independent of lifecycle. A share grants access to one active page and authorized assets, not its folder. `server.test.js`, `sandbox.test.js`, `page-delivery.test.js`. |
| Assets and grants — `Store.putAsset`, `setAssetRefs`, `ensureAssetGrants`, `deleteAsset` | Absent → owned asset → replacement/deletion; page references establish authorized grants | Ownership and historical grants govern access, including after edits and moves. A mention by an editor does not grant another owner's asset. `audit-store.test.js`, `server.test.js`, `sso.check.js`. |
| Comments — `Store.addComment`, `resolveComment`, `deleteComment` | Root open ↔ resolved → deleted; replies attach to a root and inherit its version | No replies to replies; only author or page owner changes a comment; deleting a root cascades replies. `server.test.js`, `mcp.test.js`. |
| API tokens and direct claims — `Store.resetToken`, `claimLink`, `claimToken` | Token current → replaced; claim issued → consumed, expired or superseded | Claim consumption and rotation are transactional; a claim can be used once. A claims-only account can issue token claim links for ordinary users and rotate its own token; it cannot read or publish pages, manage users, or issue links for admins or other claims-only accounts. See [account roles](README.md#users-and-admins). `server.test.js`, `cli.test.js`. |
| GitHub claims — `Store.startGitHubClaim`, `finishGitHubClaim`, server callback | Issued → browser round trip → consumed; wrong account leaves claim usable; expiration/supersession invalidates it | Latest start wins; callback checks browser state and stable GitHub identity before linking/creating an account. `github-signin.test.js`, browser claim check. |
| SSO login and sessions — `src/sso.js`, `Store.ssoSignIn`, session methods | Login started → callback validated → local session; rejection clears login cookie; session active → expired/revoked | PKCE, state and nonce validation; account linking follows issuer/subject rules; logout removes the local session. Provider discovery is cached per configuration. `sso.test.js`, `sso.check.js`. |

## Server and command workflows

| Workflow and owner | States and transitions | Existing safeguard and tests |
| --- | --- | --- |
| Folder sync — `src/sync.js`, `src/sync-remote.js` | Discover → preflight → inventory → reconcile → optional prune → report; each file new/updated/renamed/moved/unchanged/skipped/failed | Sequential reconciliation preserves source identity. Dry runs perform no remote mutation. Any reconciliation failure suppresses pruning. `sync.test.js`, `cli.test.js`. |
| Cloudflare deployment — `src/deploy.js` | Authenticate → deploy → inspect secrets → update complete, or bootstrap → verify → save credentials | Unknown secret state never replaces credentials. Recovery credentials remain if bootstrap cannot be verified. `deploy.test.js`, `cli.test.js`. |
| Server bootstrap — `src/cli.js`, `cloudflare/worker.js` | Uninitialized → first admin → serving, or awaiting explicit setup | Bootstrap only an empty user store; later starts preserve accounts. Node PostgreSQL and email-username deployments wait for explicit account setup. Cloudflare bootstraps from its admin secret. `cli.test.js`, `cloudflare.test.js`. |
| Backup — `src/cli.js` | Choose unused destination → copy → integrity check → retain/prune | Never overwrite a destination; verify before retention cleanup. `cli.test.js`. |
| SQLite import — `src/import-sqlite.js` | Snapshot → inspect → refuse/preview, or transaction → copy → rebuild → verify → commit; failure rolls back; snapshot closes | Source remains untouched; destination must qualify; only verified imported content commits. `import-sqlite.test.js`. |
| Database transaction — `Store.tx`, `PostgresDatabase.transaction`, `DurableSqlite.transaction` | Outside → transaction/savepoint → commit or rollback → outside | Backend adapters own transaction mechanics. Failed PostgreSQL cleanup discards the connection. `postgres.test.js`, `cloudflare.test.js`, store/HTTP integration tests. |
| PostgreSQL connection — `src/postgres.js` | Connected → lost → reconnectable; close → terminal; transaction depth restricts reconnect | Only eligible reads retry after loss; uncertain writes/commit do not replay. `postgres.test.js` covers loss and rollback with a fake driver; live tests require `TEST_DATABASE_URL`. |
| Derived indexes and caches — `src/store.js` | Missing/outdated → rebuilt; cached → invalidated → recomputed | Writes increment revision and invalidate derived views. SQLite data-version changes detect other connections. Search/link/grant initialization has migration markers. `audit-store.test.js`, `server.test.js`. |
| HTTP request and response — `src/server.js`, `cloudflare/body.js`, `cloudflare/worker.js` | Receiving → complete/too large/error; unresponded → headers sent → ended | Size limits stop oversized reads; errors respect response state; Cloudflare adapts to the same handler. `http-boundary.test.js`, `cloudflare.test.js`, `server.test.js`. |
| MCP input queue — `src/mcp.js` | Idle → pumping → idle; stdin close → drain → exit | Serialize queued lines, distinguish notifications from requests, validate arguments before effects. `mcp.test.js`. No extra protocol handshake state is invented. |
| Package and static site builds — `src/package.js`, `src/files.js`, `src/examples.js`, `scripts/build-site.js` | Package/cache missing → built/cached; site destination checked → generated → link-checked | Keep build/cache lifetimes local; site refuses a directory it does not own. `package.test.js`, `site.test.js`. |
| Parsers — `src/markdown.js`, SQL scanner in `src/postgres.js`, argument handling in `src/cli.js` | Frontmatter key/list and fenced-code states; SQL code/quoted-string/quoted-identifier/line-comment states; argument scanning | Local state exists only for one parse and is best kept in its parser. `markdown.test.js`, `postgres.test.js`, `cli.test.js`. |

Page delivery (`src/page-delivery.js`) chooses trusted site, sandboxed artifact or redirect
from a request's facts. Raw, preview, framed, historical and shared delivery are modes of
one request, not a persisted lifecycle. Likewise roles, content types, privacy and graph
filters are independent dimensions; combining them into one giant state enum would make
both reasoning and compatibility harder.

## Gallery demonstrations

The HTML under `gallery/` is independently sandboxed example content. Its simulation
state must not be coupled to trusted site modules. These examples retain their own
controls and state:

- `artifact-lifecycle-state-machine.html`: explicit lifecycle plus animation busy state.
- `ticket-triage-board.html`: ticket column, size, drag target, adding/reordering tickets,
  export feedback and board reset.
- `review-labeling-prototype.html`: labeling, reason entry, batch review/submission,
  completion, skipped items, undo history and transient busy state.
- `kmeans-step-through.html`, `gradient-descent-loss-surface.html`,
  `central-limit-theorem-sampler.html`, `easing-curve-tuner.html`: step/play/pause/reset,
  algorithm parameters, accumulated results and animation progress.
- `claude-code-context-window.html`, `claude-code-hooks-lifecycle.html`,
  `claude-code-settings-precedence.html`, `claude-code-permission-prompt-prototype.html`,
  `claude-code-permissions-wireframes.html`: illustrated workflow steps, selections,
  configuration or permission choices, and demonstration feedback.
- `ab-test-readout.html`, `anscombes-quartet-notebook.html`,
  `birthday-paradox-explainer.html`, `churn-model-v3-recap.html`,
  `model-card-birdsong-classifier.html`, `precision-recall-threshold.html`,
  `simpsons-paradox-berkeley-1973.html`: selected data/parameters, chart focus and
  inspection controls; outputs are derived from those inputs.
- `agentic-ml-plugin.html`, `artifact-server-architecture.html`,
  `model-monitoring-wireframes.html`, `pr-review-archived-state.html`,
  `rag-pipeline-diagram.html`, `rules-of-ml.html`: tabs, filters, selected paths,
  steps or inspection targets.
- `claude-code-pocket-reference.html`, `claude-code-rollout-plan.html`,
  `claude-code-team-setup-one-pager.html`, `explain-diff-art-cli-pipeline-fix.html`,
  `realtime-fraud-scoring-rollout-plan.html`: local navigation, disclosure, copy or
  tooltip interactions. The MOC and featured essay pages are static content.

These examples are inventoried, not refactored or exhaustively interaction-tested by
the browser workflow changes.

## Verification

Run `npm test` for domain, HTTP, CLI, MCP, packaging, static-site and helper coverage.
Run `npm run test:browser` for the browser workflows, including delayed response,
duplicate submission, authentication recovery, focus and accessibility regressions.
Run the backend suite with `TEST_DATABASE_URL` when checking a live PostgreSQL adapter.
No new dependency or database migration is required.
