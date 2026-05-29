import { query } from '@anthropic-ai/claude-agent-sdk';
import type { SDKMessage, ModelInfo } from '@anthropic-ai/claude-agent-sdk';
import { CLAUDE_CLI_PATH } from './config.js';

export interface RunOptions {
  prompt: string;
  cwd: string;
  resume?: string | null;
  model?: string;
  allowedTools?: string[];
  appendSystemPrompt?: string;
  signal?: AbortSignal;
}

export interface ClaudeRunner {
  run(opts: RunOptions): AsyncIterable<SDKMessage>;
}

export const sdkRunner: ClaudeRunner = {
  run({ prompt, cwd, resume, model, allowedTools, appendSystemPrompt, signal }) {
    const q = query({
      prompt,
      options: {
        cwd,
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        // Each of these is only forwarded when the caller provided it, so the SDK
        // falls back to whatever the interactive `claude` CLI on this machine uses.
        ...(model ? { model } : {}),
        ...(allowedTools ? { allowedTools } : {}),
        ...(appendSystemPrompt
          ? { systemPrompt: { type: 'preset', preset: 'claude_code', append: appendSystemPrompt } }
          : {}),
        ...(resume ? { resume } : {}),
        ...(CLAUDE_CLI_PATH ? { pathToClaudeCodeExecutable: CLAUDE_CLI_PATH } : {}),
        ...(signal ? { abortController: toAbortController(signal) } : {}),
      },
    });
    return q;
  },
};

function toAbortController(signal: AbortSignal): AbortController {
  const ac = new AbortController();
  if (signal.aborted) ac.abort();
  else signal.addEventListener('abort', () => ac.abort(), { once: true });
  return ac;
}

// Standard Claude Code model aliases. We intentionally do NOT probe the SDK for
// this anymore: the SDK probe (a query()+abort) could throw an async AbortError
// from its transport that crashed the whole proxy, and we run on the CLI engine
// now anyway. `default` resolves to whatever the local CLI is configured to use.
export function listSupportedModels(): Promise<ModelInfo[]> {
  return Promise.resolve([
    { value: 'default', displayName: 'Default (CLI default)', description: 'Whatever the local claude CLI uses by default' },
    { value: 'opus', displayName: 'Opus', description: 'Most capable' },
    { value: 'sonnet', displayName: 'Sonnet', description: 'Balanced' },
    { value: 'haiku', displayName: 'Haiku', description: 'Fastest' },
  ]);
}
