# src/platform AGENTS.md — durable court-evidence platform

This directory is the **real product**: a typed (strict TS), PostgreSQL-backed, content-addressed, job-queued court-record platform. One `CourtService` connects court adapters, PostgreSQL, storage, durable jobs and page-grounded processing. CLI / REST / MCP all share this service.

## Entry points

| File | Purpose |
|---|---|
| `bootstrap.ts` | `createApplication()` — DB pool, adapters, store, `CourtService`, `registerSources()` |
| `service.ts` | `CourtService` — validate → enqueue → execute → reconcile → persist |
| `courtctl.ts` | Commander CLI, JSON output, `HELP` tree |
| `api.ts` | Fastify `/api/v1`, bearer roles, swagger OpenAPI |
| `mcp.ts` | Official MCP SDK stdio server, role-gated tools |
| `worker.ts` | Durable worker: claim → execute → complete/fail, lease heartbeat, `--once`/`--drain` |

## Core modules

| Module | Responsibility |
|---|---|
| `contracts.ts` | `CourtSearchQuerySchema`, `SourceCapabilities`, `CaseObservation`, `DocketEntry`, `DocumentReference`, `CourtSourceAdapter` interface, `SourceError` codes (`blocked|restricted|not_found|retryable|permanent|parse_error|unsupported`), `errorInfo()` |
| `adapters.ts` | `MinnesotaAdapter` (live MCRO), `IndependentFixtureAdapter` (synthetic), `createAdapters()`, ROA legacy mapping `mapRoa()` |
| `interfaces.ts` | `InterfaceService` (Pick of `CourtService`), `Role` (`read|acquire|admin`), `authenticate/authorize/loadApiTokens/resolveMcpRole`, `operations` registry, `invokeOperation()`, `publicError()` |
| `database.ts` | `createDatabase()`, `transaction()` (BEGIN/COMMIT/ROLLBACK, discard terminated sockets), `migrate()` (forward-only, checksum-tracked, advisory lock) |
| `jobs.ts` | `JobQueue` — at-least-once, lease tokens, heartbeats, `claim/complete/fail/retry/cancel`, generations |
| `storage.ts` | `LocalArtifactStore` / `GcsArtifactStore`, content-addressed `sha256/XX/XXXX`, `validatePdf()`, `MAX_ARTIFACT_BYTES=128MiB` |
| `reconcile.ts` | `reconcileObservation()` — partial adds knowledge, absence is not removal; snapshots, entries, participants, proceedings |
| `discovery.ts` | `settleDiscoveryFailures()` — bounded transient recovery (2 generations, 6h/12h backoff), permanent stop until replan |
| `refresh.ts` | `refreshDecision()` — watched/failed/partial/closed/inactive/new/recent/active classes, `scheduleNextRefresh()` |
| `retention.ts` | default-off `retention_policy`, `retention_requests`, `processRetentionRequest()`, artifact deletion fencing |
| `processing.ts` | `processDocument()` — Poppler layout + selective Tesseract OCR, UTF-16 spans, deterministic classification, `llmConfigFromEnv()`, batch planning |
| `processing-runner.ts` | `processInWorker()` — bounded native subprocess execution |
| `processing-thread.ts` | thread/worker boundary for processing |
| `case-interpretation.ts` | optional bounded case inference, opt-in via `COURT_CASE_INTERPRETATION_ENABLED` + `COURT_LLM_ENABLED` |
| `identity.ts` | `eventIdentity()` — source event IDs take precedence; derived hashes never use DOM order |
| `imports.ts` | `importFeed()` — operator-supplied local extract import, never fetches/enables its source |

## Key invariants

- `CourtService.executeJob` is the single execution funnel; every job type (`source_search`, `bulk_search`, `download_artifact`, `refresh_case`, `retention`, `interpret_case`) flows through it.
- Job completion is fenced by lease token; a lost lease prevents persistence (`fence()`).
- Enqueueing a child job and persisting the parent are atomic via `enqueueChild()` + `job_links`.
- Source request budgeting: `reserveSourceRequest()` checks `enabled`, `paused_until`, `min_interval_ms` (15s non-fixture), rechecks after wait (R5 admission race).
- `registerSources()` upserts sources with `enabled=true`; bootstrap never overwrites `enabled` state. Process opt-in (`COURT_ALLOW_LIVE_MN`) is separate and checked in the worker claim allowlist.
- `MAX_BODY_BYTES = 2 MiB`; `MAX_BATCH_QUERIES = 1000` (bulk envelope `max 10000` queries validated individually).
- Pagination: default limit 50, max 100, max offset 100000; envelope `{data, meta:{limit,offset,hasMore}, coverageNote}`.
- `PUBLIC_NOTE`: "Results describe observed records, not an exhaustive court inventory. A database miss does not establish source absence."

## SourceError codes

| Code | Meaning |
|---|---|
| `blocked` | WAF/CAPTCHA/challenge or source administratively disabled/paused |
| `restricted` | Record sealed/restricted |
| `not_found` | Case/document/source absent |
| `retryable` | Transient (ECONNRESET, ETIMEDOUT, 57P03, EACCES, etc.) |
| `permanent` | Non-retryable |
| `parse_error` | Structural/parser failure |
| `unsupported` | Feature/disabled inference |

## Running

```
pnpm typecheck        # tsc --noEmit (strict)
pnpm build            # tsc → dist/
pnpm courtctl         # tsx src/platform/courtctl.ts
pnpm api              # tsx src/platform/api.ts
pnpm mcp              # tsx src/platform/mcp.ts
pnpm worker           # tsx src/platform/worker.ts [--once|--drain]
```

`courtctl doctor` returns rich subsystem discrimination: DB reachability/pool, standalone browser + system Chrome path, CDP bridge limitation, source enablement/pause, credentials presence (without secrets), storage integrity, queue counts, HTTP status, MCP status.

## Before editing

- `xd://lsp` references on every exported symbol you change.
- Read `contracts.ts` for the schema you touch; `adapters.ts` for source-specific validation.
- Migrations are forward-only, checksum-tracked — never edit an applied file; add a new forward migration `####_lower_snake.sql`.
- `src/*.js` is NOT typechecked (`checkJs:false`); only tests guard it.
