// Bridges OpenAI tool-calling (used by OpenClaw) to the Claude Agent SDK.
//
// OpenClaw sends OpenAI ChatCompletions requests with `tools[]` and expects the
// model to return `tool_calls`; it then executes the tools and sends the results
// back in a follow-up request. The Agent SDK can't natively emit "deferred" tool
// calls, so we register OpenClaw's tools as SDK MCP tools whose handlers BLOCK:
// when Claude calls one we surface it as an OpenAI tool_call, then await the
// result OpenClaw returns in its next request, then let Claude continue.
//
// A live `query()` is held per session for the duration of one user turn's
// tool-call loop (start -> tool_calls -> results -> ... -> final text), then closed.
import { query, createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

export interface OpenAITool {
  type?: string;
  function: { name: string; description?: string; parameters?: JsonSchema };
}
export interface OpenAIMessage {
  role: string;
  content?: unknown;
  tool_call_id?: string;
  tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>;
}
type JsonSchema = Record<string, unknown> | undefined;

export interface ToolChatParams {
  sessionId: string;
  cwd: string;
  resume: string | null;
  model?: string;
  systemPrompt?: string;
  promptForNewTurn: string;
  messages: ReadonlyArray<{ role: string; content?: unknown; tool_call_id?: string }>;
  tools: OpenAITool[];
}
export interface ToolChatResult {
  finishReason: 'tool_calls' | 'stop';
  content: string;
  toolCalls?: Array<{ id: string; name: string; arguments: string }>;
  claudeSessionId: string | null;
}

const MCP_SERVER = 'openclaw';
const BRIDGE_TTL_MS = 5 * 60 * 1000;

// ---------------------------------------------------------------------------
// JSON Schema -> zod (covers the surface OpenClaw uses: string/number/boolean/
// array/object, enum, required, default, min/max, patternProperties)
// ---------------------------------------------------------------------------
function jsToZod(schema: JsonSchema): z.ZodTypeAny {
  if (!schema || typeof schema !== 'object') return z.any();
  const rawType = (schema as { type?: unknown }).type;
  const t = Array.isArray(rawType) ? (rawType[0] as string) : (rawType as string | undefined);
  let zt: z.ZodTypeAny;
  switch (t) {
    case 'string': {
      const en = (schema as { enum?: unknown }).enum;
      if (Array.isArray(en) && en.length > 0 && en.every((v) => typeof v === 'string')) {
        zt = z.enum(en as [string, ...string[]]);
      } else {
        zt = z.string();
      }
      break;
    }
    case 'integer':
    case 'number':
      zt = z.number();
      break;
    case 'boolean':
      zt = z.boolean();
      break;
    case 'array': {
      const items = (schema as { items?: JsonSchema }).items;
      zt = z.array(items ? jsToZod(items) : z.any());
      break;
    }
    case 'object':
      zt = objectToZod(schema);
      break;
    default:
      zt = z.any();
  }
  const desc = (schema as { description?: unknown }).description;
  if (typeof desc === 'string') zt = zt.describe(desc);
  return zt;
}

function objectToZod(schema: JsonSchema): z.ZodTypeAny {
  const shape = shapeFromProps(schema);
  let obj = z.object(shape);
  const ap = (schema as { additionalProperties?: unknown }).additionalProperties;
  const pp = (schema as { patternProperties?: unknown }).patternProperties;
  if (ap !== false || pp) obj = obj.passthrough();
  return obj;
}

// Returns a zod raw shape ({ [k]: ZodType }) for tool()'s inputSchema arg.
function shapeFromProps(parameters: JsonSchema): Record<string, z.ZodTypeAny> {
  const props = (parameters as { properties?: Record<string, JsonSchema> } | undefined)?.properties ?? {};
  const required = ((parameters as { required?: unknown } | undefined)?.required as string[]) ?? [];
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [key, propSchema] of Object.entries(props)) {
    let zt = jsToZod(propSchema);
    if (!required.includes(key)) zt = zt.optional();
    shape[key] = zt;
  }
  return shape;
}

// ---------------------------------------------------------------------------
// Per-session bridge state
// ---------------------------------------------------------------------------
type Outcome =
  | { type: 'tool_calls'; text: string; calls: Array<{ id: string; name: string; arguments: string }> }
  | { type: 'final'; text: string }
  | { type: 'error'; error: string };

interface Bridge {
  sessionId: string;
  abort: AbortController;
  claudeSessionId: string | null;
  pending: Map<string, (result: string) => void>;
  collected: Array<{ id: string; name: string; arguments: string }>;
  expected: number;
  accumText: string;
  outcomeResolver: ((o: Outcome) => void) | null;
  settled: boolean;
  done: boolean;
  timer: ReturnType<typeof setTimeout> | null;
}

const bridges = new Map<string, Bridge>();

function newCallId(): string {
  return 'call_' + Math.random().toString(36).slice(2, 14);
}

function touch(b: Bridge): void {
  if (b.timer) clearTimeout(b.timer);
  b.timer = setTimeout(() => abortBridge(b, 'ttl'), BRIDGE_TTL_MS);
}

function abortBridge(b: Bridge, reason: string): void {
  if (b.done) return;
  b.done = true;
  if (b.timer) clearTimeout(b.timer);
  for (const resolve of b.pending.values()) resolve(`[bridge aborted: ${reason}]`);
  b.pending.clear();
  if (b.outcomeResolver && !b.settled) {
    b.settled = true;
    const r = b.outcomeResolver;
    b.outcomeResolver = null;
    r({ type: 'error', error: `bridge aborted: ${reason}` });
  }
  try {
    b.abort.abort();
  } catch {
    /* ignore */
  }
  if (bridges.get(b.sessionId) === b) bridges.delete(b.sessionId);
}

function settle(b: Bridge, outcome: Outcome): void {
  if (b.settled || !b.outcomeResolver) return;
  b.settled = true;
  const r = b.outcomeResolver;
  b.outcomeResolver = null;
  r(outcome);
}

function maybeSettleToolCalls(b: Bridge): void {
  if (b.settled || !b.outcomeResolver) return;
  if (b.expected > 0 && b.collected.length >= b.expected) {
    const calls = b.collected.slice();
    const text = b.accumText;
    b.collected = [];
    b.expected = 0;
    b.accumText = '';
    settle(b, { type: 'tool_calls', text, calls });
  }
}

function makeHandler(b: Bridge, toolName: string) {
  return async (args: unknown) => {
    const id = newCallId();
    b.collected.push({ id, name: toolName, arguments: JSON.stringify(args ?? {}) });
    const result = await new Promise<string>((resolve) => {
      b.pending.set(id, resolve);
      maybeSettleToolCalls(b);
    });
    return { content: [{ type: 'text' as const, text: result }] };
  };
}

async function drive(b: Bridge, q: AsyncIterable<unknown>): Promise<void> {
  try {
    for await (const msg of q as AsyncIterable<Record<string, unknown>>) {
      if (b.abort.signal.aborted) break;
      const type = msg.type as string;
      if (type === 'system' && (msg as { subtype?: string }).subtype === 'init') {
        const sid = (msg as { session_id?: string }).session_id;
        if (sid) b.claudeSessionId = sid;
      } else if (type === 'assistant') {
        const content = (msg as { message?: { content?: Array<Record<string, unknown>> } }).message?.content ?? [];
        let toolUseCount = 0;
        for (const block of content) {
          if (block.type === 'text' && typeof block.text === 'string') b.accumText += block.text;
          else if (block.type === 'tool_use') toolUseCount++;
        }
        if (toolUseCount > 0) {
          b.expected = toolUseCount;
          maybeSettleToolCalls(b);
        }
      } else if (type === 'result') {
        const resultText = (msg as { result?: string }).result;
        settle(b, { type: 'final', text: b.accumText || resultText || '' });
        b.done = true;
        break;
      }
    }
  } catch (err) {
    settle(b, { type: 'error', error: (err as Error).message });
    b.done = true;
  } finally {
    if (b.done) {
      if (b.timer) clearTimeout(b.timer);
      if (bridges.get(b.sessionId) === b && b.pending.size === 0) bridges.delete(b.sessionId);
    }
  }
}

function buildMcpServer(b: Bridge, tools: OpenAITool[]) {
  const defs = tools.map((t) =>
    tool(
      t.function.name,
      t.function.description ?? '',
      shapeFromProps(t.function.parameters),
      makeHandler(b, t.function.name),
    ),
  );
  return createSdkMcpServer({ name: MCP_SERVER, version: '1.0.0', tools: defs });
}

function extractTrailingToolResults(
  messages: ReadonlyArray<{ role: string; content?: unknown; tool_call_id?: string }>,
): Array<{ id: string; content: string }> {
  const out: Array<{ id: string; content: string }> = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m) break;
    if (m.role === 'tool' && typeof m.tool_call_id === 'string') {
      out.push({ id: m.tool_call_id, content: contentToText(m.content) });
    } else if (m.role === 'assistant' || m.role === 'user' || m.role === 'system') {
      break;
    }
  }
  return out.reverse();
}

function contentToText(c: unknown): string {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((p) => (p && typeof p === 'object' && 'text' in p ? String((p as { text: unknown }).text) : '')).join('');
  if (c == null) return '';
  return JSON.stringify(c);
}

function outcomeToResult(b: Bridge, outcome: Outcome): ToolChatResult {
  if (outcome.type === 'error') throw new Error(outcome.error);
  if (outcome.type === 'tool_calls') {
    return {
      finishReason: 'tool_calls',
      content: outcome.text,
      toolCalls: outcome.calls,
      claudeSessionId: b.claudeSessionId,
    };
  }
  return { finishReason: 'stop', content: outcome.text, claudeSessionId: b.claudeSessionId };
}

// Main entry: returns either tool_calls (Claude wants OpenClaw to run tools) or
// final text. Subsequent calls with matching tool results continue the same turn.
export async function handleToolChat(p: ToolChatParams): Promise<ToolChatResult> {
  const trailingResults = extractTrailingToolResults(p.messages);
  const existing = bridges.get(p.sessionId);

  if (
    existing &&
    !existing.done &&
    trailingResults.length > 0 &&
    trailingResults.some((r) => existing.pending.has(r.id))
  ) {
    // Deliver results to the in-progress turn and await the next step.
    const b = existing;
    const outcome = await new Promise<Outcome>((resolve) => {
      b.settled = false;
      b.outcomeResolver = resolve;
      touch(b);
      for (const r of trailingResults) {
        const fn = b.pending.get(r.id);
        if (fn) {
          b.pending.delete(r.id);
          fn(r.content);
        }
      }
    });
    return outcomeToResult(b, outcome);
  }

  // New turn. Discard any stale in-progress bridge for this session.
  if (existing) abortBridge(existing, 'superseded');

  const b: Bridge = {
    sessionId: p.sessionId,
    abort: new AbortController(),
    claudeSessionId: p.resume ?? null,
    pending: new Map(),
    collected: [],
    expected: 0,
    accumText: '',
    outcomeResolver: null,
    settled: false,
    done: false,
    timer: null,
  };
  bridges.set(p.sessionId, b);
  touch(b);

  const mcpServer = buildMcpServer(b, p.tools);
  const allowedTools = p.tools.map((t) => `mcp__${MCP_SERVER}__${t.function.name}`);

  const outcome = await new Promise<Outcome>((resolve) => {
    b.outcomeResolver = resolve;
    const q = query({
      prompt: p.promptForNewTurn,
      options: {
        cwd: p.cwd,
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        mcpServers: { [MCP_SERVER]: mcpServer },
        allowedTools,
        abortController: b.abort,
        ...(p.model ? { model: p.model } : {}),
        ...(p.systemPrompt ? { systemPrompt: p.systemPrompt } : {}),
        ...(p.resume ? { resume: p.resume } : {}),
      },
    });
    void drive(b, q as AsyncIterable<unknown>);
  });

  return outcomeToResult(b, outcome);
}

export function bridgeActive(sessionId: string): boolean {
  const b = bridges.get(sessionId);
  return Boolean(b && !b.done);
}
