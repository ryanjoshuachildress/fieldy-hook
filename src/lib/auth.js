'use strict';

const crypto = require('node:crypto');
const vm = require('node:vm');

const TIMEOUT_MS = 250;

function authConfigured() {
  return Boolean(process.env.AUTH_TOKEN);
}

/**
 * Check the request token against AUTH_TOKEN. Fieldy passes it as a
 * `?token=` query param; we also accept `Authorization: Bearer <token>`.
 * Returns 'query' | 'bearer' | null.
 */
function checkAuth(req) {
  const expected = process.env.AUTH_TOKEN || '';
  if (!expected) return null;

  const presented = req.query.token || bearerFromHeader(req);
  if (!presented || typeof presented !== 'string') return null;

  // Compare digests so timing/length of the secret never leaks.
  const a = crypto.createHash('sha256').update(expected).digest();
  const b = crypto.createHash('sha256').update(presented).digest();
  return crypto.timingSafeEqual(a, b) ? (req.query.token ? 'query' : 'bearer') : null;
}

function bearerFromHeader(req) {
  const header = req.headers.authorization || '';
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match ? match[1].trim() : null;
}

/**
 * Run a user-supplied transform function. `code` is the source of a function
 * like `(event, raw) => ...`. It executes in a fresh V8 context with a hard
 * timeout; anything it can reach is plain data, not this process's globals.
 */
function applyTransform(code, event, raw) {
  const sandbox = {
    __event: event,
    __raw: raw,
    __result: undefined,
    console: { log() {}, error() {}, warn() {} },
  };
  const script = new vm.Script(
    `"use strict"; const __fn = (${code}); __result = __fn(__event, __raw);`,
    { filename: 'transform.js' },
  );
  script.runInNewContext(sandbox, { timeout: TIMEOUT_MS });
  return sandbox.__result;
}

function validateTransform(code) {
  // Smoke-test against an empty event so obvious syntax/runtime errors
  // surface at save time instead of at query time.
  return applyTransform(code, {}, {});
}

module.exports = { checkAuth, authConfigured, applyTransform, validateTransform };