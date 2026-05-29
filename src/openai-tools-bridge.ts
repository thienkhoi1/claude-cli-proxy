// Lets OpenClaw drive the assistant while Claude Code does the work LOCALLY.
//
// OpenClaw's system prompt tells the model to call tools by name (exec, read,
// write, edit, web_fetch, ...). Rather than round-tripping those calls back to
// OpenClaw, we register tools with the SAME NAMES whose handlers execute directly
// on this machine (Claude Code already runs with bypassPermissions). Claude calls
// e.g. `exec` -> we run it here -> return the output -> Claude continues. The whole
// turn finishes in a single request, so there is no cross-request state to keep.
import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, resolve as resolvePath } from 'node:path';
import { query, createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { CLAUDE_CLI_PATH } from './config.js';

export interface OpenAITool {
  type?: string;
  function: { name: string; description?: string; parameters?: Record<string, unknown> };
}

export interface LocalToolChatParams {
  cwd: string;
  resume: string | null;
  model?: string;
  systemPrompt?: string;
  prompt: string;
  requestedTools: OpenAITool[];
  signal?: AbortSignal;
}
export interface LocalToolChatResult {
  content: string;
  claudeSessionId: string | null;
}

const MCP_SERVER = 'local';
const EXEC_TIMEOUT_MS = 120_000;
const MAX_OUTPUT = 60_000;

function clip(s: string): string {
  return s.length > MAX_OUTPUT ? s.slice(0, MAX_OUTPUT) + `\n…[truncated ${s.length - MAX_OUTPUT} chars]` : s;
}

function abs(cwd: string, p: string | undefined): string {
  const path = p ?? '.';
  return isAbsolute(path) ? path : resolvePath(cwd, path);
}

// Build the local-executing tools, bound to a working directory. Only the tools
// OpenClaw asked for (and that we can run locally) are registered; everything else
// (its sessions_/memory_/subagents/etc.) Claude simply doesn't get and works around
// with exec.
function buildLocalTools(cwd: string) {
  const text = (s: string) => ({ content: [{ type: 'text' as const, text: clip(s) }] });

  const execTool = tool(
    'exec',
    'Execute a shell command on this machine and return its combined stdout/stderr.',
    {
      command: z.string().describe('Shell command to execute'),
      workdir: z.string().optional().describe('Working directory (defaults to the session workspace)'),
      timeout: z.number().optional().describe('Timeout in seconds'),
    },
    async (args) => {
      const a = args as { command: string; workdir?: string; timeout?: number };
      return new Promise((resolve) => {
        execFile(
          '/bin/sh',
          ['-c', a.command],
          { cwd: abs(cwd, a.workdir), timeout: a.timeout ? a.timeout * 1000 : EXEC_TIMEOUT_MS, maxBuffer: 1024 * 1024 * 16 },
          (err, stdout, stderr) => {
            let out = String(stdout ?? '');
            if (stderr) out += (out ? '\n' : '') + '[stderr] ' + String(stderr);
            if (err && !stdout && !stderr) out = `[error] ${err.message}`;
            resolve(text(out || '(no output)'));
          },
        );
      });
    },
  );

  const readTool = tool(
    'read',
    'Read a file from disk.',
    {
      path: z.string().optional(),
      file_path: z.string().optional(),
      offset: z.number().optional().describe('Start line (1-based)'),
      limit: z.number().optional().describe('Max lines to read'),
    },
    async (args) => {
      const a = args as { path?: string; file_path?: string; offset?: number; limit?: number };
      try {
        let content = await readFile(abs(cwd, a.path ?? a.file_path), 'utf8');
        if (a.offset || a.limit) {
          const lines = content.split('\n');
          const start = a.offset ? a.offset - 1 : 0;
          content = lines.slice(start, a.limit ? start + a.limit : undefined).join('\n');
        }
        return text(content);
      } catch (e) {
        return text(`[error] ${(e as Error).message}`);
      }
    },
  );

  const writeTool = tool(
    'write',
    'Write (create or overwrite) a file on disk.',
    {
      content: z.string(),
      path: z.string().optional(),
      file_path: z.string().optional(),
    },
    async (args) => {
      const a = args as { content: string; path?: string; file_path?: string };
      const target = a.path ?? a.file_path;
      if (!target) return text('[error] path is required');
      try {
        await writeFile(abs(cwd, target), a.content, 'utf8');
        return text(`Wrote ${a.content.length} bytes to ${target}`);
      } catch (e) {
        return text(`[error] ${(e as Error).message}`);
      }
    },
  );

  const editTool = tool(
    'edit',
    'Replace a string in a file on disk.',
    {
      path: z.string().optional(),
      file_path: z.string().optional(),
      oldText: z.string().optional(),
      newText: z.string().optional(),
      old_string: z.string().optional(),
      new_string: z.string().optional(),
    },
    async (args) => {
      const a = args as {
        path?: string;
        file_path?: string;
        oldText?: string;
        newText?: string;
        old_string?: string;
        new_string?: string;
      };
      const target = a.path ?? a.file_path;
      const oldS = a.oldText ?? a.old_string ?? '';
      const newS = a.newText ?? a.new_string ?? '';
      if (!target) return text('[error] path is required');
      try {
        const before = await readFile(abs(cwd, target), 'utf8');
        if (!before.includes(oldS)) return text('[error] oldText not found in file');
        await writeFile(abs(cwd, target), before.replace(oldS, newS), 'utf8');
        return text(`Edited ${target}`);
      } catch (e) {
        return text(`[error] ${(e as Error).message}`);
      }
    },
  );

  const webFetchTool = tool(
    'web_fetch',
    'Fetch a URL and return its text content.',
    {
      url: z.string(),
      maxChars: z.number().optional(),
    },
    async (args) => {
      const a = args as { url: string; maxChars?: number };
      try {
        const res = await fetch(a.url);
        const body = await res.text();
        const max = a.maxChars && a.maxChars > 0 ? a.maxChars : MAX_OUTPUT;
        return text(body.slice(0, max));
      } catch (e) {
        return text(`[error] ${(e as Error).message}`);
      }
    },
  );

  return { exec: execTool, read: readTool, write: writeTool, edit: editTool, web_fetch: webFetchTool };
}

export async function runLocalToolChat(p: LocalToolChatParams): Promise<LocalToolChatResult> {
  const all = buildLocalTools(p.cwd);
  const wanted = new Set(p.requestedTools.map((t) => t.function.name));
  const entries = Object.entries(all).filter(([name]) => wanted.has(name));
  const defs = entries.map(([, def]) => def);
  const allowedTools = entries.map(([name]) => `mcp__${MCP_SERVER}__${name}`);
  const server = createSdkMcpServer({ name: MCP_SERVER, version: '1.0.0', tools: defs });

  const q = query({
    prompt: p.prompt,
    options: {
      cwd: p.cwd,
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      mcpServers: { [MCP_SERVER]: server },
      allowedTools,
      ...(p.model ? { model: p.model } : {}),
      ...(p.systemPrompt ? { systemPrompt: p.systemPrompt } : {}),
      ...(p.resume ? { resume: p.resume } : {}),
      ...(CLAUDE_CLI_PATH ? { pathToClaudeCodeExecutable: CLAUDE_CLI_PATH } : {}),
      ...(p.signal ? { abortController: toAbort(p.signal) } : {}),
    },
  });

  let text = '';
  let claudeSessionId: string | null = p.resume ?? null;
  for await (const msg of q as AsyncIterable<Record<string, unknown>>) {
    const type = msg.type as string;
    if (type === 'system' && (msg as { subtype?: string }).subtype === 'init') {
      const sid = (msg as { session_id?: string }).session_id;
      if (sid) claudeSessionId = sid;
    } else if (type === 'assistant') {
      const content = (msg as { message?: { content?: Array<Record<string, unknown>> } }).message?.content ?? [];
      for (const block of content) {
        if (block.type === 'text' && typeof block.text === 'string') text += block.text;
      }
    } else if (type === 'result') {
      const r = (msg as { result?: string }).result;
      if (!text && typeof r === 'string') text = r;
      break;
    }
  }
  return { content: text, claudeSessionId };
}

function toAbort(signal: AbortSignal): AbortController {
  const ac = new AbortController();
  if (signal.aborted) ac.abort();
  else signal.addEventListener('abort', () => ac.abort(), { once: true });
  return ac;
}
