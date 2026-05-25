# Claude CLI Proxy

Local HTTP gateway that wraps the Claude Code SDK so any app/script/agent on this
machine can use Claude's full agentic toolchain (Bash, Read, Edit, Glob, Grep,
WebFetch, Task, MCP, …) over HTTP/SSE.

Single-user, localhost-only. Uses your existing `claude` CLI OAuth login — no
`ANTHROPIC_API_KEY` needed. Internal project; not for public deploy.

---

## What you get

After setup you have a Fastify server on `http://127.0.0.1:3000` with:

| Path                        | What it does                                                              |
| --------------------------- | ------------------------------------------------------------------------- |
| `/`                         | Landing page with links to everything below.                              |
| `/docs`                     | Swagger UI (interactive OpenAPI 3.1 docs).                                |
| `/playground`               | Custom single-page UI that streams `/chat` events live in the browser.    |
| `/chat`                     | Native streaming chat. `POST {sessionId, prompt}` → SSE events.           |
| `/v1/chat/completions`      | **OpenAI-compatible** endpoint (streaming + non-streaming). For OpenClaw. |
| `/v1/models`                | Advertises model id `khoi-local`.                                         |
| `/sessions`                 | List/get/delete persisted sessions.                                       |
| `/health`                   | `{ok:true}`.                                                              |

Each `sessionId` gets its own workspace directory and a resumable Claude session
that's persisted in SQLite, so context carries across requests and server
restarts.

---

## Prerequisites

- **Node.js 18+** (Node 20 recommended; we ship `tsx` for direct TS execution).
- **The `claude` CLI installed and logged in.** Install instructions:
  <https://docs.claude.com/claude-code>. After install, run `claude` once in a
  terminal to complete OAuth.
- macOS or Linux. (Windows untested.)

You do **not** need an Anthropic API key — the SDK reads your CLI OAuth
credentials from `~/.claude/` (or the macOS Keychain).

---

## Quick start (recommended)

Clone the repo, then run the setup wizard:

```bash
git clone <repo-url> claude-cli-proxy
cd claude-cli-proxy
npm run setup
```

The wizard will:

1. Check Node + npm + the `claude` CLI are present.
2. Verify `~/.claude/` exists.
3. `npm install` the dependencies.
4. Run the **OAuth smoke test** (`test-auth.ts`) — sends one tiny `query` to the
   SDK to confirm your OAuth credentials work. This is the real proof that the
   machine is ready.
5. If `~/.openclaw/openclaw.json` exists, offer to patch it (with a timestamped
   backup) to point the `localproxy` provider at this server. **Defaults to
   "no"** — destructive edits require explicit confirmation.
6. Optionally generate a `launchd` plist (macOS) or `systemd --user` unit
   (Linux) so the server starts at login. **Defaults to "no"** — we print the
   file and the `launchctl load` / `systemctl --user enable` command for you to
   run yourself.
7. Print the URLs.

Then start the server:

```bash
npm start
```

Open <http://127.0.0.1:3000/> in a browser.

### Non-interactive run

If you want to run the wizard in CI or over SSH without a TTY and accept
whatever defaults the script declares:

```bash
NON_INTERACTIVE=1 npm run setup
```

The non-interactive defaults are conservative: OpenClaw is **not** patched,
launchd/systemd files are **not** written.

---

## Manual setup (no wizard)

If you'd rather do it by hand:

```bash
git clone <repo-url> claude-cli-proxy
cd claude-cli-proxy
npm install
npm run smoke      # OAuth sanity check
npm start          # listens on 127.0.0.1:3000
```

That's it. The wizard does nothing the manual steps don't do; it just adds the
OpenClaw patch and the service-file scaffolding.

---

## Verifying it works

Three curls from the project spec — should pass in order:

```bash
# 1. Create a file in session test1's workspace
curl -N -X POST http://localhost:3000/chat \
  -H "Content-Type: application/json" \
  -d '{"sessionId":"test1","prompt":"create a file hello.txt with content: world"}'

# 2. Same session reads it back (Claude session resume)
curl -N -X POST http://localhost:3000/chat \
  -H "Content-Type: application/json" \
  -d '{"sessionId":"test1","prompt":"read hello.txt and tell me what is in it"}'

# 3. Different session sees an empty workspace (isolation)
curl -N -X POST http://localhost:3000/chat \
  -H "Content-Type: application/json" \
  -d '{"sessionId":"test2","prompt":"list files in current directory"}'
```

For interactive testing, open the **Playground** at
<http://127.0.0.1:3000/playground> — type a prompt and watch SSE events stream
in live (assistant text, tool calls, tool results, final result).

---

## OpenClaw integration

This server speaks OpenAI ChatCompletions natively at `/v1`, so OpenClaw can
talk to it directly — the standalone `khoi-local-adapter.js` middlebox is no
longer needed.

Open `~/.openclaw/openclaw.json` and add/merge the snippet below under
`models.providers`. The wizard **does not** auto-patch this file — OpenClaw's
schema varies between versions and a bad merge can break your config.

```json
{
  "models": {
    "providers": {
      "localproxy": {
        "baseUrl": "http://127.0.0.1:3000/v1",
        "apiKey": "localproxy",
        "api": "openai-completions",
        "models": [
          {
            "id": "khoi-local",
            "name": "Khoi Local",
            "reasoning": false,
            "input": ["text"],
            "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
            "contextWindow": 200000,
            "maxTokens": 8192
          }
        ]
      }
    }
  }
}
```

Optionally, to make `khoi-local` the default model:

```json
{
  "models": {
    "profile":  { "primary": "localproxy/khoi-local" },
    "aliases":  { "localproxy/khoi-local": { "alias": "khoi-local" } }
  }
}
```

Restart OpenClaw after editing.

How sessions map: OpenAI's `user` field becomes our `sessionId` (own workspace,
own resumable Claude session). With no `user`, requests fall back to a shared
`openclaw` session.

Smoke-test the OpenAI surface:

```bash
curl -s http://127.0.0.1:3000/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"khoi-local","messages":[{"role":"user","content":"say hello"}]}'
```

You should get back a standard ChatCompletion JSON with `choices[0].message.content`.

---

## Workspace mapping

By default, each `sessionId` gets `./workspaces/<sessionId>/` (auto-created).

To map a `sessionId` to an existing project on disk, create
`projects.json` next to `package.json`:

```json
{
  "deepkive": "~/code/deepkive",
  "tkmedia": "/Users/you/work/tkmedia/main"
}
```

Now `POST /chat {sessionId:"deepkive", ...}` will run Claude with `cwd =
~/code/deepkive`. Use this carefully — `bypassPermissions` is on, so Claude can
modify any file under that path.

`projects.json` is gitignored.

---

## Files

```
src/
  server.ts          Fastify app, routes, Swagger registration, /, /playground
  config.ts          HOST/PORT/paths
  sessions.ts        SQLite session store (better-sqlite3)
  workspaces.ts      ensureWorkspace() — auto-create or projects.json mapping
  claude-sdk.ts      Wraps the Claude Agent SDK behind a ClaudeRunner interface
  openai-compat.ts   /v1/chat/completions + /v1/models
  playground.ts      The /playground HTML (single string export)
  test-auth.ts       OAuth smoke test — npm run smoke
scripts/
  setup.sh           Interactive setup wizard — npm run setup
workspaces/          (gitignored) auto-created scratch dirs per sessionId
sessions.db          (gitignored) SQLite store
projects.json        (gitignored) optional sessionId → real-path map
```

---

## Operations

### Run in the foreground

```bash
npm start
```

### Auto-start at login

Re-run the wizard and accept the launchd/systemd prompt, or generate the file
manually from `scripts/setup.sh` (case `Darwin` / `Linux`).

After the file is written, the wizard prints the exact load command — typically:

```bash
# macOS
launchctl load ~/Library/LaunchAgents/com.kayo.claude-cli-proxy.plist
tail -f server.out.log server.err.log

# Linux
systemctl --user daemon-reload
systemctl --user enable --now claude-cli-proxy
journalctl --user -u claude-cli-proxy -f
```

### Stop

`Ctrl+C` in the foreground, or `launchctl unload` / `systemctl --user disable
--now claude-cli-proxy` for the service.

### Wipe state

```bash
rm -f sessions.db sessions.db-*       # forgets all sessions
rm -rf workspaces/                    # deletes all scratch workspaces
```

---

## Security notes

- The server binds to `127.0.0.1` only — not reachable from the network.
- `bypassPermissions` is on, so Claude can run arbitrary `Bash` and edit any
  file inside the working directory it's given. Don't point a `sessionId` at a
  directory with irreplaceable, un-backed-up data.
- This is single-user. No auth, no rate limiting. Anything that can reach
  `127.0.0.1:3000` on this machine can drive Claude as you.
- OAuth credentials in `~/.claude/` are shared with the interactive CLI — heavy
  proxy use counts against the same subscription quota.

---

## Troubleshooting

**Smoke test fails with an auth error.** Run `claude` once in a terminal to
complete the OAuth flow, then re-run `npm run setup`.

**`/chat` returns "Claude Code process aborted by user" instantly.** Means
the client disconnected before Claude streamed anything. Reproducible if you
pipe `curl` into `head` — the pipe closes early and our server interprets that
as a client disconnect. Use `curl -N -o file.sse` or just let `curl` run to
completion.

**Port 3000 already in use.** Either kill the other process, or set
`PORT=4000 npm start` (then update OpenClaw's `baseUrl` to match).

**Typecheck:** `npm run typecheck`. **Watch-mode dev:** `npm run dev`.
