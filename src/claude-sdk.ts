import { query } from '@anthropic-ai/claude-agent-sdk';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';

export interface RunOptions {
  prompt: string;
  cwd: string;
  resume?: string | null;
  allowedTools?: string[];
  signal?: AbortSignal;
}

export interface ClaudeRunner {
  run(opts: RunOptions): AsyncIterable<SDKMessage>;
}

export const sdkRunner: ClaudeRunner = {
  run({ prompt, cwd, resume, allowedTools, signal }) {
    const q = query({
      prompt,
      options: {
        cwd,
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        // Omit `allowedTools` when the caller hasn't overridden it so the SDK
        // uses the same default toolset as the interactive `claude` CLI.
        ...(allowedTools ? { allowedTools } : {}),
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
