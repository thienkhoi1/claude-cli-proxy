import { execSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const HOST = process.env.PROXY_HOST || '127.0.0.1';
export const PORT = readPositiveInt('PROXY_PORT', 3000);

// Default Claude model for requests that don't specify one (e.g. OpenClaw, which
// sends the `khoi-local` alias). Per-machine via PROXY_DEFAULT_MODEL.
export const DEFAULT_MODEL = process.env.PROXY_DEFAULT_MODEL || 'claude-sonnet-4-6';

function readPositiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

// Cap on concurrent `claude` subprocesses. Heavy multi-agent OpenClaw runs fan out
// many parallel sub-agent turns; without a cap the bursty load trips short-window
// rate limits at the backend. Excess requests queue and run as slots free up.
export const MAX_CONCURRENCY = readPositiveInt('PROXY_MAX_CONCURRENCY', 2);
// Rate-limit retry: when an assistant message arrives with error='rate_limit' (or
// 'server_error') BEFORE any content has been yielded, we transparently retry
// with exponential backoff (base, base*2, base*4, …). After MAX retries the
// error surfaces to the caller unchanged.
export const RATE_RETRY_MAX = readPositiveInt('PROXY_RATE_RETRY_MAX', 3);
export const RATE_RETRY_BASE_MS = readPositiveInt('PROXY_RATE_RETRY_BASE_MS', 30_000);

export const HOME = homedir();

// Where the proxy keeps its sessions DB, workspaces, and projects.json. Defaults
// to ~/.claude-cli-proxy so `npx` installs work from any cwd. Override with
// PROXY_DATA_DIR — local dev (npm start) sets it to the repo root so the
// existing sessions.db / workspaces/ keep working.
export const DATA_DIR = process.env.PROXY_DATA_DIR || join(HOME, '.claude-cli-proxy');
mkdirSync(DATA_DIR, { recursive: true });
export const WORKSPACES_DIR = join(DATA_DIR, 'workspaces');
export const PROJECTS_JSON = join(DATA_DIR, 'projects.json');
export const DB_PATH = join(DATA_DIR, 'sessions.db');

// Path to the OFFICIAL `claude` CLI installed on this machine. The Agent SDK
// otherwise spawns its own bundled engine, which Anthropic bills as a
// "third-party app" (extra usage); the official first-party CLI draws on the
// plan. Pointing the SDK at this binary makes proxy calls behave exactly like
// the local `claude` CLI. Override with CLAUDE_CLI_PATH; falls back to the
// bundled engine if not found.
function detectClaudeCli(): string | undefined {
  if (process.env.CLAUDE_CLI_PATH) return process.env.CLAUDE_CLI_PATH;
  const candidates = [
    join(HOME, '.local/bin/claude'),
    join(HOME, '.npm-global/bin/claude'),
    '/usr/local/bin/claude',
    '/opt/homebrew/bin/claude',
  ];
  try {
    const found = execSync('command -v claude 2>/dev/null', { encoding: 'utf8' }).trim();
    if (found) return found;
  } catch {
    /* not on PATH */
  }
  for (const c of candidates) {
    try {
      execSync(`test -x ${c}`);
      return c;
    } catch {
      /* not here */
    }
  }
  return undefined;
}

export const CLAUDE_CLI_PATH = detectClaudeCli();
