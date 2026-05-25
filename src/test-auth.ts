import { query } from '@anthropic-ai/claude-agent-sdk';

// Strip any API key so the SDK is forced to fall back to OAuth creds in ~/.claude/
delete process.env.ANTHROPIC_API_KEY;
delete process.env.ANTHROPIC_AUTH_TOKEN;

async function main() {
  const q = query({
    prompt: 'Reply with exactly: hi',
    options: {
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      allowedTools: [],
    },
  });

  let sessionId: string | null = null;
  let assistantText = '';

  for await (const msg of q) {
    if (msg.type === 'system' && msg.subtype === 'init') {
      sessionId = msg.session_id;
      console.log(`[init] session_id=${msg.session_id} apiKeySource=${msg.apiKeySource} model=${msg.model}`);
    } else if (msg.type === 'assistant') {
      for (const block of msg.message.content) {
        if (block.type === 'text') assistantText += block.text;
      }
    } else if (msg.type === 'result') {
      console.log(`[result] subtype=${msg.subtype} session_id=${msg.session_id}`);
    }
  }

  console.log('---');
  console.log(`session: ${sessionId}`);
  console.log(`reply: ${assistantText.trim()}`);
  console.log('---');
  console.log('OAuth smoke test PASSED');
}

main().catch((err) => {
  console.error('OAuth smoke test FAILED:', err);
  process.exit(1);
});
