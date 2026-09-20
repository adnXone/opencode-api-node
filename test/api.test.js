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
const backendCalls = { history: [], final: [] };

const backend = http.createServer(async (req, res) => {
  const send = (code, obj) => {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(obj));
  };
  if (req.method === 'GET' && req.url === '/session/status') return send(200, {});
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
    if (gm[2] === '/message') return send(200, [{ id: 'msg-1', text: 'hi mock' }]);
    return send(200, { id: gm[1], title: `detail of ${gm[1]}` });
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
      parts: [{ type: 'text', text: 'mock reply' }],
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
  assert.equal(body.detail.error.code, 'invalid_api_key');

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
  const contents = [...raw.matchAll(/"content":"(.*?)"/g)].map((m) => m[1]);
  assert.equal(contents.join(''), 'mock reply');
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
