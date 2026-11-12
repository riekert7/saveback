import { DatabaseSync } from 'node:sqlite';
import { itemId } from '../shared/item.js';

/**
 * @typedef {import('../shared/item.js').Item} Item
 * @typedef {Item & {id: string, captured_at: string, seen: boolean, notes: string, tags: string[]}} StoredItem
 */

const COLS = 'id, platform, native_id, url, author, text, media, saved_at, transcript, captured_at, seen, notes, tags';
// Most-recent ordering and date filters use when the post was saved, else when we captured it.
const WHEN = 'COALESCE(saved_at, captured_at)';

/**
 * @param {string} path file path or ':memory:'
 * @returns {DatabaseSync}
 */
export function openDb(path) {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA busy_timeout = 5000'); // two local processes can share one file
  if (path !== ':memory:') db.exec('PRAGMA journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS items (
      id TEXT NOT NULL UNIQUE,
      platform TEXT NOT NULL,
      native_id TEXT NOT NULL,
      url TEXT NOT NULL,
      author TEXT NOT NULL DEFAULT '',
      text TEXT NOT NULL DEFAULT '',
      media TEXT NOT NULL DEFAULT '[]',
      saved_at TEXT,
      transcript TEXT,
      captured_at TEXT NOT NULL,
      seen INTEGER NOT NULL DEFAULT 0,
      notes TEXT NOT NULL DEFAULT '',
      tags TEXT NOT NULL DEFAULT '[]'
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS items_fts USING fts5(text, author, url, transcript, notes);
  `);
  return db;
}

/** Replace the FTS row for an item (kept in sync by hand, rowid = items.rowid). */
function syncFts(db, id) {
  const r = db.prepare('SELECT rowid, text, author, url, transcript, notes FROM items WHERE id = ?').get(id);
  db.prepare('DELETE FROM items_fts WHERE rowid = ?').run(r.rowid);
  db.prepare('INSERT INTO items_fts (rowid, text, author, url, transcript, notes) VALUES (?, ?, ?, ?, ?, ?)')
    .run(r.rowid, r.text, r.author, r.url, r.transcript ?? '', r.notes);
}

/** Run fn in a transaction. */
function tx(db, fn) {
  db.exec('BEGIN');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

/**
 * Insert, or update content fields only (seen, notes, tags, captured_at are kept).
 * @param {DatabaseSync} db
 * @param {Item} item
 * @returns {{id: string, created: boolean}}
 */
export function upsertItem(db, item) {
  const id = itemId(item);
  return tx(db, () => {
    const created = !db.prepare('SELECT 1 FROM items WHERE id = ?').get(id);
    db.prepare(`
      INSERT INTO items (id, platform, native_id, url, author, text, media, saved_at, transcript, captured_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET url = excluded.url, author = excluded.author, text = excluded.text,
        media = excluded.media, saved_at = excluded.saved_at, transcript = excluded.transcript
    `).run(id, item.platform, item.native_id, item.url, item.author, item.text, JSON.stringify(item.media),
      item.saved_at, item.transcript, new Date().toISOString());
    syncFts(db, id);
    return { id, created };
  });
}

function toStored(r) {
  return {
    id: r.id, platform: r.platform, native_id: r.native_id, url: r.url, author: r.author, text: r.text,
    media: JSON.parse(r.media), saved_at: r.saved_at, transcript: r.transcript,
    captured_at: r.captured_at, seen: r.seen === 1, notes: r.notes, tags: JSON.parse(r.tags),
  };
}

/**
 * @param {DatabaseSync} db
 * @param {string} id
 * @returns {StoredItem | null}
 */
export function getSaved(db, id) {
  const r = db.prepare(`SELECT ${COLS} FROM items WHERE id = ?`).get(id);
  return r ? toStored(r) : null;
}

const clampLimit = (n) => Math.min(Math.max(Math.trunc(Number(n)) || 20, 1), 100);

/**
 * @param {DatabaseSync} db
 * @param {{query?: string, platform?: string, since?: string, limit?: number}} opts
 * @returns {StoredItem[]}
 */
export function searchSaved(db, { query = '', platform, since, limit } = {}) {
  const where = [];
  const args = [];
  let from = 'items';
  let order = `${WHEN} DESC`;
  if (query.trim() !== '') {
    // Quote every token so FTS operators/punctuation are plain text; drop tokens with no letters/digits.
    const tokens = query.split(/\s+/).filter((t) => /[\p{L}\p{N}]/u.test(t)).map((t) => `"${t.replaceAll('"', '""')}"`);
    if (tokens.length === 0) return [];
    from = 'items JOIN items_fts ON items_fts.rowid = items.rowid';
    where.push('items_fts MATCH ?');
    args.push(tokens.join(' '));
    order = 'items_fts.rank';
  }
  if (platform) { where.push('items.platform = ?'); args.push(platform); }
  if (since) { where.push(`julianday(${WHEN}) >= julianday(?)`); args.push(since); }
  const sql = `SELECT ${COLS.split(', ').map((c) => `items.${c}`).join(', ')} FROM ${from}
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY ${order} LIMIT ?`;
  return db.prepare(sql).all(...args, clampLimit(limit)).map(toStored);
}

/** @returns {StoredItem[]} */
export function listRecent(db, { limit } = {}) {
  return searchSaved(db, { query: '', limit });
}

/** @returns {StoredItem[]} */
export function listUnseen(db, { limit, olderThanDays } = {}) {
  const args = [];
  let cond = '';
  if (olderThanDays !== undefined) {
    cond = `AND julianday(${WHEN}) <= julianday('now') - ?`;
    args.push(olderThanDays);
  }
  return db.prepare(`SELECT ${COLS} FROM items WHERE seen = 0 ${cond} ORDER BY ${WHEN} DESC LIMIT ?`)
    .all(...args, clampLimit(limit)).map(toStored);
}

/** @returns {boolean} true if the item exists */
export function markSeen(db, id) {
  return Number(db.prepare('UPDATE items SET seen = 1 WHERE id = ?').run(id).changes) > 0;
}

/** Appends on a new line. @returns {boolean} true if the item exists */
export function addNote(db, id, note) {
  return tx(db, () => {
    const r = db.prepare("UPDATE items SET notes = CASE WHEN notes = '' THEN ? ELSE notes || char(10) || ? END WHERE id = ?")
      .run(note, note, id);
    if (Number(r.changes) === 0) return false;
    syncFts(db, id);
    return true;
  });
}

/** @returns {boolean} true if the item exists */
export function setTags(db, id, tags) {
  return Number(db.prepare('UPDATE items SET tags = ? WHERE id = ?').run(JSON.stringify(tags), id).changes) > 0;
}
