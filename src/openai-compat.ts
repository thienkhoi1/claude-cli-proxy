import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { sdkRunner } from './claude-sdk.js';
import { ensureWorkspace } from './workspaces.js';
import { getSession, setClaudeSessionId, upsertSession } from './sessions.js';

export const KHOI_LOCAL_MODEL_ID = 'khoi-local';
const DEFAULT_SESSION_ID = 'openclaw';

interface OpenAIContentPart {
  type: string;
  text?: string;
}

interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool' | string;
  content: string | OpenAIContentPart[];
  name?: string;
}

interface ChatCompletionsBody {
  model?: string;
  messages: OpenAIMessage[];
  stream?: boolean;
  user?: string;
  temperature?: number;
  max_tokens?: number;
}

function contentToText(c: OpenAIMessage['content']): string {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((p) => p.text ?? '').join('');
  return '';
}

function flattenMessages(messages: OpenAIMessage[]): string {
  return messages
    .map((m) => {
      const text = contentToText(m.content);
      const role = String(m.role || 'user').toUpperCase();
      return `${role}: ${text}`;
    })
    .join('\n\n');
}

function buildPrompt(messages: OpenAIMessage[], resumed: boolean): string {
  if (!resumed) return flattenMessages(messages);
  // Resumed Claude session already has prior context — only send the latest user turn.
  // Re-prepend any system message in case the system prompt evolves between calls.
  const lastUser = [...messages].reverse().find((m) => m.role === 'user');
  const systems = messages.filter((m) => m.role === 'system');
  const parts: string[] = [];
  if (systems.length) parts.push(systems.map((m) => contentToText(m.content)).join('\n\n'));
  if (lastUser) parts.push(contentToText(lastUser.content));
  return parts.join('\n\n') || flattenMessages(messages);
}

export function registerOpenAIRoutes(app: FastifyInstance): void {
  app.get(
    '/v1/models',
    {
      schema: {
        tags: ['openai'],
        summary: 'List models (OpenAI-compatible)',
        response: {
          200: {
            type: 'object',
            properties: {
              object: { type: 'string' },
              data: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    id: { type: 'string' },
                    object: { type: 'string' },
                    created: { type: 'integer' },
                    owned_by: { type: 'string' },
                  },
                },
              },
            },
          },
        },
      },
    },
    async () => ({
      object: 'list',
      data: [
        {
          id: KHOI_LOCAL_MODEL_ID,
          object: 'model',
          created: Math.floor(Date.now() / 1000),
          owned_by: 'local',
        },
      ],
    }),
  );

  app.post<{ Body: ChatCompletionsBody }>(
    '/v1/chat/completions',
    {
      schema: {
        tags: ['openai'],
        summary: 'OpenAI-compatible chat completions',
        description:
          'Routes OpenAI ChatCompletions requests to the local Claude Code SDK.\n\n' +
          '- The `user` field is mapped to our `sessionId`, giving each user its own ' +
          'workspace and a resumable Claude session. Fallback: `openclaw`.\n' +
          '- On the **first** call for a session the full `messages[]` history is flattened ' +
          'into the prompt. On subsequent calls Claude\'s native session resume is used and ' +
          'only the latest user turn (plus any system messages) is forwarded.\n' +
          '- When `stream: true`, responds with OpenAI-format SSE chunks ' +
          '(`chat.completion.chunk` + `data: [DONE]`).\n' +
          '- The `model` field is accepted for compatibility but ignored — the underlying ' +
          'Claude model is whatever the local CLI/SDK is configured to use.',
        body: {
          type: 'object',
          required: ['messages'],
          properties: {
            model: { type: 'string', examples: [KHOI_LOCAL_MODEL_ID] },
            messages: {
              type: 'array',
              minItems: 1,
              items: {
                type: 'object',
                required: ['role'],
                properties: {
                  role: { type: 'string' },
                  content: {},
                  name: { type: 'string' },
                },
              },
            },
            stream: { type: 'boolean', default: false },
            user: {
              type: 'string',
              description: 'Mapped to sessionId. Fallback: "openclaw".',
            },
            temperature: { type: 'number' },
            max_tokens: { type: 'integer' },
          },
        },
      },
    },
    async (req, reply) => {
      const body = req.body;
      if (!body || !Array.isArray(body.messages) || body.messages.length === 0) {
        return reply.code(400).send({
          error: { message: 'messages must be a non-empty array', type: 'invalid_request_error' },
        });
      }

      const sessionId = body.user?.trim() || DEFAULT_SESSION_ID;
      let workspace: string;
      try {
        workspace = ensureWorkspace(sessionId);
      } catch (err) {
        return reply.code(400).send({
          error: { message: (err as Error).message, type: 'invalid_request_error' },
        });
      }

      const existing = getSession(sessionId);
      upsertSession(sessionId, workspace);

      const resumed = Boolean(existing?.claudeSessionId);
      const prompt = buildPrompt(body.messages, resumed);
      const completionId = `chatcmpl-${randomUUID()}`;
      const created = Math.floor(Date.now() / 1000);
      const modelEcho = body.model || KHOI_LOCAL_MODEL_ID;

      const abort = new AbortController();
      const onClose = () => {
        if (!reply.raw.writableEnded) abort.abort();
      };
      reply.raw.on('close', onClose);

      let capturedClaudeId: string | null = existing?.claudeSessionId ?? null;

      const runClaude = async function* () {
        const stream = sdkRunner.run({
          prompt,
          cwd: workspace,
          resume: capturedClaudeId,
          signal: abort.signal,
        });
        for await (const msg of stream) {
          if (abort.signal.aborted) break;
          if (
            !capturedClaudeId &&
            msg.type === 'system' &&
            msg.subtype === 'init' &&
            typeof msg.session_id === 'string'
          ) {
            capturedClaudeId = msg.session_id;
            setClaudeSessionId(sessionId, capturedClaudeId);
          }
          yield msg;
        }
      };

      if (body.stream) {
        reply.raw.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        });
        const writeChunk = (
          delta: { role?: string; content?: string },
          finishReason: string | null = null,
        ) => {
          const chunk = {
            id: completionId,
            object: 'chat.completion.chunk',
            created,
            model: modelEcho,
            choices: [{ index: 0, delta, finish_reason: finishReason }],
          };
          reply.raw.write(`data: ${JSON.stringify(chunk)}\n\n`);
        };
        writeChunk({ role: 'assistant' });
        try {
          for await (const msg of runClaude()) {
            if (msg.type === 'assistant' && Array.isArray(msg.message?.content)) {
              for (const block of msg.message.content as Array<{ type: string; text?: string }>) {
                if (block.type === 'text' && block.text) {
                  writeChunk({ content: block.text });
                }
              }
            }
          }
          writeChunk({}, 'stop');
          reply.raw.write('data: [DONE]\n\n');
        } catch (err) {
          const errChunk = {
            id: completionId,
            object: 'chat.completion.chunk',
            created,
            model: modelEcho,
            choices: [{ index: 0, delta: {}, finish_reason: 'error' }],
            error: { message: (err as Error).message },
          };
          reply.raw.write(`data: ${JSON.stringify(errChunk)}\n\n`);
        } finally {
          reply.raw.removeListener('close', onClose);
          reply.raw.end();
        }
        return reply;
      }

      // Non-streaming path
      let combined = '';
      let finalText = '';
      let usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
      try {
        for await (const msg of runClaude()) {
          if (msg.type === 'assistant' && Array.isArray(msg.message?.content)) {
            for (const block of msg.message.content as Array<{ type: string; text?: string }>) {
              if (block.type === 'text' && block.text) combined += block.text;
            }
          } else if (msg.type === 'result' && msg.subtype === 'success') {
            finalText = msg.result || '';
            const u = msg.usage as
              | { input_tokens?: number; output_tokens?: number }
              | undefined;
            const inTok = u?.input_tokens ?? 0;
            const outTok = u?.output_tokens ?? 0;
            usage = {
              prompt_tokens: inTok,
              completion_tokens: outTok,
              total_tokens: inTok + outTok,
            };
          }
        }
      } catch (err) {
        reply.raw.removeListener('close', onClose);
        return reply.code(500).send({
          error: { message: (err as Error).message, type: 'internal_error' },
        });
      }
      reply.raw.removeListener('close', onClose);

      return reply.send({
        id: completionId,
        object: 'chat.completion',
        created,
        model: modelEcho,
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: finalText || combined },
            finish_reason: 'stop',
          },
        ],
        usage,
      });
    },
  );
}
