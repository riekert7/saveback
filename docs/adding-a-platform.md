# Adding a platform

An adapter is one classic script that turns a saved-posts page into Items. Use `extension/adapters/x.js` and `test/adapter-x.test.js` as the reference.

1. **Capture the structure, not the content.** In your own logged-in browser, inspect the saved page and note tag names, `role` and `data-*` attributes, link shapes (with ids redacted) and text lengths. Avoid class names if they look generated. Keep none of the real posts, names or handles.
2. **Build a synthetic fixture** at `test/fixtures/<platform>-saved.html`: invented authors (`Test User`, `testuser`), invented ids, placeholder text such as `Sample post text`, same structure as the real page. Include a text-less item, and anything that should be ignored (a nav link, an ad, a nested quote). Never commit real posts, names or handles.
3. **Write `test/adapter-<platform>.test.js` first**, with the names the other adapter tests use:
   - `extracts N items from fixture`
   - `every item passes validateItem`
   - `text-less item keeps author and url`
   - `matches() accepts the saved page and rejects the home page`
   - `extract on an empty page returns []`

   Load the fixture with `linkedom` as in `test/adapter-x.test.js`, and run `mise exec node@22.23.4 -- npm test`.
4. **Write `extension/adapters/<platform>.js`.** A classic script (an IIFE, no imports) with a `SELECTORS` object at the top, `matches(url)`, and `extract(document)`, which must be pure: read the document you are given, return Items, touch nothing else. A bad card is skipped, not thrown. Finish with `globalThis.__saveback?.register({ platform, matches, extract })` and the `module.exports` guard the other adapters use so tests can `require` it.
5. **Wire it into the popup** (`extension/popup.js`): add `adapters/<platform>.js` to `ADAPTER_FILES`, and add the platform's host and the saved page to open to `SAVED_PAGES`, which is the wording of the wrong-page message. If the platform is new to the server, add it to `PLATFORMS` in `shared/item.js`. Add host permissions in `extension/manifest.json` if the host is not covered.
6. **Document it** in `docs/platform-status.md`: saved page, status and known limits.

## Item contract

The server validates every item (`shared/item.js`) and rejects the ones that fail.

- `platform`: one of `PLATFORMS`.
- `native_id`: non-empty string, stable for the post. Items are stored under `platform:native_id`, so a re-capture updates instead of duplicating.
- `url`: an http(s) url.
- `author`, `text`: strings (`''` when unknown).
- `media`: array of http(s) urls only (no `data:` or `blob:`).
- `saved_at`: an ISO date string or `null`. Use `null` unless the page shows the save time; a post's own timestamp is not the save time.
- `transcript`: string or `null`.

The page is a virtualised feed on some platforms, so `extract` is called after every scroll step and must work on whatever is in the DOM at that moment.
