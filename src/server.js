'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const { authConfigured } = require('./lib/auth');

// Minimal .env loader — no extra dependency, keys without quotes.
(function loadEnv() {
  const envPath = path.join(__dirname, '..', '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (!match || line.trim().startsWith('#')) continue;
    if (!(match[1] in process.env)) {
      process.env[match[1]] = match[2].replace(/^["']|["']$/g, '');
    }
  }
})();

if (!authConfigured()) {
  const generated = crypto.randomBytes(32).toString('hex');
  process.env.AUTH_TOKEN = generated;
  console.warn('WARNING: AUTH_TOKEN not set — generated a temporary one for this run.');
  console.warn(`Webhook URL for testing: http://localhost:${process.env.PORT || 3000}/hooks/fieldy?token=${generated}`);
  console.warn('Set AUTH_TOKEN in .env (see .env.example) before going public.');
}

const app = express();
app.disable('x-powered-by');

// Lightweight request log.
app.use((req, _res, next) => {
  console.log(`${new Date().toISOString()} ${req.method} ${req.path}${req.query.token ? ' [token]' : ''}`);
  next();
});

app.use('/hooks', require('./routes/webhook'));
app.use('/api', require('./routes/api'));

// The UI page is static and public; it asks the browser for the token and
// sends it with API calls. Serve last so API/webhook routes win.
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, _next) => {
  console.error('unhandled error:', err);
  if (!res.headersSent) {
    res.status(err.type === 'entity.parse.failed' ? 400 : 500).json({ error: err.message });
  }
});

const port = Number.parseInt(process.env.PORT, 10) || 3000;
app.listen(port, () => {
  console.log(`fieldy-hook listening on port ${port}`);
  console.log(`Health:        http://localhost:${port}/hooks/fieldy/health`);
  console.log(`Webhook URL:   http://localhost:${port}/hooks/fieldy?token=<AUTH_TOKEN>`);
  console.log(`UI:            http://localhost:${port}/`);
});