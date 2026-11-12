// Threads saved posts. Classic script, injected after core.js.
// Live structure (2026-11-13): https://www.threads.com/saved (Threads moved from threads.net, both accepted).
// A post is the anchor /@{user}/post/{code} wrapping a <time> (the POST time, not the save time, so saved_at
// is always null). There is no stable card element: group anchors by code and climb to the smallest
// ancestor that holds only that code, stopping at the element carrying data-pagelet.
(function () {
  const SELECTORS = {
    postLink: 'a[href*="/post/"]',
    time: 'time',
    text: '[dir="auto"]', // post body is the longest of these that is not the username or the time
    image: 'img',
    pagelet: 'data-pagelet', // attribute name
  };
  const POST = /^\/@([^/?#]+)\/post\/([\w-]{8,14})(?:[/?#]|$)/;
  const hostOk = (h) => /(^|\.)threads\.(com|net)$/.test(h);

  const matches = (url) => {
    try {
      const u = new URL(url);
      return hostOk(u.hostname) && u.pathname.replace(/\/+$/, '') === '/saved';
    } catch {
      return false;
    }
  };

  const isHttp = (s) => /^https?:\/\//i.test(s ?? '');
  const codeOf = (a) => a.getAttribute('href')?.match(POST)?.[2];

  function cardFor(anchor, code) {
    let node = anchor;
    while (node.parentElement && !/^(BODY|HTML)$/.test(node.parentElement.tagName) && !node.hasAttribute(SELECTORS.pagelet)) {
      const others = [...node.parentElement.querySelectorAll(SELECTORS.postLink)].map(codeOf).filter((c) => c && c !== code);
      if (others.length) break;
      node = node.parentElement;
    }
    return node;
  }

  function extractCard(card, user, code) {
    const profile = `a[href="/@${user}"]`;
    let text = '';
    for (const el of card.querySelectorAll(SELECTORS.text)) {
      if (el.closest(SELECTORS.time) || el.closest(profile) || el.querySelector(SELECTORS.time)) continue;
      const t = el.textContent.trim();
      if (t && t !== user && t.length > text.length) text = t;
    }

    const media = [];
    for (const img of card.querySelectorAll(SELECTORS.image)) {
      if (img.closest(profile) || /profile picture/i.test(img.getAttribute('alt') ?? '')) continue; // avatar
      const src = img.getAttribute('src');
      if (isHttp(src) && !media.includes(src)) media.push(src);
    }

    return { platform: 'threads', native_id: code, url: `https://www.threads.com/@${user}/post/${code}`, author: user, text, media, saved_at: null, transcript: null };
  }

  function extract(document) {
    const first = new Map(); // code -> first anchor
    for (const a of document.querySelectorAll(SELECTORS.postLink)) {
      const m = a.getAttribute('href')?.match(POST);
      if (m && a.querySelector(SELECTORS.time) && !first.has(m[2])) first.set(m[2], { a, user: m[1] });
    }
    const items = [];
    for (const [code, { a, user }] of first) {
      try {
        items.push(extractCard(cardFor(a, code), user, code));
      } catch {
        // one odd card must not lose the rest
      }
    }
    return items;
  }

  const adapter = { platform: 'threads', matches, extract, SELECTORS };
  globalThis.__saveback?.register(adapter);
  if (typeof module !== 'undefined') module.exports = adapter;
})();
