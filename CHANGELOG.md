# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
