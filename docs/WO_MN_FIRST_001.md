# WO-MCRO-MN-FIRST-001 — Finish the Minnesota-first application

Date: 2026-11-14. Owner: Pat.
Repository: `/Users/pat/Projects/MCRO-Puller`.
Branch: `refactor/wo-mcro-national-001`.

## Direction and continuity

This user-authorized milestone supersedes the current release boundary, not the national roadmap or source-policy/approval gates. Finish active acceptance commands before changing course. Continue in the existing session and repository; do not restart architecture or replace the project. Preserve useful work, original downloads/manifests, session exports, modifications, migrations/tests and baseline `bb88e80`. No blanket reset, clean, stash, schema wipe or deletion. Correct or quarantine demonstrated unsafe behavior with a recorded disposition.

Link this milestone from WORK_ORDER and HANDOFF. Retain every national WO ID and label accepted, remaining, externally blocked or deferred honestly. The observed 248-pass, zero-failed/skipped check, compiled CLI/worker/PostgreSQL/HTTP/MCP smoke and nine-original-PDF reprocessing evidence may be reused only for the unchanged implementation tested. Replace stale 185-test status. Do not rerun expensive unchanged checks merely because this milestone arrived.

## Product boundary

Deliver the existing courtctl CLI, authenticated REST API, MCP, worker, PostgreSQL, artifact storage, processing and operations as one usable Minnesota MCRO district-court application. No new browser frontend, state connector, framework or generalized subsystem is required. Retain extensible adapters, source-scoped identities, synthetic second-source tests, deployment assets and useful optional modules.

A user must be able to configure the application, import existing Minnesota material, submit supported single/mixed source queries, inspect durable workflow progress and every observed docket event/available document, search stored material through all three interfaces, schedule refresh and recover interrupted work without silent loss/corruption. Local database search is distinct from queued source acquisition; source citation-number search is distinct from extracted legal citations. Reject unsupported combinations explicitly.

## Independent acceptance labels

- **A — LOCAL APPLICATION VERIFIED:** reproducible non-live workflows, representative Minnesota parser/adapter-to-database fixtures and original corpus pass.
- **B — LIVE MINNESOTA VERIFIED:** a permitted live route actually passes bounded search/acquisition/refresh. Fixtures/history cannot establish this.
- **C — CLOUD OPERATIONS VERIFIED:** an approved deployed system actually runs scheduled work with monitoring, recovery and measured behavior. Docker/Terraform alone cannot establish this.

Complete A independently. B/C remain NOT VERIFIED/BLOCKED until their separate evidence and authority exist; name the smallest next action and responsible decision. No new live MCRO automation/terms acceptance, challenge bypass, identity cycling, paid inference/subscriptions, cloud provisioning/spend, publication/push, account/IAM/credential changes. Runtime opt-in is not permission. Source policy fails closed.

## Minnesota vertical acceptance

| ID | Required outcome |
|---|---|
| MN-01 | Lockfile installation, validated configuration, explicit runtime/native prerequisites, isolated development migrations, exact tested startup commands and working compiled/package assets. Never production tests. |
| MN-02 | Capability matrix distinguishes documented/implemented/fixture-tested/live-tested/unsupported/gated case/document, party/business, attorney, citation-number, hearing and judgment modes with valid filters. Single and mixed JSON/JSONL/CSV submission preserve item errors, neighbors, idempotency, lineage, cancellation and bounded inputs. No invented wildcard enumeration. |
| MN-03 | Actual Minnesota parser output reaches persistence/retrieval: raw observations, documentless events, multiple attachments, identities, explicit participants/roles, dates, provenance and availability. Reorder/add/edit/withdrawal/replacement reconcile safely; partial observations cannot delete unseen events. |
| MN-04 | Original nine PDFs/manifests import without modification; hashes/inventory verified and incomplete legacy docket remains false. Available PDFs are structurally validated, bounded, atomic, content-addressed and checkpointed. Missing/restricted/corrupt/interrupted/unsupported outcomes are explicit. Identical bytes deduplicate; replacements remain discoverable. |
| MN-05 | Embedded text then selective page OCR; exact provenance, current version/latest extraction and versioned reprocessing. Correct original Summons classification; preserve old runs. No paid inference required. Existing interpretation stays gated, evidence-linked and separate from court facts. No new ontology/AI features. |
| MN-06 | Compiled CLI, authenticated HTTP and actual MCP transport share case/docket/document/text/citation/participant semantics, current-filing filters, provenance, freshness, pagination and limitations. Exercise authentication/roles/read-only defaults/artifact safety and withdrawal. |
| MN-07 | Independent discovery/refresh, due scheduling, bounded partitions/caps, durable checkpoints, shared rate/pause, backoff and lease/fencing replay. Terminal partitions recover intentionally without dead-job loops or permanent-error spins. Controlled daily refresh is not live statewide coverage. Report known cases, observed dockets, document availability, freshness, backlog/age, unresolved partitions and unknown denominator separately. |
| MN-08 | Tested launch/capabilities/import/single/bulk/status/case/docket/text/schedule/refresh/source pause-resume/retry-replan/integrity/shutdown-restart commands. Empty runnable queue or complete search stage never implies delayed/paused/descendant/processing work is complete. |

## Eight bounded review findings

Maintain one compact table with code, named regression, actual result and residual limits. Reuse fixes already tested; no broad new audit.

1. R1: terminal discovery/idempotency deadlock — bounded backoff/generation and explicit replan.
2. R2: citation producer/query taxonomy — real case_number/reporter_citation/statute/rule processor-to-query coverage.
3. R3: filing/current-extraction correlation — two documents plus older reclassification cannot select wrong filing.
4. R4: explicit Minnesota party/counsel/judicialOfficer labels through parser-to-database; no inference from names.
5. R5: pause/disable/cancel/block during admission wait prevents dispatch, including nested requests.
6. R6: bootstrap preserves durable administration; non-opted-in processes cannot claim another process's live work.
7. R7: skip needless unchanged downloads with bounded same-ID revalidation; hashes alone do not avoid network traffic; truthful capacity model.
8. R8: recognized transient network/database errors retry within bounds and retain original diagnostics; permission/permanent errors stay terminal/blocked.

Only concrete, reproducible Minnesota-acceptance/data-safety defects may expand work.

## Acceptance execution

Inspect existing exact-code evidence first. Integrate or safely isolate existing geography, retention, adaptive refresh and interpretation; do not discard useful modules to pass. Keep real PostgreSQL credentials private, preserve tests, never weaken/skip required failures, prefer controlled scheduling clocks, and never purge originals/production.

At a coherent unchanged-code checkpoint obtain:

- `pnpm check` and `pnpm build`, zero unexplained failures/skips, real PostgreSQL/Chromium/native checks exercised.
- `node --test infra/tests/*.test.mjs` plus relevant local packaging/container smoke; reuse unchanged image/Terraform evidence, no cloud provisioning.
- Repeatable **Minnesota offline** flow: query/bulk validation → parser/adapter → jobs/database → full docket/storage → processing → CLI/HTTP/MCP retrieval → changed observation/refresh → interrupted recovery. Realistic local fixtures clearly labeled synthetic. Independent adapter proof is not sole Minnesota proof.
- Original integrity/import/versioned reprocessing, documented restart and R1–R8 regression evidence.
- Explicit blocked/partial/truncated/restricted/no-result paths and no live court traffic.

After code changes rerun affected checks and final consolidated suite. Once green, no optional features. Keep exact commands, exits, times/versions, branch/commit and dirty-tree fingerprint, provenance and redacted log paths. Counts are evidence, not completion percentages. Reuse existing smoke commands, adding only the smallest reproducible acceptance command needed.

## Operations and external gates

Finish local health/readiness, bounded concurrency, structured/redacted errors/logs, job/source metrics, storage checks, backup/restore/rollback instructions and conservative tested-workload capacity. Safe isolated recovery where feasible. No million-case benchmark or arbitrary tuning prerequisite.

Preserve GCP assets; identify smallest staging configuration, ownership/configuration, missing deployment evidence and cost model tied to measured workload/unknowns. No provider switch/purchases/apply. Write a concise live access decision from existing primary sources: known routes, scope, missing authority/credentials and next action. Do not invent feed/vendor access or send requests. Live gates must not block local import/query use.

## Deliverables and stopping rule

1. This controlling milestone: `docs/WO_MN_FIRST_001.md`.
2. `docs/WORK_ORDER.md`: reconciled national IDs/backlog mapping.
3. `docs/MINNESOTA_ACCEPTANCE.md`: MN-01–08 and R1–08 evidence, three labels, reproducible commands and limitations.
4. `docs/HANDOFF.md`: start/use/stop/resume, preservation, secret-free schema/storage locations, checkpoint identity, actionable blockers and next authorized milestone.
5. Correct README/API/operations/deployment/capacity docs only where behavior/status changed.

Maintain a short blocker list; continue authorized local work without duplicate reviews/concurrent writers/design churn. After two failed attempts on one blocker, identify cause and change approach/isolate it. Preserve a recoverable checkpoint under Git rules; never blanket-stage records/exports/secrets/databases/unrelated edits, never push. If commit approval is required, retain changes and exact resume instructions.

Stop when A is demonstrably green with handoff, or no authorized local work remains and exact blockers are recorded. If B/C stay gated report: **Minnesota-first local application verified; live collection/cloud operation not yet verified.** Never claim a complete autonomous statewide platform. Preserve the national roadmap for the next milestone.
