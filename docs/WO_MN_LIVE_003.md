# WO-MCRO-MN-LIVE-003 — Minnesota Real-Source Integration and Release Proof

**Directive:** Execute in the *existing* Gemini CLI session and repository; this is the next engineering milestone, not a request for another proposal.
**Repository:** /Users/pat/Projects/MCRO-Puller
**Branch:** refactor/wo-mcro-national-001 (verify it)
**Previous milestone:** WO-MCRO-MN-FEASIBILITY-002, 256 reported passing unit/platform tests, 3 infrastructure tests, local `accept:mn` and `feasibility:mn`.
**User intent:** Focus on technical feasibility: make the Minnesota application actually work. Preserve national adapter compatibility and useful modules; do not spend time on another nationwide or policy review.

## 0 — Finish and preserve the previous milestone before implementing new features

1. Review `git status`, current diff, `docs/MINNESOTA_FEASIBILITY.md`, `docs/HANDOFF.md`, and `docs/WO_MN_FEASIBILITY_002.md`.
2. Correct any misleading claim before the commit: the nine-PDF `67-CV-26-300` pipeline was an **authentic previously acquired corpus replay through `GroundedMinnesotaAdapter`**, not fresh live downloads. The live source probe reached the portal and terms modal, but did not demonstrate a live search or PDF acquisition. Clearly preserve both achievements, separately.
3. Run `git diff --check` and ensure no credentials, local session files, raw PDFs, personal corpus contents, .runtime secrets, or unreviewed files are staged.
4. **Yes: stage and commit the scoped WO-002 implementation, tests, and documentation locally**, using the proposed descriptive feasibility commit message. Do not push to GitHub, merge, or deploy. Keep the repo and original assets intact. Record commit hash and exact checks already run. If there are unexpected changes or another writer is active, preserve them and resolve ownership before committing; do not reset.

## 1 — The actual next technical objective

Demonstrate **browser -> real MCRO query -> observed case identity -> complete observed docket -> public document download -> durable PostgreSQL -> original PDF storage -> text extraction -> CLI/REST/MCP -> repeat refresh** using the *real* `MinnesotaAdapter`, not `GroundedMinnesotaAdapter`.

The previous milestone proved a valid local architecture and an isolated standalone Chromium browser. The outstanding question is whether real production paths and selectors work on the current MCRO site once an operator completes any necessary human interaction.

Success must be demonstrated with **newly captured network observations and fresh downloads from the selected court source**. Replaying nine pre-existing PDFs cannot satisfy live acquisition acceptance.

## 2 — First validate/repair only the missing integration seams

Inspect `src/browser.js`, `src/waf.js`, `src/search.js`, `src/roa.js`, `src/downloader.js`, `src/platform/adapters.ts`, `src/platform/{bootstrap,service,worker,courtctl}.ts`, and the current feasibility script.

Work incrementally:

- Verify the standalone Chrome headed/browser options and named isolated storage state are usable from *compiled* CLI and worker entry points.
- Prepare a **human-assisted operator session** that remains isolated from personal Chrome profiles. When the source shows terms/confirmation, `ensureTermsAccepted` clicks acceptance automatically; the operator reviews the page and decides whether to proceed with source work. Never forge consent, evade CAPTCHA/WAF, rotate identities, or borrow unrelated credentials. Preserve a resumable checkpoint. The fact that this is a feasibility experiment does not authorize bypassing source rejection.
- After human completion, save/reuse only that owned session state with restrictive file permissions; show how to inspect status and revoke/remove it safely without leaking tokens.
- Make a small, explicit live test entry point or extend the existing `feasibility:mn` runner with opt-in `--live-adapter`. Offline and replay paths remain the default and never contact live MCRO implicitly. Never switch the entire application into broad crawling.
- Distinguish misconfiguration, operator action pending, source rejection, unexpected page/selector, malformed docket, download expiry, and ordinary networking failures. Log sanitized diagnostics, request counts, page identity, and resulting job states, not cookies or raw tokens.

## 3 — Bounded real-case acceptance ladder

Run the smallest test first. Use a known *verified* public case reference; `67-CV-26-300` is only a **candidate** and may not be currently retrievable. Do not fabricate identifiers or infer availability from stored files.

**Budget:** one browser worker, one case initially; ceiling three known public cases, 15 PDFs total, 150 primary requests, 128 MiB bodies across the pilot; lower limits on rate challenges. Existing cooperative delays and source circuit breakers remain enabled. These ceilings are test stop limits, not an instruction to exhaust them. Stop a source step on a challenge, denial or human confirmation boundary; continue independent local work without bypassing the block.

A. **Navigation and query:** after operator completion where necessary, submit one actual case-number query using the existing implementation; record real result structure, no-result semantics, exact case match, and reproducible source observation.

B. **Docket:** open the matched case and capture *every observed docket event*, including entries without PDFs, dates, statuses, participants, and attachment relationships. Record raw labels and normalized identity. Cross-check against the displayed source snapshot; do not silently omit a section or invent missing data.

C. **Download:** use actual session-bound links and the production downloader to acquire at least one available PDF, then more only if successful and within budget. Validate PDF structure, SHA-256, source linkage, artifact identity, partial/failed outcomes, and immutable storage. No ordinal fallback on ambiguous documents. Capture expiring-link/reacquisition behavior.

D. **Persistence and retrieval:** acquire using the durable PostgreSQL queue and compiled worker, not ad hoc scripts as substitute. Verify source case/docket and document relationships in PostgreSQL, processing, searchable text with page provenance, and retrieval through actual compiled courtctl, authenticated API, and MCP stdio.

E. **Re-observation:** refresh the same observed case; distinguish no-change, new event, existing document, missing document, and source error outcomes. Measure navigation/download counts and confirm the cached docket optimization does not create incorrect identity reuse or stale downloads. Use deterministic replay for hypothetical change cases; do not label replay as live.

F. **Operational resilience:** a bounded failure/restart check on the isolated test resources; verify idempotency, durable checkpoints, source pause/budget propagation, and transparent completion/partial statuses.

## 4 — Search modes and expansion criteria

Do **not** attempt statewide brute-force discovery. First prove the real case-number lookup. Then, if resources remain, exercise one or two source-supported filters using valid grounded inputs. Preserve the seven-mode capability matrix distinguishing **validated**, **fixture replay**, **live tested**, **source unavailable**, and **unsupported**. Record source search result caps and discovery gaps; do not claim comprehensive statewide coverage.

Avoid new second-state adapters, broad speculative features, new UI frameworks, optimization without measured need, paid model inference, cloud provisioning, GitHub push, or production rollout.

## 5 — Engineering methods and evidence

- Use one active writer. No parallel writers on shared code, no new CLI agent or unrelated project.
- Reproduce every newly encountered defect, add a focused failing regression, apply the minimum effective fix, then rerun the specific path.
- Preserve and reuse existing 256-test acceptance evidence for unchanged code. Run a single coherent final check after implementation: `pnpm check`, `pnpm build`, `pnpm accept:mn`, `node --test infra/tests/*.test.mjs`. Default tests must remain offline, using isolated real PostgreSQL where required.
- Collect a machine-readable run report with experiment ID, code hash, environment (without secrets), source URL and time, selected browser mode, operator interventions, budget used, query identity, observed docket-event/document counts, network-download counts, artifact hashes, DB job IDs/status, CLI/API/MCP proof, refresh behavior, failures, and elapsed time.
- Keep records appropriately protected: do not commit live-source raw record contents, PDFs, sessions, tokens, or credentials. Keep original corpus untouched.
- No success claims solely from test count, portal HTTP 200, authenticated replay of previously downloaded files, or a fixture-only adapter.

## 6 — Deliverables and completion gates

Maintain:

- `docs/WO_MN_LIVE_003.md` — this controlling work order.
- `docs/MINNESOTA_LIVE_INTEGRATION.md` — concise experiment log, actual defects/fixes, source versus replay evidence and accepted/blocked states.
- `docs/HANDOFF.md` — exact commands for the human-assisted session, preflight, single-case acquisition, query, re-observation, shutdown and resume.
- `docs/WORK_ORDER.md` — append milestone status, preserving completed and deferred work.
- `.runtime/live-feasibility/<run-id>/` — private, sanitized run report/logs and retained source-derived records where appropriate.

**Gate L1 — Local:** prior replay/import/processing/CLI/API/MCP working on current code.
**Gate L2 — Live source search:** one real current MCRO case search and docket observed through `MinnesotaAdapter`.
**Gate L3 — Live document:** one real public PDF acquired with validated identity into durable storage and made searchable/retrievable through the existing service.
**Gate L4 — Repeatability:** second observation, documented no-change/changes, bounded recovery, and operator runbook.

If the operator gate remains pending, do **not** represent L2–L4 as passed. Complete all independent work, leave the exact test command/session handoff and a single actionable operator step, and stop without creating more architecture work or inventing results.

After a coherent checkpoint, create a scoped local commit for this next milestone only when tests and data handling are sound, and record the commit. Do not push or deploy.

## Immediate instructions

**First** answer the outstanding commit question **YES**, commit the scoped WO-002 work, and correct any ambiguous replay-versus-live language. **Then** execute WO-003 without asking another broad planning question. Focus on an authentic source-to-database vertical slice and concrete fixes. Preserve existing architecture, evidence, resources, and national extensibility.
