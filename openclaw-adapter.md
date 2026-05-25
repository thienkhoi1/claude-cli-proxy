# Khoi Local → OpenClaw Adapter Setup

## Purpose

This setup lets OpenClaw use a custom local chat proxy as a normal model provider.

Instead of OpenClaw calling provider APIs directly, it now calls a small local adapter that translates OpenAI-style chat requests into your custom `/chat` endpoint.

## Model name

OpenClaw model ref:

- `localproxy/khoi-local`

Alias:

- `khoi-local`

This is now configured as the default model for OpenClaw.

## Architecture

```text
OpenClaw
  -> http://127.0.0.1:3001/v1/chat/completions
  -> khoi-local-adapter.js
  -> http://localhost:3000/chat
```

## Your backend contract

Target endpoint:

- `http://localhost:3000/chat`

Expected request shape:

```json
{
  "sessionId": "demo",
  "prompt": "create a file hello.txt with content: world"
}
```

Optional field intentionally omitted by default:

- `allowedTools`

The adapter does **not** send `allowedTools` unless we explicitly add support later.

## Files

### Adapter

- `/Users/kayo/.openclaw/workspace/lily/khoi-local-adapter.js`

### OpenClaw config updated

- `/Users/kayo/.openclaw/openclaw.json`

## Adapter behavior

The adapter exposes:

- `GET /health`
- `GET /v1/models`
- `POST /v1/chat/completions`

### Request translation

OpenClaw sends OpenAI-style `messages[]`.

The adapter flattens them into one text prompt like:

```text
SYSTEM: ...

USER: ...
```

Then it forwards to your backend as:

```json
{
  "sessionId": "demo",
  "prompt": "<flattened prompt>"
}
```

If OpenClaw sends a `user` field, the adapter uses that as `sessionId`.
Otherwise it uses:

- `demo`

## Response translation

The adapter accepts flexible backend response shapes.

It tries these fields in order:

- `output`
- `response`
- `message`
- `text`
- `content`
- `reply`
- `answer`
- `result`

If none are plain strings, it returns a JSON stringified version.

## OpenClaw config applied

### Default model

Primary:

- `localproxy/khoi-local`

Fallbacks:

- `openai/gpt-5.4`
- `anthropic/claude-sonnet-4-6`

### Provider config

Provider id:

- `localproxy`

Base URL:

- `http://127.0.0.1:3001/v1`

API mode:

- `openai-completions`

## Run the adapter

```bash
node /Users/kayo/.openclaw/workspace/lily/khoi-local-adapter.js
```

By default it listens on:

- `127.0.0.1:3001`

## Environment variables

Optional overrides:

- `KHOI_LOCAL_ADAPTER_PORT`
- `KHOI_LOCAL_TARGET_URL`
- `KHOI_LOCAL_SESSION_ID`

Examples:

```bash
KHOI_LOCAL_ADAPTER_PORT=3001 \
KHOI_LOCAL_TARGET_URL=http://localhost:3000/chat \
KHOI_LOCAL_SESSION_ID=demo \
node /Users/kayo/.openclaw/workspace/lily/khoi-local-adapter.js
```

## Health check

```bash
curl http://127.0.0.1:3001/health
```

Expected shape:

```json
{
  "ok": true,
  "target": "http://localhost:3000/chat",
  "model": "khoi-local"
}
```

## Manual test

```bash
curl -s http://127.0.0.1:3001/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "khoi-local",
    "messages": [
      {"role": "user", "content": "say hello"}
    ]
  }'
```

## Notes / limitations

1. This is a compatibility adapter, not a full provider plugin.
2. Streaming is not implemented yet.
3. Tool calling is not implemented yet.
4. `allowedTools` is intentionally omitted by default.
5. The adapter currently uses a flattened text prompt, not structured tool/message semantics.
6. If your backend returns a different shape, we can expand the response extractor easily.

## Future upgrades

Possible next steps:

- add streaming support
- add optional `allowedTools` passthrough
- map OpenClaw tools into your custom tool allowlist
- persist/reuse session IDs per OpenClaw session
- turn this into a proper OpenClaw provider plugin

## Quick summary

You asked for:

- model name: `khoi-local`
- backend endpoint: `http://localhost:3000/chat`
- payload:

```json
{
  "sessionId": "demo",
  "prompt": "..."
}
```

with `allowedTools` omitted by default.

That is exactly what this adapter is set up to do.
