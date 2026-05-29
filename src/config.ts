import { execSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const HOST = '127.0.0.1';
export const PORT = 3000;

// Default Claude model for requests that don't specify one (e.g. OpenClaw, which
// sends the `khoi-local` alias). Per-machine via PROXY_DEFAULT_MODEL. When unset,
// the CLI's own default model is used. Example: claude-sonnet-4-6.
export const DEFAULT_MODEL = process.env.PROXY_DEFAULT_MODEL || undefined;

export const PROJECT_ROOT = process.cwd();
export const WORKSPACES_DIR = join(PROJECT_ROOT, 'workspaces');
export const PROJECTS_JSON = join(PROJECT_ROOT, 'projects.json');
export const DB_PATH = join(PROJECT_ROOT, 'sessions.db');

export const HOME = homedir();

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
