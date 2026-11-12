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

/**
 * @param {{db: import('node:sqlite').DatabaseSync, token?: string}} opts
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void}
 */
export function createReceiver({ db, token }) {
  return (req, res) => {
    const origin = req.headers.origin;
    const cors = {};

    const send = (status, body, extra = {}) => {
      res.writeHead(status, { 'content-type': 'application/json', ...cors, ...extra });
      res.end(body === undefined ? undefined : JSON.stringify(body));
    };

    if (origin) {
      if (!origin.startsWith(EXT_PREFIX)) return send(403, { error: 'forbidden origin' });
      cors['access-control-allow-origin'] = origin;
      cors.vary = 'Origin';
    }

    if (req.method === 'OPTIONS') {
      return send(204, undefined, {
        'access-control-allow-headers': 'Authorization, Content-Type',
        'access-control-allow-methods': 'POST, GET, OPTIONS',
      });
    }

    const path = (req.url ?? '').split('?')[0];
    // /health is open on purpose: platform health checks cannot send a bearer token.
    if (req.method === 'GET' && path === '/health') return send(200, { ok: true });

    if (token) {
      const m = /^Bearer (.*)$/.exec(req.headers.authorization ?? '');
      if (!m || !safeEqual(m[1], token)) return send(401, { error: 'unauthorized' });
    }

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
