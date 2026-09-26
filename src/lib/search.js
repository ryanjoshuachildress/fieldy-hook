'use strict';

/**
 * Shared WHERE-builder for event queries, used by the search API, the
 * batch-transform runner and the export endpoint.
 *
 * `q` is wrapped in double quotes so user text is treated as an FTS phrase
 * instead of raw FTS5 query syntax (parens, quotes, etc. would error out).
 */
function buildWhere(query) {
  const clauses = [];
  const params = [];

  if (query.q) {
    clauses.push('id IN (SELECT rowid FROM events_fts WHERE events_fts MATCH ?)');
    params.push(`"${String(query.q).replace(/"/g, '""')}"`);
  }
  if (query.from) {
    clauses.push('received_at >= ?');
    params.push(String(query.from));
  }
  if (query.to) {
    clauses.push('received_at <= ?');
    params.push(String(query.to));
  }
  if (query.speaker) {
    clauses.push('speaker = ?');
    params.push(String(query.speaker));
  }
  if (query.type) {
    clauses.push('event_type = ?');
    params.push(String(query.type));
  }
  if (query.conversation_id) {
    clauses.push('conversation_id = ?');
    params.push(String(query.conversation_id));
  }

  return { where: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params };
}

function parseLimitOffset(query, defaults = {}) {
  const maxLimit = defaults.maxLimit || 500;
  let limit = Number.parseInt(query.limit, 10);
  if (!Number.isFinite(limit) || limit <= 0) limit = defaults.limit || 50;
  limit = Math.min(limit, maxLimit);
  let offset = Number.parseInt(query.offset, 10);
  if (!Number.isFinite(offset) || offset < 0) offset = 0;
  return { limit, offset };
}

module.exports = { buildWhere, parseLimitOffset };