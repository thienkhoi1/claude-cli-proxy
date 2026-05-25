import { homedir } from 'node:os';
import { join } from 'node:path';

export const HOST = '127.0.0.1';
export const PORT = 3000;

export const PROJECT_ROOT = process.cwd();
export const WORKSPACES_DIR = join(PROJECT_ROOT, 'workspaces');
export const PROJECTS_JSON = join(PROJECT_ROOT, 'projects.json');
export const DB_PATH = join(PROJECT_ROOT, 'sessions.db');

export const HOME = homedir();
