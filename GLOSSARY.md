# HTML Server

HTML Server publishes pages, keeps their versions, and links them into a shared collection.

## Language

**Page**: A published HTML document, Markdown note or Jupyter notebook, identified by its current address and retaining its history when moved.

**Version**: An immutable snapshot of a page's source, with its author, date and optional note.

**Asset**: An uploaded image or PDF that a page can reference. Access follows ownership or an authorized page reference.

**Viewer**: The person opening a page, who may be anonymous or signed in. Their permission to open a page does not give that page access to their other private content.

**Share link**: A revocable link granting access to one active page and its authorized assets. A deployment requiring single sign-on also requires the viewer to sign in.

**Browser sign-in**: The browser's current identity, established through a single sign-on session or a saved token. An active single sign-on session takes precedence over a saved token.

**Source folder**: The local folder whose files are published together by sync. A file's location within it identifies the corresponding published page even after a server-side move.

**Sync**: Reconciliation of a source folder with its published pages and assets. A dry run previews changes; pruning moves missing pages from that source into the trash.

**Page delivery**: Preparing a page for a viewer, including its version, presentation mode and permitted surrounding content. Trusted site chrome remains distinct from sandboxed page content.
