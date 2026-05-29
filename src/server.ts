delete process.env.ANTHROPIC_API_KEY;
delete process.env.ANTHROPIC_AUTH_TOKEN;

import Fastify from 'fastify';
import fastifySwagger from '@fastify/swagger';
import fastifySwaggerUi from '@fastify/swagger-ui';
import { mkdirSync } from 'node:fs';
import { HOST, PORT, WORKSPACES_DIR } from './config.js';
import { listSupportedModels } from './claude-sdk.js';
import { activeRunner } from './runner.js';
import { ensureWorkspace } from './workspaces.js';
import {
  closeDb,
  deleteSession,
  getSession,
  listSessions,
  setClaudeSessionId,
  upsertSession,
} from './sessions.js';
import { PLAYGROUND_HTML } from './playground.js';
import { registerOpenAIRoutes } from './openai-compat.js';

mkdirSync(WORKSPACES_DIR, { recursive: true });

const app = Fastify({ logger: true });

await app.register(fastifySwagger, {
  openapi: {
    info: {
      title: 'Claude CLI Proxy',
      description:
        'Local HTTP gateway that wraps Claude Code as a programmable agent. ' +
        'Each `sessionId` maps to an isolated workspace; the underlying Claude session is ' +
        'persisted and resumed automatically across requests.\n\n' +
        'For live streaming of `POST /chat`, use the [Playground](/playground) — Swagger UI ' +
        'does not render `text/event-stream` incrementally.',
      version: '0.1.0',
    },
    servers: [{ url: `http://${HOST}:${PORT}` }],
    tags: [
      { name: 'chat', description: 'Streaming chat with Claude' },
      { name: 'openai', description: 'OpenAI-compatible API (for OpenClaw, OpenAI SDK, etc.)' },
      { name: 'sessions', description: 'Session management' },
      { name: 'meta', description: 'Server metadata' },
    ],
  },
});

await app.register(fastifySwaggerUi, {
  routePrefix: '/docs',
  uiConfig: { docExpansion: 'list', deepLinking: false, tryItOutEnabled: true },
});

const sessionRecordSchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    workspace: { type: 'string' },
    claudeSessionId: { type: ['string', 'null'] },
    createdAt: { type: 'integer' },
    updatedAt: { type: 'integer' },
  },
  required: ['id', 'workspace', 'createdAt', 'updatedAt'],
} as const;

interface ChatBody {
  sessionId: string;
  prompt: string;
  model?: string;
  allowedTools?: string[];
}

app.post<{ Body: ChatBody }>(
  '/chat',
  {
    schema: {
      tags: ['chat'],
      summary: 'Stream a chat turn with Claude',
      description:
        'Streams Server-Sent Events back to the client. Event names:\n' +
        '- `meta` — `{ sessionId, workspace, resumed }` (first event)\n' +
        '- `message` — one per Claude SDK message (assistant text, tool_use, tool_result, result, …)\n' +
        '- `done` — `{ sessionId, claudeSessionId }` on success\n' +
        '- `error` — `{ message }` on failure\n\n' +
        '**Note:** Swagger UI buffers the full response — use the [Playground](/playground) to see ' +
        'events stream in live.',
      body: {
        type: 'object',
        required: ['sessionId', 'prompt'],
        properties: {
          sessionId: {
            type: 'string',
            pattern: '^[a-zA-Z0-9_.-]+$',
            description: 'Stable id. Maps to an auto-created workspace or a path in `projects.json`.',
            examples: ['demo'],
          },
          prompt: {
            type: 'string',
            description: 'The user message to send.',
            examples: ['create a file hello.txt with content: world'],
          },
          model: {
            type: 'string',
            description:
              'Optional Claude model id (e.g. `sonnet`, `haiku`, `default`, or a full ' +
              'model id). When omitted, the CLI default is used. See `GET /models`.',
          },
          allowedTools: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Optional per-call override. When omitted, the same default toolset as the ' +
              'interactive `claude` CLI on this machine is used (currently: Task, TaskOutput, ' +
              'Bash, Glob, Grep, ExitPlanMode, Read, Edit, Write, NotebookEdit, WebFetch, ' +
              'TodoWrite, WebSearch, KillShell, AskUserQuestion, Skill, EnterPlanMode, LSP).',
          },
        },
      },
      response: {
        200: {
          description: 'SSE stream (text/event-stream)',
          content: { 'text/event-stream': { schema: { type: 'string' } } },
        },
        400: {
          description: 'Validation error',
          type: 'object',
          properties: { error: { type: 'string' } },
        },
      },
    },
  },
  async (req, reply) => {
    const body = req.body;
    if (!body || typeof body.sessionId !== 'string' || typeof body.prompt !== 'string') {
      return reply.code(400).send({ error: 'sessionId and prompt are required strings' });
    }
    if (body.allowedTools && !Array.isArray(body.allowedTools)) {
      return reply.code(400).send({ error: 'allowedTools must be an array of strings' });
    }

    let workspace: string;
    try {
      workspace = ensureWorkspace(body.sessionId);
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }

    const session = upsertSession(body.sessionId, workspace);

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    const send = (event: string, data: unknown) => {
      reply.raw.write(`event: ${event}\n`);
      reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    const abort = new AbortController();
    const onClientClose = () => {
      if (!reply.raw.writableEnded) abort.abort();
    };
    reply.raw.on('close', onClientClose);

    send('meta', {
      sessionId: session.id,
      workspace: session.workspace,
      resumed: Boolean(session.claudeSessionId),
    });

    try {
      const stream = activeRunner.run({
        prompt: body.prompt,
        cwd: workspace,
        resume: session.claudeSessionId,
        model: body.model,
        allowedTools: body.allowedTools,
        signal: abort.signal,
      });

      let capturedClaudeId: string | null = session.claudeSessionId;

      for await (const msg of stream) {
        if (abort.signal.aborted) break;

        if (
          !capturedClaudeId &&
          msg.type === 'system' &&
          msg.subtype === 'init' &&
          typeof msg.session_id === 'string'
        ) {
          capturedClaudeId = msg.session_id;
          setClaudeSessionId(session.id, capturedClaudeId);
        }

        send('message', msg);
      }

      send('done', { sessionId: session.id, claudeSessionId: capturedClaudeId });
    } catch (err) {
      req.log.error({ err }, 'chat stream error');
      send('error', { message: (err as Error).message });
    } finally {
      reply.raw.removeListener('close', onClientClose);
      reply.raw.end();
    }
  },
);

app.get(
  '/sessions',
  {
    schema: {
      tags: ['sessions'],
      summary: 'List all sessions',
      response: {
        200: {
          type: 'object',
          properties: { sessions: { type: 'array', items: sessionRecordSchema } },
        },
      },
    },
  },
  async () => ({ sessions: listSessions() }),
);

app.get<{ Params: { id: string } }>(
  '/sessions/:id',
  {
    schema: {
      tags: ['sessions'],
      summary: 'Get a single session by id',
      params: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
      },
      response: {
        200: sessionRecordSchema,
        404: { type: 'object', properties: { error: { type: 'string' } } },
      },
    },
  },
  async (req, reply) => {
    const s = getSession(req.params.id);
    if (!s) return reply.code(404).send({ error: 'not found' });
    return s;
  },
);

app.delete<{ Params: { id: string } }>(
  '/sessions/:id',
  {
    schema: {
      tags: ['sessions'],
      summary: 'Delete a session record',
      description: 'Removes the row from the session DB. Workspace files are NOT deleted.',
      params: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
      },
      response: {
        200: { type: 'object', properties: { deleted: { type: 'string' } } },
        404: { type: 'object', properties: { error: { type: 'string' } } },
      },
    },
  },
  async (req, reply) => {
    const ok = deleteSession(req.params.id);
    if (!ok) return reply.code(404).send({ error: 'not found' });
    return { deleted: req.params.id };
  },
);

app.get(
  '/health',
  {
    schema: {
      tags: ['meta'],
      summary: 'Health check',
      response: { 200: { type: 'object', properties: { ok: { type: 'boolean' } } } },
    },
  },
  async () => ({ ok: true }),
);

app.get(
  '/models',
  {
    schema: {
      tags: ['meta'],
      summary: 'List Claude models available on this machine (proxied from the CLI)',
      description:
        'Reads the model list from the local Claude SDK. Use any returned `value` as ' +
        'the `model` field in `POST /chat` or `POST /v1/chat/completions`.',
      response: {
        200: {
          type: 'object',
          properties: {
            models: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  value: { type: 'string' },
                  displayName: { type: 'string' },
                  description: { type: 'string' },
                },
              },
            },
          },
        },
        502: { type: 'object', properties: { error: { type: 'string' } } },
      },
    },
  },
  async (req, reply) => {
    try {
      const models = await listSupportedModels();
      return { models };
    } catch (err) {
      req.log.error({ err }, 'listSupportedModels failed');
      return reply.code(502).send({ error: (err as Error).message });
    }
  },
);

registerOpenAIRoutes(app);

app.get('/playground', { schema: { hide: true } }, async (_req, reply) => {
  reply.type('text/html; charset=utf-8').send(PLAYGROUND_HTML);
});

app.get('/', { schema: { hide: true } }, async (_req, reply) => {
  reply.type('text/html; charset=utf-8').send(
    `<!doctype html><html><head><meta charset="utf-8"><title>Claude CLI Proxy</title>
      <style>body{font-family:system-ui;background:#0f172a;color:#e2e8f0;display:flex;
      align-items:center;justify-content:center;min-height:100vh;margin:0}
      .card{background:#1e293b;border:1px solid #334155;padding:32px;border-radius:12px;
      max-width:480px}h1{margin:0 0 8px}p{color:#94a3b8}a{display:block;color:#38bdf8;
      padding:12px 16px;margin-top:12px;background:#0b1220;border:1px solid #334155;
      border-radius:8px;text-decoration:none}a:hover{border-color:#38bdf8}</style>
      </head><body><div class="card">
      <h1>Claude CLI Proxy</h1>
      <p>Local HTTP gateway for Claude Code running on this machine.</p>
      <a href="/docs">OpenAPI Docs (Swagger UI)</a>
      <a href="/playground">Live Streaming Playground</a>
      <a href="/v1/models">OpenAI-compatible API (/v1) — model: khoi-local</a>
      <a href="/health">Health</a>
      </div></body></html>`,
  );
});

const shutdown = async (signal: string) => {
  app.log.info({ signal }, 'shutting down');
  try {
    await app.close();
    closeDb();
  } finally {
    process.exit(0);
  }
};
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

app.listen({ host: HOST, port: PORT }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
