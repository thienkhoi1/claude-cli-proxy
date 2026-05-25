import { mkdirSync, readFileSync, existsSync } from 'node:fs';
import { join, isAbsolute, resolve } from 'node:path';
import { HOME, PROJECTS_JSON, WORKSPACES_DIR } from './config.js';

type ProjectMap = Record<string, string>;

function loadProjectMap(): ProjectMap {
  if (!existsSync(PROJECTS_JSON)) return {};
  try {
    const raw = readFileSync(PROJECTS_JSON, 'utf8');
    const parsed = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return {};
    return parsed as ProjectMap;
  } catch {
    return {};
  }
}

function expandHome(p: string): string {
  if (p === '~') return HOME;
  if (p.startsWith('~/')) return join(HOME, p.slice(2));
  return p;
}

const VALID_SESSION_ID = /^[a-zA-Z0-9_.-]+$/;

export function ensureWorkspace(sessionId: string): string {
  if (!VALID_SESSION_ID.test(sessionId)) {
    throw new Error(`Invalid sessionId: must match ${VALID_SESSION_ID}`);
  }

  const projects = loadProjectMap();
  const mapped = projects[sessionId];
  if (mapped) {
    const expanded = expandHome(mapped);
    const abs = isAbsolute(expanded) ? expanded : resolve(expanded);
    if (!existsSync(abs)) {
      throw new Error(`Mapped project path does not exist: ${abs}`);
    }
    return abs;
  }

  const dir = join(WORKSPACES_DIR, sessionId);
  mkdirSync(dir, { recursive: true });
  return dir;
}
