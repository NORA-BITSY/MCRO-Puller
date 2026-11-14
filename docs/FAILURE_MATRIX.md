# WO-031 failure acceptance matrix

## Evidence status and execution prerequisites

This records all **38 national-work-order scenarios** in their original order. Final Minnesota-first local checkpoint: **252 passed, zero failed/cancelled/skipped**, real PostgreSQL, Chromium and native tools; strict typecheck/build passed. This supersedes the earlier163-test158-pass/5-fail integration snapshot. All named authored regressions below ran in the final suite. Broader live/cloud/scale gaps remain explicitly partial/deferred, not silently converted to accepted scenarios. Exact commands/evidence are in [MINNESOTA_ACCEPTANCE](MINNESOTA_ACCEPTANCE.md).

`test/platform-failure.test.ts` uses real PostgreSQL, migrations, `CourtService`, `JobQueue`, local content-addressed storage, and Fastify injection against the real service. Each test creates a random schema in `COURT_TEST_DATABASE_URL`, uses a schema-specific connection pool, and drops only that schema. Use a disposable test database with schema creation privileges. The disconnect test terminates **only its own transaction backend**, using `pg_terminate_backend(pg_backend_pid())`; it never terminates another session or restarts the database server. The storage-write fault is a real local filesystem obstruction, not a successful mock write.

Artifact tests require `pdfinfo` on PATH. Their PDF bytes are generated in memory with a complete catalog, page tree, text stream, xref, and trailer. No downloaded user files are copied into fixtures. The independent adapter's checked-in PDFs are explicitly synthetic. Search/text restriction tests deliberately seed extraction rows marked `acceptance-seeded-evidence` / `fixture_seed`; those tests do **not** establish OCR or model correctness. In-flight tests pause a real fixture adapter response; bulk cancellation uses a PostgreSQL trigger to revoke the parent lease and finish its running attempt in the first real child/lineage checkpoint transaction, then asserts later publication is fenced. Neither simulates a real source outage.

F21–F25 cover current-observation ordering, job-result privacy, worker restriction propagation and processing generations. F24 records PostgreSQL transaction IDs through triggers to require document/job/attempt restrictions in one transaction. F25 runs real native extraction with inference disabled, then injects a partial checkpoint: lease recovery reuses it; explicit retry advances generation and extracts again. This is deliberate fault injection, not a naturally defective fixture. All passed in the final252-test run.

The final run exercised required PostgreSQL/Poppler/Tesseract/browser checks with no skips. A later operator run lacking those prerequisites is not equivalent evidence. The final host database regression also starts/stops/restarts its own isolated real cluster and verifies committed records/unchanged credentials; preserved-corpus restart was exercised separately without deletion.

## New PostgreSQL integration test index

All F references below are exact test names in [`test/platform-failure.test.ts`](../test/platform-failure.test.ts).

| Ref | Exact test name |
|---|---|
| F01 | `concurrent duplicate observations retain one case, snapshot, document, and status transition` |
| F02 | `inserted and reordered same-description events preserve identities without spurious versions` |
| F03 | `partial snapshots preserve absent entries, attachments, participants, and proceedings` |
| F04 | `complete disappearance and reappearance retain document bytes and entry history` |
| F05 | `stale observations and duplicate entry identities cannot mutate persisted state` |
| F06 | `status changes, reopening, and court transfer preserve canonical identity and observation history` |
| F07 | `conflicting human case numbers never merge distinct source case identifiers` |
| F08 | `changed bytes under the same filename create versions while byte-identical retries deduplicate` |
| F09 | `storage write failure leaves no successful checkpoint and can resume without duplicate versions` |
| F10 | `database disconnect during artifact checkpoint rolls back and a new service resumes immutable bytes` |
| F11 | `reconciliation interruption rolls back every projection and restart preserves the last committed snapshot` |
| F12 | `SQL migration failure rolls back its ledger and tables before a clean retry` |
| F13 | `restricted cases disappear from service and REST search, text, metadata, and artifact access` |
| F14 | `restriction cancels active case work and closes its durable attempt without allowing a stale completion` |
| F15 | `replacement versions never expose the older version text as current before reprocessing` |
| F16 | `service and REST pagination preserve boundaries, deterministic offsets, and maximum limits` |
| F17 | `mixed bulk input retains valid siblings, item errors, ordering, and idempotent child submissions` |
| F18 | `cancellation during bulk submission stops later children and preserves the committed child` |
| F19 | `cancelled in-flight refresh cannot checkpoint observations or enqueue children after losing its lease` |
| F20 | `expired in-flight refresh cannot checkpoint observations or enqueue children after losing its lease` |
| F21 | `artifact observations select current bytes by source time including a later return to an existing version` |
| F22 | `case restriction redacts completed processing evidence and attempt errors through ancestor job status` |
| F23 | `document restriction redacts completed processing evidence and attempt errors through ancestor job status` |
| F24 | `worker source restriction atomically withdraws a previously complete document and preserves its bytes` |
| F25 | `manual retry reprocesses a partial checkpoint while automatic retry reuses its generation` |

Existing-suite abbreviations used below:

- **DB**: [`test/platform-database.test.ts`](../test/platform-database.test.ts)
- **ACQ**: [`test/acquisition-regressions.test.js`](../test/acquisition-regressions.test.js)
- **ADAPTER**: [`test/adapter.test.ts`](../test/adapter.test.ts)
- **SEARCH**: [`test/search.test.js`](../test/search.test.js)
- **STATEWIDE**: [`test/statewide.test.js`](../test/statewide.test.js)
- **STORE**: [`test/platform-storage.test.ts`](../test/platform-storage.test.ts)
- **OCR**: [`test/ocr.test.js`](../test/ocr.test.js)
- **NLP**: [`test/nlp.test.js`](../test/nlp.test.js)
- **PROCESS**: [`test/processing.test.ts`](../test/processing.test.ts)
- **PROCESS-API**: [`test/platform-processing.test.ts`](../test/platform-processing.test.ts)

## Original 38 scenarios

“Local” means the named deterministic behavior passed in the final suite or documented smoke. “Partial” means narrower demonstrated coverage, with the remaining gap stated. “Gap” means an unimplemented broader national scenario, explicitly deferred outside this Minnesota-first release when indicated—not fabricated coverage or an invented external prerequisite.

| WO-031 | Original scenario | Exact implemented mapping | Scope and remaining gap |
|---|---|---|---|
| 01 | Browser crash during document download | ACQ: `a process crash resumes from its last artifact checkpoint and reclaims its lock` | **Partial.** Kills an actual child Node process at its second fixture request and asserts one remaining download on resume. No Chromium renderer crash, browser disconnection, or interrupted live download stream is exercised. |
| 02 | Database disconnect during checkpoint | F10; `development database restart preserves committed records and existing credentials` | **Local.** Own transaction backend termination rolls SQL back while immutable bytes survive. Separate real-cluster clean stop/start retains committed records and credentials. Abrupt database-server failover/PITR remains unexercised. |
| 03 | Object-storage write failure | F09 | **Local / external gap.** A real local-store directory obstruction prevents a checkpoint; retry succeeds without duplicate versions. GCS permission, network, quota, and partial-upload faults remain unexercised; no cloud resources were provisioned. |
| 04 | Duplicate jobs | DB: `enqueue deduplicates concurrent requests and rejects conflicting idempotency reuse`; F17 | **Local.** Concurrent enqueue and conflicting-key rejection are already covered by DB; F17 adds repeated real bulk submission execution with exactly two valid child jobs. No duplicate queue-fault test was added. |
| 05 | Concurrent workers on one case | F01; ACQ: `per-case exclusion serializes concurrent acquisition and skips duplicate requests` | **Local.** Concurrent PostgreSQL observations yield one case/snapshot/version and acquisition test retains one artifact request. The PostgreSQL case test uses concurrent clients, not separate worker OS processes. |
| 06 | Lease expiration | F20; DB: `leases fence stale owners, heartbeat live claims, and durably record expiration`; DB: `expired final attempts dead-letter rather than executing beyond the budget` | **Local.** Queue transitions/history already have direct tests. F20 additionally rejects a late fixture response after another worker has reclaimed the lease, with no case writes or download children. |
| 07 | Rate-limit response | ACQ: `HTTP 429 is a typed source-wide block`; ACQ: `artifact checkpoint precedes next request and blocked run resumes without redownload`; DB: `retries respect retry-after and stop permanently at max attempts` | **Partial.** Injected HTTP status and real durable retry deadlines/checkpoints; no live source throttling or distributed HTTP retry-after measurement. |
| 08 | Source challenge | SEARCH: `WAF indicators are surfaced as a hard block`; ACQ: `queue pauses source-wide challenges and durably retains pending work`; DB: `blocked errors pause the shared source and restrictions are never automatically retried` | **Partial.** Fixture challenge detection, durable pending work, and shared source pause are asserted. No live challenge bypass or live challenge collection is attempted. |
| 09 | Unexpected portal layout | SEARCH unrecognized-page regression; DOM `unrecognized and validation-error pages are not no-result observations` | **Local / live gap.** Real offline Chromium receives malformed/source-validation HTML and fails closed; changed live portal traversal remains gated. |
| 10 | Empty result caused by parsing failure | DOM validation-error and `explicit no-results source notice is retained` tests | **Local / live gap.** Actual source-shaped DOM distinguishes explicit no-results from parser/validation failure; not every possible portal variant is established. |
| 11 | Search-result cap | DOM `search cap notice remains incomplete evidence`; `capped discovery persists bounded splits and irreducible gaps across scheduler restart` | **Local / population gap.** Cap notice remains incomplete; actual PG parent splits into bounded child dates and preserves observations. No live denominator claim. |
| 12 | Non-divisible saturated partition | Same durable capped-discovery regression; STATEWIDE one-day-cap regression | **Local.** One-day children persist as saturated with null deadlines; coverage remains truncated/unknown denominator, repeated scheduler does not spin, duplicate candidates deduplicate. |
| 13 | Deleted source document | F04 | **Local.** A complete snapshot removes public visibility without destroying stored artifact/version history; reappearance reuses identities. A source HTTP 404 without a complete docket is a separate, unexercised adapter fault. |
| 14 | Replaced document same filename | F08, F15, F21; ACQ: `a changed PDF version never overwrites its prior immutable artifact` | **Local.** Real PDF byte changes create distinct hashes/versions with the same filename. Byte-identical retries deduplicate. A late older observation cannot replace current bytes; an actually newer return to earlier bytes reuses their version, retaining two versions and all three observation attempts. Old extracted text cannot masquerade as an unprocessed replacement. |
| 15 | Same description twice | F02; ACQ: `indistinguishable rows are explicitly ambiguous rather than overwritten or fetched` | **Local.** Distinct source IDs with identical descriptions remain distinct; genuinely indistinguishable legacy rows are not silently merged. |
| 16 | New event inserted beginning | F02 | **Local.** Inserts a non-document event before existing events; previous IDs and versions survive. |
| 17 | Docket event reordered | F02 | **Local.** Source-order changes record `reordered`, not a duplicate entry or spurious content version. |
| 18 | New non-document event | F02; ACQ: `all docket rows and sanitized sections survive immutable snapshot history` | **Local.** New non-document event persists and is queryable without a manufactured document row. |
| 19 | Case status changes | F06; ACQ: `Inactive is not active and blocked case state is never complete` | **Local.** Ordered status history persists; inactive normalization and blocked-state truthfulness have separate regressions. |
| 20 | Reopened case | F06 | **Partial.** Active → Closed → Active keeps the same canonical case and all status observations. Long-term scheduler reactivation/cadence after reopening is not directly tested. |
| 21 | Corrupt PDF | STORE: `header-only PDF is rejected by structural parser`; ACQ: `a malformed PDF yields error rather than complete with zero documents`; OCR: `malformed PDF fails explicitly rather than becoming a blank document` | **Local.** Structural failure cannot become a successful empty document. Does not cover every malformed/encrypted PDF or parser security exploit. |
| 22 | Valid PDF blank pages | OCR: `successful empty OCR is distinguished from extraction failure`; PROCESS: `page failures are partial while genuine blanks are successful` | **Local, tools required.** Generated blank page is distinguished from a failed page. OCR test can skip without Poppler/Tesseract; a skip is not acceptance. |
| 23 | Mixed searchable/scanned PDF | `one mixed PDF keeps embedded text and selectively OCRs its scanned page with exact provenance` | **Local.** One generated two-page PDF contains native text plus a rendered image-only page. Real Poppler/Tesseract preserves native page1, OCRs page2, keeps content separate and verifies chunk/page offsets. No user PDF mutation or paid inference. |
| 24 | OCR misclassification | NLP heading/caption regressions; versioned original-corpus reprocessing | **Partial.** Original Summons corrected to SUMMONS and scanned Complaint remains COMPLAINT; real mixed-page OCR also passed. No statistical OCR-noise/classifier accuracy benchmark is claimed. |
| 25 | LLM hallucinated citation | PROCESS: `interpretation rejects invented evidence, unknown fields, and citation promotion`; PROCESS-API: `citations cannot be invented beside a genuine neighboring quote` | **Partial.** Strict output/evidence validation rejects supplied invented evidence, citation promotion, and invented citations paired with a genuine neighboring quote. No actual model response, provider outage, or hallucination-rate evaluation was run by this agent. |
| 26 | Prompt injection inside filing | PROCESS-API: `controlled local API returns exact global offsets and receives untrusted instructions as data` | **Partial.** A controlled loopback API asserts the untrusted-input instruction and receives adversarial page text as data while returning fixture evidence spans. This does not establish resistance by an actual model; real-provider adversarial evaluation requires explicit model configuration and credentials. |
| 27 | Source outage multiple days | DB: `retries respect retry-after and stop permanently at max attempts`; DB: `source budgets apply after completion, pauses and disabled sources prevent claims` | **Partial.** Durable bounded retry/pause mechanics are tested, not a simulated multi-day source outage, recovery scheduling, or sustained operational availability. |
| 28 | Backlog exceeds daily capacity | None | **Gap.** No arrival/service-rate simulation or measured backlog/latency acceptance test was identified. Queue metrics and capacity formulas are not throughput evidence. A local load test is possible; sustained live capacity requires authorization and source access. |
| 29 | Inconsistent source timestamps | F05, F21 | **Partial.** An older case observation is refused atomically without regressing current title/status/history. An older artifact observed first but committed late is preserved without replacing newer current bytes. Equal-timestamp conflicts, future clock skew, and ambiguous source time zones are not exercised. |
| 30 | Partial source data | F03 | **Local.** Missing rows in a partial snapshot cannot remove prior entries/documents/participants/proceedings; snapshot and acquisition completion remain explicitly partial. |
| 31 | Case transfers between courts | F06 | **Partial.** A changed court label under a stable authoritative source case ID retains one case and old court observations. Cross-source transfers or changed authoritative IDs are not reconciled by this test. |
| 32 | Conflicting case identifiers | F07; F05; ACQ: `output paths and ROA identities fail closed` | **Partial.** Human case-number collisions do not merge distinct source case IDs; duplicate entry identities are rejected; wrong legacy docket identities fail closed. Source reassignment of an existing authoritative case ID is not resolved by these tests. |
| 33 | Invalid batch input | F17 | **Local.** Invalid item remains indexed with an error while valid siblings get durable jobs; replay does not duplicate them; REST uses the same per-item behavior rather than rejecting all siblings. Submission stage is partial while the overall workflow remains pending with its two queued child jobs. |
| 34 | Cancellation during bulk acquisition | F18–F20/F14; DB `cancellation follows workflow descendants through duplicate paths and cycles while preserving completed stages` | **Local / live gap.** Transaction-trigger cancellation preserves committed child lineage and fences later publication; recursive cancellation, duplicate paths/cycles and stale completions are tested. Interrupted live browser transfer remains gated. |
| 35 | Restart after partial reconciliation | F11/F10/F25; actual MN SIGKILL/restart; development database restart regression | **Local / production gap.** Reconciliation rolls back all projections, artifact bytes survive disconnect, worker kill after committed extraction reuses the checkpoint, and clean database-server restart retains committed rows. Cloud failover/production-container outage is not established. |
| 36 | Schema migration failure | F12; DB: `migrations are concurrent-safe, idempotent, and reject checksum drift` | **Local.** A real conflicting table causes SQL migration failure without a partial ledger/schema, then succeeds after removing only the test obstruction. Existing DB tests cover concurrency and checksum drift. No production upgrade/downgrade was attempted. |
| 37 | Storage checksum mismatch | STORE: `immutable storage survives retries and detects corrupt bytes` | **Local / external gap.** On-disk corruption rejects reads and retry overwrites. GCS corruption/precondition behavior and database inventory verification against a corrupt cloud object remain unexercised. |
| 38 | Inaccessible or newly restricted source material | F13, F14, F22–F24; ADAPTER: `fixture restricted artifacts and cancellation remain observable`; DB: `blocked errors pause the shared source and restrictions are never automatically retried` | **Local / live gap.** Local restrictions gate search, text, metadata, bytes, reingestion, completed processing result evidence, and historical attempt errors, including ancestor workflow results. A fixture adapter raises a source restriction through real `runOne`; transaction-ID assertions require prior-complete document access/status, job state, and attempt history to change atomically while bytes remain stored. Actual live access-policy changes and source case-level restriction propagation remain unexercised here. |

## Additional boundary acceptance

F16 tests actual PostgreSQL-backed service and REST pagination: default 50, maximum 100, 103-row page boundaries, deterministic unchanged-data offsets, no duplicates across pages, and rejection of zero/oversized/fractional/non-numeric limits and invalid offsets. It covers case/docket/text/coverage query boundaries and rejects service bypasses. It does not promise offset consistency under concurrent inserts.

F17/F18 and F19/F20 extend existing queue tests at service side-effect boundaries; they do not duplicate the DB suite's generic heartbeat, retry, cancellation, source-budget, or idempotency unit scenarios.

## Integrated finding dispositions

The earlier static integration checklist is resolved by the final passing regressions:

- `restrictCase` finishes active durable attempts (F14).
- Current document version is selected before latest valid extraction; old text cannot satisfy replacement queries (F15/R3).
- Lease/cancellation fencing guards post-fetch writes and bulk child submission (F18–F20).
- Complete removals use explicit schema states; identity/version history survives reappearance and rollback (F04/F11).
- Bulk item errors retain valid neighbors while the envelope remains bounded (F17).

R1–R8, optional retention/case interpretation, source administration and their exact evidence are consolidated in MINNESOTA_ACCEPTANCE. National backlog-over-capacity/multi-day operational and actual cloud/source scenarios remain deferred or gated; they are not prerequisites invented after the local release checkpoint.

No all-scenarios-passed, statewide-complete, model-safe, source-outage-resilient, or cloud-production-ready claim follows from this matrix.
