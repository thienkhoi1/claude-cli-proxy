# Claude CLI Local API Gateway

## Project Goal

Build a local HTTP API server that wraps Claude CLI as a programmable compute resource on the host machine. Other apps/scripts/agents can interact with Claude Code through HTTP/SSE, leveraging Claude's full agentic toolchain (Bash, Read, Edit, Glob, Grep, WebFetch, Task, MCP) running natively on the local machine.

Single-user, local-only. No auth, no rate limiting, no multi-tenant concerns.

## Owner Context

- Solo developer, ~15y experience, prefers TypeScript + Fastify
- Hardware: Mac Mini M4 Pro 48GB (primary)
- Uses Claude Code via OAuth login (subscription), NOT API key in env
- Anti-tracking mindset: localhost-only, no telemetry
- Has Ollama locally for cheap LLM fallback (out of scope for v1)

## Core Requirements

### Functional
1. HTTP endpoint accepting { sessionId, prompt }, streams Claude's response via SSE
2. Each sessionId maps to an isolated workspace directory Claude operates in
3. Sessions persist across server restarts (conversation context resumable)
4. Workspaces are either auto-created scratch dirs under ~/claude-workspaces/<sessionId>/, or mapped to existing project paths via a static projects.json file (e.g., "deepkive" maps to ~/code/deepkive)
5. Management endpoints: list active sessions, delete a session

### Non-functional
- Must use existing CLI OAuth credentials (no ANTHROPIC_API_KEY env var required)
- Bind to 127.0.0.1 only
- Single Node.js process, SQLite via better-sqlite3 for state
- Graceful shutdown on SIGTERM (kill child processes if any)

## Implementation Approach

### Primary: @anthropic-ai/claude-agent-sdk
- SDK auto-reads OAuth credentials from ~/.claude/ when no API key is set
- Lower overhead, typed event stream, native async
- Verify this works with a smoke test before committing

### Fallback: Spawn claude CLI as subprocess
- Command: claude -p <prompt> --output-format stream-json --verbose --dangerously-skip-permissions
- Parse JSON lines from stdout, forward as SSE
- Use only if SDK auth fallback fails
- Higher cold-start cost (~300-500ms per request)

Structure code so the two approaches are swappable behind a common interface.

## Technical Details

### Session Resume
- Claude returns a session_id in early stream events
- Store it in SQLite keyed by our app's sessionId
- On next request, pass it as resume option (SDK) or --resume flag (CLI)

### Permission Mode
- Use bypassPermissions (SDK) or --dangerously-skip-permissions (CLI)
- Server has no human to approve tool calls
- Acceptable because localhost-only, single-user

### Allowed Tools
Default: Read, Write, Edit, Bash, Glob, Grep, WebFetch, Task. Per-session override possible later.

### SSE Streaming
- Content-Type: text/event-stream
- Each Claude event becomes one `data: <json>\n\n` line
- On client disconnect, terminate the SDK query / kill the CLI subprocess

## File Structure

- ~/claude-server/src/server.ts — Fastify app + routes
- ~/claude-server/src/claude-sdk.ts — Primary approach implementation
- ~/claude-server/src/claude-cli.ts — Fallback approach implementation
- ~/claude-server/src/sessions.ts — SQLite session store
- ~/claude-server/src/workspaces.ts — Workspace dir management
- ~/claude-server/workspaces/ — Auto-created scratch dirs
- ~/claude-server/projects.json — Static map of sessionId to real project path
- ~/claude-server/sessions.db — SQLite database
- ~/claude-server/package.json
- ~/claude-server/tsconfig.json

## Build Order

1. Smoke test: test-auth.ts runs a one-shot query({ prompt: 'say hi' }) without ANTHROPIC_API_KEY in env. Confirm SDK picks up OAuth credentials. If it fails, pivot to CLI subprocess approach.
2. Minimal server: Single POST /chat route, hardcoded workspace, no persistence. Verify SSE works end-to-end.
3. Workspace management: ensureWorkspace(sessionId) with auto-create + projects.json mapping lookup.
4. Session persistence: SQLite store, capture session_id from event stream, use for resume on subsequent requests.
5. Management endpoints: GET /sessions, DELETE /sessions/:id.
6. Polish: Graceful shutdown, error handling, structured logging via Fastify's pino.

## Verification

Start a session and create a file:
curl -N -X POST http://localhost:3000/chat -H "Content-Type: application/json" -d '{"sessionId":"test1","prompt":"create a file hello.txt with content: world"}'

Continue the same session — Claude should remember and read it back:
curl -N -X POST http://localhost:3000/chat -H "Content-Type: application/json" -d '{"sessionId":"test1","prompt":"read hello.txt and tell me what is in it"}'

A different session must be isolated — should NOT see hello.txt:
curl -N -X POST http://localhost:3000/chat -H "Content-Type: application/json" -d '{"sessionId":"test2","prompt":"list files in current directory"}'

## Out of Scope for v1

- Authentication, API keys, user management
- Rate limiting, quotas, billing tracking
- Worker pools, distributed execution
- Web UI
- Hybrid routing to Ollama
- Custom hooks, custom MCP servers

## Coding Preferences

- TypeScript strict mode
- Fastify (not Express)
- better-sqlite3 (sync, fast, no daemon)
- Async/await, no callback style
- Minimal dependencies — prefer Node built-ins
- Structured logging via Fastify pino
- All paths/ports as top-level constants, no magic config

## Open Questions to Resolve During Build

1. Does the SDK pick up OAuth credentials from ~/.claude/? Confirm via smoke test.
2. What is the exact shape of the SDK event stream? Where does session_id appear?
3. How does the SDK handle cwd? Does it cd into it or pass it to tools?
4. Does the Task (sub-agent) tool work correctly with bypassPermissions via SDK?

Use Read/Bash tools to inspect node_modules/@anthropic-ai/claude-agent-sdk/ source during implementation.

## Important Warnings

- bypassPermissions gives Claude unrestricted Bash access. Run the server in a directory you trust Claude to operate in. Do NOT point workspaces at directories containing irreplaceable data without backups.
- The OAuth credential in ~/.claude/ is shared with the interactive CLI. Heavy server usage will consume the same subscription quota as your personal CLI sessions.
