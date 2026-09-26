'use strict';

/**
 * Best-effort field extraction from a Fieldy webhook payload.
 *
 * Fieldy's payload schema isn't formally documented; their own open-source
 * handler (github.com/fieldyai/fieldy-moltbot src/fieldy-webhook.js) shows
 * payloads can be flat or wrapped in a `payload` key, with transcript text
 * under `transcription`, `transcript`, or `transcriptions[0].text`. Anything
 * unknown stays intact in `raw` — these columns are only a convenience index.
 */
function pick(...candidates) {
  for (const c of candidates) {
    if (c !== undefined && c !== null && c !== '') return c;
  }
  return null;
}

function str(v) {
  return v === undefined || v === null ? null : String(v);
}

function toIsoDate(v) {
  if (v === undefined || v === null || v === '') return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function normalize(rawObj) {
  // Wrapped deliveries carry the event under `payload`; flat ones don't.
  const data = (rawObj && typeof rawObj === 'object' && rawObj.payload)
    ? rawObj.payload
    : (rawObj || {});

  const transcriptionEntry = Array.isArray(data.transcriptions) ? data.transcriptions[0] : undefined;

  const transcript = str(pick(
    data.transcription,
    data.transcript,
    transcriptionEntry && transcriptionEntry.text,
  ))?.trim() || null;

  const speaker = str(pick(
    data.speaker,
    transcriptionEntry && transcriptionEntry.speaker,
  ));

  const eventDate = toIsoDate(pick(
    data.date,
    data.startTime,
    data.timestamp,
    data.createdAt,
  ));

  const conversationId = str(pick(
    data.conversationId,
    data.conversation_id,
  ));

  const eventType = str(pick(
    data.event,
    data.eventType,
    data.type,
    transcriptionEntry && 'transcription',
    transcript !== null && 'transcription',
  )) || 'unknown';

  const result = {
    transcript,
    speaker,
    event_date: eventDate,
    conversation_id: conversationId,
    event_type: eventType,
  };

  // A payload field could legitimately be `false`/`0` — those shouldn't
  // surface as the string "false" in convenience columns. Null them out.
  for (const key of ['transcript', 'speaker', 'conversation_id', 'event_type']) {
    if (result[key] === 'false' || result[key] === '0') result[key] = null;
  }
  if (result.event_type === null) result.event_type = 'unknown';

  return result;
}

module.exports = { normalize };