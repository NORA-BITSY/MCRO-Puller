# WO-MCRO-MN-FEASIBILITY-002 — Make the Minnesota Application Work

**Owner:** Pat
**Agent:** OMP; continue in the existing MCRO-Puller repository.
**Repository:** `/Users/pat/Projects/MCRO-Puller`
**Branch:** `refactor/wo-mcro-national-001` (verify before edits).
**Starting checkpoint:** `a82917f`, after `819b512` and `e5a1140`.
**Execution:** Authorized local investigation, targeted implementation, and bounded feasibility experiments. Do not stop at an outline.

## Mission and scope

The purpose of this next phase is **technical feasibility and actual application functionality**, starting with Minnesota. The local milestone has already shown a PostgreSQL-backed platform, durable queue, artifact storage, document processing, CLI, HTTP API, MCP, and restart recovery with 252 passing local tests. This is the foundation, not a reason to rebuild.

Now answer the missing engineering question: **Does the actual browser → Minnesota search → full observed docket → downloadable PDFs → database → searchable text/API/MCP → refresh path work using the production application?** Identify the exact broken seams and fix them with minimal changes.

Stay focused on technical mechanics. Do **not** spend this phase re-researching terms, writing another licensing report, redesigning nationwide architecture, introducing new frameworks, building an unrelated UI, adding another state, or expanding optional LLM capabilities.

Preserve existing modular multi-state architecture, original nine PDFs, historical artifacts, PostgreSQL data, migrations, tests, and prior commits. No blanket reset/clean/stash or migration rewriting. Do not push, deploy, spend on cloud/models, change credentials or cloud identity, or start multiple implementation writers.

Keep existing cooperative rate budgets, circuit breakers, source opt-in, and session boundaries. Technical configuration is not itself permission or proof of live feasibility. Stop or pause any source step on denied/challenged/captcha responses, do not evade those controls or change identities; independent fixture/replay/import development proceeds. Do not automatically consent to terms or requirements on Pat's behalf. Do not turn this into an access-policy discussion.

## Stage 0 — Preserve and diagnose (before new coding)

1. Read `docs/HANDOFF.md`, `docs/MINNESOTA_ACCEPTANCE.md`, `docs/WORK_ORDER.md`, and this order. Inspect current Git status, processes, relevant source files, and environment availability.
2. Reuse prior 252-test acceptance evidence for code it actually covers. Do not repeat broad architecture audits or rerun expensive unchanged checks out of habit.
3. Inspect `src/browser.js`, `src/waf.js`, `src/search.js`, `src/roa.js`, `src/downloader.js`, and `src/platform/{adapters,bootstrap,service,worker,contracts}.ts`.
4. Run read-only diagnostics to distinguish: no process opt-in, durable source disabled/paused, browser unavailable, extension bridge missing isolated contexts, request interception unsupported, session state missing, navigation failure, an unexpected source page, or a genuine source block.
5. Establish an **isolated, retained feasibility workspace/schema/artifact prefix**. Never mix test acquisitions with unrelated existing queues. No destructive cleanup of source records.

## MN-F01 — Actual browser transport

- Start with existing Playwright **standalone headed/owned context**, using explicit configuration; inspect whether the application exposes headed/session options through the Minnesota adapter and worker. Add only minimal configuration plumbing if missing.
- Test extension mode only as a separately selected alternative. `createIsolatedExtensionContext()` calls `browser.newContext()`; verify whether the current Playwriter/CDP bridge actually supports this and source request interception. Never silently reuse the person's default tabs/context.
- Verify browser lifecycle: start, navigate, recognize page, surface any terms/human step clearly, close. A user-operated confirmation is a resumable handoff, not an automated bypass.
- Record actual outcomes and sanitized snapshots. Do not claim a configuration flag or prior browser fixture is a fresh live test.

**Acceptance:** a demonstrable isolated transport and exact reproducible invocation, or a precise blocked dependency with component-level regression and independent work finished.

## MN-F02 — One real case through the application

- Start with **one known case**, `67-CV-26-300` only if still publicly retrievable, otherwise a case actually grounded in existing records. Do not invent case IDs.
- Proposed bounded feasibility budget: one worker, no more than 15 PDFs, 128 MiB response bodies, 150 primary source requests, and existing conservative request intervals. Lower the limits based on observed source behavior. No statewide collection.
- Submit via **compiled courtctl + durable queue + production Minnesota adapter**, not a standalone proof-of-concept script.
- Verify exact case identity; capture all observed docket entries including entries without files, multiple attachments, participants, status, and raw source labels.
- Acquire available PDFs in the session-bound flow, verify PDF structure and SHA-256, persist artifacts and checkpoints immediately; mark missing/restricted/failed/budget-limited items explicitly partial.
- Process actual versions with embedded text/selective OCR, then retrieve the case, docket, document text, and provenance through compiled CLI, authenticated HTTP, and real MCP stdio.
- Produce a reconciliation table: source events observed, document references, downloaded, previously verified, restricted, failed, pending, and stored versions. No missing items can be quietly called a success.
- Make smallest necessary fixes with regression fixtures that redact tokens/cookies/private content.

**Acceptance:** a source-observed case flows across all layers with accurate document accounting, or the exact source-dependent boundary is documented while independent local steps are verified. Historic import and synthetic fixtures are distinct evidence, not substitutes.

## MN-F03 — Search and bulk functional proof

- Maintain a concise matrix for case-number, citation-number, party, business, attorney, hearing, judgment, and document modes. Identify each as documented, validated, replay-tested, live-observed, blocked, or unsupported.
- Test a **small representative selection**, not every permutation. Verify fields, required filters, no-results vs parser failure, exact case identity, pagination/caps, and source-specific incompatibilities.
- Demonstrate valid + duplicate + invalid inputs in a mixed query batch, with item-level outcomes, idempotency, and lineage. Reuse existing JSON/JSONL/CSV acceptance evidence where unchanged.
- Test that filing-specific filters match the returned current document extraction rather than another filing in the same case. Distinguish portal citation-number searches from extracted legal citations.

**Acceptance:** single and bulk workflow can be operated and inspected, with known unsupported modes rejected and untested live capabilities labeled accurately.

## MN-F04 — Refresh, efficiency, recovery

- Refresh the known case, compare snapshots, stable IDs, changed/non-document entries, and acquired versions. A no-change live observation is valid, but it does not prove change detection.
- Measure a likely cost center first: the existing `MinnesotaAdapter.fetchDocument()` calls `docket()` for every document. Log actual redundant search/navigation/download requests before optimizing. If material, use a bounded, validated session-level docket reuse with a safe reacquire-on-expiry path; never persist ephemeral download tokens as durable IDs.
- Preserve periodic bounded revalidation for same-ID replacement PDFs. Storage hash dedup alone does not avoid network transfers.
- Use controlled replay to prove added/changed/reordered/removed entries, changed bytes, partial observations, restriction, retries, shared budget pause, and crash/restart. Keep replay results separate from genuine live observations.
- Verify durable scheduling for discovery and refresh independently; retain saturated partitions and unknown population denominators; no silent infinite retries or false statewide-completeness claims.

**Acceptance:** no-change refresh observed with request-count evidence, separate replay-proven change handling, and a reproducible resumed workload after interruption.

## MN-F05 — Deliver an operable application

- Prefer existing `doctor`, scripts, and documented commands. Make readiness discriminate database, browser, source enablement/opt-in, credentials present (not printed), storage, worker health, HTTP, and MCP.
- Add one reproducible `pnpm feasibility:mn` command only if no maintained equivalent exists: default offline/preflight, explicit bounded live mode, uses compiled application services, preserves a machine-readable run report, and cannot accidentally start statewide work.
- Provide exact tested install, migrate, start, single/bulk query, case/docket/text retrieval, worker/queue inspection, source pause, retry/replan, verify, stop, and resume commands. Resolve UUIDs from returned records.
- Keep optional paid inference OFF: deterministic ingestion/extraction/search must work without it.
- Record elapsed time, navigations, requests, retries, source cases/events, bytes, PDF outcomes, processing time, and manual interventions. Tiny samples are feasibility evidence, not large-scale throughput proof.

## Acceptance and evidence discipline

For every defect: reproduce → failing targeted test → minimal implementation → passing test → return to end-to-end run. After two unsuccessful attempts change the hypothesis; do not loop. Do not relax existing regressions or omit required PostgreSQL tests.

Run at the final coherent checkpoint:
```sh
pnpm check
pnpm build
pnpm accept:mn
node --test infra/tests/*.test.mjs
```
Use only the isolated test database and existing native tools. No live source access as a side-effect of default CI/tests.

Classify each claim **live observed**, **human-assisted live**, **recorded-source replay**, **synthetic fixture**, or **imported corpus**. Distinguish **configuration blocked**, **source denied/unavailable**, **implementation bug**, **partial**, and **verified**.

## Deliverables

1. This controlling file `docs/WO_MN_FEASIBILITY_002.md`.
2. `docs/MINNESOTA_FEASIBILITY.md` with MN-F01–F05 criteria, actual results, source transport, browser mode, diagnostics, performance counts, and residual defects.
3. Updated `docs/HANDOFF.md` containing the exact repeatable command, next action, and retained resources.
4. Concise append-only milestone status in existing `docs/WORK_ORDER.md` / acceptance record; preserve previous evidence and national backlog.
5. A retained `.runtime/feasibility/<run-id>/` sanitized report and necessary tests/scripts; avoid Git-committing raw court PDFs, personal content, credentials, or sessions.

Stop when bounded end-to-end feasibility has been demonstrated and independently verified, or when a real external interaction is blocked and **all independent engineering work is complete**. Report which of these is true, and separate live results from local/replay proof. Preserve a scoped local commit/checkpoint under existing approval rules; no remote push, deployment, or idle agent swarm.

**Start from the verified handoff. Perform the smallest genuine browser-to-document experiment. Fix what its evidence reveals. Finish the working application, not another design exercise.**
