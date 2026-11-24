# LinkDrop API

The phone app and Chrome extension use one service origin. Local development uses `http://localhost:3000`; production uses an HTTPS origin and its matching WSS connection.

## HTTP

### `GET /api/health`

Returns service and database status:

```json
{"ok":true,"service":"LinkDrop","database":"sqlite","activePairs":0}
```

### `POST /api/activity`

Requires `Content-Type: application/json`. The temporary pairing code is sent in the body so it does not appear in the URL:

```json
{"code":"123456"}
```

Returns recent event metadata for an active code. It does not return note text, filenames or file contents.

## WebSocket: `/relay`

Use `ws://localhost:3000/relay` locally or `wss://your-domain/relay` in production. Phone creates a room:

```json
{"type":"room:create","role":"phone"}
```

Laptop joins with the displayed code:

```json
{"type":"room:join","role":"laptop","code":"123456"}
```

Messages use `message:send`. Files use `file:start`, `file:accept`/`file:reject`, binary chunks and `file:end`; the receiver confirms with `file:completed`. Binary chunks are relayed in memory and never written to the database.

## External API keys

None are required for local or single-server operation. For public use, the required service address is your deployed backend's HTTPS/WSS origin. A managed database such as Supabase is an optional replacement for SQLite; it is not wired in this starter. If adding it later, keep the project URL and server-only key in the backend environment file and out of both clients.
