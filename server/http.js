import { createHash, timingSafeEqual } from 'node:crypto';
import { validateItem } from '../shared/item.js';
import { upsertItem } from './db.js';

const MAX_BODY = 1024 * 1024;
const EXT_PREFIX = 'chrome-extension://';

/** Constant-time compare; hashing first makes lengths equal so timingSafeEqual never throws. */
function safeEqual(a, b) {
  const h = (s) => createHash('sha256').update(s).digest();
  return timingSafeEqual(h(a), h(b));
}

const sendJson = (res, status, body, headers = {}) => {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(body === undefined ? undefined : JSON.stringify(body));
};

/**
 * Origin check: any Origin that is not a browser extension gets 403 (sent here).
 * @returns {Record<string, string> | null} CORS headers to add to responses, or null when rejected
 */
export function checkOrigin(req, res) {
  const origin = req.headers.origin;
  if (!origin) return {};
  if (!origin.startsWith(EXT_PREFIX)) {
    sendJson(res, 403, { error: 'forbidden origin' });
    return null;
  }
  return { 'access-control-allow-origin': origin, vary: 'Origin' };
}

/** Bearer token check (skipped when token is empty/undefined); sends 401 itself. @returns {boolean} allowed */
export function checkToken(req, res, token, cors = {}) {
  if (!token) return true;
  const m = /^Bearer (.*)$/.exec(req.headers.authorization ?? '');
  if (m && safeEqual(m[1], token)) return true;
  sendJson(res, 401, { error: 'unauthorized' }, cors);
  return false;
}

/** Origin then token, for routes that are always protected (/mcp). Sends 403/401 itself. @returns {boolean} allowed */
export function authorize(req, res, { token }) {
  const cors = checkOrigin(req, res);
  return cors !== null && checkToken(req, res, token, cors);
}

/**
 * @param {{db: import('node:sqlite').DatabaseSync, token?: string}} opts
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void}
 */
export function createReceiver({ db, token }) {
  return (req, res) => {
    const cors = checkOrigin(req, res);
    if (cors === null) return;
    const send = (status, body, extra = {}) => sendJson(res, status, body, { ...cors, ...extra });

    if (req.method === 'OPTIONS') {
      return send(204, undefined, {
        'access-control-allow-headers': 'Authorization, Content-Type',
        'access-control-allow-methods': 'POST, GET, OPTIONS',
      });
    }

    const path = (req.url ?? '').split('?')[0];
    // /health is open on purpose: platform health checks cannot send a bearer token.
    if (req.method === 'GET' && path === '/health') return send(200, { ok: true });

    if (!checkToken(req, res, token, cors)) return;

    if (req.method !== 'POST' || path !== '/ingest') return send(404, { error: 'not found' });

    // Read at most MAX_BODY bytes; past that, keep draining but stop storing.
    // ponytail: drains an oversize upload instead of destroying the socket, so the client reliably sees the 413.
    const chunks = [];
    let size = 0;
    let over = false;
    req.on('data', (c) => {
      if (over) return;
      size += c.length;
      if (size > MAX_BODY) {
        over = true;
        chunks.length = 0;
        send(413, { error: 'body too large' }, { connection: 'close' });
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (over) return;
      let body;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        return send(400, { error: 'invalid JSON' });
      }
      if (body === null || typeof body !== 'object' || !Array.isArray(body.items)) {
        return send(400, { error: 'body must be {"items": [...]}' });
      }
      let stored = 0;
      let created = 0;
      const errors = [];
      body.items.forEach((raw, index) => {
        try {
          const item = validateItem(raw);
          if (item.saved_at !== null) item.saved_at = new Date(Date.parse(item.saved_at)).toISOString();
          const r = upsertItem(db, item);
          stored++;
          if (r.created) created++;
        } catch (e) {
          errors.push({ index, message: e instanceof Error ? e.message : String(e) });
        }
      });
      send(200, { stored, created, errors });
    });
    req.on('error', () => {});
  };
}
