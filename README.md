# free-opencode-proxy

OpenCode's **free** models exposed as standard **OpenAI** and **Anthropic** APIs.

Since ~2026-09-17 OpenCode's free tier rejects every client except the genuine
`opencode` binary (TLS-fingerprint gate — spoofing headers no longer works).
This proxy drives the real binary's local `opencode serve` API, so all upstream
calls are made by the genuine client and the free models keep working.

## Setup

```bash
npm install
npm start          # listens on :6447, auto-spawns `opencode serve`
```

Works with **opencode v1 and v2** — the server API generation is detected
automatically at startup (`/api/info` for v2, `/provider` for v1).

API keys live in `api-keys.json` (auto-generated on first run if missing).

## Endpoints

| Method | Path | Format |
|--------|------|--------|
| `GET`  | `/v1/models` | OpenAI model list |
| `POST` | `/v1/chat/completions` | OpenAI chat (stream supported) |
| `POST` | `/v1/messages` | Anthropic messages (stream supported) |
| `GET`  | `/health` | status |

Auth: `Authorization: Bearer <key>` (OpenAI) or `x-api-key: <key>` (Anthropic).
Base URL: `http://localhost:6447` (use `.../v1` for OpenAI clients).

```bash
# OpenAI format
curl http://localhost:6447/v1/chat/completions \
  -H "Authorization: Bearer <key>" -H "Content-Type: application/json" \
  -d '{"model":"big-pickle","messages":[{"role":"user","content":"hi"}]}'

# Anthropic format
curl http://localhost:6447/v1/messages \
  -H "x-api-key: <key>" -H "Content-Type: application/json" \
  -d '{"model":"big-pickle","max_tokens":1024,"messages":[{"role":"user","content":"hi"}]}'
```

## Notes

- Multi-turn: send header `x-oc-session: <name>` (or OpenAI `user` field /
  Anthropic `metadata.user_id`) to pin a conversation. Without a key, each
  request is self-contained (full history replayed as a transcript).
- Client-supplied `tools` schemas are **not** forwarded — the opencode agent
  runs its own built-in tools (read/edit/bash) in `./oc-workspace` and folds
  results into the reply text.
- Streaming is buffered (the local API returns the final message, not tokens).

## Environment

| Variable | Default | What |
|----------|---------|------|
| `PROXY_PORT` | `6447` | proxy port |
| `OC_BIN` | `~/.opencode/bin/opencode` | opencode binary path |
| `OC_WORKDIR` | `./oc-workspace` | agent working directory |
| `OC_SERVER` | — | reuse an existing `opencode serve` URL instead of spawning one |
| `OC_USERNAME` / `OC_PASSWORD` | `opencode` / — | basic auth for `OC_SERVER` |
| `OC_TIMEOUT` | `600` | per-request timeout (seconds) |
| `KEYS_FILE` | `./api-keys.json` | API keys file |
