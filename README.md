# codex-usage-service

`codex-usage-service` exposes Codex/ChatGPT subscription rate-limit information through a small REST API. It is intended for self-hosted integrations such as n8n workflows, monitoring systems, dashboards, and usage alerts.

The service starts one long-running `codex app-server` child process, performs the app-server initialization handshake over stdio JSONL/JSON-RPC, and translates a small set of HTTP requests into app-server calls. The REST layer intentionally does not schedule checks, store state, evaluate thresholds, deduplicate alerts, or send notifications.

## Requirements

- Node.js 24 or later
- npm 11 or later
- [Codex CLI](https://developers.openai.com/codex/cli/) with a ChatGPT login

## Install and authenticate

```bash
npm ci
codex login
codex login status
```

Follow the browser flow and choose ChatGPT authentication when prompted. Codex stores authentication in its runtime-local Codex home; this project does not copy or manage those credentials.

## Run locally

```bash
npm start
```

The service listens on `127.0.0.1:3000` by default. Override this with `HOST` and `PORT`:

```bash
HOST=0.0.0.0 PORT=8080 npm start
```

For development with automatic restarts:

```bash
npm run dev
```

## HTTP API

### `GET /healthz`

Returns `200` when Fastify is running and the initialized Codex app-server child connection is healthy. Returns `503` when the child is unavailable.

```bash
curl --silent --show-error http://127.0.0.1:3000/healthz
```

### `GET /usage`

Calls `account/rateLimits/read` and returns the upstream Codex response with minimal transformation.

```bash
curl --silent --show-error http://127.0.0.1:3000/usage
```

Representative example only; values vary by account and time:

```json
{
  "rateLimits": {
    "limitId": "codex",
    "limitName": null,
    "primary": {
      "usedPercent": 25,
      "windowDurationMins": 300,
      "resetsAt": 1760000000
    },
    "secondary": null,
    "credits": {
      "hasCredits": false,
      "unlimited": false,
      "balance": "0"
    },
    "individualLimit": null,
    "spendControlReached": false,
    "planType": "plus",
    "rateLimitReachedType": null
  },
  "rateLimitsByLimitId": {
    "codex": {
      "limitId": "codex",
      "primary": {
        "usedPercent": 25,
        "windowDurationMins": 300,
        "resetsAt": 1760000000
      }
    }
  },
  "rateLimitResetCredits": null
}
```

## Checks and production build

```bash
npm run typecheck
npm test
npm run build
npm run start:prod
```

## Container image

Images published from `main` are available at:

```text
ghcr.io/mwenkdev/codex-usage-service
```

The image includes the Codex CLI but no Codex or ChatGPT credentials. Supply a writable, authenticated Codex home at runtime; never bake `.codex`, `auth.json`, tokens, or other secrets into an image or commit them to the repository.

## Status and limitations

This is an early, intentionally small service. It currently exposes health and rate-limit data, assumes one local authenticated ChatGPT/Codex session, has no API authentication of its own, and does not restart the Codex child after an unexpected exit. Deploy it only on a trusted network or behind an appropriate authenticated proxy.

## License

MIT
