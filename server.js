'use strict';

// opencode-api-node
// OpenAI-compatible API proxy for `opencode serve`.
// Exposes the opencode session API as standard OpenAI endpoints.
//
// Env:
//   API_KEY      Bearer token for auth. Empty = no auth.        (default: "")
//   OPENCODE_URL Backend opencode serve URL.                     (default: "http://127.0.0.1:4096")
//   PORT         Adapter listening port.                         (default: "80")

const express = require('express');
const { randomUUID } = require('crypto');

let OPENCODE_URL = process.env.OPENCODE_URL || 'http://127.0.0.1:4096';
let API_KEY = process.env.API_KEY || '';

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

async function postJson(url, body, timeoutMs) {
  return fetchWithTimeout(
    url,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
    timeoutMs
  );
}

// Mirrors FastAPI's HTTPBearer(auto_error=False) + 401 detail shape.
function verifyAuth(req, res, next) {
  if (!API_KEY) return next();
  const header = req.headers.authorization || '';
  const m = header.match(/^Bearer\s+(.+)$/i);
  const token = m ? m[1] : null;
  if (token !== API_KEY) {
    return res.status(401).json({
      detail: {
        error: {
          message: 'Incorrect API key provided. Set your API key in the Authorization header.',
          type: 'invalid_request_error',
          param: null,
          code: 'invalid_api_key',
        },
      },
    });
  }
  return next();
}

async function createSession() {
  const resp = await postJson(`${OPENCODE_URL}/session`, {}, 30000);
  if (!resp.ok) throw new Error(`create session failed with status ${resp.status}`);
  const data = await resp.json();
  return data.id;
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

async function runChatCompletion(messages, modelStr) {
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

  const sessionId = await createSession();

  const modelParam = parseModel(modelStr);
  const payloadBase = {};
  if (modelParam) payloadBase.model = modelParam;
  if (systemMessage && systemMessage.length !== 0) payloadBase.system = systemMessage;

  async function sendNoReply(parts) {
    try {
      await postJson(
        `${OPENCODE_URL}/session/${sessionId}/message`,
        { ...payloadBase, parts, noReply: true },
        30000
      );
    } catch {
      // best-effort history replay; failures are ignored
    }
  }

  for (const text of historyTexts) {
    await sendNoReply(text);
  }

  const resp = await postJson(
    `${OPENCODE_URL}/session/${sessionId}/message`,
    { ...payloadBase, parts: lastUserParts },
    300000
  );
  if (!resp.ok) throw new Error(`opencode backend returned status ${resp.status}`);
  const result = await resp.json();

  return {
    text: extractAssistantText(result),
    tokens: extractTokens(result),
    model: modelStr || 'opencode',
    completionId: `chatcmpl-${randomUUID()}`,
    created: Math.floor(Date.now() / 1000),
  };
}

async function doChatCompletion(messages, modelStr, stream, res) {
  let out;
  try {
    out = await runChatCompletion(messages, modelStr);
  } catch (e) {
    return res.status(500).json({ detail: String((e && e.message) || e) });
  }
  const { text, tokens, model, completionId, created } = out;

  if (stream) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    for (const char of text) {
      const chunk = {
        id: completionId,
        object: 'chat.completion.chunk',
        created,
        model,
        choices: [{ index: 0, delta: { content: char }, finish_reason: null }],
      };
      res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      await sleep(5);
    }
    const final = {
      id: completionId,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    };
    res.write(`data: ${JSON.stringify(final)}\n\n`);
    res.write('data: [DONE]\n\n');
    return res.end();
  }

  return res.json({
    id: completionId,
    object: 'chat.completion',
    created,
    model,
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
    await doChatCompletion(data.messages || [], data.model || '', !!data.stream, res);
  } catch (e) {
    return res.status(500).json({ detail: String((e && e.message) || e) });
  }
});

app.post('/v1/completions', verifyAuth, async (req, res) => {
  const data = req.body || {};
  let prompt = data.prompt !== undefined ? data.prompt : '';
  if (Array.isArray(prompt)) prompt = prompt.join('\n');
  const stream = !!data.stream;
  const modelStr = data.model || '';

  // Reuse the chat path for the actual backend call (non-streaming),
  // then reshape to a text_completion.
  const messages = [{ role: 'user', content: prompt }];
  let text;
  let tokens;
  try {
    const out = await runChatCompletion(messages, modelStr);
    text = out.text;
    tokens = out.tokens;
  } catch (e) {
    return res.status(500).json({ detail: String((e && e.message) || e) });
  }

  if (stream) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    for (const char of text) {
      const chunk = {
        id: `cmpl-${randomUUID()}`,
        object: 'text_completion',
        created: Math.floor(Date.now() / 1000),
        model: modelStr || 'opencode',
        choices: [{ text: char, index: 0, finish_reason: null, logprobs: null }],
      };
      res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      await sleep(5);
    }
    const final = {
      id: `cmpl-${randomUUID()}`,
      object: 'text_completion',
      created: Math.floor(Date.now() / 1000),
      model: modelStr || 'opencode',
      choices: [{ text: '', index: 0, finish_reason: 'stop', logprobs: null }],
    };
    res.write(`data: ${JSON.stringify(final)}\n\n`);
    res.write('data: [DONE]\n\n');
    return res.end();
  }

  return res.json({
    id: `cmpl-${randomUUID()}`,
    object: 'text_completion',
    created: Math.floor(Date.now() / 1000),
    model: modelStr || 'opencode',
    choices: [{ text, index: 0, finish_reason: 'stop', logprobs: null }],
    usage: tokens,
  });
});

// Keep body-parse errors JSON instead of Express' default HTML.
app.use((err, req, res, next) => {
  if (err && (err.status === 400 || err.type === 'entity.parse.failed')) {
    return res.status(400).json({ detail: 'invalid JSON body' });
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
  API_KEY                  Bearer token for auth, empty = no auth (default: empty)`);
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
