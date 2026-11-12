import { createHash } from 'node:crypto';
import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP, isIPv4 } from 'node:net';

/** @typedef {import('../shared/item.js').Item} Item */

const MAX_REDIRECTS = 3;
const MAX_BYTES = 2 * 1024 * 1024;
const TIMEOUT_MS = 10_000;
const MAX_TEXT = 20_000;

/** @param {string} host */
const defaultLookup = async (host) => (await dnsLookup(host, { all: true })).map((a) => a.address);

/** @param {string} ip dotted quad */
function blockedV4(ip) {
  const [a, b] = ip.split('.').map(Number);
  return (
    a === 0 || a === 10 || a === 127 || a >= 224 || // this-net, private, loopback, multicast/reserved
    (a === 169 && b === 254) || // link-local incl. cloud metadata
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) // CGNAT
  );
}

/** Expand an IPv6 literal to eight 16-bit groups, or null if malformed. @param {string} ip */
function groupsV6(ip) {
  let s = ip;
  const dot = s.lastIndexOf('.');
  if (dot !== -1) { // embedded ipv4 tail
    const i = s.lastIndexOf(':') + 1;
    const q = s.slice(i);
    if (!isIPv4(q)) return null;
    const [a, b, c, d] = q.split('.').map(Number);
    s = `${s.slice(0, i)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const fill = 8 - head.length - tail.length;
  if (halves.length === 1 ? fill !== 0 : fill < 1) return null;
  const all = [...head, ...Array(halves.length === 2 ? fill : 0).fill('0'), ...tail].map((h) => parseInt(h, 16));
  return all.length === 8 && all.every((n) => n >= 0 && n <= 0xffff) ? all : null;
}

/** True when the address must not be fetched; anything unparseable counts as blocked. @param {string} ip */
function isBlockedIp(ip) {
  if (isIPv4(ip)) return blockedV4(ip);
  if (isIP(ip) !== 6) return true; // also rejects zone ids like fe80::1%eth0
  const g = groupsV6(ip);
  if (!g) return true;
  const v4 = `${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}.${g[7] & 255}`;
  if (g.slice(0, 5).every((n) => n === 0) && (g[5] === 0xffff || g[5] === 0)) return g[5] === 0 ? true : blockedV4(v4); // ::ffff:a.b.c.d judged by v4; ::, ::1, ::/96 blocked
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((n) => n === 0)) return blockedV4(v4); // NAT64
  return (g[0] & 0xfe00) === 0xfc00 || (g[0] & 0xffc0) === 0xfe80; // fc00::/7, fe80::/10
}

/**
 * Throws unless the url is http(s) and every address it resolves to is public.
 * ponytail: DNS may change between this check and the fetch (rebinding); upgrade is to pin the resolved IP for the request.
 * @param {URL} u
 * @param {(host: string) => Promise<string[]>} lookup
 */
async function assertPublic(u, lookup) {
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('only http(s) urls are allowed');
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost')) throw new Error('blocked address: localhost');
  const addrs = isIP(host) ? [host] : await lookup(host);
  if (!addrs.length) throw new Error(`could not resolve ${host}`);
  for (const a of addrs) if (isBlockedIp(a)) throw new Error(`blocked address: ${host} resolves to ${a}`);
}

/**
 * @typedef {{fetch?: typeof fetch, lookup?: (host: string) => Promise<string[]>}} Deps
 * @param {string} rawUrl
 * @param {Required<Deps>} deps
 * @param {AbortSignal} signal
 * @returns {Promise<{url: string, res: Response}>} final url and a successful response
 */
async function guardedGet(rawUrl, { fetch, lookup }, signal) {
  let url = new URL(rawUrl);
  for (let hop = 0; ; hop++) {
    await assertPublic(url, lookup);
    const res = await fetch(url.href, { redirect: 'manual', signal, headers: { 'user-agent': 'Mozilla/5.0 (compatible; Saveback)', accept: 'text/html,text/plain;q=0.9,*/*;q=0.1' } });
    const loc = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
    if (!loc) {
      if (!res.ok) throw new Error(`fetch failed: ${res.status}`);
      return { url: url.href, res };
    }
    await res.body?.cancel();
    if (hop >= MAX_REDIRECTS) throw new Error('too many redirects');
    url = new URL(loc, url);
  }
}

/** Read at most MAX_BYTES of the body as utf-8. @param {Response} res */
async function readCapped(res) {
  if (!res.body) return '';
  const chunks = [];
  let n = 0;
  for await (const c of res.body) {
    chunks.push(c);
    n += c.length;
    if (n >= MAX_BYTES) break; // breaking cancels the stream
  }
  return new TextDecoder().decode(Buffer.concat(chunks).subarray(0, MAX_BYTES));
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
/** @param {string} s */
const decode = (s) =>
  s.replace(/&(?:#(\d+)|#x([0-9a-f]+)|(\w+));/gi, (m, d, h, n) => {
    if (n) return ENTITIES[n.toLowerCase()] ?? m;
    const cp = d ? Number(d) : parseInt(h, 16);
    return cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
  });

/** Every pattern stops at the next '<' or end of input, so unclosed tags cannot cause quadratic backtracking. @param {string} html */
function htmlToText(html) {
  const title = /<title\b[^<>]*>([^<]*)/i.exec(html)?.[1] ?? '';
  const body = html
    .replace(/<!--[\s\S]*?(?:-->|$)/g, ' ')
    .replace(/<(script|style|noscript|template|head)\b[\s\S]*?(?:<\/\1\s*>|$)/gi, ' ')
    .replace(/<[^<>]*>/g, ' ');
  const squash = (s) => decode(s).replace(/\s+/g, ' ').trim();
  return [squash(title), squash(body)].filter(Boolean).join('\n\n').slice(0, MAX_TEXT);
}

/** @param {URL} u @returns {string|null} */
function youtubeId(u) {
  const h = u.hostname.toLowerCase();
  const id = h === 'youtu.be' ? u.pathname.slice(1).split('/')[0]
    : /^(www\.|m\.)?youtube\.com$/.test(h) && u.pathname === '/watch' ? u.searchParams.get('v') : null;
  return id && /^[\w-]{6,20}$/.test(id) ? id : null;
}

/** Pull the JSON object assigned to ytInitialPlayerResponse out of a watch page. @param {string} html */
function playerResponse(html) {
  const m = /ytInitialPlayerResponse\s*=\s*/.exec(html);
  if (!m) return null;
  const start = m.index + m[0].length;
  let depth = 0, inStr = false;
  for (let i = start; i < html.length; i++) {
    const c = html[i];
    if (inStr) { if (c === '\\') i++; else if (c === '"') inStr = false; }
    else if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) {
      try { return JSON.parse(html.slice(start, i + 1)); } catch { return null; }
    }
  }
  return null;
}

/**
 * Save a url as an Item. Refuses non-http(s) and anything that resolves to a non-public address.
 * @param {string} url
 * @param {Deps} [deps]
 * @returns {Promise<Item>}
 */
export async function fetchSaveable(url, deps = {}) {
  const d = { fetch: deps.fetch ?? globalThis.fetch, lookup: deps.lookup ?? defaultLookup };
  const signal = AbortSignal.timeout(TIMEOUT_MS);
  const { url: finalUrl, res } = await guardedGet(url, d, signal);
  const type = res.headers.get('content-type') ?? '';
  const readable = /^text\/(html|plain)\b/i.test(type);
  const body = readable ? await readCapped(res) : (await res.body?.cancel(), '');

  const vid = youtubeId(new URL(finalUrl));
  if (vid) {
    const pr = playerResponse(body);
    const track = pr?.captions?.playerCaptionsTracklistRenderer?.captionTracks?.[0]?.baseUrl;
    let transcript = null;
    if (typeof track === 'string') {
      try { // caption url comes from page content, so it goes through the same guard
        const cap = await guardedGet(track, d, signal);
        const xml = await readCapped(cap.res);
        const lines = [...xml.matchAll(/<text\b[^<>]*>([^<]*)/g)].map((x) => decode(x[1]).replace(/\s+/g, ' ').trim());
        transcript = lines.filter(Boolean).join(' ') || null;
      } catch { /* no usable captions */ }
    }
    return {
      platform: 'youtube', native_id: vid, url: `https://www.youtube.com/watch?v=${vid}`,
      author: String(pr?.videoDetails?.author ?? ''), text: String(pr?.videoDetails?.title ?? htmlToText(body)),
      media: [], saved_at: null, transcript,
    };
  }

  return {
    platform: 'web', native_id: createHash('sha1').update(finalUrl).digest('hex').slice(0, 16), url: finalUrl,
    author: '', text: !readable ? '' : /html/i.test(type) ? htmlToText(body) : body.trim().slice(0, MAX_TEXT),
    media: [], saved_at: null, transcript: null,
  };
}
