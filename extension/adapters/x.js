// X (Twitter) saved posts. Classic script, injected after core.js.
// Live structure (2026-11-13): the saved page is https://x.com/i/history with the Bookmarks tab selected
// (the old /i/bookmarks redirects there, so both are accepted). The list is virtualised: extract on every scroll step.
(function () {
  const SELECTORS = {
    card: 'article[data-testid="tweet"]',
    permalink: 'a[href*="/status/"]', // the one that wraps <time>
    text: '[data-testid="tweetText"]',
    showMore: '[data-testid="tweet-text-show-more-link"]',
    media: '[data-testid="tweetPhoto"] img, video[poster]',
    quoted: 'div[role="link"]', // a quoted tweet nests its own text, photos and author in here
  };
  const SAVED_PATHS = ['/i/history', '/i/bookmarks'];
  const STATUS = /^\/([^/?#]+)\/status\/(\d+)/;

  const matches = (url) => {
    try {
      const u = new URL(url);
      const host = u.hostname.replace(/^www\./, '');
      return (host === 'x.com' || host === 'twitter.com') && SAVED_PATHS.includes(u.pathname.replace(/\/+$/, ''));
    } catch {
      return false;
    }
  };

  const isHttp = (s) => /^https?:\/\//i.test(s ?? '');

  function extractCard(card) {
    // First permalink anchor that wraps a <time>: the post itself (a quoted tweet's time is not in an anchor).
    const link = [...card.querySelectorAll(SELECTORS.permalink)].find((a) => a.querySelector('time') && STATUS.test(a.getAttribute('href')));
    if (!link) return null;
    const [, handle, id] = link.getAttribute('href').match(STATUS);

    // Nothing nested in a quoted tweet counts as this post's own.
    const own = (el) => !el.closest(SELECTORS.quoted);
    const textEl = [...card.querySelectorAll(SELECTORS.text)].find(own);
    let text = '';
    if (textEl) {
      const copy = textEl.cloneNode(true);
      copy.querySelectorAll(SELECTORS.showMore).forEach((n) => n.remove());
      text = copy.textContent.trim();
    }

    const media = [];
    for (const el of card.querySelectorAll(SELECTORS.media)) {
      if (!own(el)) continue;
      const src = el.tagName === 'VIDEO' ? el.getAttribute('poster') : el.getAttribute('src');
      if (isHttp(src) && !media.includes(src)) media.push(src);
    }

    return { platform: 'x', native_id: id, url: `https://x.com/${handle}/status/${id}`, author: handle, text, media, saved_at: null, transcript: null };
  }

  function extract(document) {
    const items = [];
    for (const card of document.querySelectorAll(SELECTORS.card)) {
      try {
        const item = extractCard(card);
        if (item) items.push(item);
      } catch {
        // one odd card must not lose the rest
      }
    }
    return items;
  }

  const adapter = { platform: 'x', matches, extract, SELECTORS };
  globalThis.__saveback?.register(adapter);
  if (typeof module !== 'undefined') module.exports = adapter;
})();
