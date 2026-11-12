# Saveback Server Implementation Plan (Pane A)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One Node process that stores saved posts in SQLite, serves them to Claude over MCP, and receives captures from the browser extension, either on localhost or hosted on Railway.

**Architecture:** Plain ESM JavaScript with JSDoc types, no build step. `shared/item.js` is the contract the extension plan also uses. `server/db.js` owns all SQL. `server/mcp.js` and `server/http.js` are thin layers over `db.js`. `server/cli.js` picks local mode (stdio MCP + 127.0.0.1 receiver) or remote mode (HTTP MCP + receiver, bearer token) from env.

**Tech Stack:** Node >= 22.13 (`node:sqlite` with FTS5, `node:test`, `node:http`, global `fetch`), `@modelcontextprotocol/sdk`, `zod` (tool input schemas, already a peer of the SDK). Nothing else.

**Spec:** `docs/superpowers/specs/2026-11-12-saveback-design.md`

## Global Constraints

- Package name `saveback`, MIT, repo `riekert7/saveback`. `engines.node: ">=22.13"`; this machine's default Node is 20, so run with `mise exec node@22.23.4 --`.
- No dependency beyond the two listed. No TypeScript, no bundler.
- Local mode binds `127.0.0.1` only, default port `7777`. Data dir `~/.saveback/`, DB file `saveback.db`. Remote mode requires `SAVEBACK_TOKEN`, reads `PORT`, DB path from `SAVEBACK_DB`.
- stdout is the MCP channel in stdio mode: all logging goes to stderr.
- Commit messages are plain. No `Co-Authored-By` or attribution lines.

## Review Focus

- Re-ingesting the same post (the extension re-scrolls the same page): updates the row, never duplicates, and keeps `seen`, `notes`, `tags`.
- Search text with FTS syntax characters (`"`, `-`, `:`, `*`, unbalanced quotes) returns results or an empty list, never throws.
- Ingest body that is huge, not JSON, or has one bad item among good ones: size capped at 1 MB (413), bad JSON 400, good items stored and bad ones reported by index.
- A web page POSTing to the localhost receiver from a browser: refused (403) because its `Origin` is not `chrome-extension://`.
- `save_url` pointed at `http://169.254.169.254/` or `localhost` or a private range: refused, matters most in remote mode.
- Image-only posts with empty `text`: stored and still findable by author or URL.

---

### Task 1: Item contract

**Files:**
- Create: `shared/item.js`
- Test: `test/item.test.js`

**Interfaces:**
- Produces: `validateItem(raw: unknown): Item` (throws `Error` with a message naming the bad field) and `itemId(item): string` returning `` `${platform}:${native_id}` ``.
- `Item` = `{ platform: 'x'|'linkedin'|'instagram'|'facebook'|'threads'|'youtube'|'reddit'|'tiktok'|'pinterest'|'web', native_id: string, url: string (http/https), author: string, text: string (may be ''), media: string[] (urls), saved_at: string|null (ISO), transcript: string|null }`. Unknown extra fields are dropped. `author`, `text`, `media`, `transcript` default to `''`, `''`, `[]`, `null`.

- [ ] **Step 1: Write failing tests** in `test/item.test.js`: `valid item round-trips`, `rejects unknown platform`, `rejects non-http url (javascript:)`, `defaults optional fields`, `accepts empty text`, `drops unknown fields`.
- [ ] **Step 2: Run** `mise exec node@22.23.4 -- node --test test/item.test.js`. Expected: FAIL, module not found.
- [ ] **Step 3: Implement** `shared/item.js` per the Interfaces block, hand-written checks, no schema library.
- [ ] **Step 4: Run again.** Expected: PASS.
- [ ] **Step 5: Commit** `git add shared test && git commit -m "feat: item contract"`.

### Task 2: SQLite store

**Files:**
- Create: `server/db.js`
- Test: `test/db.test.js`

**Interfaces:**
- Consumes: `Item`, `itemId` from Task 1.
- Produces (all take the `db` returned by `openDb`):
  - `openDb(path: string): DatabaseSync` (`':memory:'` allowed; creates tables `items` and FTS5 table `items_fts(text, author, url, transcript, notes)`; WAL on for files).
  - `upsertItem(db, item: Item): { id: string, created: boolean }` (insert, or update content fields only; preserves `seen`, `notes`, `tags`, `captured_at`).
  - `getSaved(db, id): StoredItem | null` where `StoredItem = Item & { id, captured_at: string, seen: boolean, notes: string, tags: string[] }`.
  - `searchSaved(db, { query: string, platform?: string, since?: string, limit?: number }): StoredItem[]` (default limit 20, max 100; query tokens are quoted so FTS syntax cannot break it; empty query returns most recent).
  - `listRecent(db, { limit?: number }): StoredItem[]`, `listUnseen(db, { limit?: number, olderThanDays?: number }): StoredItem[]`.
  - `markSeen(db, id): boolean`, `addNote(db, id, note: string): boolean` (appends), `setTags(db, id, tags: string[]): boolean`.

- [ ] **Step 1: Write failing tests** in `test/db.test.js`: `upsert twice keeps one row and preserves seen/notes/tags`, `search finds by text, author and transcript`, `search with syntax chars '"', 'a-b', 'x:' does not throw`, `platform and since filters`, `listUnseen excludes seen items`, `empty-text item found by author`, `notes are searchable after addNote`.
- [ ] **Step 2: Run** `mise exec node@22.23.4 -- node --test test/db.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement** `server/db.js`. Keep `items_fts` in sync inside `upsertItem`/`addNote` (delete + insert by rowid) rather than triggers. Quote search tokens as `"tok"` joined by space.
- [ ] **Step 4: Run again.** Expected: PASS.
- [ ] **Step 5: Commit** `feat: sqlite store with full-text search`.

### Task 3: HTTP receiver

**Files:**
- Create: `server/http.js`
- Test: `test/http.test.js`

**Interfaces:**
- Consumes: `openDb`, `upsertItem`, `validateItem`.
- Produces: `createReceiver({ db, token?: string }): (req, res) => void` (a `node:http` request handler). Routes: `GET /health` → `{ok:true}`; `POST /ingest` body `{ items: unknown[] }` → `{ stored: number, created: number, errors: {index:number,message:string}[] }`. CORS: respond to `OPTIONS` and set `Access-Control-Allow-Origin` to the request origin only when it starts with `chrome-extension://`; any other non-empty `Origin` → 403. When `token` is set, require `Authorization: Bearer <token>` else 401. Body cap 1 MB → 413; invalid JSON or missing `items` array → 400.

- [ ] **Step 1: Write failing tests** (start the handler on an ephemeral port with `http.createServer`): `ingest stores valid items and reports bad index`, `re-ingest does not duplicate`, `403 for Origin https://evil.example`, `chrome-extension origin allowed and echoed`, `401 without token when token set, 200 with`, `413 over 1 MB`, `400 on invalid JSON`.
- [ ] **Step 2: Run** `... node --test test/http.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement** `server/http.js`; compare the token with `crypto.timingSafeEqual`.
- [ ] **Step 4: Run again.** Expected: PASS.
- [ ] **Step 5: Commit** `feat: http receiver with origin and token checks`.

### Task 4: URL fetcher for `save_url`

**Files:**
- Create: `server/fetchUrl.js`
- Test: `test/fetchUrl.test.js`

**Interfaces:**
- Produces: `fetchSaveable(url: string, deps?: { fetch?: typeof fetch, lookup?: (host)=>Promise<string[]> }): Promise<Item>`. Rejects non-http(s), and any host that resolves to loopback, link-local, private (10/8, 172.16/12, 192.168/16), or `169.254.0.0/16`, checked on the resolved IPs before fetching and on each redirect (manual redirect handling, max 3). YouTube URLs (`youtube.com/watch?v=`, `youtu.be/`) return platform `youtube`, `native_id` the video id, `transcript` from the captions track found in the watch page's `ytInitialPlayerResponse` (null if none). Other URLs return platform `web`, `native_id` = sha1 of the final URL (first 16 hex), `text` = page `<title>` + visible text stripped of tags/scripts/styles, capped at 20,000 chars.

- [ ] **Step 1: Write failing tests** with injected `fetch`/`lookup` (no network): `blocks 127.0.0.1, localhost, 169.254.169.254, 10.0.0.5`, `blocks redirect to private address`, `non-http scheme rejected`, `html page becomes web item with title and stripped text`, `youtube watch url becomes youtube item with transcript from fixture`, `youtube without captions has null transcript`.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement** `server/fetchUrl.js`. Fetch the YouTube caption track URL taken from the player response (`captionTracks[0].baseUrl`, XML `<text>` nodes joined); keep the fixture small in `test/fixtures/yt-player.html`.
- [ ] **Step 4: Run again.** Expected: PASS.
- [ ] **Step 5: Commit** `feat: save_url fetcher with ssrf guard and youtube transcripts`.

### Task 5: MCP tools

**Files:**
- Create: `server/mcp.js`
- Test: `test/mcp.test.js`

**Interfaces:**
- Consumes: Task 2 functions, `fetchSaveable` (injectable for tests).
- Produces: `buildMcpServer({ db, fetchSaveable? }): McpServer` registering tools `search_saved {query, platform?, since?, limit?}`, `get_saved {id}`, `list_recent {limit?}`, `list_unseen {limit?, older_than_days?}`, `mark_seen {id}`, `add_note {id, note}`, `tag {id, tags[]}`, `save_url {url}`. Each returns one text content block of JSON; unknown id returns `isError: true`. Tool descriptions say what Claude should use them for (the digest: "call list_unseen, summarise themes, then mark_seen what the user has dealt with").

- [ ] **Step 1: Write failing tests** using the SDK's in-memory transport and `Client`: `lists all eight tools`, `search_saved returns an ingested item`, `list_unseen then mark_seen removes it`, `save_url stores the fetched item (fake fetchSaveable)`, `save_url error surfaces as isError`, `get_saved unknown id is isError`.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement** `server/mcp.js` using `McpServer.registerTool` with zod input shapes.
- [ ] **Step 4: Run again.** Expected: PASS.
- [ ] **Step 5: Commit** `feat: mcp tools`.

### Task 6: CLI entry and modes

**Files:**
- Create: `server/cli.js`, `package.json` (`bin: { saveback: "server/cli.js" }`, `files`, `engines`, `scripts.test`)
- Test: `test/cli.test.js`

**Interfaces:**
- Consumes: everything above.
- Produces: `node server/cli.js` runs local mode: stdio MCP + receiver on `127.0.0.1:${SAVEBACK_PORT||7777}` (no token), DB at `$SAVEBACK_DB || ~/.saveback/saveback.db`. With `SAVEBACK_MODE=remote`: requires `SAVEBACK_TOKEN` (exit 1 with a stderr message if missing), listens on `0.0.0.0:$PORT`, serves `/ingest`, `/health` and streamable-HTTP MCP at `/mcp`, both behind the bearer token (health open).

- [ ] **Step 1: Write failing tests** (spawn the process): `remote mode without token exits 1`, `remote mode: /health 200, /ingest 401 without token, ingest then search over /mcp with token finds the item`, `local mode: POST /ingest works on 127.0.0.1 and nothing is written to stdout except MCP frames`.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement** `server/cli.js` and `package.json`; suppress the SQLite experimental warning on stderr only if trivial (`process.removeAllListeners('warning')` is fine).
- [ ] **Step 4: Run the whole suite** `mise exec node@22.23.4 -- npm test`. Expected: all PASS.
- [ ] **Step 5: Commit** `feat: cli with local and remote modes`.

### Task 7: Railway deploy

**Files:**
- Create: `railway.json`, `README.md` section "Self-host on Railway"
- No automated test; verification below.

- [ ] **Step 1:** In `railway.json` set start command `node server/cli.js` and health check path `/health`. Document env: `SAVEBACK_MODE=remote`, `SAVEBACK_TOKEN` (generated), `SAVEBACK_DB=/data/saveback.db`, volume mounted at `/data`.
- [ ] **Step 2:** Create a new small Railway project via the CLI (never pipe `railway` output through `head`), 1 GB volume, deploy, set the variables.
- [ ] **Step 3: Verify** `curl -i https://<domain>/health` → 200; `curl -i -X POST https://<domain>/ingest` without token → 401; with token and a sample item → `{stored:1}`; `claude mcp add --transport http saveback https://<domain>/mcp --header "Authorization: Bearer <token>"` then ask Claude to search for the item. Record memory use from Railway metrics (target well under 150 MB).
- [ ] **Step 4: Commit** `docs: railway deploy`.
