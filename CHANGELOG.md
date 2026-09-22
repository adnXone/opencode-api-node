# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.2.1] - 2026-09-22

### Fixed

- Thinking works with any model that exposes plaintext reasoning, not just
  one delta shape: recognized delta fields are now `reasoning`,
  `reasoning_text`, and `thinking`, and thinking streamed via
  `message.part.updated` snapshot deltas is forwarded too (with a dedupe
  guard so backends sending both shapes never emit it twice). Verified
  live against `mimo-v2.6-flash-free` (non-streaming `reasoning_content`,
  opt-in streaming deltas, clean `content` by default).
- Backend per-model failures that arrive as HTTP 200 with `info.error`
  (e.g. `402 Insufficient account funds`, found live on non-free models)
  no longer return an empty 200: non-streaming endpoints answer `500
  backend_error` with the upstream message, and streams end with an error
  frame instead of a clean-but-empty `[DONE]`.
- Long agentic runs no longer look hung: streams now send an SSE heartbeat
  comment every `STREAM_HEARTBEAT_MS` (default 15000, `0` disables), so
  client/proxy idle timeouts don't kill runs while the backend works tools
  with no text deltas. Verified live (heartbeat interleaved mid-run,
  clean `[DONE]`).
- Streaming master switch: `ENABLE_STREAMING=0` (or `--no-streaming`;
  `--streaming` re-enables) serves `stream: true` requests blocking as
  regular JSON instead of SSE, so strict clients keep working. Forcing
  streaming onto non-streaming requests is deliberately not offered.
- Ops config gaps closed: `HOST` bind address (`--host`, default keeps
  `0.0.0.0` for Docker; use `127.0.0.1` for localhost-only no-auth use),
  `CORS_ORIGIN` (`--cors`, off by default; preflights bypass auth),
  `VISION_MODEL` (`--vision_model`, was hardcoded),
  `INCLUDE_REASONING` (`--include_reasoning`, default-on thinking for
  clients that can't send the flag), `LOG_LEVEL` (`--log_level`,
  `error|warn|info|debug`, request lines without bodies/keys), and a
  `--version`/`-v` flag.
- Help for humans and agents: bare `help` subcommand (`node server.js
  help`) plus richer `--help` with endpoints, request-field hints,
  copy-paste examples, and exit codes.

### Notes

- Some models (observed: `muse-spark-1.3-contributor-free`) keep thinking
  encrypted server-side (`reasoningEncryptedContent`, empty text, zero
  deltas). For those only `usage.completion_tokens_details.reasoning_tokens`
  comes through — there is no plaintext for the adapter to forward.

## [1.2.0] - 2026-09-22

### Added

- Thinking output: backend reasoning parts are exposed OpenAI-style as
  `reasoning_content` (DeepSeek/OpenRouter/vLLM convention)
  - Streaming chat completions forward thinking as
    `delta.reasoning_content` chunks when the client opts in
    (`include_reasoning: true`; also accepts `include_thinking`,
    `stream_options.include_reasoning`, `reasoning`,
    `reasoning_effort`, `thinking` / `enable_thinking`). Default still
    drops thinking so `content` stays clean.
  - Reasoning parts are tracked via `message.part.updated` snapshots, so
    thinking never leaks into `content` even when the backend streams it
    with `field: "text"` on a reasoning part.
  - Non-streaming chat completions include `message.reasoning_content`
    whenever the backend produced thinking (unless explicitly disabled,
    e.g. `reasoning: { effort: "none" }`).
  - `usage.completion_tokens_details.reasoning_tokens` when the backend
    reports reasoning tokens.
- Thinking request aliases are accepted without error but never forwarded
  to the backend: opencode tunes effort via model variants
  (`opencode.json`), the adapter only gates reasoning output. Effort
  tuning via `tools`-style per-message params is not supported by
  `POST /session/:id/message` (`{ messageID?, model?, agent?, noReply?,
  system?, tools?, parts }`).

## [1.1.1] - 2026-09-22

### Fixed

- Plain `node server.js` now reads `.env` (zero-dependency built-in loader),
  so `PORT` (and `OPENCODE_URL`, `API_KEY`, timeouts, retries) from `.env`
  are honored instead of silently falling back to port 80. Precedence:
  CLI flags > shell env > `.env` file > defaults.

## [1.1.0] - 2026-09-21

### Added

- True token streaming: chat and text completions forward backend
  `message.part.delta` events live via `prompt_async` + the `/event` bus
  (replaces buffered char-by-char replay); `stream_options.include_usage`
  adds a `usage` block to the final chunk; client disconnect aborts the
  backend run
- Conversation memory: opt-in `session_id` request field pins turns to one
  backend session (no history replay); responses echo it back; unknown ids
  return `404 session_not_found`
- Resilience: retries with backoff on network failures and 5xx GETs
  (`OPENCODE_RETRIES`), configurable `OPENCODE_TIMEOUT` /
  `OPENCODE_MESSAGE_TIMEOUT`
- OpenAI-shaped errors everywhere on `/v1/*` (`401 invalid_api_key`,
  `400 invalid_json`, `404 session_not_found`, `502 backend_unreachable`)
- npm binary: global install exposes the `opencode-api-node` command

## [1.0.0] - 2026-09-20

### Added

- OpenAI-compatible proxy for `opencode serve` (`server.js`, Express, zero
  runtime deps besides `express`)
- Endpoints: `GET /`, `GET /health`, `GET /v1/models`,
  `POST /v1/chat/completions`, `POST /v1/completions`
- SSE character-by-character streaming for chat and text completions
- Multi-turn context via `noReply` history replay, `system` prompt mapping,
  `provider/model` splitting, vision-model forcing with `image_url` inlining
- Optional bearer auth (`API_KEY`), backend selection (`OPENCODE_URL`),
  port selection (`PORT` / `--port`)
- `--session [<id>]` CLI action to dump backend session data as JSON
- Docker image + compose setup with healthcheck
- Test suite with mock backend (`npm test`)
- MIT license
