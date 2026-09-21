#!/usr/bin/env node
'use strict';

// opencode-api-node
// OpenAI-compatible API proxy for `opencode serve`.
// Exposes the opencode session API as standard OpenAI endpoints.
//
// Env:
//   API_KEY                  Bearer token for auth. Empty = no auth.        (default: "")
//   OPENCODE_URL             Backend opencode serve URL.                     (default: "http://127.0.0.1:4096")
//   PORT                     Adapter listening port.                         (default: "80")
//   OPENCODE_TIMEOUT         Control-plane backend timeout in ms.            (default: "15000")
//   OPENCODE_MESSAGE_TIMEOUT Generation timeout in ms (blocking + stream).  (default: "300000")
//   OPENCODE_RETRIES         Extra attempts on network-level backend
//                            failures (timeouts, refused connections).       (default: "1")

const express = require('express');
const { randomUUID } = require('crypto');

let OPENCODE_URL = process.env.OPENCODE_URL || 'http://127.0.0.1:4096';
let API_KEY = process.env.API_KEY || '';

function parsePositiveInt(raw, fallback) {
  const n = parseInt(raw, 10);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

function parseNonNegativeInt(raw, fallback) {
  if (raw === undefined || raw === '') return fallback;
  const n = parseInt(raw, 10);
  return Number.isInteger(n) && n >= 0 ? n : fallback;
}

let OPENCODE_TIMEOUT = parsePositiveInt(process.env.OPENCODE_TIMEOUT, 15000);
let OPENCODE_MESSAGE_TIMEOUT = parsePositiveInt(process.env.OPENCODE_MESSAGE_TIMEOUT, 300000);
let OPENCODE_RETRIES = parseNonNegativeInt(process.env.OPENCODE_RETRIES, 1);

const MIME_MAP = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
};
const VISION_MODEL = 'qwen3.6-plus-free';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchWithTimeout(url, options = {}, timeoutMs = 10000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (e) {
    if (e && e.name === 'AbortError') {
      throw new Error(`request to ${url} timed out after ${timeoutMs}ms`);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

async function postJson(url, body, timeoutMs, opts = {}) {
  return backendFetch(
    url,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
    timeoutMs,
    opts
  );
}

// Backend call with retries on network-level failures (refused connection,
// timeout, reset). HTTP 5xx responses are retried for GETs only — POSTs may
// already have been processed server-side, so retrying them could double
// the side effect (use { retries: 0 } for fire-and-forget calls like
// prompt_async).
async function backendFetch(url, options = {}, timeoutMs, opts = {}) {
  const method = (options && options.method ? String(options.method) : 'GET').toUpperCase();
  const retries = opts.retries !== undefined ? opts.retries : OPENCODE_RETRIES;
  const retryOn5xx = opts.retryOn5xx !== undefined ? opts.retryOn5xx : method === 'GET';
  let lastErr = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await sleep(500 * 2 ** (attempt - 1));
    try {
      const resp = await fetchWithTimeout(url, options, timeoutMs);
      if (retryOn5xx && resp.status >= 500) {
        lastErr = new Error(`opencode backend returned status ${resp.status}`);
        try {
          if (resp.body && typeof resp.body.cancel === 'function') await resp.body.cancel();
        } catch { /* ignore */ }
        continue;
      }
      return resp;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

// OpenAI-shaped error envelope: { error: { message, type, code, param } }.
function openaiError(res, status, message, type, code) {
  return res.status(status).json({
    error: { message, type, code: code || null, param: null },
  });
}

// Maps backend/transport failures to OpenAI errors on /v1/* routes:
// 404 only for an explicitly requested session_id, 502 when the backend
// is unreachable, 500 otherwise.
function sendBackendError(res, e, what) {
  if (e && e.status === 404) {
    return openaiError(res, 404, e.message, 'invalid_request_error', e.code || 'not_found');
  }
  const msg = (e && e.message) || String(e);
  if (/timed out|fetch failed|ECONNREFUSED|ENOTFOUND|EPIPE|aborted|abort/i.test(msg)) {
    return openaiError(res, 502, `opencode backend unreachable: ${msg}`, 'server_error', 'backend_unreachable');
  }
  return openaiError(res, 500, `${what}: ${msg}`, 'server_error', 'backend_error');
}

// Mirrors OpenAI's 401 shape (extra `param: null` for compatibility).
function verifyAuth(req, res, next) {
  if (!API_KEY) return next();
  const header = req.headers.authorization || '';
  const m = header.match(/^Bearer\s+(.+)$/i);
  const token = m ? m[1] : null;
  if (token !== API_KEY) {
    return openaiError(
      res,
      401,
      'Incorrect API key provided. Set your API key in the Authorization header.',
      'invalid_request_error',
      'invalid_api_key'
    );
  }
  return next();
}

async function createSession() {
  const resp = await postJson(`${OPENCODE_URL}/session`, {}, OPENCODE_TIMEOUT);
  if (!resp.ok) throw new Error(`create session failed with status ${resp.status}`);
  const data = await resp.json();
  return data.id;
}

async function getSession(id) {
  const resp = await backendFetch(
    `${OPENCODE_URL}/session/${encodeURIComponent(id)}`,
    {},
    OPENCODE_TIMEOUT,
    { retryOn5xx: true }
  );
  if (resp.status === 404) return null;
  if (!resp.ok) throw new Error(`get session failed with status ${resp.status}`);
  return resp.json();
}

// Resolves the backend session for a request. Without session_id a fresh
// session is created (history is replayed into it); with session_id the
// existing session is reused (its server-side history is kept, nothing is
// replayed) so multi-turn conversations need only send the new message.
async function resolveSession(sessionId) {
  if (sessionId) {
    const existing = await getSession(sessionId);
    if (!existing) {
      const e = new Error(`session not found: ${sessionId}`);
      e.status = 404;
      e.code = 'session_not_found';
      throw e;
    }
    return { id: sessionId, fresh: false };
  }
  return { id: await createSession(), fresh: true };
}

function extractAssistantText(response) {
  for (const part of response.parts || []) {
    if (part && part.type === 'text') return part.text || '';
  }
  return '';
}

function extractTokens(response) {
  const tokens = ((response || {}).info || {}).tokens || {};
  return {
    prompt_tokens: tokens.input || tokens.total || 0,
    completion_tokens: tokens.output || 0,
    total_tokens: tokens.total || 0,
  };
}

// Backend /session/{id}/message entries are parts-containers ({ parts, info },
// no role). The newest entry holding a text part is the assistant reply.
function lastTextBearingMessage(messages) {
  if (!Array.isArray(messages)) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    const parts = (m && m.parts) || [];
    if (parts.some((p) => p && p.type === 'text' && typeof p.text === 'string')) return m;
  }
  return null;
}

function extractUsageFromMessages(messages) {
  const m = lastTextBearingMessage(messages);
  const tokens = ((m || {}).info || {}).tokens || {};
  return {
    prompt_tokens: tokens.input || tokens.total || 0,
    completion_tokens: tokens.output || 0,
    total_tokens: tokens.total || 0,
  };
}

function extractTextFromMessages(messages) {
  const m = lastTextBearingMessage(messages);
  if (!m) return '';
  return (m.parts || [])
    .filter((p) => p && p.type === 'text')
    .map((p) => p.text || '')
    .join('');
}

function parseModel(modelStr) {
  if (!modelStr) return null;
  const idx = modelStr.indexOf('/');
  if (idx !== -1) {
    return { providerID: modelStr.slice(0, idx), modelID: modelStr.slice(idx + 1) };
  }
  return { providerID: 'opencode', modelID: modelStr };
}

function detectMime(dataUrl) {
  const m = /^data:([^;]+)/.exec(dataUrl);
  return m ? m[1] : 'image/png';
}

async function urlToDataUrl(url) {
  if (url.startsWith('data:')) return [url, detectMime(url)];
  const resp = await fetchWithTimeout(url, {}, 30000);
  if (!resp.ok) throw new Error(`failed to fetch image ${url}: ${resp.status}`);
  const buf = Buffer.from(await resp.arrayBuffer());
  let contentType = resp.headers.get('content-type') || '';
  if (!contentType || contentType === 'application/octet-stream') {
    const dot = url.lastIndexOf('.');
    const ext = dot !== -1 ? url.slice(dot + 1).toLowerCase() : 'png';
    contentType = MIME_MAP[ext] || 'image/png';
  }
  return [`data:${contentType};base64,${buf.toString('base64')}`, contentType];
}

async function convertOpenaiContentToParts(content) {
  const parts = [];
  if (typeof content === 'string') {
    parts.push({ type: 'text', text: content });
  } else if (Array.isArray(content)) {
    for (const item of content) {
      if (item.type === 'text') {
        parts.push({ type: 'text', text: item.text });
      } else if (item.type === 'image_url') {
        const url = item.image_url.url;
        const [b64Url, mime] = await urlToDataUrl(url);
        parts.push({ type: 'file', mime, url: b64Url });
      }
    }
  }
  return parts;
}

const app = express();
app.use(express.json({ limit: '50mb' }));

async function prepareChat(messages, modelStr, sessionId) {
  let systemMessage = '';
  const historyTexts = [];
  let lastUserParts = [];

  for (const msg of messages || []) {
    const role = msg.role || '';
    const content = msg.content !== undefined ? msg.content : '';
    if (role === 'system') {
      systemMessage = content;
    } else if (role === 'user') {
      if (lastUserParts.length > 0) historyTexts.push(lastUserParts);
      lastUserParts = await convertOpenaiContentToParts(content);
    } else if (role === 'assistant') {
      if (lastUserParts.length > 0) historyTexts.push(lastUserParts);
      historyTexts.push([{ type: 'text', text: content }]);
      lastUserParts = [];
    }
  }

  if (lastUserParts.length === 0) {
    lastUserParts = [{ type: 'text', text: 'hello' }];
  }

  const hasImage =
    lastUserParts.some((p) => p.type === 'file') ||
    historyTexts.some(
      (h) => Array.isArray(h) && h.some((p) => p.type === 'file')
    );
  if (hasImage) modelStr = VISION_MODEL;

  const session = await resolveSession(sessionId);

  const modelParam = parseModel(modelStr);
  const payloadBase = {};
  if (modelParam) payloadBase.model = modelParam;
  if (systemMessage && systemMessage.length !== 0) payloadBase.system = systemMessage;

  async function sendNoReply(parts) {
    try {
      await postJson(
        `${OPENCODE_URL}/session/${session.id}/message`,
        { ...payloadBase, parts, noReply: true },
        OPENCODE_TIMEOUT
      );
    } catch {
      // best-effort history replay; failures are ignored
    }
  }

  // Fresh sessions need the conversation replayed into them; reused sessions
  // already hold the history server-side, so only the newest message is sent.
  if (session.fresh) {
    for (const text of historyTexts) {
      await sendNoReply(text);
    }
  }

  return {
    session: session.id,
    payloadBase,
    lastUserParts,
    model: modelStr || 'opencode',
  };
}

async function runChatCompletion(messages, modelStr, sessionId) {
  const prepared = await prepareChat(messages, modelStr, sessionId);
  const resp = await postJson(
    `${OPENCODE_URL}/session/${prepared.session}/message`,
    { ...prepared.payloadBase, parts: prepared.lastUserParts },
    OPENCODE_MESSAGE_TIMEOUT
  );
  if (!resp.ok) throw new Error(`opencode backend returned status ${resp.status}`);
  const result = await resp.json();

  return {
    text: extractAssistantText(result),
    tokens: extractTokens(result),
    model: prepared.model,
    sessionId: prepared.session,
    completionId: `chatcmpl-${randomUUID()}`,
    created: Math.floor(Date.now() / 1000),
  };
}

// Subscribes to the backend's global SSE event bus (/event). Resolves once
// subscribed so the caller can prompt afterwards without losing deltas.
async function openEventStream(signal) {
  const resp = await fetch(`${OPENCODE_URL}/event`, {
    headers: { Accept: 'text/event-stream' },
    signal,
  });
  if (!resp.ok || !resp.body) throw new Error(`event stream failed with status ${resp.status}`);
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  async function* gen() {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n\n')) !== -1) {
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          for (const line of frame.split('\n')) {
            if (line.startsWith('data:')) {
              try {
                yield JSON.parse(line.slice(5).trim());
              } catch {
                // keep-alive comment or partial frame — ignore
              }
            }
          }
        }
      }
    } finally {
      try { reader.releaseLock(); } catch { /* already closed */ }
    }
  }
  return gen();
}

// True token streaming: prompts via prompt_async (204 immediately) and
// forwards the backend's message.part.delta events as OpenAI SSE chunks until
// session.idle. Failures after headers are sent become
// `data: {"error": ...}` followed by [DONE]. A client disconnect aborts the
// backend run via /session/{id}/abort.
async function streamFromBackend(opts) {
  const { res, sessionId, promptPayload, model, completionId, created, textMode, includeUsage } = opts;
  const timeoutMs = OPENCODE_MESSAGE_TIMEOUT;
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  const write = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
  const writeDone = () => res.write('data: [DONE]\n\n');
  const writeChunk = (content, finishReason) => {
    if (textMode) {
      write({
        id: completionId,
        object: 'text_completion',
        created,
        model,
        session_id: sessionId,
        choices: [{ text: content, index: 0, finish_reason: finishReason, logprobs: null }],
      });
    } else {
      write({
        id: completionId,
        object: 'chat.completion.chunk',
        created,
        model,
        session_id: sessionId,
        choices: [{ index: 0, delta: content, finish_reason: finishReason }],
      });
    }
  };

  let finished = false;
  let clientGone = false;
  let timedOut = false;
  const ctrl = new AbortController();
  const timer = setTimeout(() => {
    timedOut = true;
    try { ctrl.abort(); } catch { /* ignore */ }
  }, timeoutMs);
  const finish = () => {
    finished = true;
    clearTimeout(timer);
    res.removeListener('close', onResClose);
  };
  const onResClose = () => {
    if (finished || clientGone) return;
    clientGone = true;
    try { ctrl.abort(); } catch { /* ignore */ }
    // Stop the backend run too — best effort, never blocks the response.
    fetchWithTimeout(
      `${OPENCODE_URL}/session/${encodeURIComponent(sessionId)}/abort`,
      { method: 'POST' },
      5000
    ).catch(() => {});
  };
  res.on('close', onResClose);

  const fail = (message, code) => {
    if (clientGone) { finish(); return; }
    write({ error: { message, type: 'server_error', code: code || null, param: null } });
    writeDone();
    try { res.end(); } catch { /* ignore */ }
    finish();
  };

  try {
    if (!textMode) writeChunk({ role: 'assistant' }, null);
    const events = await openEventStream(ctrl.signal);
    const pResp = await postJson(
      `${OPENCODE_URL}/session/${encodeURIComponent(sessionId)}/prompt_async`,
      promptPayload,
      timeoutMs,
      { retries: 0 } // fire-and-forget: never retry, the first send may have run
    );
    if (pResp.status === 404) {
      const e = new Error(`session not found: ${sessionId}`);
      e.status = 404;
      e.code = 'session_not_found';
      throw e;
    }
    if (pResp.status !== 204 && !pResp.ok) {
      throw new Error(`opencode backend returned status ${pResp.status}`);
    }
    try { await pResp.arrayBuffer(); } catch { /* empty 204 body — ignore */ }

    for await (const evt of events) {
      if (clientGone) break;
      const props = (evt && evt.properties) || {};
      if (props.sessionID !== sessionId) continue;
      if (
        evt.type === 'message.part.delta' &&
        typeof props.delta === 'string' &&
        (props.field === 'text' || props.field === undefined)
      ) {
        writeChunk(textMode ? props.delta : { content: props.delta }, null);
      } else if (evt.type === 'session.idle') {
        break;
      } else if (evt.type === 'session.error') {
        const detail = props.error !== undefined ? JSON.stringify(props.error) : 'unknown backend error';
        throw new Error(`opencode backend run failed: ${detail}`);
      }
    }
    try { ctrl.abort(); } catch { /* closes the SSE socket; the generator cleans up */ }
  } catch (e) {
    if (clientGone) { finish(); return; }
    if (timedOut || (e && e.name === 'AbortError')) {
      fail(`stream timed out after ${timeoutMs}ms`, 'backend_timeout');
      return;
    }
    if (e && e.status === 404) {
      fail(e.message, e.code || 'not_found');
      return;
    }
    const msg = (e && e.message) || String(e);
    fail(
      /fetch failed|ECONNREFUSED|ENOTFOUND|EPIPE/i.test(msg)
        ? `opencode backend unreachable: ${msg}`
        : msg,
      'backend_error'
    );
    return;
  }

  if (clientGone) { finish(); return; }
  // Usage accounting + text fallback (tool-only replies emit no text deltas).
  let usage;
  try {
    const mResp = await backendFetch(
      `${OPENCODE_URL}/session/${encodeURIComponent(sessionId)}/message`,
      {},
      OPENCODE_TIMEOUT,
      { retryOn5xx: true }
    );
    if (mResp.ok) {
      const messages = await mResp.json();
      usage = extractUsageFromMessages(messages);
    }
  } catch {
    // usage stays undefined — the stream still closes cleanly
  }
  const final = textMode
    ? {
      id: completionId,
      object: 'text_completion',
      created,
      model,
      session_id: sessionId,
      choices: [{ text: '', index: 0, finish_reason: 'stop', logprobs: null }],
    }
    : {
      id: completionId,
      object: 'chat.completion.chunk',
      created,
      model,
      session_id: sessionId,
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    };
  if (includeUsage && usage) final.usage = usage;
  write(final);
  writeDone();
  try { res.end(); } catch { /* ignore */ }
  finish();
}

async function doChatCompletion(messages, modelStr, stream, sessionId, includeUsage, res) {
  let prepared;
  try {
    prepared = await prepareChat(messages, modelStr, sessionId);
  } catch (e) {
    return sendBackendError(res, e, 'chat completion failed');
  }

  if (stream) {
    await streamFromBackend({
      res,
      sessionId: prepared.session,
      promptPayload: { ...prepared.payloadBase, parts: prepared.lastUserParts },
      model: prepared.model,
      completionId: `chatcmpl-${randomUUID()}`,
      created: Math.floor(Date.now() / 1000),
      textMode: false,
      includeUsage,
    });
    return undefined;
  }

  let result;
  try {
    const resp = await postJson(
      `${OPENCODE_URL}/session/${prepared.session}/message`,
      { ...prepared.payloadBase, parts: prepared.lastUserParts },
      OPENCODE_MESSAGE_TIMEOUT
    );
    if (!resp.ok) throw new Error(`opencode backend returned status ${resp.status}`);
    result = await resp.json();
  } catch (e) {
    return sendBackendError(res, e, 'chat completion failed');
  }
  const text = extractAssistantText(result);
  const tokens = extractTokens(result);

  return res.json({
    id: `chatcmpl-${randomUUID()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: prepared.model,
    session_id: prepared.session,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: text },
        finish_reason: 'stop',
      },
    ],
    usage: tokens,
  });
}

app.get(['/', '/health'], async (req, res) => {
  let ok = false;
  try {
    const resp = await fetchWithTimeout(`${OPENCODE_URL}/provider`, {}, 5000);
    ok = resp.status === 200;
  } catch {
    ok = false;
  }
  return res.json({ status: ok ? 'ok' : 'degraded', opencode: ok });
});

app.get('/v1/models', verifyAuth, async (req, res) => {
  try {
    const resp = await fetchWithTimeout(`${OPENCODE_URL}/provider`, {}, 10000);
    if (resp.status === 200) {
      const data = await resp.json();
      const providers = data && typeof data === 'object' && !Array.isArray(data)
        ? data.all || []
        : Array.isArray(data)
          ? data
          : [];
      const models = [];
      for (const p of providers) {
        if (p.id !== 'opencode') continue;
        for (const mid of Object.keys(p.models || {})) {
          models.push({
            id: mid,
            object: 'model',
            created: Math.floor(Date.now() / 1000),
            owned_by: 'opencode',
          });
        }
      }
      return res.json({ object: 'list', data: models });
    }
  } catch {
    // fall through to empty list
  }
  return res.json({ object: 'list', data: [] });
});

app.post('/v1/chat/completions', verifyAuth, async (req, res) => {
  const data = req.body || {};
  try {
    await doChatCompletion(
      data.messages || [],
      data.model || '',
      !!data.stream,
      data.session_id || data.sessionId || null,
      !!(data.stream_options && data.stream_options.include_usage),
      res
    );
  } catch (e) {
    return sendBackendError(res, e, 'chat completion failed');
  }
});

app.post('/v1/completions', verifyAuth, async (req, res) => {
  const data = req.body || {};
  let prompt = data.prompt !== undefined ? data.prompt : '';
  if (Array.isArray(prompt)) prompt = prompt.join('\n');
  const stream = !!data.stream;
  const sessionId = data.session_id || data.sessionId || null;
  const includeUsage = !!(data.stream_options && data.stream_options.include_usage);

  let prepared;
  try {
    prepared = await prepareChat([{ role: 'user', content: prompt }], data.model || '', sessionId);
  } catch (e) {
    return sendBackendError(res, e, 'text completion failed');
  }

  if (stream) {
    try {
      await streamFromBackend({
        res,
        sessionId: prepared.session,
        promptPayload: { ...prepared.payloadBase, parts: prepared.lastUserParts },
        model: prepared.model,
        completionId: `cmpl-${randomUUID()}`,
        created: Math.floor(Date.now() / 1000),
        textMode: true,
        includeUsage,
      });
    } catch (e) {
      return sendBackendError(res, e, 'text completion failed');
    }
    return undefined;
  }

  let text;
  let tokens;
  try {
    const resp = await postJson(
      `${OPENCODE_URL}/session/${prepared.session}/message`,
      { ...prepared.payloadBase, parts: prepared.lastUserParts },
      OPENCODE_MESSAGE_TIMEOUT
    );
    if (!resp.ok) throw new Error(`opencode backend returned status ${resp.status}`);
    const result = await resp.json();
    text = extractAssistantText(result);
    tokens = extractTokens(result);
  } catch (e) {
    return sendBackendError(res, e, 'text completion failed');
  }

  return res.json({
    id: `cmpl-${randomUUID()}`,
    object: 'text_completion',
    created: Math.floor(Date.now() / 1000),
    model: prepared.model,
    session_id: prepared.session,
    choices: [{ text, index: 0, finish_reason: 'stop', logprobs: null }],
    usage: tokens,
  });
});

// Keep body-parse errors JSON instead of Express' default HTML.
app.use((err, req, res, next) => {
  if (err && (err.status === 400 || err.type === 'entity.parse.failed')) {
    return openaiError(res, 400, 'invalid JSON body', 'invalid_request_error', 'invalid_json');
  }
  return next(err);
});

function printUsage() {
  // eslint-disable-next-line no-console
  console.log(`Usage:
  node server.js [--port <n>] [--opencode_url <url>] [--api_key <key>]   Start the adapter
  node server.js --session [--opencode_url <url>]                        List backend sessions
  node server.js --session <id> [--opencode_url <url>]                   Show one session + its messages

Options:
  --port <n>, --port=<n>                 Adapter listening port (overrides PORT env var)
  --opencode_url <url>                   Backend opencode serve URL (overrides OPENCODE_URL env var,
                                         --opencode-url also accepted)
  --api_key <key>                        Bearer token for auth (overrides API_KEY env var,
                                         --api-key also accepted)
  --session [<id>]                       Query session data from the backend instead of starting
                                         the server: no <id> lists sessions, with <id> shows
                                         that session including its messages (JSON to stdout)
  -h, --help                             Show this help

Env:
  PORT                     Adapter listening port (default: 80)
  OPENCODE_URL             Backend opencode serve URL (default: http://127.0.0.1:4096)
  API_KEY                  Bearer token for auth, empty = no auth (default: empty)
  OPENCODE_TIMEOUT         Control-plane backend timeout in ms (default: 15000)
  OPENCODE_MESSAGE_TIMEOUT Generation timeout in ms, blocking and stream (default: 300000)
  OPENCODE_RETRIES         Extra attempts on network-level backend failures (default: 1)`);
}

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--port') {
      if (i + 1 >= argv.length) throw new Error('--port requires a value');
      opts.port = argv[++i];
    } else if (arg.startsWith('--port=')) {
      opts.port = arg.slice('--port='.length);
    } else if (arg === '--opencode_url' || arg === '--opencode-url') {
      if (i + 1 >= argv.length) throw new Error(`${arg} requires a value`);
      opts.opencodeUrl = argv[++i];
    } else if (arg.startsWith('--opencode_url=')) {
      opts.opencodeUrl = arg.slice('--opencode_url='.length);
    } else if (arg.startsWith('--opencode-url=')) {
      opts.opencodeUrl = arg.slice('--opencode-url='.length);
    } else if (arg === '--api_key' || arg === '--api-key') {
      if (i + 1 >= argv.length) throw new Error(`${arg} requires a value`);
      opts.apiKey = argv[++i];
    } else if (arg.startsWith('--api_key=')) {
      opts.apiKey = arg.slice('--api_key='.length);
    } else if (arg.startsWith('--api-key=')) {
      opts.apiKey = arg.slice('--api-key='.length);
    } else if (arg === '--session') {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('-')) {
        opts.session = argv[++i];
      } else {
        opts.session = true; // list mode
      }
    } else if (arg === '--help' || arg === '-h') {
      opts.help = true;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return opts;
}

async function runSessionQuery(session) {
  try {
    if (session === true) {
      const resp = await fetchWithTimeout(`${OPENCODE_URL}/session`, {}, 15000);
      if (!resp.ok) throw new Error(`backend returned status ${resp.status}`);
      // eslint-disable-next-line no-console
      console.log(JSON.stringify(await resp.json(), null, 2));
      return;
    }
    const id = encodeURIComponent(session);
    const [sResp, mResp] = await Promise.all([
      fetchWithTimeout(`${OPENCODE_URL}/session/${id}`, {}, 15000),
      fetchWithTimeout(`${OPENCODE_URL}/session/${id}/message`, {}, 15000),
    ]);
    if (sResp.status === 404) throw new Error(`session not found: ${session}`);
    if (!sResp.ok) throw new Error(`backend returned status ${sResp.status}`);
    const data = await sResp.json();
    data.messages = mResp.ok ? await mResp.json() : [];
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(data, null, 2));
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error(`error: ${(e && e.message) || e}`);
    process.exit(1);
  }
}

if (require.main === module) {
  (async () => {
    let cli;
    try {
      cli = parseArgs(process.argv.slice(2));
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error(`error: ${e.message}`);
      printUsage();
      process.exit(1);
    }
    if (cli.help) {
      printUsage();
      process.exit(0);
    }
    if (cli.opencodeUrl !== undefined) OPENCODE_URL = cli.opencodeUrl;
    if (cli.apiKey !== undefined) API_KEY = cli.apiKey;
    if (cli.session !== undefined) {
      await runSessionQuery(cli.session);
      return;
    }
    const raw = cli.port !== undefined ? cli.port : process.env.PORT || '80';
    const port = parseInt(raw, 10);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      // eslint-disable-next-line no-console
      console.error(`error: invalid port: ${raw}`);
      process.exit(1);
    }
    app.listen(port, '0.0.0.0', () => {
      // eslint-disable-next-line no-console
      console.log(`opencode-api-node listening on 0.0.0.0:${port} -> ${OPENCODE_URL}`);
    });
  })();
}

module.exports = app;
module.exports.parseArgs = parseArgs;
module.exports.runSessionQuery = runSessionQuery;
module.exports.backendFetch = backendFetch;
module.exports.extractUsageFromMessages = extractUsageFromMessages;
module.exports.extractTextFromMessages = extractTextFromMessages;
