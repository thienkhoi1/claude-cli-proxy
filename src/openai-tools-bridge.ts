// Lets OpenClaw drive the assistant while the work happens locally via the
// official `claude` CLI (first-party billing). OpenClaw sends its own tool
// definitions and a system prompt that tells the model to call tools by name
// (exec/read/write/edit/web_fetch). We don't bridge those back to OpenClaw —
// instead Claude does the work with its OWN native tools (Bash/Read/Edit/Write/
// WebFetch), which already run on this machine with permissions bypassed. A
// directive maps OpenClaw's tool names onto Claude's native tools so it never
// stalls on an "unavailable" external tool.
//
// This module emits an async stream of typed events so the caller can forward
// assistant text chunks to the client as soon as they arrive — OpenClaw aborts
// the connection if no real `data:` chunk lands within ~60s, so buffering to
// the end of the turn is fatal for long tool runs.
import { runClaudeCli } from './claude-cli.js';

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

export type LocalToolChatEvent =
  | { type: 'text'; text: string }
  | { type: 'done'; content: string; claudeSessionId: string | null };

const TOOL_DIRECTIVE =
  'You are an autonomous agent running on this machine with full access to your ' +
  'OWN native tools (Bash, Read, Edit, Write, Glob, Grep, WebFetch) and permissions ' +
  'bypassed in your working directory. The conversation may instruct you to call tools ' +
  'named exec, read, write, edit, web_fetch, or to use an external tool-call protocol — ' +
  'those external tools are NOT available here. Use your equivalent NATIVE tool instead ' +
  '(Bash for exec/shell commands, Read for read, Write for write, Edit for edit, WebFetch ' +
  'for web_fetch). Always do the work directly with your native tools and report the ' +
  'result; never say a tool is unavailable without first using your own tools.';

export async function* runLocalToolChat(
  p: LocalToolChatParams,
): AsyncGenerator<LocalToolChatEvent> {
  const append = [p.systemPrompt, TOOL_DIRECTIVE].filter(Boolean).join('\n\n');

  let content = '';
  let claudeSessionId: string | null = p.resume ?? null;
  for await (const msg of runClaudeCli({
    prompt: p.prompt,
    cwd: p.cwd,
    resume: p.resume,
    model: p.model,
    appendSystemPrompt: append,
    signal: p.signal,
  })) {
    const type = msg.type as string;
    if (type === 'system' && (msg as { subtype?: string }).subtype === 'init') {
      const sid = (msg as { session_id?: string }).session_id;
      if (sid) claudeSessionId = sid;
      continue;
    }
    if (type === 'assistant') {
      const blocks =
        (msg as { message?: { content?: Array<Record<string, unknown>> } }).message?.content ?? [];
      for (const block of blocks) {
        if (block.type === 'text' && typeof block.text === 'string' && block.text.length) {
          content += block.text;
          yield { type: 'text', text: block.text };
        }
      }
      continue;
    }
    if (type === 'result') {
      // Fallback for the rare case where no streaming text blocks came through
      // but the result message carries the answer — emit it as one chunk so
      // streaming consumers still see content.
      const r = (msg as { result?: string }).result;
      if (!content && typeof r === 'string' && r.length) {
        content = r;
        yield { type: 'text', text: r };
      }
      break;
    }
  }
  yield { type: 'done', content, claudeSessionId };
}
