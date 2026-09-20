# opencode-api-node

[![CI](https://github.com/adnxone/opencode-api-node/actions/workflows/ci.yml/badge.svg)](https://github.com/adnxone/opencode-api-node/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/opencode-api-node.svg)](https://www.npmjs.com/package/opencode-api-node)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](./package.json)

OpenAI-compatible API proxy for [opencode](https://opencode.ai) — exposes `opencode serve` as a standard `/v1/chat/completions` endpoint.

Built with Node.js and Express. Drop-in replacement for any OpenAI client.

## Features

- **OpenAI-compatible** — drop-in replacement for any OpenAI client
- **Free models** — only lists opencode free models (`deepseek-v4-flash-free`, `qwen3.6-plus-free`, etc.)
- **Multi-turn conversation** — preserves context via `noReply` messages
- **System prompts** — maps `system` role to opencode's system prompt
- **Streaming** — SSE character-by-character streaming (chat & text completion)
- **Image input** — supports `image_url` for vision-capable models
- **Text completions** — legacy `/v1/completions` endpoint
- **API key auth** — optional `API_KEY` env var for bearer token auth
- **Model mapping** — bare model name → `opencode/<model>` provider
- **Health check** — `GET /health` and `GET /`

## Quick Start

```bash
npm install

# point at a running `opencode serve` (default http://127.0.0.1:4096)
PORT=55890 node server.js

# or via CLI flags (flags win over env vars)
node server.js --port 55890 --opencode_url http://127.0.0.1:4096 --api_key sk-mykey
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
      {"role": "system", "content": "你是一只猫娘，每句话结尾加喵"},
      {"role": "user", "content": "你好"}
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

```bash
curl -N -X POST http://localhost:80/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sk-mykey" \
  -d '{
    "model": "deepseek-v4-flash-free",
    "messages": [{"role": "user", "content": "你好"}],
    "stream": true
  }'
```

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

CLI flags override the env vars above: `--port <n>`, `--opencode_url <url>`
(`--opencode-url` also works), `--api_key <key>` (`--api-key` also works).
`--session [<id>]` queries session data from the backend instead of starting
the server.

Copy `.env.example` to `.env` and adjust it to your setup. `docker compose`
loads `.env` automatically; plain `node server.js` does not read it (no dotenv
dependency) — export the variables in your shell or use the CLI flags instead.

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

- OpenAI-compatible routes with OpenAI-style JSON shapes (including the
  `401 {"detail": {"error": ...}}` auth-error envelope and
  `500 {"detail": "..."}` backend-error envelope).
- Image URLs are fetched and inlined as `data:` URLs (30s fetch timeout); any
  message containing an image forces the vision model (`qwen3.6-plus-free`).
- Streaming replays the full text char-by-char with a 5ms delay, ending with
  `data: [DONE]`.
- Malformed JSON bodies return `400 {"detail": "invalid JSON body"}` instead of
  an HTML error page.
- Requires Node.js ≥ 18 (uses the built-in `fetch`).
