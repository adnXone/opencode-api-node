'use strict';

// Smoke tests for server.js against a mock opencode backend.
// Run: npm test
// No real `opencode serve` needed.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execFileAsync = promisify(execFile);
const path = require('node:path');

const SERVER_JS = path.join(__dirname, '..', 'server.js');
const API_KEY = 'test-secret-key';

function getFreePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

// ---- mock opencode backend ----
const backendCalls = { history: [], final: [], async: [] };
let flakyHits = 0;

const backend = http.createServer(async (req, res) => {
  const send = (code, obj) => {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(obj));
  };
  if (req.method === 'GET' && req.url === '/session/status') return send(200, {});
  if (req.method === 'GET' && req.url === '/flaky') {
    flakyHits += 1;
    if (flakyHits === 1) return send(500, { error: 'boom' });
    return send(200, { ok: true });
  }
  if (req.method === 'GET' && req.url === '/event') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    const frame = (obj) => `data: ${JSON.stringify(obj)}\n\n`;
    res.write(frame({ id: 'evt-0', type: 'server.connected', properties: {} }));
    // Simulate a real backend run for the session the adapter creates.
    setTimeout(() => {
      try {
        const textBase = { sessionID: 'sess-mock', messageID: 'msg-9', partID: 'prt-text' };
        const reasonBase = { sessionID: 'sess-mock', messageID: 'msg-9', partID: 'prt-reason' };
        // Authoritative snapshot marking prt-reason as a thinking part.
        res.write(frame({ id: 'evt-r0', type: 'message.part.updated', properties: { part: { id: 'prt-reason', type: 'reasoning', sessionID: 'sess-mock' } } }));
        res.write(frame({ id: 'evt-1', type: 'message.part.delta', properties: { ...textBase, field: 'text', delta: 'mock ' } }));
        res.write(frame({ id: 'evt-2', type: 'message.part.delta', properties: { ...reasonBase, field: 'reasoning', delta: 'should be ignored' } }));
        // Backend quirk shape: text field on a reasoning part — must never leak into content.
        res.write(frame({ id: 'evt-2b', type: 'message.part.delta', properties: { ...reasonBase, field: 'text', delta: 'hidden-thought' } }));
        res.write(frame({ id: 'evt-3', type: 'message.part.delta', properties: { ...textBase, field: 'text', delta: 'reply' } }));
        res.write(frame({ id: 'evt-4', type: 'session.idle', properties: { sessionID: 'sess-mock' } }));
      } catch { /* client went away */ }
    }, 50);
    return; // left open; the adapter aborts it after session.idle
  }
  if (req.method === 'GET' && req.url === '/provider') {
    return send(200, {
      all: [
        { id: 'opencode', models: { 'mock-model': {}, 'other-free': {} } },
        { id: 'something-else', models: { 'x-model': {} } },
      ],
    });
  }
  if (req.method === 'POST' && req.url === '/session') return send(200, { id: 'sess-mock' });
  if (req.method === 'GET' && req.url === '/session') {
    return send(200, [
      { id: 'ses-list-1', title: 'mock session one' },
      { id: 'ses-list-2', title: 'mock session two' },
    ]);
  }
  const gm = req.method === 'GET' && /^\/session\/([^/]+)(\/message)?$/.exec(req.url);
  if (gm) {
    if (gm[1] === 'nope') return send(404, { error: 'not found' });
    if (gm[2] === '/message') {
      return send(200, [
        { id: 'msg-1', text: 'hi mock' },
        {
          parts: [{ type: 'text', text: 'mock reply' }],
          info: { tokens: { input: 3, output: 4, total: 7 } },
        },
      ]);
    }
    return send(200, { id: gm[1], title: `detail of ${gm[1]}` });
  }
  const pa = req.method === 'POST' && /^\/session\/[^/]+\/prompt_async$/.exec(req.url);
  if (pa) {
    const body = await readJson(req);
    backendCalls.async.push(body);
    res.writeHead(204);
    return res.end();
  }
  const ab = req.method === 'POST' && /^\/session\/[^/]+\/abort$/.exec(req.url);
  if (ab) {
    res.writeHead(200);
    return res.end();
  }
  const m = req.method === 'POST' && /^\/session\/[^/]+\/message$/.exec(req.url);
  if (m) {
    const body = await readJson(req);
    if (body.noReply) {
      backendCalls.history.push(body);
      return send(200, {});
    }
    backendCalls.final.push(body);
    return send(200, {
      parts: [
        { type: 'reasoning', text: 'mock thought' },
        { type: 'text', text: 'mock reply' },
      ],
      info: { tokens: { input: 3, output: 4, total: 7 } },
    });
  }
  return send(404, { error: 'not found' });
});

// ---- server under test ----
let base;
let mockBase;
let child;

async function waitForHealth(url) {
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(`${url}/health`);
      if (r.ok) return;
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`server never became healthy: ${url}`);
}

before(async () => {
  await new Promise((resolve) => backend.listen(0, '127.0.0.1', resolve));
  const backendPort = backend.address().port;
  mockBase = `http://127.0.0.1:${backendPort}`;
  const frontendPort = await getFreePort();
  base = `http://127.0.0.1:${frontendPort}`;
  child = spawn(process.execPath, [SERVER_JS], {
    env: {
      ...process.env,
      PORT: String(frontendPort),
      OPENCODE_URL: `http://127.0.0.1:${backendPort}`,
      API_KEY,
    },
    stdio: 'pipe',
  });
  child.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));
  await waitForHealth(base);
});

after(() => {
  child && child.kill();
  backend.close();
});

const auth = { Authorization: `Bearer ${API_KEY}` };

test('GET /health reports ok', async () => {
  const r = await fetch(`${base}/health`);
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { status: 'ok', opencode: true });
});

test('GET /v1/models requires auth', async () => {
  const anon = await fetch(`${base}/v1/models`);
  assert.equal(anon.status, 401);
  const body = await anon.json();
  assert.equal(body.error.code, 'invalid_api_key');
  assert.equal(body.error.type, 'invalid_request_error');

  const wrong = await fetch(`${base}/v1/models`, {
    headers: { Authorization: 'Bearer wrong' },
  });
  assert.equal(wrong.status, 401);
});

test('GET /v1/models lists only opencode provider models', async () => {
  const r = await fetch(`${base}/v1/models`, { headers: auth });
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.object, 'list');
  assert.deepEqual(
    body.data.map((m) => m.id).sort(),
    ['mock-model', 'other-free']
  );
});

test('POST /v1/chat/completions (non-stream)', async () => {
  backendCalls.history.length = 0;
  backendCalls.final.length = 0;
  const r = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...auth },
    body: JSON.stringify({
      model: 'mock-model',
      messages: [
        { role: 'system', content: 'sys prompt' },
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'prior answer' },
        { role: 'user', content: 'second' },
      ],
    }),
  });
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.object, 'chat.completion');
  assert.equal(body.model, 'mock-model');
  assert.equal(body.choices[0].message.role, 'assistant');
  assert.equal(body.choices[0].message.content, 'mock reply');
  assert.equal(body.choices[0].finish_reason, 'stop');
  assert.deepEqual(body.usage, { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 });

  // multi-turn replayed as noReply history (first user + assistant), then final call
  assert.equal(backendCalls.history.length, 2);
  assert.equal(backendCalls.final.length, 1);
  const fin = backendCalls.final[0];
  assert.deepEqual(fin.model, { providerID: 'opencode', modelID: 'mock-model' });
  assert.equal(fin.system, 'sys prompt');
  assert.deepEqual(fin.parts, [{ type: 'text', text: 'second' }]);
});

test('POST /v1/chat/completions maps provider/model split', async () => {
  backendCalls.final.length = 0;
  const r = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...auth },
    body: JSON.stringify({
      model: 'custom/prov-model',
      messages: [{ role: 'user', content: 'hi' }],
    }),
  });
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.model, 'custom/prov-model');
  assert.deepEqual(backendCalls.final[0].model, {
    providerID: 'custom',
    modelID: 'prov-model',
  });
});

test('POST /v1/chat/completions (stream) yields SSE + [DONE]', async () => {
  backendCalls.async.length = 0;
  const r = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...auth },
    body: JSON.stringify({
      model: 'mock-model',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
    }),
  });
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /text\/event-stream/);
  const raw = await r.text();
  assert.ok(raw.includes('data: [DONE]'));
  assert.ok(raw.includes('"role":"assistant"'));
  assert.ok(raw.includes('"session_id":"sess-mock"'));
  const contents = [...raw.matchAll(/"content":"(.*?)"/g)].map((m) => m[1]);
  // true streaming: multiple progressive deltas, thinking dropped by default
  // (both the reasoning-field delta and the text-field delta on a reasoning part)
  assert.ok(contents.length >= 2);
  assert.equal(contents.join(''), 'mock reply');
  assert.ok(!raw.includes('should be ignored'));
  assert.ok(!raw.includes('hidden-thought'));
  assert.ok(!raw.includes('reasoning_content'));
  // prompted via fire-and-forget prompt_async, not the blocking endpoint
  assert.equal(backendCalls.async.length, 1);
  assert.deepEqual(backendCalls.async[0].parts, [{ type: 'text', text: 'hi' }]);
});

test('POST /v1/chat/completions (stream) forwards thinking with include_reasoning', async () => {
  const r = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...auth },
    body: JSON.stringify({
      model: 'mock-model',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
      include_reasoning: true,
    }),
  });
  assert.equal(r.status, 200);
  const raw = await r.text();
  assert.ok(raw.includes('data: [DONE]'));
  const thinking = [...raw.matchAll(/"reasoning_content":"(.*?)"/g)].map((m) => m[1]);
  assert.equal(thinking.join(''), 'should be ignoredhidden-thought');
  // content stays clean — thinking never leaks into it
  const contents = [...raw.matchAll(/"content":"(.*?)"/g)].map((m) => m[1]);
  assert.equal(contents.join(''), 'mock reply');
});

test('POST /v1/chat/completions (non-stream) includes reasoning_content', async () => {
  const r = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...auth },
    body: JSON.stringify({
      model: 'mock-model',
      messages: [{ role: 'user', content: 'hi' }],
    }),
  });
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.choices[0].message.content, 'mock reply');
  assert.equal(body.choices[0].message.reasoning_content, 'mock thought');
});

test('POST /v1/chat/completions (non-stream) drops thinking when disabled', async () => {
  const r = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...auth },
    body: JSON.stringify({
      model: 'mock-model',
      messages: [{ role: 'user', content: 'hi' }],
      reasoning: { effort: 'none' },
    }),
  });
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.choices[0].message.content, 'mock reply');
  assert.ok(!('reasoning_content' in body.choices[0].message));
});

test('POST /v1/chat/completions (stream) honors include_usage', async () => {
  const r = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...auth },
    body: JSON.stringify({
      model: 'mock-model',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
      stream_options: { include_usage: true },
    }),
  });
  assert.equal(r.status, 200);
  const raw = await r.text();
  assert.ok(raw.includes('"usage":{"prompt_tokens":3,"completion_tokens":4,"total_tokens":7}'));
});

test('POST /v1/chat/completions reuses session_id without replay', async () => {
  backendCalls.history.length = 0;
  backendCalls.final.length = 0;
  const r = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...auth },
    body: JSON.stringify({
      model: 'mock-model',
      session_id: 'ses-list-1',
      messages: [
        { role: 'user', content: 'earlier turn' },
        { role: 'assistant', content: 'earlier answer' },
        { role: 'user', content: 'follow-up' },
      ],
    }),
  });
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.session_id, 'ses-list-1');
  // no history replayed — the backend session already holds the turns
  assert.equal(backendCalls.history.length, 0);
  assert.equal(backendCalls.final.length, 1);
  assert.deepEqual(backendCalls.final[0].parts, [{ type: 'text', text: 'follow-up' }]);
});

test('POST /v1/chat/completions rejects unknown session_id with 404', async () => {
  const r = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...auth },
    body: JSON.stringify({
      model: 'mock-model',
      session_id: 'nope',
      messages: [{ role: 'user', content: 'hi' }],
    }),
  });
  assert.equal(r.status, 404);
  const body = await r.json();
  assert.equal(body.error.code, 'session_not_found');
});

test('malformed JSON body yields 400 OpenAI error', async () => {
  const r = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...auth },
    body: '{not json',
  });
  assert.equal(r.status, 400);
  const body = await r.json();
  assert.equal(body.error.code, 'invalid_json');
});

test('POST /v1/completions (non-stream)', async () => {
  const r = await fetch(`${base}/v1/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...auth },
    body: JSON.stringify({ model: 'mock-model', prompt: 'Once upon' }),
  });
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.object, 'text_completion');
  assert.equal(body.choices[0].text, 'mock reply');
  assert.equal(body.choices[0].finish_reason, 'stop');
});

test('POST /v1/completions (stream) yields SSE + [DONE]', async () => {
  const r = await fetch(`${base}/v1/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...auth },
    body: JSON.stringify({ model: 'mock-model', prompt: 'Once upon', stream: true }),
  });
  assert.equal(r.status, 200);
  const raw = await r.text();
  assert.ok(raw.includes('data: [DONE]'));
  assert.ok(raw.includes('"object":"text_completion"'));
});

test('unreachable backend yields 502 OpenAI error', async () => {
  const deadBackend = await getFreePort(); // nothing listens here
  const port = await getFreePort();
  const proc = spawn(process.execPath, [SERVER_JS], {
    env: {
      ...process.env,
      PORT: String(port),
      OPENCODE_URL: `http://127.0.0.1:${deadBackend}`,
      API_KEY,
      OPENCODE_RETRIES: '0',
    },
    stdio: 'pipe',
  });
  try {
    await waitForHealth(`http://127.0.0.1:${port}`);
    const r = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...auth },
      body: JSON.stringify({ model: 'mock-model', messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.equal(r.status, 502);
    const body = await r.json();
    assert.equal(body.error.code, 'backend_unreachable');
  } finally {
    proc.kill();
  }
});

test('backendFetch retries GETs on 5xx', async () => {
  const { backendFetch } = require('../server.js');
  flakyHits = 0;
  const r = await backendFetch(`${mockBase}/flaky`, {}, 5000);
  assert.equal(r.status, 200);
  assert.equal(flakyHits, 2);
  assert.deepEqual(await r.json(), { ok: true });
});

test('extractUsageFromMessages / extractTextFromMessages read backend messages', () => {
  const { extractUsageFromMessages, extractTextFromMessages } = require('../server.js');
  const messages = [
    { parts: [{ type: 'step-start' }], info: { tokens: { input: 1, output: 1, total: 2 } } },
    {
      parts: [{ type: 'text', text: 'hello' }, { type: 'text', text: ' world' }],
      info: { tokens: { input: 3, output: 4, total: 7 } },
    },
  ];
  assert.deepEqual(extractUsageFromMessages(messages), {
    prompt_tokens: 3,
    completion_tokens: 4,
    total_tokens: 7,
  });
  assert.equal(extractTextFromMessages(messages), 'hello world');
  assert.deepEqual(extractUsageFromMessages([]), {
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0,
  });
  assert.equal(extractTextFromMessages([{ parts: [] }]), '');
});

test('resolveReasoningPref handles thinking aliases', () => {
  const { resolveReasoningPref } = require('../server.js');
  assert.equal(resolveReasoningPref({}), null);
  assert.equal(resolveReasoningPref({ include_reasoning: true }), true);
  assert.equal(resolveReasoningPref({ include_reasoning: false }), false);
  assert.equal(resolveReasoningPref({ stream_options: { include_reasoning: true } }), true);
  assert.equal(resolveReasoningPref({ reasoning: { effort: 'high' } }), true);
  assert.equal(resolveReasoningPref({ reasoning: { effort: 'none' } }), false);
  assert.equal(resolveReasoningPref({ reasoning: { enabled: false } }), false);
  assert.equal(resolveReasoningPref({ reasoning_effort: 'low' }), true);
  assert.equal(resolveReasoningPref({ reasoning_effort: 'none' }), false);
  assert.equal(resolveReasoningPref({ thinking: { type: 'enabled' } }), true);
  assert.equal(resolveReasoningPref({ enable_thinking: false }), false);
});

test('extractReasoningText / extractTokens cover thinking', () => {
  const { extractReasoningText, extractTokens } = require('../server.js');
  assert.equal(extractReasoningText({ parts: [{ type: 'text', text: 'hi' }] }), '');
  assert.equal(
    extractReasoningText({ parts: [{ type: 'reasoning', text: 'a' }, { type: 'text', text: 'b' }, { type: 'reasoning', text: 'c' }] }),
    'ac'
  );
  assert.deepEqual(extractTokens({ info: { tokens: { input: 1, output: 2, total: 3 } } }), {
    prompt_tokens: 1,
    completion_tokens: 2,
    total_tokens: 3,
  });
  assert.deepEqual(
    extractTokens({ info: { tokens: { input: 1, output: 5, total: 6, reasoning: 3 } } }),
    {
      prompt_tokens: 1,
      completion_tokens: 5,
      total_tokens: 6,
      completion_tokens_details: { reasoning_tokens: 3 },
    }
  );
});

test('parseArgs handles --port forms and rejects bad input', () => {
  const { parseArgs } = require('../server.js');
  assert.deepEqual(parseArgs([]), {});
  assert.deepEqual(parseArgs(['--port', '55890']), { port: '55890' });
  assert.deepEqual(parseArgs(['--port=1234']), { port: '1234' });
  assert.deepEqual(parseArgs(['--help']), { help: true });
  assert.deepEqual(parseArgs(['-h']), { help: true });
  assert.throws(() => parseArgs(['--bogus']), /unknown argument/);
  assert.throws(() => parseArgs(['--port']), /requires a value/);
});

test('parseArgs handles backend/auth/session flags', () => {
  const { parseArgs } = require('../server.js');
  assert.deepEqual(parseArgs(['--opencode_url', 'http://x:1']), { opencodeUrl: 'http://x:1' });
  assert.deepEqual(parseArgs(['--opencode-url=http://x:2']), { opencodeUrl: 'http://x:2' });
  assert.deepEqual(parseArgs(['--api_key', 'k']), { apiKey: 'k' });
  assert.deepEqual(parseArgs(['--api-key=k2']), { apiKey: 'k2' });
  assert.deepEqual(parseArgs(['--session']), { session: true });
  assert.deepEqual(parseArgs(['--session', 'ses-1']), { session: 'ses-1' });
  assert.deepEqual(parseArgs(['--session', '--port', '1']), { session: true, port: '1' });
  assert.throws(() => parseArgs(['--opencode_url']), /requires a value/);
  assert.throws(() => parseArgs(['--api_key']), /requires a value/);
});

test('--session lists backend sessions as JSON', async () => {
  const { stdout } = await execFileAsync(
    process.execPath,
    [SERVER_JS, '--session', '--opencode_url', mockBase],
    { timeout: 20000 }
  );
  const data = JSON.parse(stdout);
  assert.ok(Array.isArray(data));
  assert.deepEqual(data.map((s) => s.id), ['ses-list-1', 'ses-list-2']);
});

test('--session <id> shows detail with messages', async () => {
  const { stdout } = await execFileAsync(
    process.execPath,
    [SERVER_JS, '--opencode_url', mockBase, '--session', 'ses-list-1'],
    { timeout: 20000 }
  );
  const data = JSON.parse(stdout);
  assert.equal(data.id, 'ses-list-1');
  assert.ok(Array.isArray(data.messages));
  assert.equal(data.messages[0].id, 'msg-1');
});

test('--session <unknown> exits non-zero', async () => {
  await assert.rejects(
    execFileAsync(
      process.execPath,
      [SERVER_JS, '--session', 'nope', '--opencode_url', mockBase],
      { timeout: 20000 }
    ),
    /session not found/
  );
});
