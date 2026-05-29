// Picks the Claude engine. Default: the official local `claude` CLI subprocess
// (first-party billing). Falls back to the Agent SDK's bundled engine only if no
// official CLI is found, or when PROXY_ENGINE=sdk is set explicitly.
import { sdkRunner, type ClaudeRunner } from './claude-sdk.js';
import { cliRunner } from './claude-cli.js';
import { CLAUDE_CLI_PATH } from './config.js';

const forceSdk = process.env.PROXY_ENGINE === 'sdk';
export const ENGINE: 'cli' | 'sdk' = !forceSdk && CLAUDE_CLI_PATH ? 'cli' : 'sdk';
export const activeRunner: ClaudeRunner = ENGINE === 'cli' ? cliRunner : sdkRunner;
