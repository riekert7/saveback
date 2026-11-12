// Instagram saved posts. Classic script, injected after core.js.
// Live structure (2026-11-13): the saved POSTS live at /{me}/saved/all-posts/ (or a collection page
// /{me}/saved/{name}/{id}/). The plain /{me}/saved/ is the collections overview, so it is rejected.
// A grid item is a[role="link"][href="/p/{code}/"] (reels use /p/ too; a child svg[aria-label="Clip"]
// marks one, informational only) holding one img whose alt is the text. The grid does not show the
// author (known ceiling, author is ''), and does not show the save time (saved_at null).
(function () {
  const SELECTORS = {
    post: 'a[role="link"][href^="/p/"]',
    image: 'img',
  };
  const POST = /^\/p\/([\w-]+)\/?$/;
  const SAVED = /^\/[^/]+\/saved\/(?:all-posts|[^/]+\/[^/]+)\/?$/;

  const matches = (url) => {
    try {
      const u = new URL(url);
      return /^(www\.)?instagram\.com$/.test(u.hostname) && SAVED.test(u.pathname);
    } catch {
      return false;
    }
  };

  const isHttp = (s) => /^https?:\/\//i.test(s ?? '');

  function extract(document) {
    const items = [];
    const seen = new Set();
    for (const a of document.querySelectorAll(SELECTORS.post)) {
      try {
        const code = a.getAttribute('href').match(POST)?.[1];
        if (!code || seen.has(code)) continue;
        seen.add(code);
        const img = a.querySelector(SELECTORS.image);
        const src = img?.getAttribute('src');
        items.push({
          platform: 'instagram',
          native_id: code,
          url: `https://www.instagram.com/p/${code}/`,
          author: '',
          text: (img?.getAttribute('alt') ?? '').trim(),
          media: isHttp(src) ? [src] : [],
          saved_at: null,
          transcript: null,
        });
      } catch {
        // one odd card must not lose the rest
      }
    }
    return items;
  }

  const adapter = { platform: 'instagram', matches, extract, SELECTORS };
  globalThis.__saveback?.register(adapter);
  if (typeof module !== 'undefined') module.exports = adapter;
})();
