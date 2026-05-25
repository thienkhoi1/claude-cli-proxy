export const PLAYGROUND_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Claude CLI Proxy — Playground</title>
<style>
  :root {
    --bg: #0f172a;
    --panel: #1e293b;
    --panel-2: #0b1220;
    --border: #334155;
    --text: #e2e8f0;
    --muted: #94a3b8;
    --accent: #38bdf8;
    --accent-2: #a78bfa;
    --ok: #4ade80;
    --warn: #fbbf24;
    --err: #f87171;
    --mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 24px; font-family: system-ui, -apple-system, sans-serif;
    background: var(--bg); color: var(--text);
  }
  header { display: flex; align-items: baseline; gap: 16px; margin-bottom: 20px; }
  h1 { margin: 0; font-size: 20px; font-weight: 600; }
  header nav { display: flex; gap: 12px; font-size: 13px; }
  header nav a { color: var(--accent); text-decoration: none; }
  header nav a:hover { text-decoration: underline; }
  .grid {
    display: grid; grid-template-columns: 360px 1fr; gap: 16px;
    height: calc(100vh - 100px);
  }
  .panel {
    background: var(--panel); border: 1px solid var(--border); border-radius: 8px;
    padding: 16px; display: flex; flex-direction: column; min-height: 0;
  }
  .panel h2 { margin: 0 0 12px 0; font-size: 13px; text-transform: uppercase;
    letter-spacing: 0.06em; color: var(--muted); font-weight: 600; }
  label { display: block; font-size: 12px; color: var(--muted); margin: 10px 0 4px; }
  input, textarea, select {
    width: 100%; padding: 8px 10px; background: var(--panel-2);
    border: 1px solid var(--border); border-radius: 6px; color: var(--text);
    font-family: inherit; font-size: 14px;
  }
  textarea { resize: vertical; min-height: 88px; font-family: var(--mono); font-size: 13px; }
  input:focus, textarea:focus { outline: none; border-color: var(--accent); }
  .row { display: flex; gap: 8px; }
  .row > * { flex: 1; }
  button {
    padding: 8px 14px; border-radius: 6px; border: 1px solid var(--border);
    background: var(--accent); color: #0b1220; font-weight: 600; cursor: pointer;
    font-size: 14px;
  }
  button:hover { filter: brightness(1.1); }
  button.secondary { background: transparent; color: var(--text); }
  button:disabled { opacity: 0.4; cursor: not-allowed; }
  .toolbar { display: flex; gap: 8px; margin-top: 12px; }
  .stream {
    flex: 1; overflow: auto; background: var(--panel-2);
    border: 1px solid var(--border); border-radius: 6px; padding: 12px;
    font-family: var(--mono); font-size: 12px; line-height: 1.5;
    white-space: pre-wrap; word-break: break-word;
  }
  .event { margin-bottom: 10px; padding: 8px 10px; border-radius: 4px;
    background: rgba(255,255,255,0.02); border-left: 3px solid var(--border); }
  .event .head { color: var(--muted); font-size: 11px; margin-bottom: 4px;
    text-transform: uppercase; letter-spacing: 0.05em; }
  .event.meta { border-left-color: var(--accent-2); }
  .event.message { border-left-color: var(--accent); }
  .event.done { border-left-color: var(--ok); }
  .event.error { border-left-color: var(--err); }
  .assistant-text { color: var(--ok); font-weight: 500; white-space: pre-wrap; }
  .tool-use { color: var(--warn); }
  .tool-result { color: var(--muted); }
  details { margin-top: 6px; }
  details summary { cursor: pointer; color: var(--muted); font-size: 11px; }
  details pre { margin: 6px 0 0; font-size: 11px; color: var(--muted); }
  .status {
    font-size: 12px; color: var(--muted); margin-bottom: 8px;
    display: flex; gap: 12px; align-items: center;
  }
  .badge { padding: 2px 8px; border-radius: 999px; font-size: 11px;
    background: var(--panel-2); border: 1px solid var(--border); }
  .badge.live { background: var(--ok); color: #0b1220; border-color: var(--ok); }
  .sessions-list { flex: 1; overflow: auto; }
  .session-item {
    padding: 8px 10px; border: 1px solid var(--border); border-radius: 6px;
    margin-bottom: 6px; display: flex; justify-content: space-between;
    align-items: center; font-size: 13px;
  }
  .session-item .id { font-family: var(--mono); }
  .session-item .ts { color: var(--muted); font-size: 11px; }
  .session-actions { display: flex; gap: 4px; }
  .session-actions button { padding: 4px 8px; font-size: 11px; background: var(--panel-2);
    color: var(--text); border: 1px solid var(--border); }
  .session-actions button.del { color: var(--err); }
</style>
</head>
<body>
<header>
  <h1>Claude CLI Proxy — Playground</h1>
  <nav>
    <a href="/docs">OpenAPI Docs</a>
    <a href="https://github.com" onclick="return false">v0.1.0</a>
  </nav>
</header>

<div class="grid">
  <div class="panel">
    <h2>Request</h2>
    <label for="sessionId">Session ID</label>
    <input id="sessionId" value="demo" placeholder="my-session" />
    <label for="prompt">Prompt</label>
    <textarea id="prompt" placeholder="Ask Claude to do something...">create a file hello.txt with the content "world" and confirm</textarea>
    <label for="allowed">Allowed tools (comma-separated, blank = default)</label>
    <input id="allowed" placeholder="Read, Write, Edit, Bash, Glob, Grep, WebFetch, Task" />
    <div class="toolbar">
      <button id="sendBtn">Send</button>
      <button id="stopBtn" class="secondary" disabled>Stop</button>
      <button id="clearBtn" class="secondary">Clear</button>
    </div>

    <h2 style="margin-top:24px">Sessions</h2>
    <div class="toolbar" style="margin-top:0; margin-bottom:8px">
      <button id="refreshBtn" class="secondary">Refresh</button>
    </div>
    <div id="sessions" class="sessions-list"></div>
  </div>

  <div class="panel">
    <h2>Stream</h2>
    <div class="status">
      <span class="badge" id="statusBadge">idle</span>
      <span id="claudeId"></span>
      <span id="workspace"></span>
    </div>
    <div id="stream" class="stream"></div>
  </div>
</div>

<script>
const $ = (id) => document.getElementById(id);
const streamEl = $('stream');
const statusBadge = $('statusBadge');
const claudeIdEl = $('claudeId');
const workspaceEl = $('workspace');
const sendBtn = $('sendBtn');
const stopBtn = $('stopBtn');
const clearBtn = $('clearBtn');
const refreshBtn = $('refreshBtn');
const sessionsEl = $('sessions');

let abortCtrl = null;

function setStatus(text, cls) {
  statusBadge.textContent = text;
  statusBadge.className = 'badge ' + (cls || '');
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function renderEvent(eventName, payload) {
  const el = document.createElement('div');
  el.className = 'event ' + eventName;
  let body = '';

  if (eventName === 'message' && payload && payload.type === 'assistant' && payload.message?.content) {
    for (const block of payload.message.content) {
      if (block.type === 'text') {
        body += '<div class="assistant-text">' + escapeHtml(block.text) + '</div>';
      } else if (block.type === 'tool_use') {
        body += '<div class="tool-use">→ ' + escapeHtml(block.name) +
          '(' + escapeHtml(JSON.stringify(block.input)) + ')</div>';
      }
    }
    body += '<details><summary>raw</summary><pre>' + escapeHtml(JSON.stringify(payload, null, 2)) + '</pre></details>';
  } else if (eventName === 'message' && payload?.type === 'user' && Array.isArray(payload.message?.content)) {
    for (const block of payload.message.content) {
      if (block.type === 'tool_result') {
        const text = typeof block.content === 'string' ? block.content
          : Array.isArray(block.content) ? block.content.map(c => c.text || '').join('') : '';
        body += '<div class="tool-result">← ' + escapeHtml(text.slice(0, 500)) +
          (text.length > 500 ? '…' : '') + '</div>';
      }
    }
    body += '<details><summary>raw</summary><pre>' + escapeHtml(JSON.stringify(payload, null, 2)) + '</pre></details>';
  } else if (eventName === 'message' && payload?.type === 'result') {
    body += '<div><strong>result:</strong> ' + escapeHtml(payload.result || '') + '</div>';
    body += '<div style="color:var(--muted);font-size:11px;margin-top:4px">' +
      'duration: ' + payload.duration_ms + 'ms · cost: $' + (payload.total_cost_usd?.toFixed?.(4) ?? '?') +
      '</div>';
  } else {
    body = '<pre>' + escapeHtml(JSON.stringify(payload, null, 2)) + '</pre>';
  }

  el.innerHTML = '<div class="head">' + eventName + '</div>' + body;
  streamEl.appendChild(el);
  streamEl.scrollTop = streamEl.scrollHeight;
}

async function send() {
  const sessionId = $('sessionId').value.trim();
  const prompt = $('prompt').value;
  const allowedRaw = $('allowed').value.trim();
  if (!sessionId || !prompt) return;
  const allowedTools = allowedRaw ? allowedRaw.split(',').map(s => s.trim()).filter(Boolean) : undefined;

  sendBtn.disabled = true;
  stopBtn.disabled = false;
  setStatus('streaming…', 'live');
  claudeIdEl.textContent = '';
  workspaceEl.textContent = '';

  abortCtrl = new AbortController();
  try {
    const res = await fetch('/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, prompt, ...(allowedTools ? { allowedTools } : {}) }),
      signal: abortCtrl.signal,
    });
    if (!res.ok || !res.body) {
      const text = await res.text();
      renderEvent('error', { message: 'HTTP ' + res.status + ': ' + text });
      setStatus('error', 'err');
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const chunks = buffer.split('\\n\\n');
      buffer = chunks.pop() || '';
      for (const chunk of chunks) {
        if (!chunk.trim()) continue;
        let event = 'message';
        let data = '';
        for (const line of chunk.split('\\n')) {
          if (line.startsWith('event: ')) event = line.slice(7).trim();
          else if (line.startsWith('data: ')) data += line.slice(6);
        }
        if (!data) continue;
        let parsed;
        try { parsed = JSON.parse(data); } catch { parsed = { raw: data }; }
        if (event === 'meta') {
          claudeIdEl.textContent = parsed.resumed ? 'resumed' : 'new session';
          workspaceEl.textContent = parsed.workspace || '';
        }
        renderEvent(event, parsed);
      }
    }
    setStatus('done', '');
  } catch (err) {
    if (err.name === 'AbortError') {
      setStatus('aborted', 'warn');
    } else {
      renderEvent('error', { message: String(err) });
      setStatus('error', 'err');
    }
  } finally {
    sendBtn.disabled = false;
    stopBtn.disabled = true;
    abortCtrl = null;
    refreshSessions();
  }
}

function stop() {
  if (abortCtrl) abortCtrl.abort();
}

function clearStream() {
  streamEl.innerHTML = '';
  setStatus('idle', '');
  claudeIdEl.textContent = '';
  workspaceEl.textContent = '';
}

async function refreshSessions() {
  try {
    const res = await fetch('/sessions');
    const { sessions } = await res.json();
    sessionsEl.innerHTML = '';
    if (!sessions.length) {
      sessionsEl.innerHTML = '<div style="color:var(--muted);font-size:12px;padding:8px">No sessions yet.</div>';
      return;
    }
    for (const s of sessions) {
      const div = document.createElement('div');
      div.className = 'session-item';
      const when = new Date(s.updatedAt).toLocaleTimeString();
      div.innerHTML =
        '<div><div class="id">' + escapeHtml(s.id) + '</div>' +
        '<div class="ts">' + when + (s.claudeSessionId ? ' · resumable' : '') + '</div></div>' +
        '<div class="session-actions">' +
          '<button data-load="' + escapeHtml(s.id) + '">Load</button>' +
          '<button class="del" data-del="' + escapeHtml(s.id) + '">Delete</button>' +
        '</div>';
      sessionsEl.appendChild(div);
    }
  } catch (err) {
    sessionsEl.innerHTML = '<div style="color:var(--err);font-size:12px">' + escapeHtml(String(err)) + '</div>';
  }
}

sessionsEl.addEventListener('click', async (ev) => {
  const t = ev.target;
  if (!(t instanceof HTMLElement)) return;
  const loadId = t.getAttribute('data-load');
  const delId = t.getAttribute('data-del');
  if (loadId) { $('sessionId').value = loadId; }
  if (delId) {
    if (!confirm('Delete session ' + delId + '? (only removes the DB record, files stay)')) return;
    await fetch('/sessions/' + encodeURIComponent(delId), { method: 'DELETE' });
    refreshSessions();
  }
});

sendBtn.addEventListener('click', send);
stopBtn.addEventListener('click', stop);
clearBtn.addEventListener('click', clearStream);
refreshBtn.addEventListener('click', refreshSessions);
refreshSessions();
</script>
</body>
</html>`;
