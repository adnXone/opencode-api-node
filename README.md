# opencode-api-node

[![CI](https://github.com/adnxone/opencode-api-node/actions/workflows/ci.yml/badge.svg)](https://github.com/adnxone/opencode-api-node/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/opencode-api-node.svg)](https://www.npmjs.com/package/opencode-api-node)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](./package.json)

OpenAI-compatible API proxy for [opencode](https://opencode.ai) — exposes `opencode serve` as a standard `/v1/chat/completions` endpoint.

Built with Node.js and Express. Drop-in replacement for any OpenAI client.

## Features

- **OpenAI-compatible** — drop-in replacement for any OpenAI client
- **Free models** — lists opencode free models (`deepseek-v4-flash-free`, `qwen3.6-plus-free`, etc.)
- **True streaming** — forwards backend tokens live via `prompt_async` + the
  backend event bus (chat & text completion), with `stream_options.include_usage`
- **Conversation memory** — pass `session_id` to keep multi-turn context in one
  backend session instead of replaying history on every request
- **Thinking output** — backend reasoning streams as `reasoning_content`
  deltas (opt-in via `include_reasoning: true`) and non-streaming replies
  carry `message.reasoning_content`
- **System prompts** — maps `system` role to opencode's system prompt
- **Image input** — supports `image_url` for vision-capable models
- **Text completions** — legacy `/v1/completions` endpoint
- **API key auth** — optional `API_KEY` env var for bearer token auth
- **Resilient** — retries on network failures, configurable timeouts, OpenAI-shaped errors
- **Model mapping** — bare model name → `opencode/<model>` provider, or `provider/model`
- **Session inspector** — `--session [<id>]` CLI queries backend sessions as JSON
- **Health check** — `GET /health` and `GET /`

## Install

```bash
npm install -g opencode-api-node

# then run it (flags win over env vars)
opencode-api-node --port 55890 --opencode_url http://127.0.0.1:4096 --api_key sk-mykey
```

Or without installing:

```bash
npx opencode-api-node --port 55890
```

Or from source:

```bash
git clone https://github.com/adnxone/opencode-api-node.git
cd opencode-api-node
npm install
```

## Quick Start

```bash
# point at a running `opencode serve` (default http://127.0.0.1:4096)
PORT=55890 node server.js

# or via CLI flags (flags win over env vars)
node server.js --port 55890 --opencode_url http://127.0.0.1:4096 --api_key sk-mykey

# or with the global binary (same flags)
opencode-api-node --port 55890
```

Query session data straight from the backend (prints JSON, no server started):

```bash
node server.js --session                  # list all sessions
node server.js --session ses_f40...       # one session, including its messages
```

The adapter proxies to a running `opencode serve` — start one first if it isn't
already (it does not start the backend for you, except inside Docker):

```bash
opencode serve --hostname 127.0.0.1 --port 4096
```

Run with docker:

```bash
docker build -t opencode-api-node .
docker run -d -p 80:80 -e API_KEY=sk-mykey opencode-api-node

# or with docker-compose
API_KEY=sk-mykey docker compose up -d --build

# without auth (API_KEY not set → no auth required)
docker run -d -p 80:80 opencode-api-node
```

### Health check

```bash
curl http://localhost:80/health
# {"status":"ok","opencode":true}
```

### List models

```bash
curl http://localhost:80/v1/models
```

### Chat completion

```bash
curl -X POST http://localhost:80/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sk-mykey" \
  -d '{
    "model": "deepseek-v4-flash-free",
    "messages": [
      {"role": "system", "content": "You are a pirate. End every sentence with arr!"},
      {"role": "user", "content": "Hello there"}
    ],
    "stream": false
  }'
```

### Text completion

```bash
curl -X POST http://localhost:80/v1/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sk-mykey" \
  -d '{
    "model": "deepseek-v4-flash-free",
    "prompt": "Once upon a time",
    "max_tokens": 100,
    "stream": false
  }'
```

### Streaming

Tokens arrive as the backend produces them (not buffered):

```bash
curl -N -X POST http://localhost:80/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sk-mykey" \
  -d '{
    "model": "deepseek-v4-flash-free",
    "messages": [{"role": "user", "content": "Tell me a joke"}],
    "stream": true,
    "stream_options": {"include_usage": true}
  }'
```

### Conversation memory

Without `session_id` every request gets a fresh backend session (earlier turns
are replayed into it). Pass `session_id` to pin all turns to one backend
session — then each request only needs the new message:

```bash
# turn 1 — the response includes a session_id
curl -X POST http://localhost:80/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek-v4-flash-free",
    "messages": [{"role": "user", "content": "My name is Ada"}]
  }'
# {"id":"chatcmpl-...","session_id":"ses_f40...","choices":[...],...}

# turn 2 — same session, context kept server-side
curl -X POST http://localhost:80/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek-v4-flash-free",
    "session_id": "ses_f40...",
    "messages": [{"role": "user", "content": "What is my name?"}]
  }'
```

Unknown ids return `404 {"error": {"code": "session_not_found", ...}}`.

### Image input (vision models)

```bash
curl -X POST http://localhost:80/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "qwen3.6-plus-free",
    "messages": [
      {
        "role": "user",
        "content": [
          {"type": "text", "text": "What is in this image?"},
          {"type": "image_url", "image_url": {"url": "https://example.com/image.jpg"}}
        ]
      }
    ]
  }'
```

## Configuration

| Environment Variable | Default | Description |
|---|---|---|
| `API_KEY` | (empty) | Bearer token for auth. Omit to disable auth. |
| `OPENCODE_URL` | `http://127.0.0.1:4096` | Backend opencode serve URL |
| `PORT` | `80` | Adapter listening port |
| `OPENCODE_TIMEOUT` | `15000` | Control-plane backend timeout in ms (health, models, sessions) |
| `OPENCODE_MESSAGE_TIMEOUT` | `300000` | Generation timeout in ms (blocking and streaming) |
| `OPENCODE_RETRIES` | `1` | Extra attempts on network-level backend failures |

CLI flags override the env vars above: `--port <n>`, `--opencode_url <url>`
(`--opencode-url` also works), `--api_key <key>` (`--api-key` also works).
`--session [<id>]` queries session data from the backend instead of starting
the server.

Copy `.env.example` to `.env` and adjust it to your setup. `node server.js`
reads `.env` automatically (built-in loader, no dotenv dependency);
`docker compose` loads `.env` automatically too. Precedence: CLI flags >
shell env > `.env` file > defaults.

### Thinking / reasoning

Chat completions expose backend thinking as `reasoning_content`
(DeepSeek/OpenRouter convention):

```bash
# streaming — opt in, otherwise thinking is dropped and content stays clean
curl -N -X POST http://localhost:80/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model": "deepseek-v4-flash-free",
       "messages": [{"role": "user", "content": "Think step by step"}],
       "stream": true, "include_reasoning": true}'
# deltas arrive as {"reasoning_content": "..."} alongside {"content": "..."}

# non-streaming — included automatically when the backend produced thinking
curl -X POST http://localhost:80/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model": "deepseek-v4-flash-free",
       "messages": [{"role": "user", "content": "Hello"}]}'
# {"choices": [{"message": {"role": "assistant", "content": "...",
#                           "reasoning_content": "..."}}], ...}
```

Aliases accepted: `include_thinking`, `stream_options.include_reasoning`,
`reasoning` / `reasoning_effort`, `thinking` / `enable_thinking`
(`reasoning: { effort: "none" }` disables thinking output). These only gate
adapter output — effort itself is tuned via opencode model variants, and the
aliases are never forwarded to the backend. `usage` gains
`completion_tokens_details.reasoning_tokens` when the backend reports it.
`/v1/completions` (legacy text endpoint) omits thinking — use chat
completions for reasoning models.

## Tests

```bash
npm test
```

Runs `test/api.test.js` (Node built-in test runner) against a mock opencode
backend — no real `opencode serve` needed.

## Architecture

```
┌─────────────┐     /v1/chat/completions     ┌──────────────┐     session API     ┌──────────────┐
│  OpenAI SDK  │ ──────────────────────────►  │  server.js   │ ──────────────────► │ opencode     │
│  curl / any  │ ◄──────────────────────────  │  (port 80)   │ ◄────────────────── │ serve        │
└─────────────┘     OpenAI format             └──────────────┘     session API     │ (port 4096)  │
                                                                  └──────────────┘
```

## Project Structure

```
├── server.js           # Express app: OpenAI → opencode proxy
├── test/api.test.js    # Tests with mock opencode backend (npm test)
├── .github/            # CI workflow + Dependabot config
├── package.json        # Node deps (express only)
├── package-lock.json   # Locked dependency tree
├── .env.example        # Template config — copy to `.env` (gitignored) and adjust
├── .nvmrc              # Pinned Node version for contributors
├── CHANGELOG.md        # Release history
├── Dockerfile          # Docker image with opencode + node deps
├── .dockerignore       # Keeps node_modules/logs/tests out of the image
├── entrypoint.sh       # Starts opencode serve, then adapter
├── docker-compose.yml
├── LICENSE             # MIT
├── README.md           # This file
└── .gitignore
```

## License

MIT — see [LICENSE](./LICENSE).

## Author

**Adrian Marian Paunescu** — [adrian@adnxone.eu](mailto:adrian@adnxone.eu)

- GitHub: [github.com/adnxone](https://github.com/adnxone)
- LinkedIn: [linkedin.com/in/adnxone](https://linkedin.com/in/adnxone)
- Instagram: [instagram.com/adnxone](https://instagram.com/adnxone)
- Facebook: [facebook.com/adnxone](https://facebook.com/adnxone)
- X: [x.com/adnxone_](https://x.com/adnxone_)
- Threads: [threads.net/@adnxone](https://threads.net/@adnxone)
- TikTok: [tiktok.com/@adnxone](https://tiktok.com/@adnxone)
- Sites: [adnxone.eu](https://adnxone.eu) | [adhdadultiromania.eu](https://adhdadultiromania.eu) | [meetaxel.eu](https://meetaxel.eu)

## Behavior notes

- OpenAI-compatible routes with OpenAI-style JSON shapes: errors are
  `{ "error": { "message", "type", "code", "param" } }` — `401 invalid_api_key`
  for bad auth, `400 invalid_json` for malformed bodies, `404 session_not_found`
  for unknown `session_id`, `502 backend_unreachable` when `opencode serve` is
  down.
- Streaming forwards backend `message.part.delta` events live and ends with
  `data: [DONE]`; mid-stream failures arrive as `data: {"error": ...}`. A client
  disconnect aborts the backend run. Pass `stream_options.include_usage` for a
  `usage` block on the final chunk. Thinking streams as
  `delta.reasoning_content` only with `include_reasoning: true`; reasoning
  parts are tracked via `message.part.updated` so thinking never leaks into
  `content`.
- `session_id` (also accepted as `sessionId`) pins turns to one backend session;
  without it each request gets a fresh session with the history replayed.
  Responses echo the id back as `session_id`.
- Backend GETs are retried on HTTP 5xx and everything is retried on
  network-level failures (`OPENCODE_RETRIES`, backoff); `prompt_async` is never
  retried (fire-and-forget).
- Image URLs are fetched and inlined as `data:` URLs (30s fetch timeout); any
  message containing an image forces the vision model (`qwen3.6-plus-free`).
- Malformed JSON bodies return `400` instead of an HTML error page.
- Requires Node.js ≥ 18 (uses the built-in `fetch`).
