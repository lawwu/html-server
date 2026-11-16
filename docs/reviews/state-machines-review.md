# Independent Elephant–Goldfish review of state workflows

The initial review found three browser recovery defects and four documentation gaps.
All seven findings were accepted and addressed. The underlying design remains two
small shared helpers, with domain state and simple presentation state owned locally.

## Scope and method

Reviewed the uncommitted state-machine changes against commit
`febc16b88a5b0bb4dcdee8b84cae0af4cf6a8eda`, including the new
[`STATE-MACHINES.md`](../../STATE-MACHINES.md),
[`public/async-state.js`](../../public/async-state.js) and helper tests.
The baseline code diff was saved before remediation; production files and the workflow
document remained unchanged until the initial code reviews finished.

This applies the [EGM guide](https://github.com/google/elephant-goldfish-model/blob/main/docs/getting_started.md)
to an existing implementation. It is an adapted review, rather than the full five-stage
design-document pipeline or an invocation of an installed EGM plugin. The review used
the upstream reviewer personas and standards retrieved through GitHub, with the native
fresh-context setup described in [EGM's Codex integration](https://github.com/google/elephant-goldfish-model/blob/main/docs/codex.md).

Three independent reviewers started with `fork_turns: "none"`. They received no parent
conversation, prior praise, proposed fixes or other reviewers' findings. They confirmed
reading their assigned personas and standards. Fresh conversation context does not
isolate the shared filesystem or host instructions. No applicable project `AGENTS.md`
was found. Reviewers were read-only; the primary agent reproduced failures, made fixes
and ran tests.

| Reviewer | Reading scope | Review criteria |
| --- | --- | --- |
| Comprehension | Workflow document only, with the comprehension persona | Can a new developer or agent explain the system and use its documented rules without chat history? |
| Design and standards | Workflow document, diff, code, README design notes, glossary and tests | Zoom-out, design-critic and style personas; zoom-out and feature-spec standards, applied proportionately to an inventory; simplicity, reuse and UX/DX/AX consequences. |
| Implementation and specification | Workflow document, diff, code, baseline documentation and tests | Codebase-details and implementation-readiness personas and readiness standard; claimed behavior versus code, failure recovery and test coverage. |

The latter two reviewers independently identified the same two cancellation defects.
Neither found a reason to introduce a state-machine framework or replace the helpers
with the existing sign-in promise cache or top-bar revision guard.

## Findings and resolution

IDs C, D and I refer to the initial comprehension, design and implementation findings.
Line references in those initial reports identify the pre-remediation version.

| ID | Source findings | Finding and consequence | Resolution |
| --- | --- | --- | --- |
| R1 | D1, I1 — Major/P2 | Changing usage period cancels a pending person read. If the period refresh fails, the old panel remains “Loading…” with its link expanded, although nothing can finish it. | `closePerson()` in `public/stats.js` now couples cancellation with hiding the panel and resetting its expanded link. Explicit close also restores focus. |
| R2 | D2, I2 — Major/P2 | Starting a version switch cancels the diff. If metadata fails, the frame remains “Loading changes…” indefinitely. | The current metadata failure restores the previously selected page when a comparison was cancelled, while retaining the error and resetting the version selector. |
| R3 | D3 — Nit/P2 | A guest submits a token, then clears and resubmits it while usage is loading. Cancellation returns early and leaves the region permanently `aria-busy="true"`. | The no-credentials exit now clears busy state. A late response cannot render content or save the abandoned token. |
| R4 | C1 — Major; I3 — Nit | The document incorrectly says `latestRequest()` returns the per-request handle, obscuring the main interface for new callers. | Documented the owner (`pending`, `start`, `cancel`) separately from the handle returned by `start()` (`signal`, boolean `current`, `finish`), with a concrete call/check sequence. |
| R5 | C2 — Nit | Restore's browser success outcome was described only as refreshed comments. | Documented selection and display of the appended version, metadata/URL/control updates and comment loading. |
| R6 | C3 — Nit | “Window mode” did not explain frame sizing or how long it lasts. | Defined content-height versus window-height embedding. The fresh re-audit corrected the reset boundary: window mode persists until the containing page reloads or the iframe element is recreated; child-document navigation or reload does not reset it. |
| R7 | C4 — Nit | “Claims-only” and “privileged accounts” were undefined in the security rule. | Described claims-only permissions and prohibited targets, and linked the account-role documentation. |

R1 and R2 improve UX by replacing abandoned loading displays with coherent states.
R3 keeps accessibility state aligned with the request lifecycle. The shared close path
reduces duplicated cleanup for DX. R4–R7 make the interface and outcomes usable without
unstated project context, improving both DX and AX.

The common cause was incomplete cancellation handling: request ownership was invalidated,
but the UI state owned by that request was not always settled. The workflow document now
requires cancellation to settle visible loading and accessibility state as well.

## Independent comprehension result

### What this proposes

The document records a focused refactor of an existing application: consolidate replaceable
reads and guarded user writes in `public/async-state.js`, while retaining existing domain
rules, storage and external contracts. Read ownership prevents obsolete responses from
changing the interface, and write guards prevent overlapping submissions within an
operation. Other state remains local to its existing component; the gallery demonstrations
are inventoried but excluded from the refactor.

### How the existing system works, per this document

Browser workflows manage asynchronous reads and writes alongside dialogs, focus,
interaction modes and resource lifetimes. Persisted workflows enforce page lifecycle,
immutable versions, address ownership, access rules, comments and authentication. Server
and command workflows manage synchronization, deployment, database operations and request
processing. The document distinguishes these lifecycles from independent values and
request modes, and identifies relevant tests without claiming exhaustive transition coverage.

The primary agent checked this paraphrase against the intended scope; it matches the
change's purpose. The four clarity findings are retained individually as R4–R7 above.

## Standards and specification results

**Standards/design axis:** three actionable recovery findings (D1–D3), all addressed.
The strongest findings within this axis were the two stranded loading states. The reviewer
found the helper abstraction proportionate and no inventory-template violation.

**Specification/implementation axis:** two recovery defects and one incorrect interface
description (I1–I3), all addressed. The strongest findings within this axis were the same
two cancellation sequences. No additional uncertain concern was promoted to a finding.

There were no contested findings or requests for broader refactoring. The review did not
change server authorization, persisted data, API contracts, dependencies or deployment.

## Verification

Each new browser regression failed against the reviewed code before the fix:

| Test in `test/browser.check.js` | Before fix | After fix |
| --- | --- | --- |
| `a failed usage refresh does not leave cancelled person details loading` | Panel remained visible: expected hidden `true`, received `false`. | Pass; panel hidden, expanded link reset, late person response ignored. |
| `a failed version switch returns a cancelled diff to the current page` | Diff mode persisted: expected “Show changes”, received “Show page”. | Pass; previous page visible, version selector restored, late diff response ignored. |
| `clearing a pending usage sign-in releases its busy state without accepting the old token` | Expected busy `false`, received `true`. | Pass; busy cleared, old token neither saved nor rendered. |

Completed full-suite validation after the behavior fixes:

- `npm test`: 255 passed, 0 failed, 14 skipped. The skipped live PostgreSQL checks
  require `TEST_DATABASE_URL`, which was not configured.
- `npm run test:browser`: 34 passed, 0 failed. These checks use their own temporary
  database, server and browser.
- `git diff --check`: passed.

A fourth reviewer started with fresh conversation context for one bounded, read-only
re-audit of R1–R7. It used the comprehension and codebase-details personas and the
implementation-readiness standard. It inspected the workflow document, this report,
the helper, usage and review implementations, the relevant regression tests, and
supporting sign-in, embedding and account-role code. It did not run tests itself.

That reviewer found no remaining actionable issues in R1–R5 or R7, and confirmed that
the three new regressions exercise the reported cancellation and failure sequences.
It found one remaining inaccuracy in R6's reset boundary. The primary agent verified
the parent iframe's `auto` class handling in `src/pages.js` and corrected that wording
as recorded above. That final documentation-only correction was not sent through a
second independent re-audit. No behavior changed after the full test runs.

The review provides independent source inspection and targeted regression evidence;
it does not claim exhaustive transition coverage or replace human oversight.
