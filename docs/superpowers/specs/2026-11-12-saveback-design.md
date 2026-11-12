# Saved-posts → Claude: open-source extension + MCP server

## Context
Riekert saves posts on every social platform and never goes back. Goal: an open-source project under the `riekert7` GitHub account that pulls saves from every platform into one store and exposes them to Claude through MCP (also searchable, with a "you never revisited these" digest). Secondary goal: GitHub stars via a launch on his personal accounts.

Prior art is real, so the angle matters: [withweft](https://github.com/shubhamr/withweft) (capture only, needs its own app), [socialmemory-mcp](https://github.com/kennyberg/socialmemory-mcp) and [x-bookmarks-mcp](https://github.com/p0ki/x-bookmarks-mcp) (X only), SuperBrain (IG/YouTube/LinkedIn), Tweetsmash/PostMind (hosted, paid). None found that does all platforms + extension + MCP + self-hostable. That is the pitch: **one extension, every platform, local-first, Claude-native, one-click Railway deploy.** Prior-art claims came from vendor pages, so re-check stars/features before the README names competitors.

Decisions from the user: local-first AND Railway-hosted option (start with local, hosted is the same code); v1 = everything possible; one local process serves MCP and receives the extension's POSTs.

## Architecture (lazy version)
One Node process, two modes, same code:
- **Local:** `npx <name>` → MCP over stdio for Claude + HTTP receiver on `127.0.0.1` for the extension. Data in `~/.<name>/` (SQLite + markdown).
- **Hosted:** same process with `MODE=remote`: streamable-HTTP MCP + the receiver behind a bearer token, SQLite on a Railway volume. Single-tenant per deploy ("Deploy on Railway" button), so we never hold other people's data.
- **Extension (Chrome MV3):** content script per platform. Opens that platform's saved page, auto-scrolls slowly, extracts items, POSTs to the configured endpoint (localhost or the Railway URL + token).

Reuse/stdlib: `node:sqlite` with FTS5 for search (no native dep), official `@modelcontextprotocol/sdk` for MCP, no framework for HTTP (`node:http`). The digest needs no LLM code: Claude calls `list_unseen` and writes it.

## Repo layout (monorepo, `riekert7/<name>`, MIT)
- `server/` — `ingest` (validate + upsert by platform+id), `db.ts` (schema + FTS), `mcp.ts` (tools), `http.ts` (receiver + auth).
- `extension/` — `manifest.json`, `background.ts`, `adapters/<platform>.ts` (one file each: URL match, scroll, `extract()` → Item), popup for endpoint/token.
- `schema/item.ts` — the shared Item contract (id, platform, url, author, text, media urls, saved_at, captured_at, transcript?, tags[], seen). **Written first; it is the seam between the two tracks.**
- `README.md` with GIF demo, `docs/adding-a-platform.md` (an adapter is the easy contribution, which helps stars).

## MCP tools
`search_saved(query, platform?, since?)`, `get_saved(id)`, `list_recent`, `list_unseen` (saved, never opened/used), `mark_seen`, `add_note`, `tag`, and **`save_url(url)`**, which covers "make saved posts": fetch the page text (YouTube: transcript) and store it, so Claude can save things on request.

## Platforms (adapter per platform; each can fail independently, with a visible status in the popup)
X (bookmarks), LinkedIn (my-items/saved-posts), Instagram (saved + collections), Facebook (saved), Threads (saved), YouTube (Watch Later/playlists + transcripts). Stretch if time: Reddit, TikTok, Pinterest. Ceiling: Instagram/Facebook layouts change often, so adapters keep selectors in one map at the top of the file. Video transcripts: YouTube captions in v1; Instagram/TikTok audio transcription (local whisper) is a later option.
Safety: user-initiated runs only, slow scroll, no background crawling, no credentials ever read or stored; README states ToS risk plainly.

## Two parallel tracks (his "2 panes")
0. Together, first: pick the name (check GitHub + npm free), `gh auth login` as `riekert7`, write `schema/item.ts`.
1. **Pane A — server/MCP/Railway:** db + ingest + MCP tools + HTTP auth, then Railway deploy (new small project, 1 GB volume, sleep on, low memory; do not pipe `railway` CLI output into `head`).
2. **Pane B — extension:** adapters, starting with X and YouTube (easiest), then LinkedIn, Instagram, Facebook, Threads. Verify selectors against the live pages in Chrome before relying on them; keep sanitised HTML fixtures for adapter checks.
3. Join: end-to-end run, README + demo GIF, Chrome Web Store submission (optional, later).

## Launch (separate from building)
Posts go on the personal account only. Show a real moment (Claude finding something he saved months ago) rather than a feature list. Stars are not guaranteed; the adapter-contribution doc and one-click deploy are the levers.

## Verification
- Check: `node --test` round trip: ingest a fixture Item, `search_saved` finds it, `list_unseen` returns it, `mark_seen` removes it.
- Local: `claude mcp add` the server, curl a sample Item to the receiver, ask Claude "what did I save about …?".
- Extension: load unpacked in Chrome, run X capture on his real bookmarks page, confirm items land in the DB; repeat per platform and record which ones work.
- Hosted: deploy to Railway, point extension + `claude mcp add --transport http` at it, confirm requests without the token are rejected (401).
