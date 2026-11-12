// YouTube playlist rows (Watch later, Liked videos, any playlist). Classic script, injected after core.js.
// Structure (2026-11-13, from a PUBLIC playlist because the user's own lists were empty, so this is
// untested on a real Watch later): one yt-lockup-view-model per row, holding two anchors to the video,
// /watch?v={id}&list=...: the thumbnail anchor (an img plus the duration text, e.g. "12:34") and the title
// anchor. The channel name is not reliably in the row (author ''); the server's save_url fetches the
// transcript on demand (transcript null).
(function () {
  const SELECTORS = {
    row: 'yt-lockup-view-model',
    videoLink: 'a[href*="/watch?"]',
    image: 'img',
  };
  const VIDEO_ID = /^[\w-]{11}$/;
  const DURATION = /^\d{1,2}(?::\d{2}){1,2}$/;

  const matches = (url) => {
    try {
      const u = new URL(url);
      return u.hostname === 'www.youtube.com' && u.pathname.replace(/\/+$/, '') === '/playlist' && !!u.searchParams.get('list');
    } catch {
      return false;
    }
  };

  const isHttp = (s) => /^https?:\/\//i.test(s ?? '');
  const idOf = (a) => {
    try {
      const v = new URL(a.getAttribute('href'), 'https://www.youtube.com').searchParams.get('v');
      return v && VIDEO_ID.test(v) ? v : null;
    } catch {
      return null;
    }
  };

  function extract(document) {
    const items = [];
    const seen = new Set();
    for (const row of document.querySelectorAll(SELECTORS.row)) {
      try {
        const links = [...row.querySelectorAll(SELECTORS.videoLink)];
        const id = links.map(idOf).find(Boolean);
        if (!id || seen.has(id)) continue;
        seen.add(id);

        let text = '';
        for (const a of links) {
          if (a.querySelector(SELECTORS.image)) continue; // thumbnail anchor
          const t = a.textContent.trim();
          if (!DURATION.test(t) && t.length > text.length) text = t;
        }
        const src = row.querySelector(SELECTORS.image)?.getAttribute('src');
        items.push({
          platform: 'youtube',
          native_id: id,
          url: `https://www.youtube.com/watch?v=${id}`,
          author: '',
          text,
          media: isHttp(src) ? [src] : [],
          saved_at: null,
          transcript: null,
        });
      } catch {
        // one odd row must not lose the rest
      }
    }
    return items;
  }

  const adapter = { platform: 'youtube', matches, extract, SELECTORS };
  globalThis.__saveback?.register(adapter);
  if (typeof module !== 'undefined') module.exports = adapter;
})();
