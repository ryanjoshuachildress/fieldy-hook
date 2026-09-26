'use strict';

const express = require('express');
const db = require('../db');
const { checkAuth, applyTransform, validateTransform } = require('../lib/auth');
const { buildWhere, parseLimitOffset } = require('../lib/search');

const router = express.Router();

// The token gates everything under /api; the static UI page stays public and
// sends the token with each fetch.
router.use(express.json({ limit: '1mb' }));
router.use((req, res, next) => {
  if (!checkAuth(req)) return res.status(401).json({ error: 'invalid token' });
  next();
});

const BASE_COLUMNS = `
  id, received_at, source_ip, auth_method, content_type, event_date,
  transcript, speaker, conversation_id, event_type, raw_sha256
`;

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

router.get('/events', (req, res) => {
  const { where, params } = buildWhere(req.query);
  const { limit, offset } = parseLimitOffset(req.query);

  const total = db.prepare(`SELECT COUNT(*) AS n FROM events ${where}`).get(...params).n;
  const rows = db
    .prepare(`SELECT ${BASE_COLUMNS} FROM events ${where} ORDER BY id DESC LIMIT ? OFFSET ?`)
    .all(...params, limit, offset);

  res.json({ total, limit, offset, events: rows });
});

router.get('/events/:id', (req, res) => {
  const row = db
    .prepare(`SELECT id, raw, content_type FROM events WHERE id = ?`)
    .get(req.params.id);
  if (!row) return res.status(404).json({ error: 'not found' });

  // ?raw=1 streams the payload exactly as Fieldy sent it.
  if (req.query.raw) {
    res.set('Content-Type', row.content_type || 'application/json');
    return res.send(row.raw);
  }

  let parsed;
  try { parsed = JSON.parse(row.raw); } catch { parsed = { undecodable: true }; }
  return res.json({ id: row.id, raw: parsed });
});

router.delete('/events/:id', (req, res) => {
  const info = db.prepare('DELETE FROM events WHERE id = ?').run(req.params.id);
  if (info.changes === 0) return res.status(404).json({ error: 'not found' });
  res.json({ ok: true, deleted: info.changes });
});

// ---------------------------------------------------------------------------
// Transforms
// ---------------------------------------------------------------------------

const TRANSFORM_COLUMNS = 'name, code, created_at, updated_at';

router.get('/transforms', (_req, res) => {
  res.json({ transforms: db.prepare(`SELECT ${TRANSFORM_COLUMNS} FROM transforms ORDER BY name`).all() });
});

router.post('/transforms', (req, res) => {
  const { name, code } = req.body || {};
  if (!name || typeof name !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(name)) {
    return res.status(400).json({ error: 'name must match [a-zA-Z0-9_-]{1,64}' });
  }
  if (!code || typeof code !== 'string') {
    return res.status(400).json({ error: 'code (function source) is required' });
  }

  try {
    validateTransform(code);
  } catch (err) {
    return res.status(400).json({ error: `transform failed validation: ${err.message}` });
  }

  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO transforms (name, code, created_at, updated_at)
    VALUES (@name, @code, @now, @now)
    ON CONFLICT(name) DO UPDATE SET code = excluded.code, updated_at = excluded.updated_at
  `).run({ name, code, now });

  res.status(201).json({ ok: true, name });
});

router.delete('/transforms/:name', (req, res) => {
  const info = db.prepare('DELETE FROM transforms WHERE name = ?').run(req.params.name);
  if (info.changes === 0) return res.status(404).json({ error: 'not found' });
  res.json({ ok: true });
});

// Apply a saved transform to a single event.
router.get('/events/:id/transform/:name', (req, res) => {
  const transform = db.prepare('SELECT code FROM transforms WHERE name = ?').get(req.params.name);
  if (!transform) return res.status(404).json({ error: 'transform not found' });

  const event = db.prepare(`
    SELECT ${BASE_COLUMNS}, raw FROM events WHERE id = ?
  `).get(req.params.id);
  if (!event) return res.status(404).json({ error: 'event not found' });

  try {
    let parsedRaw;
    try { parsedRaw = JSON.parse(event.raw); } catch { parsedRaw = event.raw; }
    const result = applyTransform(transform.code, publicEvent(event), parsedRaw);
    return res.json({ ok: true, id: event.id, transform: req.params.name, result });
  } catch (err) {
    return res.status(422).json({ error: `transform failed: ${err.message}` });
  }
});

// Apply a saved transform to every event matching a search query.
router.post('/transforms/:name/run', (req, res) => {
  const transform = db.prepare('SELECT code FROM transforms WHERE name = ?').get(req.params.name);
  if (!transform) return res.status(404).json({ error: 'transform not found' });

  const query = { ...(req.query), ...(req.body || {}) };
  const { where, params } = buildWhere(query);
  const { limit } = parseLimitOffset(query, { limit: 200, maxLimit: 5000 });

  const rows = db
    .prepare(`SELECT ${BASE_COLUMNS}, raw FROM events ${where} ORDER BY id DESC LIMIT ?`)
    .all(...params, limit);

  const results = [];
  const failures = [];
  for (const row of rows) {
    try {
      let parsedRaw;
      try { parsedRaw = JSON.parse(row.raw); } catch { parsedRaw = row.raw; }
      results.push({ id: row.id, result: applyTransform(transform.code, publicEvent(row), parsedRaw) });
    } catch (err) {
      failures.push({ id: row.id, error: err.message });
    }
  }

  res.json({ ok: true, transform: req.params.name, matched: rows.length, results, failures });
});

// Strips heavy/internal columns before handing an event to a transform.
function publicEvent(row) {
  const { raw, raw_sha256, ...rest } = row;
  return rest;
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

router.get('/export', (req, res) => {
  const format = (req.query.format || 'json').toLowerCase();
  const { where, params } = buildWhere(req.query);
  const { limit } = parseLimitOffset(req.query, { limit: 1000, maxLimit: 50000 });

  const rows = db
    .prepare(`SELECT ${BASE_COLUMNS}, raw FROM events ${where} ORDER BY id DESC LIMIT ?`)
    .all(...params, limit);

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');

  if (format === 'jsonl') {
    res.set('Content-Type', 'application/x-ndjson');
    res.set('Content-Disposition', `attachment; filename="fieldy-events-${stamp}.jsonl"`);
    return res.send(rows.map((r) => r.raw).join('\n'));
  }

  if (format === 'csv') {
    const esc = (v) => {
      const s = v === undefined || v === null ? '' : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const header = 'id,received_at,event_date,speaker,event_type,conversation_id,transcript';
    const lines = rows.map((r) => [r.id, r.received_at, r.event_date, r.speaker, r.event_type, r.conversation_id, r.transcript].map(esc).join(','));
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="fieldy-events-${stamp}.csv"`);
    return res.send([header, ...lines].join('\n'));
  }

  res.set('Content-Disposition', `attachment; filename="fieldy-events-${stamp}.json"`);
  return res.json(rows);
});

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

router.get('/stats', (_req, res) => {
  const byDay = db.prepare(`
    SELECT substr(received_at, 1, 10) AS day, COUNT(*) AS count
    FROM events GROUP BY day ORDER BY day DESC LIMIT 30
  `).all();
  const bySpeaker = db.prepare(`
    SELECT COALESCE(speaker, '(none)') AS speaker, COUNT(*) AS count
    FROM events GROUP BY speaker ORDER BY count DESC LIMIT 20
  `).all();
  const byType = db.prepare(`
    SELECT event_type, COUNT(*) AS count FROM events GROUP BY event_type ORDER BY count DESC
  `).all();
  const total = db.prepare('SELECT COUNT(*) AS n FROM events').get().n;

  res.json({ total, byDay, bySpeaker, byType });
});

module.exports = router;