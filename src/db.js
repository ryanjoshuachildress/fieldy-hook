'use strict';

const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

const dbPath = process.env.DB_PATH || 'data/events.db';
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY,
    received_at TEXT NOT NULL,
    source_ip TEXT,
    auth_method TEXT,
    content_type TEXT,
    event_date TEXT,
    transcript TEXT,
    speaker TEXT,
    conversation_id TEXT,
    event_type TEXT,
    raw TEXT NOT NULL,
    raw_sha256 TEXT NOT NULL
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_dedupe ON events(raw_sha256);
  CREATE INDEX IF NOT EXISTS idx_received ON events(received_at);
  CREATE INDEX IF NOT EXISTS idx_event_date ON events(event_date);

  CREATE TABLE IF NOT EXISTS transforms (
    name TEXT PRIMARY KEY,
    code TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE VIRTUAL TABLE IF NOT EXISTS events_fts USING fts5(
    transcript,
    content='events',
    content_rowid='id'
  );

  CREATE TRIGGER IF NOT EXISTS events_ai AFTER INSERT ON events BEGIN
    INSERT INTO events_fts(rowid, transcript) VALUES (new.id, new.transcript);
  END;

  CREATE TRIGGER IF NOT EXISTS events_ad AFTER DELETE ON events BEGIN
    INSERT INTO events_fts(events_fts, rowid, transcript)
    VALUES ('delete', old.id, old.transcript);
  END;
`);

module.exports = db;