# Setup — for people who just want to run the proxy

This is the short path. If you want to read code, contribute, or debug the
SDK side, see [README.md](README.md) instead.

What you'll have at the end:

- A local HTTP server on `http://127.0.0.1:3000` that any OpenAI-compatible
  client can point at — including the OpenClaw Telegram bot, the Anthropic
  SDK, `curl`, your own scripts.
- It uses **your** Claude subscription via the `claude` CLI's OAuth login. No
  API key. Nothing leaves the machine except the calls the CLI would have
  made anyway.

---

## 1. Prerequisites (one-time)

You need two things installed on this machine:

| What | How to install | How to verify |
| --- | --- | --- |
| **Node.js 22+** | <https://nodejs.org/> (or `brew install node@22`, `nvm install 22`) | `node -v` shows `v22.x` or higher |
| **`claude` CLI** | <https://docs.claude.com/claude-code> | `claude --version` works |

Then sign in to Claude with your own subscription. **This is the only
authentication step** — the proxy reads these credentials from disk.

```bash
claude login
```

Run `claude` once after login to confirm it responds. If it does, you're done
with prerequisites.

---

## 2. Start the proxy

```bash
npx github:thienkhoi1/claude-cli-proxy
```

That's the whole install + run command. First time it runs:

1. npm clones the repo into its cache.
2. It compiles the TypeScript (`tsc`) and builds the native SQLite module.
3. It boots the Fastify server on `http://127.0.0.1:3000`.

Expect 30–60 seconds on the first call (network + native build). Every
subsequent `npx` call reuses the cache and starts in roughly a second.

When it's running you'll see Fastify's startup log line ending in
`Server listening at http://127.0.0.1:3000`.

**Verify** in another terminal:

```bash
curl http://127.0.0.1:3000/health
# => {"ok":true}
```

Stop it with Ctrl-C. State (sessions DB, workspaces, projects map) is
persisted under `~/.claude-cli-proxy/`, so the next start picks up where the
previous one left off.

---

## 3. Optional: persistent configuration via `.env`

The proxy boots with sensible defaults — most people never need to touch
this. If you want to change the port, default model, concurrency cap, or
data directory, drop a `.env` file in `~/.claude-cli-proxy/`:

```bash
mkdir -p ~/.claude-cli-proxy
curl -fsSL https://raw.githubusercontent.com/thienkhoi1/claude-cli-proxy/main/.env.example \
  -o ~/.claude-cli-proxy/.env
```

Open `~/.claude-cli-proxy/.env`, uncomment the lines you want to override,
save. Next `npx` run picks them up automatically. Restart the proxy after
any edit.

All available knobs:

| Variable | Default | What it does |
| --- | --- | --- |
| `PROXY_HOST` | `127.0.0.1` | Bind address. Leave as `127.0.0.1` unless you really mean to expose it on the LAN. |
| `PROXY_PORT` | `3000` | TCP port. Change if `3000` is taken. |
| `PROXY_DEFAULT_MODEL` | `claude-sonnet-4-6` | Model used when a client doesn't specify one. Any id the local `claude` CLI accepts. |
| `PROXY_MAX_CONCURRENCY` | `2` | Max simultaneous `claude` subprocesses. Higher = more parallelism, more rate-limit risk. |
| `PROXY_RATE_RETRY_MAX` | `3` | How many times to transparently retry on a rate-limit. |
| `PROXY_RATE_RETRY_BASE_MS` | `30000` | Backoff base. Retries wait `base, base*2, base*4, …`. |
| `PROXY_DATA_DIR` | `~/.claude-cli-proxy` | Where sessions DB, workspaces, projects map live. |
| `CLAUDE_CLI_PATH` | auto-detected | Override only if `which claude` finds the wrong binary. |

**Precedence:** an explicit `PROXY_PORT=…` in your shell always wins over
the `.env` file. The file fills in defaults; it does not force.

**Alternate lookup paths:** the proxy also reads `./.env` (cwd at startup)
and `PROXY_ENV_FILE=/some/path` if set.

---

## 4. Smoke-test a real call

```bash
curl -N -X POST http://127.0.0.1:3000/chat \
  -H 'Content-Type: application/json' \
  -d '{"sessionId":"smoke","prompt":"say hi"}'
```

You'll see SSE events stream back. Continue the same session and Claude
remembers context across requests:

```bash
curl -N -X POST http://127.0.0.1:3000/chat \
  -H 'Content-Type: application/json' \
  -d '{"sessionId":"smoke","prompt":"what was the last thing you said?"}'
```

For OpenAI-compatible clients, point them at `http://127.0.0.1:3000/v1`
with any non-empty `apiKey` value (the proxy ignores it; auth is your local
Claude login).

---

## 5. Updating

`npx` re-resolves the git ref each call.

```bash
# Track main — gets the latest code on every call
npx github:thienkhoi1/claude-cli-proxy

# Pin to a specific release for reproducibility
npx github:thienkhoi1/claude-cli-proxy#v1.0.2
```

To force a refresh (e.g. when `main` has moved but npm cached the old
version), clear the npx cache entry:

```bash
rm -rf ~/.npm/_npx/*
```

(That removes all npx caches, not just this one — harmless, they re-clone
on demand.)

---

## 6. Troubleshooting

**`EADDRINUSE: address already in use 127.0.0.1:3000`**
Another process holds port 3000. Either stop it or set `PROXY_PORT=3099`
in your `.env` (or inline: `PROXY_PORT=3099 npx github:thienkhoi1/claude-cli-proxy`).

**`claude: command not found` during startup**
The `claude` CLI isn't on `PATH`. Install it from
<https://docs.claude.com/claude-code> and re-run `claude login`. If it's
installed but in an unusual location, set `CLAUDE_CLI_PATH=/full/path/to/claude`
in your `.env`.

**Calls fail with auth errors**
Your `claude` CLI session expired. Run `claude login` again and retry.
The proxy never holds an API key of its own.

**SQLite native build fails on first install**
Make sure you're on Node 22+ (`node -v`). On Linux you may need
`build-essential` and `python3` for the prebuild fallback. Re-run after
installing them; the npx cache will rebuild on the next call.

**I want to run two proxies on one box**
Give each one its own port and data dir:

```bash
PROXY_PORT=3000 PROXY_DATA_DIR=~/.claude-cli-proxy-a npx github:thienkhoi1/claude-cli-proxy
PROXY_PORT=3001 PROXY_DATA_DIR=~/.claude-cli-proxy-b npx github:thienkhoi1/claude-cli-proxy
```

---

## What's NOT in scope

- Authentication / multi-user accounts. This is single-user, localhost only.
- Running as a service that survives reboot. See the `scripts/setup.sh`
  wizard in the repo if you want a `launchd`/`systemd` unit.
- Public LAN or internet exposure. The default `PROXY_HOST=127.0.0.1` is on
  purpose — flipping it to `0.0.0.0` exposes a `bypassPermissions` Claude
  agent to anything on the network. Don't do that without a firewall and a
  very clear reason.
