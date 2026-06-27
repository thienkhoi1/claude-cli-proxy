# Progress

Cross-session continuity log for the Claude CLI proxy. Most recent entry on
top. Procedure: see `.claude/skills/handoff/SKILL.md`.

---

## 2026-06-27 — package as npx-installable, ship to thienkhoi1/claude-cli-proxy

**Done**
- `5e31759` — package as npx-installable bin. `package.json` name →
  `@thienkhoi1/claude-cli-proxy`, added `bin`/`main`/`engines`, MIT LICENSE,
  `prepare: tsc` so `npx github:...` self-builds. Shebang on `src/server.ts`.
  Data dir defaults to `~/.claude-cli-proxy/` (override `PROXY_DATA_DIR`); local
  `npm dev`/`start` set `PROXY_DATA_DIR=$PWD` so existing `sessions.db` keeps
  working. Inlined `claude-sonnet-4-6` model default in `config.ts`.
- `e1643fa` — release **v1.0.0**.
- `e5f8dc1` — `PROXY_HOST` / `PROXY_PORT` env-overridable.
- `323f8f7` — release **v1.0.1**.
- `5376670` — auto-load `.env` so end users don't need to export vars. Search
  order: `PROXY_ENV_FILE` → `$PROXY_DATA_DIR/.env` → `./.env`. Existing shell
  env keys always win. Added `.env.example` as the documented template.
- `b11759c` — release **v1.0.2**.
- `f47e3cc` — `SETUP.md` end-user install guide (prereqs, single `npx` command,
  `.env` workflow + full knob table, smoke test, troubleshooting). README
  points to it on first screen.
- Pushed to `github.com/thienkhoi1/claude-cli-proxy` via SSH alias
  `github.com-tkmultimedia` (key `~/.ssh/id_rsa_thienkhoi1`). Tags `v1.0.0`,
  `v1.0.1`, `v1.0.2` live.
- Verified end-to-end twice via `npx github:thienkhoi1/claude-cli-proxy#vX`
  from a clean tmp dir: install → tsc → native sqlite build → bin exec →
  bind. Second run staged a `.env` that flipped PORT to 3098, server came up
  there, `/health` returned ok. Test dirs + npx cache entries cleaned up
  after each.

**State**
- Public end-user command: `npx github:thienkhoi1/claude-cli-proxy` (tracks
  `main`) or pin with `#v1.0.2`. Requires Node 22+, `claude` CLI logged in.
- Git remotes on this repo: `origin` →
  `git@github.com-tkmultimedia:thienkhoi1/claude-cli-proxy.git`, `kayotran` →
  the old `KayoTTran/claude-cli-proxy` (kept as fallback, untouched).
- Local proxy still on `:3000` (PID 40434, unchanged by today's work — config
  defaults preserve behavior when launched via `npm start`).
- A2A broker `:8080`, dashboard `:8091`, MCP bridges status unchanged from
  the morning entry below; `a2a` bridge still reports `disconnected` in this
  session (stale stdio).

**Next**
1. Task #10 — deploy to LAN box. Now trivial: `claude login` then
   `npx github:thienkhoi1/claude-cli-proxy` (or `#v1.0.2` to pin). Verify the
   OpenClaw 60s timeout no longer trips. Drop a `.env` with the box's preferred
   port / concurrency.
2. Still pending from this morning — watch for ack replies on
   `mcp__a2a__a2a_inbox` (or REST `/api/stream`) confirming Koi/Jan have
   migrated to their own `a2a-<slug>` MCP entries.
3. Consider `dotenv-expand`-style `${VAR}` substitution in the `.env` loader
   only if a real user case needs it. Today's loader is plain `KEY=value`,
   which is enough.

**Blockers / notes**
- This session's MCP `a2a` bridge is still disconnected (same as morning).
  Use REST `/api/publish` if you need to broadcast before the next Claude
  Code restart.
- The npx-install path RElies on the GitHub repo staying **public** —
  `npx github:user/repo` clones via plain git, not via npm. If you ever
  flip it private, end-user installs break.

---

## 2026-06-27 — per-agent session isolation + handoff skill

**Done**
- `45c5db2` (`claude-cli-proxy@main`) — isolate sessions per agent via
  system-prompt fingerprint (`src/openai-compat.ts`). Falls back from
  `body.user` to `openclaw-<sha1(systems)[:10]>` so Jan/Lily/Bob no longer
  collide on a shared workspace.
- `6d785c5` (`awesome-a2a@mcp-bridge-and-durable-cursors`) — onboarding doc
  rewritten so each agent registers a per-agent `mcpServers.a2a-<slug>`
  entry instead of overwriting a shared `a2a`. New "Message routing" section
  explains broker delivery is by token-bound WS, not entry name. Branch has
  since advanced (last seen `6640cc5`); check `git log` for current head.
- Broadcast sent on pool `tkmedia.com/all` via
  `POST http://localhost:8080/api/publish` as Lily, telling every agent to
  migrate to `a2a-<slug>`. Message id
  `019f08243309-6013e57b101d8aca`.
- New project skill: `.claude/skills/handoff/SKILL.md` + this file.

**State**
- Proxy: running on `:3000` (PID 40434, started by user in ttys014, logs go
  to that terminal — NOT a file I can read).
- Branches:
  - `claude-cli-proxy@main` — clean except untracked `.claude/` and this
    new `progress.md`.
  - `awesome-a2a@mcp-bridge-and-durable-cursors` — has untracked
    `role-system.md`; advances independently.
- A2A broker on `:8080`, dashboard on `:8091`. MCP bridges:
  `pedantic_knuth` (deploy_default, lily, A2A_POOL=all) and `brave_poincare`
  (bridge net).
- Default proxy model is `claude-sonnet-4-6` via `PROXY_DEFAULT_MODEL` env,
  baked into `npm start` / `npm run dev` (`package.json:9-10`).

**Next**
1. Commit `.claude/skills/handoff/SKILL.md` + `progress.md` together when
   the user gives the word.
2. Task #10 (still pending) — deploy to LAN box and verify there. Carry over
   the four changes that landed locally this stretch: concurrency cap +
   retry (`8427c5c`), default-model env (`ce570e9`), ZWSP heartbeat (part of
   the streaming refactor in `src/openai-compat.ts`), per-agent fingerprint
   (`45c5db2`). Verify on the box that the OpenClaw 60s timeout no longer
   trips on long tool turns.
3. After the broadcast, watch for ack replies on
   `mcp__a2a__a2a_inbox` (or REST `/api/stream`) — confirm Koi/Jan have
   migrated to their own `a2a-<slug>` entries before assuming the identity
   bleed is fully closed.

**Blockers / notes**
- This session's MCP `a2a` bridge reports `disconnected` (stale stdio
  container started before the broker came up). Sending via MCP fails until
  Claude Code is restarted; until then use REST `/api/publish` with Lily's
  bearer token straight from `~/.claude.json`.
- Proxy log is in the user's terminal, not a file — when debugging, ask the
  user to restart it with `> /tmp/proxy.log 2>&1` so future sessions can
  `Read` it.
