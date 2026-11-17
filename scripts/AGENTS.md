# scripts AGENTS.md — maintenance scripts

## Scripts

| Script | Purpose |
|---|---|
| `accept-minnesota.mjs` | Offline acceptance: synthetic Minnesota parser→DB→compiled CLI/worker/HTTP/MCP; disposable schema + temp artifact store; blocks browser network; originals untouched |
| `feasibility-minnesota.mjs` | Offline feasibility harness (MN-F01–F05): readiness, browser transport, corpus replay, OCR, reconciliation, search modes, bulk isolation, refresh/recovery; `--live-adapter` for gated live |
| `session-interactive.mjs` | Isolated headed browser session save/review for MN terms modal; `--status` checks stored-cookie readiness |
| `decodo-provision.mjs` | Provisions sticky US residential proxies (commit 047b0c8 "WAF bypass, sticky proxy pool"); `--check` verifies |
| `dev-database.ts` | `pnpm dev:database` — embedded PostgreSQL on 127.0.0.1:15439, `.runtime/postgres`, `.runtime/database.env` (0600) |
| `import-feed.ts` | Feed import entry point |

## Safety

- `.runtime/*` and `downloads/` are protected: never print/share secrets, never move/rewrite/purge originals.
- Never start a second database process on 15439.
- `accept-minnesota.mjs` is the maintained repeatable vertical/recovery command; temporary smoke/crash scripts were removed after preserving reports.
