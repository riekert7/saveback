# Saveback Extension Implementation Plan (Pane B)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Chrome (MV3) extension that, on the user's request, scrolls a platform's saved-posts page in their own logged-in browser, extracts each saved post, and POSTs batches to a Saveback endpoint (localhost or Railway).

**Architecture:** Plain JS, no build step. `extension/core.js` holds the platform-independent loop (scroll, dedupe, batch, post); each `extension/adapters/<platform>.js` registers `{ platform, matches(url), extract(document) }`. The service worker does the network POST so content scripts avoid page CORS. Adapter tests run in Node against HTML fixtures.

**Tech Stack:** Chrome MV3, `node:test`, `linkedom` (devDependency only, gives a DOM for fixture tests).

**Spec:** `docs/superpowers/specs/2026-11-12-saveback-design.md`

## Global Constraints

- Depends only on Task 1 of the server plan (`shared/item.js`: `validateItem`, `Item` shape). Adapter output must pass `validateItem`.
- Platforms in v1: `x`, `youtube`, `linkedin`, `instagram`, `facebook`, `threads`. Reddit, TikTok, Pinterest are stretch.
- User-initiated only (popup button). No background crawling, no reading or storing credentials, no network calls except to the configured endpoint and the platform page already open.
- Scroll step delay 800 ms plus up to 600 ms jitter; stop after 3 consecutive steps with no new items; hard cap 2,000 items per run.
- Selectors live in one `SELECTORS` object at the top of each adapter.
- Fixtures committed to this public repo must be hand-trimmed to synthetic content (fake names and text) that keeps the real tag and attribute structure. Never commit real posts, names or account data.
- Commit messages are plain. No `Co-Authored-By` or attribution lines.

## Review Focus

- The platform changed its layout and the adapter finds nothing: the popup must say "0 found, selectors may be outdated", never show a silent success.
- Virtualised feeds (X, LinkedIn, Instagram remove off-screen nodes): items are extracted on every scroll step, not once at the end.
- The same post appears twice in one run: sent once.
- The user starts a capture on a page that is not that platform's saved page: refused with a message saying which page to open.
- The Saveback server is not running or the token is wrong: batches are kept and retried, and the popup says "start `npx saveback`" or "check your token".
- Posts with no text (image or video only): still extracted, with author and URL.

---

### Task 1: Skeleton and capture loop

**Files:**
- Create: `extension/manifest.json`, `extension/core.js`, `extension/background.js`, `extension/popup.html`, `extension/popup.js`, `package.json` (devDependency `linkedom`, `scripts.test`)
- Test: `test/core.test.js`

**Interfaces:**
- Produces in `core.js` (pure, exported for tests via `globalThis.__saveback` and `module.exports` when `module` exists):
  - `dedupe(items: Item[], seen: Set<string>): Item[]` (key `platform:native_id`, mutates `seen`).
  - `chunk<T>(arr: T[], n: number): T[][]`.
  - `shouldStop({ stagnantSteps: number, total: number }): boolean` (true at 3 stagnant steps or total >= 2000).
  - `runCapture(adapter, { doc, scroll, sleep, send, onProgress }): Promise<{ found: number, sent: number, error?: string }>` where `send(items: Item[]): Promise<{ok:boolean,status?:number}>`.
- Messages: popup → content script `{type:'capture'}`; content script → background `{type:'send', items}` → `fetch(endpoint + '/ingest')` with `Authorization: Bearer <token>` when a token is configured; endpoint and token from `chrome.storage.local` (default `http://127.0.0.1:7777`).
- Manifest: `host_permissions` for the six platform domains plus `http://127.0.0.1:7777/*` and `https://*.up.railway.app/*`; `optional_host_permissions` for custom domains; content scripts registered per adapter match.

- [ ] **Step 1: Write failing tests** in `test/core.test.js`: `dedupe drops repeats across steps`, `chunk splits into n-sized groups`, `shouldStop at 3 stagnant steps`, `shouldStop at 2000 total`, `runCapture extracts every step, not once` (fake adapter whose DOM drops earlier nodes; all items still sent), `runCapture reports error when send fails and keeps unsent items for retry`, `runCapture with zero items returns found 0`.
- [ ] **Step 2: Run** `mise exec node@22.23.4 -- node --test test/core.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement** `core.js`, `background.js`, popup (endpoint, token, Capture button, result line), `manifest.json`.
- [ ] **Step 4: Run again.** Expected: PASS.
- [ ] **Step 5: Commit** `feat: extension skeleton and capture loop`.

### Tasks 2–7: One adapter per platform

Every adapter task has the same shape. Order: 2 `x`, 3 `youtube`, 4 `linkedin`, 5 `instagram`, 6 `facebook`, 7 `threads`.

**Files (per platform `P`):**
- Create: `extension/adapters/P.js`, `test/fixtures/P-saved.html`
- Test: `test/adapter-P.test.js`

**Interfaces:**
- Produces: `registers({ platform: 'P', matches(url): boolean, extract(document): Item[] })`. `extract` is pure (no scrolling, no network) and returns the items currently in the DOM; `native_id` comes from the post's permalink or id attribute, `url` is absolute, `saved_at` is null when the page doesn't show it.

| Platform | Page the adapter accepts | Native id from | Notes |
|---|---|---|---|
| x | `x.com/i/bookmarks` | `/status/<id>` in the permalink | text from the tweet text node; media from `img`/`video` poster urls |
| youtube | `youtube.com/playlist?list=WL` and other playlists | `v=` in the video link | `text` is the title; transcripts come on demand via the server's `save_url` (ceiling: a later `saveback enrich` command can backfill) |
| linkedin | `linkedin.com/my-items/saved-posts` | activity urn in the post link | cards are lazy-rendered; extract per step |
| instagram | `instagram.com/<user>/saved/` | shortcode in `/p/<code>/` or `/reel/<code>/` | grid shows thumbnails only: `text` from the image `alt`, then open-post enrichment is a later step |
| facebook | `facebook.com/saved` | id in the saved item link | layout changes often: keep selectors minimal |
| threads | `threads.net/saved` (or `threads.com` if the domain has moved) | post id in `/post/<id>` | verify the live domain first |

- [ ] **Step 1: Capture a real fixture.** In the user's logged-in Chrome, open the saved page and save the relevant list markup. Verify live (do not trust the table) that the page URL, permalink shape and text/author nodes match, and note any difference in the adapter's header comment. Then hand-trim the saved HTML to 3 to 5 synthetic items, one of them with no text, keeping real structure. Check nothing real remains: `grep -iE "riekert|luies|@gmail" test/fixtures/P-saved.html` returns nothing.
- [ ] **Step 2: Write the failing test** in `test/adapter-P.test.js` using `linkedom`: `extracts N items from fixture`, `every item passes validateItem`, `image-only item has empty text and still has author and url`, `matches() accepts the saved page and rejects the home page`, `extract on an empty page returns []`.
- [ ] **Step 3: Run** `mise exec node@22.23.4 -- node --test test/adapter-P.test.js`. Expected: FAIL.
- [ ] **Step 4: Implement** the adapter with its `SELECTORS` map; add it to the manifest content-script list.
- [ ] **Step 5: Run again.** Expected: PASS.
- [ ] **Step 6: Live check.** Load the unpacked extension, run Capture on the real saved page with the server running, confirm item count in Saveback matches what the page shows (within the platform's own limits). Record result per platform in `docs/platform-status.md` (works / partial / broken, date).
- [ ] **Step 7: Commit** `feat: P adapter`.

### Task 8: Popup status and docs

**Files:**
- Modify: `extension/popup.js`, `extension/popup.html`
- Create: `docs/adding-a-platform.md`, `README.md` (install, `claude mcp add`, platform table from `docs/platform-status.md`, ToS/privacy note, Railway button)

**Interfaces:**
- Consumes: `runCapture` result `{ found, sent, error? }`.
- Popup shows, per run: "N found, M saved", or "0 found, selectors may be outdated", or the server-not-running / bad-token messages from Review Focus; and refuses with the right-page message when `adapter.matches(url)` is false.

- [ ] **Step 1: Write failing test** `test/popup-messages.test.js` for a pure `describeResult(result, matched): string` exported from `popup.js`: covers 0 found, error (network), error (401), success, wrong page.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement** `describeResult` and wire it to the UI.
- [ ] **Step 4: Run whole suite** `mise exec node@22.23.4 -- npm test`. Expected: PASS.
- [ ] **Step 5: Write the docs;** `docs/adding-a-platform.md` is the fixture + adapter + test recipe from the table above in under one page.
- [ ] **Step 6: Commit** `docs: readme and contribution guide`.
