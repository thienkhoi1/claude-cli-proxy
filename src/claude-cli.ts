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
import { CLAUDE_CLI_PATH, DEFAULT_MODEL } from './config.js';

export interface CliRunOptions {
  prompt: string;
  cwd: string;
  resume?: string | null;
  model?: string;
  appendSystemPrompt?: string;
  signal?: AbortSignal;
}

export async function* runClaudeCli(opts: CliRunOptions): AsyncGenerator<Record<string, unknown>> {
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
