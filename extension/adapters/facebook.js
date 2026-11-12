// Facebook saved items. Classic script, injected after core.js.
// Live structure (2026-11-13): https://www.facebook.com/saved. Class names are obfuscated, so nothing here
// selects by class. Each saved item holds 2 links to the same video (a thumbnail link with an img and a
// duration such as "0:30", and a text link with the title), often a source link too. So: derive an id from
// every primary link inside [role="main"] (v= param, /reel/{id}, or the numeric path segment), and for each
// distinct id climb from its first link to the biggest ancestor that holds links for that one id only.
// That ancestor is the card. The page shows no save time (saved_at null).
(function () {
  const SELECTORS = {
    main: '[role="main"]',
    link: 'a[href]',
    image: 'img',
    // id derivation, applied to the link pathname / search
    watchPath: /^\/watch\/?$/,
    reelPath: /^\/reel\/(\d+)/,
    numericSegment: /\/(\d{8,})(?:\/|$)/,
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
    if (SELECTORS.watchPath.test(u.pathname) && v) return { id: v, kind: 'video', url: `${BASE}/watch/?v=${v}` };
    const reel = u.pathname.match(SELECTORS.reelPath)?.[1];
    if (reel) return { id: reel, kind: 'reel', url: `${BASE}/reel/${reel}/` };
    const num = u.pathname.match(SELECTORS.numericSegment)?.[1];
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
    const idsIn = (el) => new Set([...el.querySelectorAll(SELECTORS.link)].map((a) => parsed.get(a)?.id).filter(Boolean));

    const items = [];
    for (const [id, { info, links }] of groups) {
      try {
        let card = links[0];
        while (
          card.parentElement &&
          !card.matches(SELECTORS.main) &&
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
