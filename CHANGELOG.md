# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
