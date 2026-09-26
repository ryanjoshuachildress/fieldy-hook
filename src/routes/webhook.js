'use strict';

const crypto = require('node:crypto');
const express = require('express');
const db = require('../db');
const { normalize } = require('../lib/normalize');
const { checkAuth } = require('../lib/auth');

const router = express.Router();

// Capture the exact bytes we received for *any* content type — Fieldy's
// payload schema is undocumented, so nothing should be rejected at the
// parser level. JSON is parsed opportunistically for field extraction.
const anyBody = express.raw({ limit: '2mb', type: '*/*' });

// Mounted at /hooks in server.js, so these resolve to /hooks/fieldy/...
router.get('/fieldy/health', (_req, res) => {
  res.json({ ok: true, service: 'fieldy-hook' });
});

router.post('/fieldy', anyBody, (req, res) => {
  const authMethod = checkAuth(req);
  if (!authMethod) {
    return res.status(401).json({ error: 'invalid token' });
  }

  const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  const rawText = body.toString('utf8');
  const rawSha256 = crypto.createHash('sha256').update(body).digest('hex');

  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    // Still keep non-JSON deliveries — the point of this service is to never
    // lose a webhook, not to enforce Fieldy's (undocumented) schema.
    parsed = { undecodable: true };
  }

  try {
    const insert = db.prepare(`
      INSERT INTO events (
        received_at, source_ip, auth_method, content_type,
        event_date, transcript, speaker, conversation_id, event_type,
        raw, raw_sha256
      ) VALUES (
        @received_at, @source_ip, @auth_method, @content_type,
        @event_date, @transcript, @speaker, @conversation_id, @event_type,
        @raw, @raw_sha256
      )
    `);

    const info = insert.run({
      received_at: new Date().toISOString(),
      source_ip: req.ip || null,
      auth_method: authMethod,
      content_type: req.headers['content-type'] || null,
      ...normalize(parsed),
      raw: rawText,
      raw_sha256: rawSha256,
    });

    return res.status(200).json({ ok: true, id: info.lastInsertRowid });
  } catch (err) {
    // Unique index on raw_sha256 → Fieldy retried a delivery we already have.
    if (err && err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return res.status(200).json({ ok: true, duplicate: true });
    }
    console.error('webhook store failed:', err);
    return res.status(500).json({ error: 'failed to store event' });
  }
});

module.exports = router;