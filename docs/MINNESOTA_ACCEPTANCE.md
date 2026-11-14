# Minnesota-first acceptance — 2026-11-14

Controlling milestone: [WO-MCRO-MN-FIRST-001](WO_MN_FIRST_001.md). National dispositions remain in [WORK_ORDER](WORK_ORDER.md); practical commands are in [HANDOFF](HANDOFF.md).

## Three independent labels

| Label | Result | Boundary |
|---|---|---|
| A — LOCAL APPLICATION VERIFIED | **VERIFIED** | Existing-material import, synthetic Minnesota parser-to-database acquisition, durable automation, processing and actual compiled CLI/HTTP/MCP; real PostgreSQL/native tools/browser |
| B — LIVE MINNESOTA VERIFIED | **NOT VERIFIED / BLOCKED** | No permission for new automated MCRO searches/acquisition; no live test performed |
| C — CLOUD OPERATIONS VERIFIED | **NOT VERIFIED / BLOCKED** | Local image/Compose/Terraform checks are not cloud deployment, IAM, scheduled operations or production recovery |

**Minnesota-first local application verified; live collection/cloud operation not yet verified.** No statewide denominator/completeness or WAF immunity is asserted.

## Checkpoint identity and reproducibility

- Repository `/Users/pat/Projects/MCRO-Puller`, branch `refactor/wo-mcro-national-001`.
- Preserved pre-refactor source/test checkpoint `bb88e80`; application committed locally as **`819b512`**, followed by **`e5a1140`** fixing host database restart and adding three focused acceptance regressions. Documentation checkpoint follows; no push/publication. The packaged application source did not change in e5a1140.
- Final tested implementation fingerprint: **`09b8d2d0d76e6904781c91e90a68d1b1eaf5cd1fdfb94b3e9f01ef78a8012847`**. `.runtime/implementation-fingerprint.json` records105 sorted per-path SHA-256 entries covering source, tests, migrations, scripts, package/lock/build/infra configuration, retaining the pre-refactor removed-path `DELETED` marker. Aggregate is SHA-256 of `hash + two spaces + path + newline`. Documentation, secrets, data, generated binaries and Git metadata are excluded. This identifies the implementation tested while dirty and then committed, not a hash of private records.
- Host: macOS25.6 arm64, Node24.22.2, pnpm12.18.0, TypeScript7.0.2, Poppler26.11.0, Tesseract5.5.4, installed Chrome157.0.8103.51. Real isolated embedded PostgreSQL18.6beta; packaged smoke uses PostgreSQL17.
- Local image `court-platform:local`, manifest `sha256:4a5a6db8bb8044732d4f4646d7aeb00ed2649c59dbb80064ee40a7c36b79df46`, image index `sha256:5ccb30d14b11b10a2f782359be62d0c73b2821b1b58b5891e6b2eabb6c51ad08`. Node24.22.2 and packaged Chromium158.0.8127.18. Colima validation VM:2CPU/4GiB, no host mounts.

From a shell configured with the **isolated development database**, not production:

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm build
pnpm accept:mn
node --test infra/tests/*.test.mjs
terraform -chdir=infra init -backend=false
terraform -chdir=infra validate
```

`pnpm dev:database` creates persistent ignored local PostgreSQL and mode-0600 `.runtime/database.env`; source that file without printing it. Browser tests use installed system Chrome on macOS, otherwise install the locked Playwright Chromium. Native requirements and exact launch commands are in HANDOFF. Tests create isolated schemas and temporary copied storage. The acceptance script drops only its own schema/temp directory; originals remain untouched.

## Actual execution evidence

| Command/scenario | Actual result | Evidence |
|---|---|---|
| `pnpm check` | Exit0; **252 passed,0failed,0cancelled,0skipped**; strict TS and legacy syntax passed;17.344s | `.runtime/acceptance-check.log`; supersedes185/248/249 checkpoints |
| `pnpm build` | Exit0 | Final compiler invocation after final runtime/test changes |
| `pnpm accept:mn` | Exit0;17.402s; completed2026-11-14T06:21:54Z | `.runtime/minnesota-acceptance.log`, `.runtime/minnesota-acceptance.json` |
| `node --test infra/tests/*.test.mjs` | Exit0;3passed,0failed/skipped | Infrastructure tests unchanged after that run; retained tool evidence |
| Terraform init/validate | Exit0, Google provider6.50.0, Terraform1.17.2; no apply | Local `.runtime/tools/terraform`, committed provider lock |
| `docker build --progress=plain -t court-platform:local .` | Exit0;181.34s; frozen lock install, production prune and native/browser assets | Image digests above; build tool artifact271 |
| Compose `up -d --no-build --wait`; compiled fixture acquire; one-off `worker --drain` | Exit0;6jobs complete,1case/3events/2documents,1petition text match,2/2artifacts valid | `.runtime/container-acceptance.log` and `.json` |
| Packaged offline Chromium page | Exit0; actual rendered text asserted, no court requests | Container report |
| Compiled original import and worker drain |9PDFs/35pages, all nine current processing runs complete | `.runtime/acceptance-reprocessing.log`, `.runtime/recovery-corpus-report.json` |
| Actual process crash/restart | SIGKILL after committed extraction; explicit lease-expiry fault injection; new worker reuses same extraction; attempts expired→complete | Minnesota acceptance plus `.runtime/recovery-corpus-report.json` |
| Synthetic `pg_dump -Fc` / restore into separate disposable database | Exit0;13migrations,1case,3events,2documents,2pages,6jobs restored;2/2artifact references verify | Container report; restore database removed after proof, original volumes retained |
| `BENCH_REQUESTS=30 BENCH_CONCURRENCY=2 node infra/benchmark.mjs` against local case-search API | Exit0;30successful/0failed;78.004ms total; p50 2.578ms,p95 21.418ms,p99 38.534ms | `.runtime/local-http-capacity.json`; tiny one-case warm/local workload, not production capacity |
| Focused restart/OCR/refresh suites | Exit0;21passed,0failed/skipped;5.713s | `.runtime/focused-final-acceptance.log`; all included again in final252 |
| Preserved host database stop/start | Existing cluster restarted without initdb; compiled `storage verify`:11/11valid | Actual service readiness after fix; isolated restart regression preserves records and credential hashes |

The packaged exercise uses the independent synthetic adapter solely to prove shipped assets/native dependencies. The separate Minnesota acceptance is the Minnesota parser proof. The full suite includes real PostgreSQL failure injection, real Chromium, native PDF/OCR checks,17case-interpretation tests and9retention tests. No mock-only DB substitution or unexplained skip was used.

Two initial Minnesota acceptance attempts stopped because the default Playwright browser was not installed on this host. The harness now selects the same installed Chrome as existing tests; the successful run above is the acceptance evidence. An initial restore-inspection query misspelled `pages` as `document_pages`; the successful restore was retained, inspection corrected, and all restored counts/integrity then verified. Neither issue was suppressed or counted as passing. No application source changed after the final suite/build; subsequent changes are documentation only.

Final handoff restart exposed a real development-script defect: `initialise()` reran initdb against existing nonempty storage. No data was deleted. The script now initializes only when `PG_VERSION` is absent; other access/startup errors remain failures. `development database restart preserves committed records and existing credentials` creates its own real cluster, commits evidence, gracefully stops/restarts it and verifies evidence plus unchanged credential hashes. The preserved application cluster also restarted and verified11objects. This host helper is not in the production image; unchanged packaged-runtime/Minnesota vertical/original-corpus evidence remains applicable. The final252-test suite/build was run after this correction.

Two focused evidence gaps were also closed without runtime feature changes: `one mixed PDF keeps embedded text and selectively OCRs its scanned page with exact provenance` constructs one native-plus-image PDF and verifies page-specific methods/text/chunk spans; `capped discovery persists bounded splits and irreducible gaps across scheduler restart` proves two-day partition splitting, one-day saturation, retained partial cases, unknown denominators, no automatic requeue and no metadata-only refresh. Both passed in the focused and final consolidated runs.

## MN-01 through MN-08

| Criterion | Accepted local evidence | Limitation |
|---|---|---|
| MN-01 Reproducible start | Frozen-lock container build, compiled migrations/CLI/worker/API/MCP, thirteen migrations, authenticated health and native/browser execution | Host requires documented native tools; cloud restricted-role profile not accepted |
| MN-02 Capabilities/queries | Every supported mode validated by `adapter.test.ts`; single idempotent submission; actual JSON/JSONL/CSV batches each retain two valid neighbors and one invalid query; lineage/cancellation/bounds regressions | Synthetic search answers do not prove live portal results; matrix below distinguishes this |
| MN-03 Full observed docket | Production `parseRoa`→`mapRoa` on synthetic Minnesota-shaped HTML→durable worker/PG; two initial events/two attachments, explicit party/counsel/org/judge; reordered refresh adds third documentless event; stable old identities; partial observation retains unseen entries | Unrecognized role labels stay unknown; no inference from a person's name; source-only identity ambiguity remains explicit |
| MN-04 Import/documents | Original nine PDF hashes matched baseline; non-destructive manifest import; immediate immutable artifact checkpoints; replacement retains3versions for2documents; corrupt/missing/restricted/storage/disconnect regressions | Old manifest has no full docket: `docketComplete=false`, acquisition partial; no reconstruction of unobserved events |
| MN-05 Processing | Original35pages:16OCR,18native,1sparse; pipeline4/schema3; corrected SUMMONS/NOTICE; prior runs retained; page/UTF-16 spans and latest-version extraction | Three classifications use filename fallback; confidence not calibrated; advanced OCR/layout and statistical NER recall not claimed |
| MN-06 Interface parity | Actual compiled CLI, authenticated loopback HTTP, official SDK child stdio MCP; matching filing text; real processor citation/classification regressions through shared interfaces;401/403, read-only MCP, authorized PDF, restriction404/error | Local CLI has trusted DB privileges; stdio is not a public network service |
| MN-07 Automation/coverage | Controlled due deadlines, separate discovery/refresh, persisted policy, caps/cursors/gaps, lease/fencing/backoff, actual SIGKILL recovery; R1/R5–R8 below | A currently empty runnable queue is not workflow completion; source budgets/backlog can miss freshness targets; denominator unknown |
| MN-08 Operations | Compiled pause/resume and preserved admin state; exact import/query/status/schedule/retry/replan commands; metrics/integrity; local packaged restore and worker restart | Monitoring is local machine-readable data, not a staffed cloud alerting/on-call service |

### Minnesota capability matrix

All modes are **documented + implemented + validation-fixture-tested**, **not live-tested**, and **gated**. ROA/result parsing uses representative synthetic HTML, not captured proof of every current populated search view. The current form-control inspection did not accept terms or submit searches. Exact required/optional fields and restrictions are in `docs/capabilities-mn.json` and `courtctl source caps --state MN`.

| Mode | Accepted criteria | Local test level / explicit exclusions |
|---|---|---|
| Case / citation-number | Exactly one `caseNumber` or `citationNumber` | Contract validation; no extra filters. Citation-number is not extracted legal authority |
| Document | `caseNumber` | Contract validation and document/ROA fixture pipeline; no unrelated party/date filters |
| Party | First+last, optional middle/soundex, DOB/filed dates, status/category/county | Validated combinations; no empty-name statewide enumeration |
| Business | Business name plus valid soundex/filed/status/category/county filters | Validated combinations, not live result semantics |
| Attorney | Bar number OR first+last/middle, with compatible case filters | Validated alternatives; unsupported mixtures rejected |
| Hearing | Required hearing date; one person/business/case/judge/attorney/bar criterion | Case-number hearing search accepts only hearing-date criteria; malformed/date-error pages never become no-result success |
| Judgment | Person OR business; optional docketed dates/status/county | Validated combinations; not a universal docket/filing-date query |

The200-result cap or unconsumed pagination remains incomplete; an indivisible saturated partition remains a gap. Wildcards need source-supported prefixes; no invented all-record enumeration. The local source subclass in `accept:mn` exists only inside that harness and its disposable schema; it does not grant a production bypass.

## R1–R8 disposition and named regression evidence

All named regressions below passed in the **252-test final run**. Names are abbreviated only where a parameterized suffix is shown explicitly.

| Finding | Change | Regression / result | Residual limit |
|---|---|---|---|
| R1 Terminal discovery deadlock | `discovery.ts`, `service.ts`, migration0012 settle terminal attempts, bounded generations/backoff, explicit replan | `terminal discovery failures stop scheduling and require explicit replanning`; `exhausted transient discovery uses bounded generations and durable backoff`; `expired final discovery lease enters the same bounded recovery path` — pass | At most two automatic recovery generations (6h/12h); permanent/exhausted work requires operator action |
| R2 Citation mismatch | `service.ts` matches actual `reporter_citation`, `case_number`, `statute`, `rule` producers | `stored citation taxonomy and latest filing classification correlate through CLI HTTP and MCP` — pass using real `analyzePages` mentions | Citation extraction is deterministic recognition, not legal authority verification |
| R3 Filing/current extraction | Filing predicates correlate with current document/run; case filters select latest valid current-version run | Same two-document/citation test plus `replacement versions never expose the older version text as current before reprocessing` — pass | A new unprocessed version intentionally has no current searchable text |
| R4 MN roles | `adapters.ts mapRoa` normalizes explicit labels/judicialOfficer, preserves raw evidence | `Minnesota observed participant labels and judicial officer persist searchable roles without inferred organizations` — pass; actual HTML parser→DB acceptance also passed | Ambiguous unlabeled names remain unknown |
| R5 Admission race | `service.ts` rechecks shared state after wait; `search.js` nested-request gate latches block/cancellation | `source disable during reserved wait prevents dispatch`; `source pause during reserved wait prevents dispatch`; `a response block arriving during budget wait prevents the reserved request from continuing`; cancellation/gate tests — pass | Stops are cooperative; no promise to recall a request already dispatched |
| R6 Durable admin/process opt-in | `registerSources` preserves enabled; worker claim allowlist requires its own opt-in; explicit audited source control | `bootstrap preserves durable source administration and process opt-in never claims unauthorized jobs`; `operator source controls persist across bootstraps and enforce administrative HTTP roles` — pass | Administrative enable/opt-in are technical controls, never permission |
| R7 Re-download churn | `reconcile.ts`, `service.ts`, migration0013 fingerprint/revision/deadline checks | `routine refresh skips verified bytes while revision changes and bounded revalidation acquire replacements` — pass;4refreshes/3adapter downloads/3retained versions | Same-ID replacement without trustworthy revision signal waits until revalidation plus next case observation; default168h, bounded1–720h |
| R8 Transient codes | `contracts.ts errorInfo` allowlist preserves `originalCode`; bounded queue retry | `worker classifies ECONNRESET`, `ETIMEDOUT`, `57P03`, `EACCES`, `UNRECOGNIZED_DRIVER_CODE`, `untyped errors` `without losing diagnostic evidence` — six passed | Unknown/permission/untyped errors remain terminal; not every failure is transient |

Other required failure paths are mapped in [FAILURE_MATRIX](FAILURE_MATRIX.md): unexpected layout/no-result confusion, blocked/rate-limited sources, caps, corrupt/blank/mixed PDFs, lease loss/cancel, partial snapshots, replacement/removal/reappearance, storage corruption, rollback and restricted material. Optional interpretation rejects ungrounded spans/citations; no paid inference was used.

## Original corpus and restart provenance

Originals remain in `downloads/67-CV-26-300` and their existing manifests/dossiers; historical session HTML and decoded review artifacts remain preserved outside commits. Nine original PDFs matched recorded SHA-256 and parsed to35pages. Imported case UUID `87bf73bd-837a-461e-809d-c4064f8a9376` remains partial because its legacy manifest never contained the whole observed docket. Copied content-addressed storage is `.runtime/artifacts`; eleven objects (nine originals plus two synthetic files),4,626,440bytes, verified. No purge/retention test used original data.

The current original processing runs completed at2026-11-14T06:07:10–06:07:32Z. The Summons is now SUMMONS; Complaint remains COMPLAINT. Existing earlier runs remain. This evidence applies to the unchanged processing implementation in819b512 and was reused rather than rerunning expensive OCR after source-control-only changes.

Separate real crash proof killed a child after `CHECKPOINT_COMMITTED`, explicitly expired its test lease, then launched the compiled worker. Job `4f29bb62-cdec-4571-bebb-90dc0cd462cf` reused extraction `785d289b-f10a-4ff3-a36d-6bfab8bcd991`; attempts are expired/complete, not duplicate extraction. `accept:mn` repeats the same boundary in its disposable Minnesota fixture schema. Lease expiry is deliberate fault injection, not a claim that a full production lease timeout elapsed naturally.

## Remaining external gates and deferred national work

1. **Live route — Pat/court access decision.** [MCRO landing terms](https://publicaccess.courts.state.mn.us/) observed2026-11-14, revision April2026 clause10(b), prohibit bots/data mining. No terms accepted/search submitted. Obtain a court-approved automated route and its budget/credentials, then authorize a bounded search/acquire/refresh test. Current controls/guides and historical PDFs are not that authorization. No bypass, proxy identity cycling or challenge solver.
2. **Bulk feed — Pat/subscription decision.** [Official bulk-data information](https://mncourts.gov/help-topics/court-statistics/bulk-data) describes weekly subscription extracts with limited populations, not full dockets/PDFs. Local import support exists; no agreement/credentials/feed delivery is present. Obtain an authorized sample/specification before connecting a feed. [FAQ exclusions](https://mncourts.gov/access-case-records/mcro/faqs) and the [200-result guide](https://mncourts.gov/_media/migration/mcro/handout-understanding-mcro-search-results.pdf) prevent a completeness claim.
3. **Cloud — Pat/release operator approval.** Select project/region/owners, release/proxy/COS digests, protected state, secrets, budgets and invocation principals; review plan before any spend/deploy. The smallest supplied topology remains one worker VM, private HA Cloud SQL/GCS and bounded Cloud Run API; no provider substitution. Baseline estimate$280.17/month excludes API/storage/network/backup/etc; see CAPACITY. **Restricted-role SQL profile is not accepted:** `infra/database-roles.sql` predates integrated refresh/retention administrative writes (for example `refresh_policy`, `retention_policy`, `retention_requests`, `retention_events`). Review/update and test dedicated runtime grants before enabling that deployment; local acceptance uses isolated development-owner credentials. GCS physical GC also requires a separately approved custodian permission, absent from shipped worker IAM. No IAM/account changes were made.
4. **Optional inference — Pat/data-governance approval.** Both model and case interpretation opt-ins remain off; no provider/data-sharing/cost permission inferred from OMP configuration. Deterministic processing and search work without it.
5. **Deferred national scope.** Live second-state integration, calibrated OCR/NER accuracy, advanced layout-engine comparison, scaled10k/100k/1m workload benchmarks, source population denominators and production monitoring/PITR/IAM validation remain unaccepted. Existing synthetic adapter, optional modules, harnesses and GCP assets are preserved. They are not prerequisites to local label A.

No remaining known local Minnesota acceptance failure. Do not reopen architecture or add optional features to invalidate this checkpoint; next action is the separately authorized live-access or staging decision, with the specific gates above.
