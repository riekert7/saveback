// Facebook saved items. Classic script, injected after core.js.
// Live structure (2026-11-13): https://www.facebook.com/saved. Class names are obfuscated, so nothing here
// selects by class. Each saved item holds 2 links to the same video (a thumbnail link with an img and a
// duration such as "0:30", and a text link with the title), often a source link too. So: derive an id from
// every primary link inside [role="main"] (v= param, /reel/{id}, or the id of a post-like path), and for
// each CARD id climb from its first link to the biggest ancestor that holds links for that one card id only.
// That ancestor is the card, but the climb never enters [role="main"] itself (one saved item on the page must
// not swallow the rest of main). The page shows no save time (saved_at null).
// Rules that keep foreign links from breaking cards:
//  - Only post-like paths carry an id: /watch/?v=digits, /reel/{id}, /{page}/posts/{id}, /permalink/{id},
//    /groups/{g}/posts|permalink/{id}, /{page}/{id}/{seg}/. Groups, /photo, /pages/, /events/, profile.php and
//    other numeric-segment links (usually a source link) are not ids.
//  - An id is a CARD only if the page has the two-link pattern for it: at least two links, one of them
//    holding an img (the thumbnail). An id seen through a single link is secondary (a "related video" link
//    inside another card): it neither ends a climb nor becomes an item. Ceiling: a saved item that really
//    has just one link is not captured.
// Known ceilings (live-untested, see docs/platform-status.md):
//  - Text comes from the id's primary links only; captions outside a primary link are not read.
//  - Items with a single link, or whose thumbnail link has no img, are skipped.
//  - A related block that is itself a thumbnail-plus-title pair can become a phantom item or break a card.
//  - /{page}/videos/{id}/ links are not recognised.
//  - The reserved-first-segment rule for post-like paths is a blocklist, not an allowlist.
(function () {
  const SELECTORS = {
    main: '[role="main"]',
    link: 'a[href]',
    image: 'img',
    // id derivation, applied to the link pathname / search
    watchPath: /^\/watch\/?$/,
    videoId: /^\d{8,}$/,
    reelPath: /^\/reel\/(\d{8,})(?:\/|$)/,
    postPaths: [
      /^\/groups\/[^/]+\/(?:posts|permalink)\/(\d{8,})(?:\/|$)/,
      /^\/(?:[^/]+\/)?(?:posts|permalink)\/(\d{8,})(?:\/|$)/,
      /^\/(?!(?:groups|photo|photos|pages|events|people|profile\.php|watch|reel|reels|stories|marketplace|hashtag|saved|share)\/)[^/]+\/(\d{8,})\/[^/]+/,
    ],
  };
  const TRACKING = ['__tn__', 'ref', 'mibextid', '_rdr'];
  const BASE = 'https://www.facebook.com';
  const DURATION = /^\d{1,2}(?::\d{2}){1,2}$/;

  const hostOk = (h) => /(^|\.)facebook\.com$/.test(h);
  const matches = (url) => {
    try {
      const u = new URL(url);
      return hostOk(u.hostname) && /^\/saved\/?$/.test(u.pathname);
    } catch {
      return false;
    }
  };

  const isHttp = (s) => /^https?:\/\//i.test(s ?? '');

  /** { id, kind: 'video'|'reel'|'post', url } for a primary link, else null. */
  function parseLink(a) {
    let u;
    try {
      u = new URL(a.getAttribute('href'), BASE);
    } catch {
      return null;
    }
    if (!hostOk(u.hostname)) return null;
    const v = u.searchParams.get('v');
    if (SELECTORS.watchPath.test(u.pathname) && v && SELECTORS.videoId.test(v)) return { id: v, kind: 'video', url: `${BASE}/watch/?v=${v}` };
    const reel = u.pathname.match(SELECTORS.reelPath)?.[1];
    if (reel) return { id: reel, kind: 'reel', url: `${BASE}/reel/${reel}/` };
    const num = SELECTORS.postPaths.map((re) => u.pathname.match(re)?.[1]).find(Boolean);
    if (num) {
      for (const k of TRACKING) u.searchParams.delete(k);
      return { id: num, kind: 'post', url: `${BASE}${u.pathname}${u.search}` };
    }
    return null;
  }

  /** A profile/page link: /profile.php?id=... or /{seg}?id=... */
  function isProfileLink(a) {
    try {
      const u = new URL(a.getAttribute('href'), BASE);
      if (!hostOk(u.hostname) || !u.searchParams.get('id')) return false;
      return u.pathname === '/profile.php' || /^\/[^/]+\/?$/.test(u.pathname);
    } catch {
      return false;
    }
  }

  function extract(document) {
    const root = document.querySelector(SELECTORS.main) ?? document;
    const parsed = new Map(); // anchor -> parsed link
    const groups = new Map(); // id -> { first, links[] , info }
    for (const a of root.querySelectorAll(SELECTORS.link)) {
      const p = parseLink(a);
      if (!p) continue;
      parsed.set(a, p);
      const g = groups.get(p.id);
      if (g) g.links.push(a);
      else groups.set(p.id, { info: p, links: [a] });
    }
    // card ids: the two-link pattern (2+ links, one with an img); the rest are secondary
    const cardIds = new Set([...groups].filter(([, g]) => g.links.length > 1 && g.links.some((a) => a.querySelector(SELECTORS.image))).map(([id]) => id));
    const idsIn = (el) => new Set([...el.querySelectorAll(SELECTORS.link)].map((a) => parsed.get(a)?.id).filter((x) => cardIds.has(x)));

    const items = [];
    for (const id of cardIds) {
      const { info, links } = groups.get(id);
      try {
        let card = links[0];
        while (
          card.parentElement &&
          !card.parentElement.matches(SELECTORS.main) &&
          !/^(BODY|HTML)$/.test(card.parentElement.tagName) &&
          [...idsIn(card.parentElement)].every((x) => x === id)
        ) {
          card = card.parentElement;
        }

        let text = '';
        for (const a of card.querySelectorAll(SELECTORS.link)) {
          if (parsed.get(a)?.id !== id) continue;
          const t = a.textContent.trim();
          if (!DURATION.test(t) && t.length > text.length) text = t;
        }

        let media = [];
        const imgs = [...links.flatMap((a) => [...a.querySelectorAll(SELECTORS.image)]), ...card.querySelectorAll(SELECTORS.image)];
        for (const img of imgs) {
          const src = img.getAttribute('src');
          if (isHttp(src) && /(^|\.)fbcdn\.net$/.test(new URL(src).hostname)) {
            media = [src];
            break;
          }
        }

        const who = [...card.querySelectorAll(SELECTORS.link)].find(isProfileLink);
        const author = who ? who.textContent.trim() || (who.getAttribute('aria-label') ?? '').trim() : '';

        items.push({ platform: 'facebook', native_id: id, url: info.url, author, text, media, saved_at: null, transcript: null });
      } catch {
        // one odd card must not lose the rest
      }
    }
    return items;
  }

  const adapter = { platform: 'facebook', matches, extract, SELECTORS };
  globalThis.__saveback?.register(adapter);
  if (typeof module !== 'undefined') module.exports = adapter;
})();
