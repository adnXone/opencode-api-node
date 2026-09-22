# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
