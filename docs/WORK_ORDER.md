# WO-MCRO-NATIONAL-001 implementation ledger

Current release boundary: [WO-MCRO-MN-FIRST-001](WO_MN_FIRST_001.md). **Minnesota-first local application verified; live collection/cloud operation not yet verified.** [Acceptance evidence](MINNESOTA_ACCEPTANCE.md) and [operator handoff](HANDOFF.md) control this checkpoint. The national roadmap below remains intact; a local acceptance label does not complete gated or deferred national work.

## Preservation and baseline

Repository: `/Users/pat/Projects/MCRO-Puller`. Active implementation branch: `refactor/wo-mcro-national-001`. Pre-refactor checkpoint: `bb88e80`. This commit preserves the previously uncommitted source and tests; no downloads or session exports were removed. No remote push or production deployment authorized/performed.

Baseline verification: `pnpm run check`: 21/21 tests passed, zero skipped. The test suite does not establish live portal compatibility. Local earlier audit: nine downloaded PDFs matched recorded SHA-256 hashes and parsed to 35 pages; 17 pages below embedded-text threshold. No PostgreSQL server, Docker, or Terraform executable was found on the initial PATH; installing isolated development PostgreSQL tooling rather than changing existing databases.

Full export preserved; inert base64 JSON decoded to ignored `.review/session.jsonl` without executing embedded scripts. Historical consultation reviewed all 1,489 entries: the successful nine-PDF run used in-page FormData fetch → arrayBuffer → base64 (108.72 seconds with 4–7-second pauses). A native click also downloaded an affidavit despite its event waiter timing out. The later page.request.post rewrite had no live proof. Acquisition now restores the demonstrated transport with bounded size and structural validation; this history is not a fresh portal verification.

## Baseline component inventory and dispositions

| Component | Baseline | Decision |
|---|---|---|
| cli.js | Commander search/download/bulk/sync/OCR, local files | Preserve legacy entry; add shared-service courtctl |
| browser/search/roa | Minnesota browser navigation and DOM parsing | Reuse inside source adapter; validate modes, preserve all sections |
| downloader | PDF header checks, row-dependent key, end-of-case manifest | Replace identity/checkpoint/error behavior; structural validation |
| state/sync/queue/statewide | Local JSON, in-memory queue, manual discovery | Preserve import path; canonical PostgreSQL, leases and separate discovery/refresh |
| ocr/nlp/models | Poppler/Tesseract, regex extraction, JSON templates | Reuse extraction, add page spans/evaluation and optional validated inference |
| downloads | Nine case PDFs and legacy manifests/dossiers | Read-only originals; explicit non-destructive migration |
| test | 21 local tests, many browser doubles | Add realistic adapter fixtures, DB integration and fault scenarios |
| dependencies | Browser and commander only | Add strict TS, pg, storage, Fastify and official MCP SDK |

Confirmed baseline defects: lost non-document events; partial acquisition reported success; row-order identities; late checkpoints; inactive substring match; no automatic discovery; missing judgment/hearing modes; regex classification mistakes; no database/API/MCP or deployment. Prior completeness/WAF-immunity claims are rejected. Reuse is conditional on regression evidence, not legacy descriptions.

## Architecture and migration path

New typed platform lives in `src/platform/`. One shared service connects court adapters, PostgreSQL, content-addressed storage, durable jobs and page-grounded processing. CLI/REST/MCP share this service. Raw observations remain source-specific JSON; normalized case/event/document/version records support querying. Original bytes remain immutable. Discovery completeness and acquisition completion are separate.

Migrate schema first into a NEW isolated database. Import legacy manifests without changing source directories. Verify original checksums and inventory counts. Legacy manifests lacking full dockets are explicitly partial; do not infer missing non-document events. Run fixture end-to-end recovery, then limited source validation only where enabled. Cut over scheduling only after reconciliation evidence.

Rollback: stop new workers/API; retain the database and object store; use pre-refactor checkpoint in a separate worktree if needed, never reset this branch or original downloads. Production migrations are checksum-tracked and transactional; restoration uses database backup plus artifact checksums. No destructive migration or production resource provisioning in this work order without approval.

## Work-order task ledger

Each row retains its original ID/dependencies. “Local accepted” means the Minnesota-first non-live boundary only. Remaining live, paid-provider, scaled and production obligations are not marked complete. Exact commands/logs and the eight review dispositions are consolidated in MINNESOTA_ACCEPTANCE.

| ID | Priority | Dependencies | State | Acceptance/evidence target |
|---|---|---|---|---|
| WO-001 | P0 | — | baseline/history verified | bb88e80, 21 baseline tests, complete historical consultation, original PDF integrity |
| WO-002 | P0 | 001 | local accepted; denominator unknown | MN-07: separate observed counts, scoped gaps, availability/freshness/backlog; COVERAGE.md |
| WO-003 | P0 | 001 | local accepted | MN-01/06: shared typed service, adapters, storage and real CLI/HTTP/MCP |
| WO-004 | P0 | 003 | implemented/fixture-tested; live externally blocked | MN-02: per-mode matrix; current controls inspected without accepting terms/searching |
| WO-005 | P0 | 001 | local accepted | MN-03: real MN parser→DB, two initial events/two attachments, documentless addition; raw sections preserved |
| WO-006 | P0 | 004,008,013 | local import/discovery accepted; feeds externally blocked | MN-02/04: structured query batches and original nine PDFs; authorized feed acquisition unavailable |
| WO-007 | P0 | 006 | local accepted; statewide discovery unverified | MN-07/R1: capped splits, irreducible gaps, cursors, bounded recovery/replan |
| WO-008 | P0 | 003 | local accepted; national ontology expansion deferred | Migrations0001–0013, geography constraints/backfill, version/history/provenance; source-specific unmapped data retained |
| WO-009 | P0 | 005,008 | local accepted | MN-03: reorder/add/edit/withdraw/reappear/version, partial/stale observations and rollback |
| WO-010 | P0 | 005 | local accepted | MN-04/07: immediate artifact checkpoints, partial/restricted truth, actual SIGKILL/restart replay |
| WO-011 | P1 | 004 | offline accepted; live externally blocked | R5/R6: Chromium parser, popup/nested-request controls, shared pauses, process opt-in; no bypass |
| WO-012 | P1 | 010 | local accepted; GCS live unverified | MN-04/R7: original nine plus two synthetic objects verified; bounded replacement revalidation |
| WO-013 | P0 | 008 | local accepted | MN-07: real-PG leases/fencing, dependencies, cancellation, diagnostics and bounded retries |
| WO-014 | P1 | 013,022 | local packaging/configuration accepted; cloud externally blocked | MN-01: real container/native/PG packaging; Terraform validation, no apply/deploy |
| WO-015 | P0 | 006,013 | local accepted; live daily freshness unverified | MN-07: persisted adaptive policy, controlled deadlines, independent discovery/refresh and watched cases |
| WO-016 | P1 | 012 | local accepted; advanced-engine accuracy benchmark deferred | MN-05: nine originals/35 pages; 16 OCR,18 native,1 sparse; page spans; no accuracy claim |
| WO-017 | P1 | 016 | local accepted; statistical NER evaluation deferred | MN-05/R2/R3: pipeline4/schema3 original reprocessing; corrected SUMMONS, current filing/citation matching |
| WO-018 | P2 | 016,017 | optional integrated contracts accepted; paid inference blocked | Document plus bounded case interpretation/evidence validation; controlled providers only |
| WO-019 | P1 | 008 | local accepted | MN-06: same database semantics through compiled CLI, actual HTTP and MCP; source search stays queued |
| WO-020 | P1 | 019 | local accepted | MN-06/07: current version/extraction, observation timestamps, freshness and limitations |
| WO-021 | P1 | 019 | local accepted | MN-08: compiled commands for import/query/jobs/source controls/scheduling/integrity/recovery |
| WO-022 | P1 | 019 | local accepted; cloud auth/deployment unverified | MN-06: actual loopback401/403/200, authorized artifacts, OpenAPI and restricted404 |
| WO-023 | P1 | 019 | local accepted | MN-06: official SDK child-process stdio, role visibility, consistent text and restricted errors |
| WO-024 | P1 | 013,019 | local accepted | MN-02: JSON/JSONL/CSV valid neighbors, item errors, idempotency, child lineage, cancellation |
| WO-025 | P1 | 003 | local accepted | Existing versioned adapter contract; unsupported combinations fail explicitly |
| WO-026 | P1 | 025 | independent synthetic proof accepted; live second state deferred | Separate opaque IDs/pagination/docket/attachments reuse unchanged core; not a live state |
| WO-027 | P1 | 008,019 | local accepted; cloud deletion/governance blocked | Nine PG retention tests; default-off withdrawal/purge, fencing, shared-hash GC, original preservation |
| WO-028 | P1 | all | local controls accepted; production assessment remaining | SECURITY.md; role/secret/native limits, safe read projections, no live bypass or paid calls |
| WO-029 | P1 | 013 | local accepted; deployed monitoring blocked | MN-07/08: health, job/source/case/artifact metrics and coverage; external alerts/on-call not configured |
| WO-030 | P1 | 029 | tested local workload measured; scaled/live benchmarks deferred | CAPACITY.md: small fixture/original corpus only; scaled arithmetic and cloud costs explicitly estimates |
| WO-031 | P0 | all | Minnesota local accepted; broader failure campaign deferred/blocked | 252/252, zero failures/skips; actual MN vertical, mixed-page OCR, durable cap gaps, worker/server restart; national gaps retained in FAILURE_MATRIX.md |

## External gates

- Live MCRO enumeration and sustained throughput are unverified. On2026-11-14, its landing terms expressly prohibited bots/data mining (clause10(b), revision April2026). Terms were not accepted and no search submitted. Source access stays disabled pending court authorization; no CAPTCHA bypass or proxy identity cycling.
- Bulk subscriptions/credentials are not present; implement local extract import, not fictitious feed connectivity.
- Production cloud deployment/material spend not authorized; configuration only until approval.
- Optional model inference requires explicit model configuration and credentials; omp's model configuration is not this application's configuration.
- No complete statewide population denominator established. No nationwide completeness claim.

## Latest exercised checkpoint

- `pnpm check`: **252 passed, zero failed/cancelled/skipped**, strict typecheck and legacy syntax check passed;17.344seconds on2026-11-14. `pnpm build`: exit0. This supersedes185/248/249 checkpoints. Application819b512 plus host-restart/test correctione5a1140.
- `pnpm accept:mn`: exit0,17.402 seconds, real Minnesota parser→PostgreSQL→compiled CLI/worker→authenticated HTTP/actual MCP;2→3 docket entries,2 attachments,3 versions, mixed JSON/JSONL/CSV, partial preservation, restriction and actual SIGKILL/restart. Browser network attempts:0.
- Original import/reprocessing:9 unchanged PDFs,35 pages, pipeline`poppler-tesseract-4`/schema3, corrected SUMMONS; prior runs retained. Legacy docket remains incomplete. Eleven copied objects passed integrity verification.
- Final handoff restart found `initdb` being repeated on an existing cluster; fixed initialization to reuse `PG_VERSION`. Actual preserved database resumed with11/11objects valid. New isolated regression stops/restarts real PostgreSQL and verifies committed records/unchanged credential hashes; mixed PDF and persistent saturated-partition regressions also passed.
- Retention, geography, adaptive refresh and optional case interpretation are integrated and included in the final suite, not merely subagent outputs. No external paid provider call.
- Infrastructure tests:3 passed,0failed/skipped; local image/native/real PostgreSQL and Terraform validation evidence is recorded in MINNESOTA_ACCEPTANCE. No cloud apply, live court collection or remote publication.

The next product milestone requires Pat's separate source-access decision, not another local architecture redesign. National items deferred above remain in this ledger. Production deployment also requires reviewed runtime grants, release artifacts, owners/budgets, monitoring and restore evidence; configuration alone is not operations verification.

## Milestone WO-MCRO-MN-FEASIBILITY-002: Technical Feasibility Execution

- Milestone order: [WO-MCRO-MN-FEASIBILITY-002](WO_MN_FEASIBILITY_002.md). Detailed technical report: [MINNESOTA_FEASIBILITY.md](MINNESOTA_FEASIBILITY.md).
- Test baseline: **256 passed, zero failed/cancelled/skipped**; strict typecheck passed; `pnpm test` (256/256), `pnpm accept:mn` (exit 0), `node --test infra/tests/*.test.mjs` (3/3 passed).
- Added `test/feasibility-transport.test.ts` (4 targeted regressions: browser discovery, terms modal consent enforcement, session-level docket reuse metrics, rich subsystem discrimination in `health`).
- Browser transport (MN-F01): Standalone Chromium with installed Google Chrome verified; context isolation and request gating verified; Playwriter CDP extension bridge isolated-context limitation diagnosed (`Target.createBrowserContext` unsupported); live portal probe confirms HTTP 200, title, and Terms modal (`#tcModalContent`); automated terms consent refused on user's behalf per mandate (`ensureTermsAccepted` throws `blocked`).
- End-to-end case acquisition (MN-F02): Authentic grounded case `67-CV-26-300` replayed from `downloads/67-CV-26-300` through `GroundedMinnesotaAdapter` across compiled `courtctl acquire`, durable queue, worker, and artifact storage (9 authentic PDFs verified against ground-truth SHA-256 hashes); text extraction, selective OCR, and chunking completed; verified retrieval across compiled CLI, Fastify HTTP API, and MCP stdio; 100% reconciliation (0 missing, 0 corrupt). Note: these were authentic previously acquired files, not fresh live portal downloads.
- Search and bulk proof (MN-F03): 7 search modes evaluated and documented; mixed bulk query batch (valid + duplicate + invalid) proves item-level error isolation and lineage without neighboring row failure.
- Refresh & recovery (MN-F04): Docket reuse efficiency implemented (`navsAvoided > 0`), eliminating redundant search/navigation cycles in `fetchDocument`; scheduled refresh skips unchanged bytes; worker SIGKILL and lease expiry recovery verified without duplicate artifacts.
- Operability (MN-F05): Rich subsystem readiness in `courtctl doctor`; reproducible `pnpm feasibility:mn` harness verified with retained report `.runtime/feasibility/<run-id>/report.json`.
