// The command line's usage text: printed by `html-server --help` (with this machine's
// paths and server) and shown on the Docs page (with generic ones). One copy, so the two
// can't drift.
import { DEFAULT_HOST, DEFAULT_PORT, VERSION } from './config.js';

export const usage = ({ backupDir, homeDir, server = null }) => `html-server ${VERSION} — host, version, search and link HTML pages and Markdown notes

Run the server (on this machine, straight to the database):
  serve [--port ${DEFAULT_PORT}] [--host ${DEFAULT_HOST}] [--db PATH] [--sandbox-allow PERMISSION]...
                                        --sandbox-allow adds a sandbox permission for pages, e.g. allow-downloads
  create-user NAME [--admin] [--save]    print a new user's token once (--save: also keep it for this CLI)
  reset-token NAME [--save]              new token for a user who lost theirs; pages are kept
  backup [PATH] [--keep N]               snapshot the database (safe while serving); default: ${backupDir}
                                        --keep N: then delete all but the newest N backups there
  config [usernames name|email] [editing owner|open]
                                        show or change this deployment's settings

Deploy it to Cloudflare Workers instead (free tier; data in a Durable Object's SQLite):
  deploy cloudflare [--name NAME] [--user NAME]
                                        signs in to Cloudflare if needed, deploys, and on the first deploy
                                        creates the admin (--user, default your login name) and signs this
                                        CLI in. Run it again to update; data and tokens stay

Connect AI apps (Claude Desktop, Claude Code, Cursor, …) over MCP:
  mcp                                   run as an MCP server on stdin/stdout (the app starts this; see Docs)

Sign this CLI in to a server (saved, so there's nothing to add to your shell profile):
  login [--url URL] [--token TOKEN]     asks for anything missing; checks it before saving
  logout

Use a running server:
  put FILE [NOTE] [--private] [--name NAME] [--base N]
                                        upload an .html page, .md note or .ipynb notebook; it lives at /pages/<file name>.
                                        --base N: refuse if someone added a version after vN
  history NAME                          every version, with date, author and note
  pin NAME | unpin NAME                 feature a page at the top of the home page (owner or admin)
  tag add TAG NAME... | tag rm TAG NAME...   tag or untag many pages at once
  tags                                  every tag in use, with counts
  import DIR [--private]                upload every .html file in DIR (re-runnable: unchanged files are skipped)
  sync DIR [--private] [--prune] [--dry-run] [--install-hook]
                                        upload a Markdown/Quartz/Obsidian folder (notes, notebooks, .html, images), recursively;
                                        re-runnable; --prune trashes pages whose file is gone; --install-hook re-syncs
                                        on every git commit and pull. A Quartz repo syncs content/ and its ignorePatterns
  ls                                    your pages and everyone's public ones
  search WORDS... [--tag T] [--json]    search titles, file names and text; best matches first
  find WORDS...                         the same as search
  open NAME | review NAME               open the page, or its review page, in a browser
  diff NAME [FROM TO] [--source]        what changed (default: previous vs latest)
  restore NAME N                        make version N current again (adds a copy)
  views NAME                            page views report
  rm NAME [--purge]                     trash; --purge deletes for good (trash first)
  whoami
  --version                             print the version

Data lives in ${homeDir} (HTML_SERVER_HOME moves it).
Client commands use the server and token saved by login (or by the first serve on
this machine). HTML_SERVER_URL and HTML_SERVER_TOKEN override them for one shell.${server ? `\nCurrently: ${server}` : ''}`;
