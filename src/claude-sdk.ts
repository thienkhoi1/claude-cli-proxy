import { query } from '@anthropic-ai/claude-agent-sdk';
import type { SDKMessage, ModelInfo } from '@anthropic-ai/claude-agent-sdk';

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

// Cached promise so concurrent callers share one fetch and the result is stable
// for the lifetime of the process. Resets on error so the next call retries.
let modelsCache: Promise<ModelInfo[]> | null = null;

export function listSupportedModels(): Promise<ModelInfo[]> {
  if (!modelsCache) {
    modelsCache = (async () => {
      const ac = new AbortController();
      const q = query({
        prompt: 'list-models-probe',
        options: {
          permissionMode: 'bypassPermissions',
          allowDangerouslySkipPermissions: true,
          abortController: ac,
        },
      });
      try {
        return await q.supportedModels();
      } finally {
        ac.abort();
      }
    })().catch((err) => {
      modelsCache = null;
      throw err;
    });
  }
  return modelsCache;
}
