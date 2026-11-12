# Platform status

Last checked: 2026-11-13. Every adapter was built from the real page structure captured on that date (structure only, tests use synthetic fixtures). No end-to-end capture on a live page has been verified yet.

| Platform | Adapter | Saved page | Status | Last checked |
| --- | --- | --- | --- | --- |
| x | `extension/adapters/x.js` | `x.com/i/history`, Bookmarks tab | adapter built from live page structure (2026-11-13); end-to-end capture not yet verified | 2026-11-13 |
| instagram | `extension/adapters/instagram.js` | `instagram.com/<you>/saved/all-posts/` | adapter built from live page structure (2026-11-13); end-to-end capture not yet verified | 2026-11-13 |
| linkedin | `extension/adapters/linkedin.js` | `linkedin.com/my-items/saved-posts/` | adapter built from live page structure (2026-11-13); end-to-end capture not yet verified | 2026-11-13 |
| facebook | `extension/adapters/facebook.js` | `facebook.com/saved` | adapter built from live page structure (2026-11-13); end-to-end capture not yet verified | 2026-11-13 |
| threads | `extension/adapters/threads.js` | `threads.com/saved` | adapter built from live page structure (2026-11-13); end-to-end capture not yet verified | 2026-11-13 |
| youtube | `extension/adapters/youtube.js` | `youtube.com/playlist?list=WL` (any playlist) | adapter built from live page structure (2026-11-13); end-to-end capture not yet verified | 2026-11-13 |

`saved_at` is `null` on every platform unless noted: the pages show the post time or nothing, not the save time.

## Known limits

**x**
- Author is the handle only (no display name).
- `saved_at` is always null.

**instagram**
- Author is empty; the saved grid does not show it.
- Text is the image's `alt` (a generated description or a caption excerpt), not the full caption.

**linkedin**
- A post body shorter than 10 characters is treated as text-less (the short label paragraph would otherwise be taken as the body).
- Author is the first non-empty `/in/` link text, which may include a subtitle.

**facebook**
- Selectors are by structure, not class names, and the card is found by a heuristic: the biggest ancestor holding links for one id.
- Text comes from the id's primary links only. If real captions sit outside a primary link, text is empty.
- A saved item needs two links to the same post, one with an `img` thumbnail. Items with a single link, or with a thumbnail without an `img`, are skipped.
- A related block that is itself a thumbnail-plus-title pair can create a phantom item or break a card.
- `/{page}/videos/{id}/` links are not recognised.
- The permalink rule is a blocklist of reserved first path segments, not an allowlist, so an unusual path may be read as a post.

**threads**
- There is no stable card element: the card boundary is a heuristic (the largest ancestor holding one post code, stopping at `data-pagelet`).
- The body is the longest `dir="auto"` text, so counts or labels could be picked up on photo-only posts.

**youtube**
- Built from a public playlist's page structure because the maintainer's own Watch Later and playlists are empty, so it is untested on a real Watch Later.
- Author is empty (the channel name is not reliably in the row).
- Transcripts are not captured by the extension; the server attempts to fetch them on demand through `save_url` (YouTube may not serve captions to non-browser clients, so it can be empty).

**all platforms**
- If a platform changes its markup the popup shows `0 found, selectors may be outdated`; the fix is in the adapter's `SELECTORS` and its fixture (see [adding-a-platform.md](adding-a-platform.md)).
