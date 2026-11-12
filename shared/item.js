/**
 * @typedef {'x'|'linkedin'|'instagram'|'facebook'|'threads'|'youtube'|'reddit'|'tiktok'|'pinterest'|'web'} Platform
 * @typedef {{platform: Platform, native_id: string, url: string, author: string, text: string, media: string[], saved_at: string|null, transcript: string|null}} Item
 */

export const PLATFORMS = ['x', 'linkedin', 'instagram', 'facebook', 'threads', 'youtube', 'reddit', 'tiktok', 'pinterest', 'web'];

/** @param {string} v */
function isHttpUrl(v) {
  try {
    const p = new URL(v).protocol;
    return p === 'http:' || p === 'https:';
  } catch {
    return false;
  }
}

/**
 * @param {unknown} raw
 * @returns {Item}
 */
export function validateItem(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('item must be an object');
  const r = /** @type {Record<string, unknown>} */ (raw);

  if (typeof r.platform !== 'string' || !PLATFORMS.includes(r.platform)) throw new Error('platform: unknown platform');
  if (typeof r.native_id !== 'string' || r.native_id === '') throw new Error('native_id: must be a non-empty string');
  if (typeof r.url !== 'string' || !isHttpUrl(r.url)) throw new Error('url: must be an http(s) url');

  const author = r.author ?? '';
  if (typeof author !== 'string') throw new Error('author: must be a string');
  const text = r.text ?? '';
  if (typeof text !== 'string') throw new Error('text: must be a string');
  const media = r.media ?? [];
  if (!Array.isArray(media) || !media.every((m) => typeof m === 'string' && isHttpUrl(m))) {
    throw new Error('media: must be an array of http(s) urls');
  }
  const saved_at = r.saved_at ?? null;
  if (saved_at !== null && (typeof saved_at !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(saved_at) || Number.isNaN(Date.parse(saved_at)))) {
    throw new Error('saved_at: must be an ISO date-time string (YYYY-MM-DDT...) or null');
  }
  const transcript = r.transcript ?? null;
  if (transcript !== null && typeof transcript !== 'string') throw new Error('transcript: must be a string or null');

  return {
    platform: /** @type {Platform} */ (r.platform),
    native_id: r.native_id,
    url: r.url,
    author,
    text,
    media: [...media],
    saved_at,
    transcript,
  };
}

/** @param {Pick<Item, 'platform'|'native_id'>} item */
export function itemId(item) {
  return `${item.platform}:${item.native_id}`;
}
