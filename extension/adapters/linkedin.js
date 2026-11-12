// LinkedIn saved posts. Classic script, injected after core.js.
// Live structure (2026-11-13): https://www.linkedin.com/my-items/saved-posts/ ; cards are lazy-rendered
// (about 7 at first, more on scroll), so extract on every step. The card carries the activity urn;
// the permalink has an ?updateEntityUrn=... query that is dropped from `url`. saved_at is always null
// (the page only shows a relative time such as "2w").
(function () {
  const SELECTORS = {
    card: 'div[data-view-name="search-entity-result-content-a-template"][data-chameleon-result-urn]',
    profileLink: 'a[href*="/in/"]', // first wraps the avatar, a later one holds the name text
    paragraph: 'p', // a short label first, then the post body: take the longest
    seeMore: 'button', // "…see more" lives inside the body paragraph
    media: 'a[href*="/feed/update/"] img',
  };
  const MIN_BODY = 10; // ponytail: the short label paragraph is ~4 chars; a real body under 10 chars reads as text-less
  const SAVED_PREFIX = '/my-items/saved-posts';

  const matches = (url) => {
    try {
      const u = new URL(url);
      return /(^|\.)linkedin\.com$/.test(u.hostname) && u.pathname.startsWith(SAVED_PREFIX);
    } catch {
      return false;
    }
  };

  const isHttp = (s) => /^https?:\/\//i.test(s ?? '');
  const squash = (s) => s.replace(/\s+/g, ' ').trim();

  function bodyText(p) {
    const copy = p.cloneNode(true);
    copy.querySelectorAll(SELECTORS.seeMore).forEach((n) => n.remove());
    copy.querySelectorAll('br').forEach((br) => br.replaceWith('\n'));
    return copy.textContent.trim();
  }

  function extractCard(card) {
    const id = card.getAttribute('data-chameleon-result-urn')?.match(/(\d+)$/)?.[1];
    if (!id) return null;

    const links = [...card.querySelectorAll(SELECTORS.profileLink)];
    const name = links.map((a) => squash(a.textContent)).find(Boolean);
    const slug = links[0]?.getAttribute('href')?.match(/\/in\/([^/?#]+)/)?.[1] ?? '';

    const text = [...card.querySelectorAll(SELECTORS.paragraph)].map(bodyText).reduce((a, b) => (b.length > a.length ? b : a), '');

    const media = [];
    for (const img of card.querySelectorAll(SELECTORS.media)) {
      if (img.closest(SELECTORS.profileLink)) continue; // author avatar
      const src = img.getAttribute('src');
      if (isHttp(src) && !media.includes(src)) media.push(src);
    }

    return {
      platform: 'linkedin',
      native_id: id,
      url: `https://www.linkedin.com/feed/update/urn:li:activity:${id}/`,
      author: name || slug,
      text: text.length >= MIN_BODY ? text : '',
      media,
      saved_at: null,
      transcript: null,
    };
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

  const adapter = { platform: 'linkedin', matches, extract, SELECTORS };
  globalThis.__saveback?.register(adapter);
  if (typeof module !== 'undefined') module.exports = adapter;
})();
