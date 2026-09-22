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
//   STREAM_HEARTBEAT_MS      SSE heartbeat interval in ms for streams, keeps
//                            long runs alive through idle timeouts.          (default: "15000", "0" disables)
//   ENABLE_STREAMING         Master switch for SSE streaming. 0/false serves
//                            stream requests blocking as JSON instead.       (default: "1")
//   HOST                     Bind address, 127.0.0.1 = localhost only.      (default: "0.0.0.0")
//   CORS_ORIGIN              Enable CORS for this origin ("*"), empty = off. (default: "")
//   VISION_MODEL             Vision model forced on image input.             (default: "qwen3.6-plus-free")
//   INCLUDE_REASONING        Default-on thinking when requests say nothing. (default: "0")
//   LOG_LEVEL                error|warn|info|debug request logging.          (default: "info")

const express = require('express');
const { randomUUID } = require('crypto');
const fs = require('fs');
const path = require('path');

// Minimal .env loader (no dotenv dependency): fills missing process.env
// entries from `<server.js dir>/.env` so plain `node server.js` picks up
// PORT / OPENCODE_URL / API_KEY without requiring `export` or --flags.
// Precedence stays: CLI flags > shell env > .env file > defaults.
function loadDotEnv(dotEnvPath) {
  const target = dotEnvPath || path.join(__dirname, '.env');
  let raw;
  try {
    raw = fs.readFileSync(target, 'utf8');
  } catch {
    return {}; // no .env file — nothing to do
  }
  const loaded = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const body = trimmed.startsWith('export ')
      ? trimmed.slice('export '.length).trim()
      : trimmed;
    const eq = body.indexOf('=');
    if (eq === -1) continue;
    const key = body.slice(0, eq).trim();
    if (!key) continue;
    let value = body.slice(eq + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) {
      process.env[key] = value;
      loaded[key] = value;
    }
  }
  return loaded;
}

loadDotEnv();

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

function parseEnabled(raw, fallback) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
  const s = String(raw).trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(s)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(s)) return false;
  return fallback;
}

// When false, `stream: true` requests are completed blocking and returned
// as regular JSON instead of SSE (graceful downgrade — clients keep
// working, just all-at-once). Forcing streaming on non-streaming requests
// is deliberately not offered: it would break clients expecting JSON.
let STREAMING_ENABLED = parseEnabled(process.env.ENABLE_STREAMING, true);

// Default-on thinking for clients that cannot send `include_reasoning`:
// explicit request prefs still win, this only fills the gap when the
// request says nothing.
let INCLUDE_REASONING = parseEnabled(process.env.INCLUDE_REASONING, false);

function parseLogLevel(raw, fallback) {
  const s = String(raw === undefined || raw === null ? fallback : raw).trim().toLowerCase();
  return ['error', 'warn', 'info', 'debug'].includes(s) ? s : fallback;
}

const LOG_ORDER = { error: 0, warn: 1, info: 2, debug: 3 };
let LOG_LEVEL = parseLogLevel(process.env.LOG_LEVEL, 'info');

function log(level, ...args) {
  if (LOG_ORDER[level] <= LOG_ORDER[LOG_LEVEL]) {
    // eslint-disable-next-line no-console
    console.log(...args);
  }
}

let HOST = process.env.HOST || '0.0.0.0';
let CORS_ORIGIN = process.env.CORS_ORIGIN || '';
let VISION_MODEL = process.env.VISION_MODEL || 'qwen3.6-plus-free';

const MIME_MAP = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
};


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

// Thinking/reasoning text from a single backend message ({ parts: [...] }).
// Returns '' when the model emitted no reasoning parts.
function extractReasoningText(response) {
  let out = '';
  for (const part of (response && response.parts) || []) {
    if (part && part.type === 'reasoning' && typeof part.text === 'string') out += part.text;
  }
  return out;
}

function extractTokens(response) {
  const tokens = ((response || {}).info || {}).tokens || {};
  const usage = {
    prompt_tokens: tokens.input || tokens.total || 0,
    completion_tokens: tokens.output || 0,
    total_tokens: tokens.total || 0,
  };
  if (Number.isInteger(tokens.reasoning)) {
    usage.completion_tokens_details = { reasoning_tokens: tokens.reasoning };
  }
  return usage;
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
  const usage = {
    prompt_tokens: tokens.input || tokens.total || 0,
    completion_tokens: tokens.output || 0,
    total_tokens: tokens.total || 0,
  };
  if (Number.isInteger(tokens.reasoning)) {
    usage.completion_tokens_details = { reasoning_tokens: tokens.reasoning };
  }
  return usage;
}

function extractReasoningFromMessages(messages) {
  const m = lastTextBearingMessage(messages);
  if (!m) return '';
  return ((m.parts || [])
    .filter((p) => p && p.type === 'reasoning' && typeof p.text === 'string')
    .map((p) => p.text)
    .join(''));
}

// Client thinking controls. Accepted aliases (all optional, never forwarded
// to the backend — opencode tunes effort via model variants, the adapter only
// gates reasoning output):
//   include_reasoning / include_thinking (bool, top-level or stream_options)
//   reasoning: false | { enabled, effort ('none' disables), exclude, include_reasoning }
//   reasoning_effort: 'none' disables, any other string enables
//   thinking: false | { enabled } | { type: 'enabled' }, enable_thinking (bool)
// Returns true (explicitly on), false (explicitly off), or null (no opinion).
function resolveReasoningPref(data) {
  const d = data || {};
  const boolOf = (v) => (v === true ? true : v === false ? false : null);
  let pref = null;

  const top = boolOf(d.include_reasoning ?? d.include_thinking);
  if (top !== null) pref = top;
  const streamOpt = d.stream_options ? boolOf(d.stream_options.include_reasoning) : null;
  if (streamOpt !== null) pref = streamOpt;

  const r = d.reasoning;
  if (r === false) {
    pref = false;
  } else if (r !== undefined && r !== null) {
    if (typeof r === 'object') {
      if (r.enabled === false || r.exclude === true) pref = false;
      else if (r.enabled === true || r.include_reasoning === true) pref = true;
      if (typeof r.effort === 'string') {
        pref = r.effort.toLowerCase() === 'none' ? false : true;
      }
    }
  }
  if (typeof d.reasoning_effort === 'string') {
    pref = d.reasoning_effort.toLowerCase() === 'none' ? false : true;
  }

  const t = d.thinking ?? d.enable_thinking;
  if (t === false) {
    pref = false;
  } else if (t === true) {
    pref = true;
  } else if (t !== undefined && t !== null && typeof t === 'object') {
    if (t.enabled === false) pref = false;
    else if (t.enabled === true || t.type === 'enabled') pref = true;
  }

  return pref;
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
// Minimal CORS without dependencies. Enabled only when CORS_ORIGIN is set
// ("*" or one origin, echoed verbatim — never reflected). Preflights end
// here so they never reach auth.
app.use((req, res, next) => {
  if (!CORS_ORIGIN) return next();
  res.setHeader('Access-Control-Allow-Origin', CORS_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (CORS_ORIGIN !== '*') res.setHeader('Vary', 'Origin');
  if (req.method === 'OPTIONS') return res.status(204).end();
  return next();
});

// Request log: method path status duration. Bodies and keys never logged.
// SSE streams log once, when the stream ends.
app.use((req, res, next) => {
  const t0 = Date.now();
  res.on('finish', () => {
    const line = `${req.method} ${req.path} ${res.statusCode} ${Date.now() - t0}ms`;
    if (res.statusCode >= 500) log('warn', line);
    else log('info', line);
  });
  next();
});

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

// Delta `field` values that carry thinking on message.part.delta events.
// "text" (or missing) stays the content channel; anything else unknown is
// ignored.
const REASONING_FIELDS = new Set(['reasoning', 'reasoning_text', 'thinking']);

// The backend answers HTTP 200 with the failure inside { info: { error } }
// for per-model errors (402 funds, unknown model, upstream 5xx, ...).
// Surface those loudly instead of returning an empty 200.
function describeBackendError(err) {
  const data = (err && err.data) || {};
  return `opencode backend error: ${data.message || (err && err.message) || 'unknown backend error'}`;
}

function throwIfBackendError(result) {
  const err = result && (result.info ? result.info.error : result.error);
  if (err) throw new Error(describeBackendError(err));
}

// Newest-first scan of a GET /session/{id}/message list for a terminal
// backend failure (used after streaming to fail loudly instead of ending
// cleanly on an errored run).
function lastMessageError(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    const err = m && m.info && m.info.error;
    if (err) return err;
  }
  return null;
}

// True token streaming: prompts via prompt_async (204 immediately) and
// forwards the backend's message.part.delta events as OpenAI SSE chunks until
// session.idle. Thinking deltas are forwarded as `reasoning_content` chunks
// only when the client opts in (includeReasoning); otherwise they are dropped
// and content stays clean. Failures after headers are sent become
// `data: {"error": ...}` followed by [DONE]. A client disconnect aborts the
// backend run via /session/{id}/abort.
async function streamFromBackend(opts) {
  const { res, sessionId, promptPayload, model, completionId, created, textMode, includeUsage, includeReasoning } = opts;
  const wantReasoning = !!includeReasoning && !textMode; // text_completion chunks have no reasoning channel
  // partIDs known to hold thinking. The backend may stream reasoning with
  // field "reasoning" (or aliases), or with field "text" on a reasoning
  // part — tracking part types via message.part.updated covers both shapes.
  const reasoningPartIds = new Set();
  // partIDs already seen on message.part.delta: snapshot deltas for those
  // parts are ignored (dedupe guard, see below).
  const seenDeltaPartIds = new Set();
  const eventSessionId = (props) =>
    props.sessionID ?? props.sessionId ?? props.session_id ??
    (props.part && (props.part.sessionID ?? props.part.sessionId ?? props.part.session_id));
  const eventPartId = (props) =>
    props.partID ?? props.partId ?? props.part_id ??
    (props.part && (props.part.id ?? props.part.partID));
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
  let heartbeat = null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => {
    timedOut = true;
    try { ctrl.abort(); } catch { /* ignore */ }
  }, timeoutMs);
  const finish = () => {
    finished = true;
    clearTimeout(timer);
    if (heartbeat !== null) clearInterval(heartbeat);
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

  // Keep long agentic runs alive through client/proxy idle timeouts: while
  // the backend works tools (no text deltas), the stream would otherwise
  // look dead and Hermes-style clients appear to hang. SSE comments are
  // ignored by event parsers. Tunable via STREAM_HEARTBEAT_MS (default
  // 15000, 0 disables); read per request so tests can override per spawn.
  const heartbeatMs = parseNonNegativeInt(process.env.STREAM_HEARTBEAT_MS, 15000);
  if (heartbeatMs > 0) {
    heartbeat = setInterval(() => {
      if (finished || clientGone) return;
      try {
        res.write(':\n\n');
      } catch { /* ignore */ }
    }, heartbeatMs);
    if (typeof heartbeat.unref === 'function') heartbeat.unref();
  }

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
      const sid = eventSessionId(props);
      if (sid !== undefined && sid !== sessionId) continue;
      if (evt.type === 'message.part.updated') {
        // Authoritative part snapshot: remember reasoning parts so their
        // deltas route to reasoning_content even when field is "text".
        const part = props.part;
        const pid = eventPartId(props);
        const isReasoningPart =
          (part && part.type === 'reasoning') ||
          (pid !== undefined && reasoningPartIds.has(pid));
        if (part && part.type === 'reasoning' && pid !== undefined) reasoningPartIds.add(pid);
        // Fallback for backends that stream thinking via snapshot deltas
        // instead of part.delta events. The dedupe guard (no part.delta
        // seen for this part) prevents double emission when a backend
        // sends both — and thinking never routes into text content.
        if (
          wantReasoning &&
          isReasoningPart &&
          typeof props.delta === 'string' &&
          props.delta.length > 0 &&
          pid !== undefined &&
          !seenDeltaPartIds.has(pid)
        ) {
          writeChunk({ reasoning_content: props.delta }, null);
        }
        continue;
      }
      if (
        evt.type === 'message.part.delta' &&
        typeof props.delta === 'string'
      ) {
        const pid = eventPartId(props);
        if (pid !== undefined) seenDeltaPartIds.add(pid);
        const isReasoning =
          (typeof props.field === 'string' && REASONING_FIELDS.has(props.field)) ||
          (pid !== undefined && reasoningPartIds.has(pid));
        if (isReasoning) {
          if (wantReasoning) writeChunk({ reasoning_content: props.delta }, null);
        } else if (props.field === 'text' || props.field === undefined) {
          writeChunk(textMode ? props.delta : { content: props.delta }, null);
        }
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
  let terminalError = null;
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
      const err = lastMessageError(messages);
      if (err) terminalError = describeBackendError(err);
    }
  } catch {
    // usage stays undefined — the stream still closes cleanly
  }
  // The run errored server-side (e.g. 402 funds): fail loudly with an error
  // frame instead of ending a clean-but-empty stream.
  if (terminalError) {
    write({ error: { message: terminalError, type: 'server_error', code: 'backend_error', param: null } });
    writeDone();
    try { res.end(); } catch { /* ignore */ }
    finish();
    return;
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

async function doChatCompletion(messages, modelStr, stream, sessionId, includeUsage, res, opts) {
  const reasoningPref = (opts && opts.reasoningPref) ?? null;
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
      includeReasoning: reasoningPref === true,
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
    throwIfBackendError(result);
  } catch (e) {
    return sendBackendError(res, e, 'chat completion failed');
  }
  const text = extractAssistantText(result);
  const tokens = extractTokens(result);
  // Non-streaming always carries thinking when the backend produced it,
  // unless the client explicitly disabled it.
  const reasoning = reasoningPref === false ? '' : extractReasoningText(result);
  const message = { role: 'assistant', content: text };
  if (reasoning) message.reasoning_content = reasoning;

  return res.json({
    id: `chatcmpl-${randomUUID()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: prepared.model,
    session_id: prepared.session,
    choices: [
      {
        index: 0,
        message,
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
  let reasoningPref = resolveReasoningPref(data);
  if (reasoningPref === null && INCLUDE_REASONING) reasoningPref = true;
  try {
    await doChatCompletion(
      data.messages || [],
      data.model || '',
      !!data.stream && STREAMING_ENABLED,
      data.session_id || data.sessionId || null,
      !!(data.stream_options && data.stream_options.include_usage),
      res,
      { reasoningPref }
    );
  } catch (e) {
    return sendBackendError(res, e, 'chat completion failed');
  }
});

app.post('/v1/completions', verifyAuth, async (req, res) => {
  const data = req.body || {};
  let prompt = data.prompt !== undefined ? data.prompt : '';
  if (Array.isArray(prompt)) prompt = prompt.join('\n');
  const stream = !!data.stream && STREAMING_ENABLED;
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
    throwIfBackendError(result);
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
  node server.js [options]                 Start the adapter
  node server.js --session [--opencode_url <url>]                        List backend sessions
  node server.js --session <id> [--opencode_url <url>]                   Show one session + its messages

Options:
  --port <n>, --port=<n>                 Adapter listening port (overrides PORT env var)
  --opencode_url <url>                   Backend opencode serve URL (overrides OPENCODE_URL env var,
                                         --opencode-url also accepted)
  --api_key <key>                        Bearer token for auth (overrides API_KEY env var,
                                         --api-key also accepted)
  --streaming / --no-streaming         Enable/disable SSE streaming (overrides ENABLE_STREAMING;
                                     disabled serves stream requests blocking as JSON)
  --host <addr>, --host=<addr>         Bind address (overrides HOST env var)
  --cors <origin>, --cors=<origin>     Enable CORS for this origin ("*" for any)
  --vision_model <m>                   Vision model forcing on image input
                                       (--vision-model also accepted)
  --include_reasoning /                Default-on thinking when the request says
    --no-include_reasoning             nothing (overrides INCLUDE_REASONING)
  --log_level <lvl>                    error|warn|info|debug (--log-level also accepted)
  --version, -v                        Print version and exit
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
  OPENCODE_RETRIES         Extra attempts on network-level backend failures (default: 1)
  STREAM_HEARTBEAT_MS      SSE heartbeat interval in ms for streams (default: 15000, 0 disables)
  ENABLE_STREAMING         Master switch for SSE streaming (default: 1).
                           0/false disables: stream requests complete blocking
                           as JSON instead (--no-streaming flag also works)
  HOST                     Bind address, 127.0.0.1 = localhost only (default: 0.0.0.0)
  CORS_ORIGIN              Enable CORS for this origin ("*"), empty = off (default: empty)
  VISION_MODEL             Vision model forced on image input (default: qwen3.6-plus-free)
  INCLUDE_REASONING        Default-on thinking when requests say nothing (default: 0)
  LOG_LEVEL                error|warn|info|debug request logging (default: info)

Endpoints (OpenAI-compatible, base http://<host>:<port>):
  GET  /  /health              Liveness + backend reachability
  GET  /v1/models              Model list (opencode provider only)
  POST /v1/chat/completions    Chat completions. stream:true for SSE,
                               include_reasoning:true for thinking deltas,
                               session_id to pin a conversation turn
  POST /v1/completions         Legacy text completions (no thinking)

Examples:
  PORT=55890 node server.js
  node server.js --port 55890 --opencode_url http://127.0.0.1:4096
  curl http://127.0.0.1:55890/health
  curl -N -X POST http://127.0.0.1:55890/v1/chat/completions \\
    -H 'Content-Type: application/json' \\
    -d '{"model":"mimo-v2.6-flash-free",
         "messages":[{"role":"user","content":"Hi"}],
         "stream":true,"include_reasoning":true}'

Exit codes:
  0  success (including --help / --version / --session output)
  1  bad arguments, invalid port, or failed session query`);
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
    } else if (arg === '--streaming') {
      opts.streaming = true;
    } else if (arg === '--no-streaming') {
      opts.streaming = false;
    } else if (arg === '--host') {
      if (i + 1 >= argv.length) throw new Error('--host requires a value');
      opts.host = argv[++i];
    } else if (arg.startsWith('--host=')) {
      opts.host = arg.slice('--host='.length);
    } else if (arg === '--cors') {
      if (i + 1 >= argv.length) throw new Error('--cors requires a value');
      opts.cors = argv[++i];
    } else if (arg.startsWith('--cors=')) {
      opts.cors = arg.slice('--cors='.length);
    } else if (arg === '--vision_model' || arg === '--vision-model') {
      if (i + 1 >= argv.length) throw new Error(`${arg} requires a value`);
      opts.visionModel = argv[++i];
    } else if (arg.startsWith('--vision_model=')) {
      opts.visionModel = arg.slice('--vision_model='.length);
    } else if (arg.startsWith('--vision-model=')) {
      opts.visionModel = arg.slice('--vision-model='.length);
    } else if (arg === '--include_reasoning' || arg === '--include-reasoning') {
      opts.includeReasoning = true;
    } else if (arg === '--no-include_reasoning' || arg === '--no-include-reasoning') {
      opts.includeReasoning = false;
    } else if (arg === '--log_level' || arg === '--log-level') {
      if (i + 1 >= argv.length) throw new Error(`${arg} requires a value`);
      opts.logLevel = argv[++i];
    } else if (arg.startsWith('--log_level=')) {
      opts.logLevel = arg.slice('--log_level='.length);
    } else if (arg.startsWith('--log-level=')) {
      opts.logLevel = arg.slice('--log-level='.length);
    } else if (arg === '--version' || arg === '-v') {
      opts.version = true;
    } else if (arg === '--session') {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('-')) {
        opts.session = argv[++i];
      } else {
        opts.session = true; // list mode
      }
    } else if (arg === '--help' || arg === '-h') {
      opts.help = true;
    } else if (arg === 'help') {
      // Bare `help` subcommand for humans and agents; anything else
      // combined with it is a mistake, not a session id.
      if (argv.length !== 1) throw new Error(`unknown argument: ${arg}`);
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
    if (cli.version) {
      let pkgVersion = 'unknown';
      try {
        pkgVersion = require(path.join(__dirname, 'package.json')).version || pkgVersion;
      } catch { /* ignore */ }
      // eslint-disable-next-line no-console
      console.log(`opencode-api-node ${pkgVersion}`);
      process.exit(0);
    }
    if (cli.opencodeUrl !== undefined) OPENCODE_URL = cli.opencodeUrl;
    if (cli.apiKey !== undefined) API_KEY = cli.apiKey;
    if (cli.streaming !== undefined) STREAMING_ENABLED = cli.streaming;
    if (cli.host !== undefined) HOST = cli.host;
    if (cli.cors !== undefined) CORS_ORIGIN = cli.cors;
    if (cli.visionModel !== undefined) VISION_MODEL = cli.visionModel;
    if (cli.includeReasoning !== undefined) INCLUDE_REASONING = cli.includeReasoning;
    if (cli.logLevel !== undefined) LOG_LEVEL = parseLogLevel(cli.logLevel, LOG_LEVEL);
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
    app.listen(port, HOST, () => {
      // eslint-disable-next-line no-console
      console.log(`opencode-api-node listening on ${HOST}:${port} -> ${OPENCODE_URL}`);
      if (!STREAMING_ENABLED) {
        // eslint-disable-next-line no-console
        console.log('streaming disabled: stream requests complete blocking as JSON');
      }
    });
  })();
}

module.exports = app;
module.exports.loadDotEnv = loadDotEnv;
module.exports.resolveReasoningPref = resolveReasoningPref;
module.exports.throwIfBackendError = throwIfBackendError;
module.exports.lastMessageError = lastMessageError;
module.exports.extractReasoningText = extractReasoningText;
module.exports.extractReasoningFromMessages = extractReasoningFromMessages;
module.exports.extractTokens = extractTokens;
module.exports.parseArgs = parseArgs;
module.exports.parseEnabled = parseEnabled;
module.exports.parseLogLevel = parseLogLevel;
module.exports.runSessionQuery = runSessionQuery;
module.exports.backendFetch = backendFetch;
module.exports.extractUsageFromMessages = extractUsageFromMessages;
module.exports.extractTextFromMessages = extractTextFromMessages;
