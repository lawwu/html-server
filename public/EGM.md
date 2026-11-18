# Browser interactions

## Interface

The server chooses which scripts run in the surrounding site and which run inside a published page. Start with the template that supplies the DOM or embeds the script when changing a browser interaction. [Page templates](../src/pages.js) · [page delivery](../src/page-delivery.js)

| Surface | Contract |
| --- | --- |
| Gallery and dialogs | `gallery.js` binds the search form and updates `#results`. It calls `openUpload({ files, folder, onUploaded })` and `openMove(pages, onMoved)`. Those callbacks let the gallery refresh after writes. [Gallery](./gallery.js) · [upload](./upload.js) · [move](./move.js) |
| Sign-in | `browserSignIn()` gives trusted controls a shared identity and request helper. `createSignIn({ session, storage, fetch, leave })` exposes the same behavior with caller-supplied dependencies. The top bar subscribes to credential changes. [Sign-in](./signin.js) · [session display](./session.js) |
| Review | The page supplies the page name in `body[data-slug]`. The review script loads metadata and comments for the selected version, switches between the page and its diff, and submits comments or a version restore. [Review](./review.js) · [review template](../src/pages.js) |
| Notes and embedded HTML | Search can fall back to titles already in the explorer. Hover previews and the local graph consume JSON embedded by the renderer. Inside an embedded artifact, scripts send search, navigation and sizing messages to the parent. [Search](./search.js) · [previews](./popover.js) · [local graph](./minigraph.js) · [frame events](./in-frame.js) · [sizing](./embed-size.js) |

## Invariants

- **A read belongs to the current interaction.** Keep one `latestRequest()` owner per replaceable read. Calling `owner.start()` invalidates its previous handle. Check `request.current` after reading the response body, before updating the DOM, focus, cache or URL. Where a write uses `singleAction`, repeated submissions during that action are ignored, and the guard releases on success or failure. [Async state](./async-state.js) · [workflow inventory](../STATE-MACHINES.md)
- **Sign-in has one authority per request.** An active SSO session takes precedence over a saved token. With token sign-in, changing credentials invalidates the cached identity. Keep credential handling in the trusted site controls. [Sign-in](./signin.js)
- **Read the frame's message in the parent.** The site frame and review view accept navigation from their current iframe, require active user interaction and check the destination scheme. The child can request navigation without direct access to the parent's document. [Frame events](./in-frame.js) · [site frame](../src/pages.js) · [review](./review.js)

## Side Effects

Gallery, review and statistics interactions update the displayed content and URL. Upload sends page or asset bytes, and move submits the selected address changes. If only part of an upload succeeds, the gallery refreshes and the dialog keeps unfinished files available to retry. [Gallery](./gallery.js) · [review](./review.js) · [statistics](./stats.js) · [upload](./upload.js) · [move](./move.js)

## Verification

From the repository root, run `node --test test/async-state.test.js test/signin.test.js` for request ownership and sign-in precedence. With Playwright Chromium installed, `npm run test:browser` exercises the rendered pages, including dialogs, navigation and SSO. [Browser checks](../test/browser.check.js) · [SSO checks](../test/sso.check.js)
