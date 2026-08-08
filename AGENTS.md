# Repository instructions

## Purpose and boundaries

This service exposes Codex/ChatGPT subscription rate-limit information over REST for consumers such as n8n. Keep the REST layer thin. n8n owns scheduling, thresholds, deduplication, and notifications; do not move those concerns into this service. Do not introduce Kubernetes or ArgoCD concerns into application code.

## Architecture

- `src/codex-app-server-client.ts` owns one long-running `codex app-server --stdio` child, JSONL parsing, request ID correlation, timeouts, notifications, errors, and shutdown.
- `src/server.ts` creates Fastify, starts/stops the client, and defines `/healthz` and `/usage`.
- `src/app.ts` is the executable entry point and process-signal handler.
- `src/codex-app-server-client.test.ts` tests the protocol client with fake streams and no real account.

The app-server lifecycle is `initialize` request, correlated response, then `initialized` notification. Requests use numeric IDs; notifications have no ID and must not resolve pending requests. `/usage` calls `account/rateLimits/read`. The child is shared across HTTP requests and must inherit the runtime environment and `CODEX_HOME`.

## Development

```bash
npm ci
npm run dev
npm run typecheck
npm test
npm run build
```

Run typechecking and tests for every change; run the build when production behavior or packaging changes. Prefer minimal dependencies and direct, testable code over unnecessary abstractions.

## Security

Codex/ChatGPT authentication is runtime-local. Never read into source control, copy, log, embed, or commit `.codex`, `auth.json`, `.env` files, tokens, credentials, or environment secrets. Images must contain the Codex CLI but no authentication state.
