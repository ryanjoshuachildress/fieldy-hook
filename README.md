# fieldy-hook

Receives [Fieldy](https://www.fieldy.ai) webhooks, stores every payload verbatim in SQLite, and gives you a REST API + web UI to search and transform them.

```
Fieldy app ──POST /hooks/fieldy?token=…──▶ fieldy-hook ──▶ SQLite
                                              │
              browser UI ◀──REST API /api/* ──┘
```

## Why store raw JSON?

Fieldy's webhook payload schema isn't formally documented. Their own open-source handler ([fieldyai/fieldy-moltbot](https://github.com/fieldyai/fieldy-moltbot)) shows payloads can be flat or wrapped in a `payload` key, with transcript text under `transcription`, `transcript`, or `transcriptions[0].text`. So this service:

- stores the **original payload bytes** in `events.raw` (nothing is ever lost),
- extracts known fields into queryable columns (`transcript`, `speaker`, `event_date`, `conversation_id`, `event_type`),
- adds a full-text index (FTS5) over transcript text,
- dedupes retries by SHA-256 of the raw body.

Unknown payload shapes still get stored — the `raw` column plus SQLite's `json_extract` lets you query anything later.

## Quick start

```bash
npm install
cp .env.example .env          # then edit AUTH_TOKEN
npm start                     # listens on :3000
```

Generate a token:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Verify it's up:

```bash
curl localhost:3000/hooks/fieldy/health
```

## Connect Fieldy

1. Open the Fieldy app → **Settings → Developer Settings → Webhook Endpoint URL**.
2. Paste `https://YOUR-SERVER/hooks/fieldy?token=<AUTH_TOKEN>` (TLS strongly recommended — the payloads contain your private conversation transcripts).
3. Fieldy sends a `401`-visible token mismatch, so if you get one, recheck the token.

To test before you have DNS, expose the local server with a tunnel:

```bash
cloudflared tunnel --url localhost:3000    # or ngrok http 3000
```

## API

All `/api` endpoints need the token: `Authorization: Bearer <AUTH_TOKEN>` (or `?token=`).

### Webhook

| | |
|---|---|
| `POST /hooks/fieldy` | The receiver. Token via `?token=` or Bearer. Duplicate deliveries return `200 {duplicate: true}`. |
| `GET /hooks/fieldy/health` | Reachability check. |

### Search & events

| | |
|---|---|
| `GET /api/events?q=&from=&to=&speaker=&type=&limit=&offset=` | Search. `q` is full-text (FTS5) over transcripts; `from`/`to` filter `received_at`. |
| `GET /api/events/:id` | One event, raw parsed. `?raw=1` returns the original bytes. |
| `DELETE /api/events/:id` | Delete an event. |
| `GET /api/stats` | Totals by day / speaker / type. |

### Transforms

A transform is a named JS function `(event, raw) => …` stored in the DB. `event` holds the normalized columns; `raw` is the parsed original payload. Functions run in an isolated V8 context with a 250 ms timeout.

```bash
# create/update
curl -X POST localhost:3000/api/transforms -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"wordcount","code":"(event, raw) => ({ id: event.id, words: (event.transcript || \"\").split(/\\s+/).filter(Boolean).length })"}'

# apply to one event
curl localhost:3000/api/events/1/transform/wordcount -H "Authorization: Bearer $TOKEN"

# apply to everything matching a search, get results as JSON
curl -X POST localhost:3000/api/transforms/wordcount/run -H "Authorization: Bearer $TOKEN" \
     -H "Content-Type: application/json" -d '{"q":"meeting"}'
```

| | |
|---|---|
| `GET /api/transforms` | List transforms. |
| `POST /api/transforms` | Upsert `{name, code}` — code is validated at save time. |
| `DELETE /api/transforms/:name` | Delete. |
| `GET /api/events/:id/transform/:name` | Apply to one event. |
| `POST /api/transforms/:name/run` | Apply to a search result set (body takes the same filters as `/api/events`). |

### Export

| | |
|---|---|
| `GET /api/export?format=json\|jsonl\|csv&q=…` | Export a filtered result set. `jsonl` contains the raw payloads, one per line. |

### Web UI

Open `http://localhost:3000/` — enter the token once (kept in `localStorage`), then search, browse raw payloads, preview transforms, and export.

## Deployment (public server)

Any of:

- **systemd**: copy the repo to `/opt/fieldy-hook`, `npm ci --omit=dev`, then install `deploy/fieldy-hook.service` (`systemctl enable --now fieldy-hook`). Put secrets in `/opt/fieldy-hook/.env`.
- **Docker**: `docker build -t fieldy-hook .` and `docker run -p 3000:3000 -e AUTH_TOKEN=… -v "$PWD/data:/app/data" fieldy-hook`.

Put nginx or Caddy in front for TLS, e.g. Caddy:

```
hooks.example.com {
    reverse_proxy localhost:3000
}
```

The SQLite database lives at `data/events.db` (WAL mode). Back it up by copying the file (or use `sqlite3 .backup`).

## Development

No build step, no dev server — edit and `npm start`. Tests of the webhook path can be replayed with curl; see the payload-shape examples in `src/lib/normalize.js`.