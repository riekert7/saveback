# Saveback

Saveback keeps the posts you save on every platform in one searchable local store (SQLite) and lets Claude search it over MCP. Once a week Claude can run the "you saved this and never opened it" digest through `list_unseen`, so saves stop disappearing into each platform's bookmarks.

The server stores items, serves them over MCP, and can fetch a public web page or YouTube video you give it (`save_url`). A Chrome extension captures saves from X, Instagram, LinkedIn, Facebook, Threads and YouTube.

Status: the extension exists and its adapters were built from the real page structure captured on 2026-11-13, but an end-to-end capture on live pages has not been verified yet. See [docs/platform-status.md](docs/platform-status.md).

## Quick start (local)

The package is not published to npm yet, so run it from a checkout (Node 22.13 or newer):

```sh
npm install
node server/cli.js
```

Register it with Claude Code, using the absolute path to your checkout:

```sh
claude mcp add saveback -- node /absolute/path/to/server/cli.js
```

After it is published this becomes `claude mcp add saveback -- npx saveback`.

Local mode serves MCP over stdio and a receiver for the extension on `127.0.0.1:7777` (override with `SAVEBACK_PORT`). Data lives in `~/.saveback/saveback.db` unless `SAVEBACK_DB` points elsewhere.

## Browser extension

1. In Chrome open `chrome://extensions`, turn on Developer mode, click Load unpacked and pick the `extension/` folder of this checkout.
2. Click the Saveback icon. The endpoint defaults to `http://127.0.0.1:7777`, which is where local mode listens (start it with `node server/cli.js`). For a hosted server paste its `https://` URL and the token; Chrome asks permission for that origin the first time you click Capture. Other `http://` endpoints are not accepted.
3. Open the platform's saved page (table below) and click Capture. The page scrolls by itself while the extension reads it, so keep the tab open and visible until it finishes.

| Platform | Open this page |
| --- | --- |
| x | `x.com/i/history`, Bookmarks tab |
| instagram | Saved > All posts, `instagram.com/<you>/saved/all-posts/` |
| linkedin | `linkedin.com/my-items/saved-posts/` |
| facebook | `facebook.com/saved` |
| threads | `threads.com/saved` |
| youtube | a playlist page such as Watch Later, `youtube.com/playlist?list=WL` |

The result line in the popup reads:

- `N found, M saved`: N posts were read from the page and M were stored. Posts you already saved are updated, not duplicated. `(K rejected by the server)` means the server refused K of them as invalid.
- `0 found, selectors may be outdated`: the page matched but no posts were read, so the platform probably changed its markup. See [docs/platform-status.md](docs/platform-status.md).
- `This is not a saved page. Open ...`: the current tab is not the page for that platform.
- `Cannot reach Saveback at <endpoint>` or `Check your token.`: the server is not running or the token is wrong. Items not sent are counted (`N found, M saved, K not sent`); click Capture again to retry.

Capture stops after 3 scroll steps with nothing new, or at 2000 items. Per-platform limits are in [docs/platform-status.md](docs/platform-status.md); to add a platform see [docs/adding-a-platform.md](docs/adding-a-platform.md).

## MCP tools

| Tool | What it does |
| --- | --- |
| `search_saved` | Full-text search over text, author, url, transcript and notes; optional platform and date filters |
| `get_saved` | One item in full, including the whole transcript |
| `list_recent` | Newest saves first |
| `list_unseen` | Saves not yet dealt with; `older_than_days` resurfaces forgotten ones (the digest) |
| `mark_seen` | Mark an item as dealt with |
| `add_note` | Attach a searchable note to an item |
| `tag` | Replace the tags on an item |
| `save_url` | Fetch a public web page or YouTube video (with transcript when captions exist) and store it |

## Self-host on Railway

Hosted mode runs the same server behind a bearer token so the extension and Claude can reach it from anywhere. The repo ships a `railway.json` (start command `node server/cli.js`, health check `/health`).

A first deploy fails its health check until `SAVEBACK_MODE`, the other variables and the volume are set (the server will not start without them), so set them before the first deploy or right after it and redeploy.

1. Create a Railway project from this repo.
2. Add a volume mounted at `/data`.
3. Set the variables:
   - `SAVEBACK_MODE=remote`
   - `SAVEBACK_TOKEN` a long random secret, e.g. from `openssl rand -hex 32` (the server refuses to start without it)
   - `SAVEBACK_DB=/data/saveback.db`
   - `RAILPACK_NODE_VERSION=22` to make sure the build uses Node 22 (the server needs 22.13 or newer; Railway's builder also reads `engines.node` from `package.json`, this variable just removes any doubt)
4. Generate a public domain. Railway sets `PORT` itself; the server listens on it.
5. Check it: `curl https://<your-domain>/health` returns 200 without a token. `/ingest` and `/mcp` need `Authorization: Bearer <token>`.
6. Connect Claude:

```sh
claude mcp add --transport http saveback https://<your-domain>/mcp --header "Authorization: Bearer <token>"
```

`claude mcp add --header` stores the token in Claude's config (`~/.claude.json`). To rotate it, change `SAVEBACK_TOKEN` on the server and add the server again with the new token (and paste the new token into the extension popup).

## Privacy and safety

- Your data stays in your own SQLite file (local disk, or the volume on your own Railway deploy). Nothing is sent to a Saveback service.
- The extension reads a page only when you click Capture: the popup injects the capture script into the active tab at that moment, and there are no content scripts that run on their own.
- Capture happens in your own logged-in browser. Scraping logged-in pages may go against a platform's terms of service; use at your own risk.
- Hosted mode is single-tenant: one deploy, one token, one person's data. `save_url` refuses private and local addresses (a small DNS-rebinding window is a known limit).

## License

MIT, see `LICENSE`.
