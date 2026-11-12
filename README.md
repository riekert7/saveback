# Saveback

Saveback keeps the posts you save on every platform in one searchable local store (SQLite) and lets Claude search it over MCP. Once a week Claude can run the "you saved this and never opened it" digest through `list_unseen`, so saves stop disappearing into each platform's bookmarks.

The browser extension that captures saves is in progress. Today the server is what exists: it stores items, serves them over MCP, and can fetch a public web page or YouTube video you give it (`save_url`).

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

## Privacy and safety

- Your data stays in your own SQLite file (local disk, or the volume on your own Railway deploy). Nothing is sent to a Saveback service.
- The extension only runs when you click it.
- Capture happens in your own logged-in browser. Scraping logged-in pages may go against a platform's terms of service; use at your own risk.
- Hosted mode is single-tenant: one deploy, one token, one person's data. `save_url` refuses private and local network addresses so a hosted instance cannot be pointed at its own network.

## License

MIT, see `LICENSE`.
