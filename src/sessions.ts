import Database from 'better-sqlite3';
import { DB_PATH } from './config.js';

export interface SessionRecord {
  id: string;
  workspace: string;
  claudeSessionId: string | null;
  createdAt: number;
  updatedAt: number;
}

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    workspace TEXT NOT NULL,
    claude_session_id TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
`);

const stmts = {
  get: db.prepare<[string], {
    id: string;
    workspace: string;
    claude_session_id: string | null;
    created_at: number;
    updated_at: number;
  }>('SELECT id, workspace, claude_session_id, created_at, updated_at FROM sessions WHERE id = ?'),
  upsert: db.prepare(
    `INSERT INTO sessions (id, workspace, claude_session_id, created_at, updated_at)
     VALUES (@id, @workspace, @claudeSessionId, @now, @now)
     ON CONFLICT(id) DO UPDATE SET
       workspace = excluded.workspace,
       updated_at = excluded.updated_at`,
  ),
  setClaudeId: db.prepare(
    `UPDATE sessions SET claude_session_id = ?, updated_at = ? WHERE id = ?`,
  ),
  list: db.prepare<[], {
    id: string;
    workspace: string;
    claude_session_id: string | null;
    created_at: number;
    updated_at: number;
  }>('SELECT id, workspace, claude_session_id, created_at, updated_at FROM sessions ORDER BY updated_at DESC'),
  delete: db.prepare<[string]>('DELETE FROM sessions WHERE id = ?'),
};

function toRecord(row: {
  id: string;
  workspace: string;
  claude_session_id: string | null;
  created_at: number;
  updated_at: number;
}): SessionRecord {
  return {
    id: row.id,
    workspace: row.workspace,
    claudeSessionId: row.claude_session_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function getSession(id: string): SessionRecord | null {
  const row = stmts.get.get(id);
  return row ? toRecord(row) : null;
}

export function upsertSession(id: string, workspace: string): SessionRecord {
  const now = Date.now();
  const existing = stmts.get.get(id);
  stmts.upsert.run({
    id,
    workspace,
    claudeSessionId: existing?.claude_session_id ?? null,
    now,
  });
  const row = stmts.get.get(id);
  if (!row) throw new Error(`Failed to upsert session ${id}`);
  return toRecord(row);
}

export function setClaudeSessionId(id: string, claudeSessionId: string): void {
  stmts.setClaudeId.run(claudeSessionId, Date.now(), id);
}

export function listSessions(): SessionRecord[] {
  return stmts.list.all().map(toRecord);
}

export function deleteSession(id: string): boolean {
  const result = stmts.delete.run(id);
  return result.changes > 0;
}

export function closeDb(): void {
  db.close();
}
