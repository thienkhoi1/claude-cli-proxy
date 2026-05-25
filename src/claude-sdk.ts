import { query } from '@anthropic-ai/claude-agent-sdk';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { DEFAULT_ALLOWED_TOOLS } from './config.js';

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
        allowedTools: allowedTools ?? DEFAULT_ALLOWED_TOOLS,
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
