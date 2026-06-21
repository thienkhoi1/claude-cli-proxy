// Drives the OFFICIAL local `claude` CLI as a subprocess (first-party, draws on
// the plan), instead of the Agent SDK's bundled engine (billed as third-party /
// "extra usage"). The CLI's `--output-format stream-json` emits the same message
// shapes the SDK does, so downstream consumers are unchanged.
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { ClaudeRunner, RunOptions } from './claude-sdk.js';
import {
  CLAUDE_CLI_PATH,
  DEFAULT_MODEL,
  MAX_CONCURRENCY,
  RATE_RETRY_BASE_MS,
  RATE_RETRY_MAX,
} from './config.js';

export interface CliRunOptions {
  prompt: string;
  cwd: string;
  resume?: string | null;
  model?: string;
  appendSystemPrompt?: string;
  signal?: AbortSignal;
}

// Process-wide semaphore. Holding code (acquireSlot/release) lives here because
// only the CLI runner serialises subprocess spawns; the SDK runner is unused on
// the box. A waiter is handed the slot directly on release — no decrement race.
let activeSlots = 0;
const slotWaiters: Array<() => void> = [];

function acquireSlot(signal?: AbortSignal): Promise<() => void> {
  return new Promise((resolve, reject) => {
    const grant = () => {
      let released = false;
      resolve(() => {
        if (released) return;
        released = true;
        const next = slotWaiters.shift();
        if (next) next();
        else activeSlots--;
      });
    };
    if (activeSlots < MAX_CONCURRENCY) {
      activeSlots++;
      grant();
      return;
    }
    const waiter = () => {
      cleanup();
      grant();
    };
    const onAbort = () => {
      cleanup();
      const idx = slotWaiters.indexOf(waiter);
      if (idx >= 0) slotWaiters.splice(idx, 1);
      reject(new Error('aborted while waiting for proxy slot'));
    };
    const cleanup = () => {
      if (signal) signal.removeEventListener('abort', onAbort);
    };
    slotWaiters.push(waiter);
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = () => {
      cleanup();
      clearTimeout(timer);
      reject(new Error('aborted during rate-limit backoff'));
    };
    const cleanup = () => {
      if (signal) signal.removeEventListener('abort', onAbort);
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

// Per @anthropic-ai/claude-agent-sdk SDKAssistantMessageError: 'rate_limit' and
// 'server_error' are transient; the rest ('authentication_failed',
// 'billing_error', 'invalid_request', 'unknown') are not retriable.
const RETRIABLE_ASSISTANT_ERRORS = new Set(['rate_limit', 'server_error']);

function backoffMs(attempt: number): number {
  return RATE_RETRY_BASE_MS * Math.pow(2, attempt);
}

// Single attempt — spawns one `claude` subprocess and yields its stream-json
// messages. The wrapper (runClaudeCli) handles the semaphore + retry around it.
async function* spawnAndStream(
  opts: CliRunOptions,
): AsyncGenerator<Record<string, unknown>> {
  const bin = CLAUDE_CLI_PATH || 'claude';
  const args = [
    '--print',
    '--output-format',
    'stream-json',
    '--verbose',
    '--dangerously-skip-permissions',
  ];
  // Per-request model wins; otherwise fall back to the machine default (if set).
  const model = opts.model || DEFAULT_MODEL;
  if (model) args.push('--model', model);
  if (opts.resume) args.push('--resume', opts.resume);
  if (opts.appendSystemPrompt) {
    const dir = mkdtempSync(join(tmpdir(), 'ccp-sys-'));
    const file = join(dir, 'append.txt');
    writeFileSync(file, opts.appendSystemPrompt, 'utf8');
    args.push('--append-system-prompt-file', file);
  }

  // The prompt is passed via STDIN, not argv: OpenClaw sends large conversations
  // and a long prompt as a command-line argument overflows the OS arg limit (E2BIG).
  const child = spawn(bin, args, {
    cwd: opts.cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: process.env,
  });
  child.stdin.write(opts.prompt);
  child.stdin.end();

  if (opts.signal) {
    if (opts.signal.aborted) child.kill('SIGTERM');
    else opts.signal.addEventListener('abort', () => child.kill('SIGTERM'), { once: true });
  }

  const queue: Array<Record<string, unknown>> = [];
  let buffer = '';
  let finished = false;
  let failure: Error | null = null;
  let wake: (() => void) | null = null;
  const bump = () => {
    if (wake) {
      wake();
      wake = null;
    }
  };

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    buffer += chunk;
    let nl: number;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      try {
        queue.push(JSON.parse(line) as Record<string, unknown>);
      } catch {
        /* ignore non-JSON lines */
      }
    }
    bump();
  });
  let stderr = '';
  child.stderr.on('data', (d: Buffer) => {
    stderr += d.toString();
  });
  child.on('error', (e) => {
    failure = e;
    finished = true;
    bump();
  });
  child.on('close', (code) => {
    if (buffer.trim()) {
      try {
        queue.push(JSON.parse(buffer.trim()) as Record<string, unknown>);
      } catch {
        /* ignore */
      }
    }
    if (code !== 0 && queue.length === 0) {
      failure = new Error(`claude CLI exited with code ${code}: ${stderr.slice(0, 800)}`);
    }
    finished = true;
    bump();
  });

  try {
    while (true) {
      while (queue.length) yield queue.shift() as Record<string, unknown>;
      if (finished) break;
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
    while (queue.length) yield queue.shift() as Record<string, unknown>;
    if (failure) throw failure;
  } finally {
    if (child.exitCode === null && !child.killed) child.kill('SIGTERM');
  }
}

// Public entry: holds a concurrency slot for the whole call (across retries),
// and transparently retries when the first assistant message reports a
// transient error. Pre-assistant messages (the init) are buffered so the
// consumer only ever sees the SUCCESSFUL attempt's session_id — failed
// attempts are discarded silently.
export async function* runClaudeCli(
  opts: CliRunOptions,
): AsyncGenerator<Record<string, unknown>> {
  const release = await acquireSlot(opts.signal);
  try {
    for (let attempt = 0; ; attempt++) {
      const buffered: Array<Record<string, unknown>> = [];
      let decided = false;
      let needsRetry = false;

      for await (const msg of spawnAndStream(opts)) {
        if (decided) {
          yield msg;
          continue;
        }
        if (msg.type !== 'assistant') {
          buffered.push(msg);
          continue;
        }
        const errKind = (msg as { error?: string }).error;
        if (
          typeof errKind === 'string' &&
          RETRIABLE_ASSISTANT_ERRORS.has(errKind) &&
          attempt < RATE_RETRY_MAX
        ) {
          const wait = backoffMs(attempt);
          console.error(
            `[claude-cli] retriable error=${errKind} attempt=${attempt + 1}/${RATE_RETRY_MAX} sleeping=${wait}ms`,
          );
          needsRetry = true;
          break;
        }
        if (typeof errKind === 'string') {
          console.error(`[claude-cli] non-retriable error=${errKind}`);
        }
        decided = true;
        for (const b of buffered) yield b;
        buffered.length = 0;
        yield msg;
      }

      if (!needsRetry) {
        // Stream ended naturally (or threw). Flush whatever was buffered so the
        // consumer at least sees the init message before EOF.
        if (!decided) for (const b of buffered) yield b;
        return;
      }

      await abortableSleep(backoffMs(attempt), opts.signal);
    }
  } finally {
    release();
  }
}

// Adapter so the CLI engine is interchangeable with sdkRunner.
export const cliRunner: ClaudeRunner = {
  run(opts: RunOptions) {
    return runClaudeCli({
      prompt: opts.prompt,
      cwd: opts.cwd,
      resume: opts.resume,
      model: opts.model,
      appendSystemPrompt: opts.appendSystemPrompt,
      signal: opts.signal,
    }) as unknown as AsyncIterable<SDKMessage>;
  },
};
