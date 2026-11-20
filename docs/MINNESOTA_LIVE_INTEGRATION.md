# Minnesota Real-Source Integration and Release Proof (WO-MCRO-MN-LIVE-003)

**Controlling work order:** [WO_MN_LIVE_003.md](WO_MN_LIVE_003.md)  
**Independent review:** [WO_MN_LIVE_003_REVIEW.md](WO_MN_LIVE_003_REVIEW.md)

## Current acceptance status

The six R003 findings have focused offline regressions and engineering corrections. This correction did **not** navigate to MCRO, submit a live search, download a court document, accept terms, or make cloud changes. Therefore L2–L4 remain **pending**. Offline tests, recorded-source replay, and a portal HTTP 200 do not establish live acceptance.

Prior versions of this log reported live run `a7aadc29` as passing L2/L3. The independent review found that the reported source probe/download did not flow through the durable service, worker, storage, extraction, and interface path. Keep the old run and its artifacts as historical evidence; it does not satisfy the corrected L2/L3 gates and has not been revalidated here. No corpus replay is substituted for a live run.

## Corrections and regression evidence

- **R003-1 — Live opt-in:** `isLiveModeEnabled()` requires both `COURT_ALLOW_LIVE_MN=true` and the explicit `--live`/`--live-adapter` CLI flag. Without both, the runner stays offline. Regression covers all four input combinations.
- **R003-2 — Gate accounting:** zero matches are `no_results`; L2 requires the selected case and a complete matching docket. One downloaded document cannot pass L4; L4 also requires a matching persisted repeat observation and recovery evidence.
- **R003-3 — Durable path:** Live mode selects `MinnesotaAdapter` inside `CourtService`, submits through compiled `courtctl`, and drains the durable worker. The resulting records/artifacts are then checked through CLI, authenticated HTTP, and MCP. Offline replay uses `GroundedMinnesotaAdapter` separately. No fresh live path was exercised in this correction.
- **R003-4 — Stage failures:** Gate evaluation retains a complete successful L2 when later download or extraction work fails. Durable descendant job failures are reported with their stage and typed code rather than relabeled as search blocks.
- **R003-5 — Budgets and retention:** The live worker receives shared limits of 150 source data requests, 15 document reservations, and 128 MiB of document bodies. Over-limit artifacts are not persisted; partial streamed bytes are measured, and later work is stopped when the byte budget is exhausted. Live schemas, artifacts, and sanitized failure/success reports are retained under `.runtime/live-feasibility/<run-id>/`; offline schemas remain disposable.
- **R003-6 — Session readiness:** `pnpm session:mn` is human-assisted. The operator reviews the page and the saved session state; the stored session (including terms cookie) is what gates whether live source work proceeds. The page is checked for dismissed modal, nonempty terms/session cookies, and visible search controls before saving private state. Import/status/live preflight checks required stored cookies; file existence alone is not readiness. Cookie readiness does not prove that a later portal request will succeed.
- **Terms behavior:** `ensureTermsAccepted` clicks acceptance automatically when the modal is present; `COURT_AUTO_ACCEPT_TERMS` is no longer consulted. A visible modal no longer blocks source work.

## Gates

| Gate | Status | Required fresh evidence |
|---|---|---|
| L1 — Local architecture and replay | **Passed offline only** (`bab98b75`) | Nine previously acquired corpus PDFs replayed through the durable worker; CLI/HTTP/MCP retrieval, refresh, and recovery passed. Zero live downloads. |
| L2 — Live source search | **Pending operator gate** | Fresh selected-case search and complete matching docket through `MinnesotaAdapter` and the durable worker. |
| L3 — Live document | **Pending operator gate** | Fresh public PDF, validated identity/hash, durable storage, extraction, and CLI/HTTP/MCP retrieval. |
| L4 — Repeatability | **Pending operator gate** | Matching persisted re-observation, documented change/no-change, bounded recovery, and runbook evidence. |

## Fresh local verification

- `pnpm check`: 273 tests passed; zero failures, cancellations, or skips.
- `pnpm build`: passed.
- `pnpm accept:mn`: synthetic acceptance passed; report marked `liveTraffic: 0`, local workflow passed, live Minnesota not verified.
- `pnpm feasibility:mn`: run `bab98b75` passed with nine corpus-replay PDFs, 9/9 storage integrity, CLI/HTTP/MCP retrieval, refresh, and worker recovery. The live-gate output explicitly says L2–L4 were not evaluated in offline replay.
- `node --test infra/tests/*.test.mjs`: 3/3 passed.
- `pnpm session:mn -- --status`: existing session file is mode `0600`, has nine cookies, and stored-cookie readiness is true. This is not a fresh page-restoration check or proof of source access; no cookie values were emitted.

## Next operator action

1. Start the local PostgreSQL service and load its existing protected environment without printing it. Do not reset or recreate the database.
2. Run `pnpm session:mn`. Review the page yourself; if you choose to accept terms, click in the headed browser. The application does not accept terms or complete challenges for you. Press Enter only after the session page is ready. If no valid session is saved, the live runner stops before source work.
3. After that voluntary browser action, the single bounded live command is `COURT_ALLOW_LIVE_MN=true pnpm live:mn`. It requires the database/session configuration and retains its isolated schema and report. Stop at a block, denial, or human-confirmation prompt; do not retry or rotate identity.

Limits: one worker, at most 150 primary source-data requests, 15 PDFs, and 128 MiB of document bodies. The selected case remains a candidate until the source returns and confirms its identity. Do not treat a no-result as acceptance or exhaust the limits to prove coverage.
