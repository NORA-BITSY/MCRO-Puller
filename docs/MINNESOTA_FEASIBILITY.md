# Minnesota Technical Feasibility Report (WO-MCRO-MN-FEASIBILITY-002)

**Milestone:** WO-MCRO-MN-FEASIBILITY-002 — Technical Feasibility & Operable Minnesota Application  
**Branch:** `refactor/wo-mcro-national-001`  
**Starting Checkpoint:** `a82917f`  
**Feasibility Run IDs:** `bbba817e` (offline/preflight), `a7e8940a` (live portal probe)  
**Test Suite Baseline:** 256 passing unit and platform tests (including 4 new feasibility transport regressions)  

---

## Executive Summary

This milestone establishes the working technical feasibility of the Minnesota court records application across all architectural tiers: compiled CLI (`dist/src/platform/courtctl.js`), durable PostgreSQL worker queue, authenticated REST HTTP API, and standard Model Context Protocol (MCP) child-process stdio interface.

The implementation proves that:
1. **Isolated browser transport** works in Playwright standalone mode using the host's installed Google Chrome binary (`/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`), supporting isolated browser contexts and cooperative source request interception.
2. **Playwriter CDP extension bridge** cannot create isolated browser contexts (`Protocol error: Target.createBrowserContext unsupported`), confirming that standalone mode is mandatory for source request interception and user tab isolation.
3. **Live portal probe** to `https://publicaccess.courts.state.mn.us/CaseSearch` confirms HTTP 200 availability and detects the Terms and Conditions modal (`#tcModalContent`, `#tcModalAcceptBtn`). In accordance with work order mandates, automated consent is refused on the user's behalf without explicit operator authorization, establishing a verifiable human-in-the-loop confirmation gate (`terms_required` / `blocked`).
4. **Authentic grounded case `67-CV-26-300`** executes end-to-end across all layers: durable enqueue, worker claims, docket reconciliation, artifact verification replayed from the existing authentic corpus (`downloads/67-CV-26-300`, 9 authentic PDFs verified by SHA-256), text extraction/selective OCR, and multi-interface retrieval (CLI, REST, MCP). Note: this validates pipeline processing and integrity using authentic records; it does not represent fresh live portal downloads.
5. **Efficiency optimizations** eliminate redundant search and navigation in `MinnesotaAdapter.fetchDocument()` via session-level docket caching (`navsAvoided > 0`), with safe reacquisition on expiry.
6. **Application operability** is packaged in `courtctl doctor` (with rich subsystem discrimination) and the reproducible `pnpm feasibility:mn` command.

---

## Evidence Classification

| Evidence Type | Scope in Milestone |
|---|---|
| **Live Observed** | Standalone browser transport navigation to `https://publicaccess.courts.state.mn.us/CaseSearch`; HTTP 200 response; Terms & Conditions modal `#tcModalContent` detection. (Did not execute search or PDF acquisition on live portal). |
| **Human-Assisted / Blocked Boundary** | MCRO Terms & Conditions modal requires operator acknowledgment. Automated click is blocked by default (`COURT_AUTO_ACCEPT_TERMS !== 'true'`) to protect user consent. |
| **Recorded-Source Replay** | Authentic case `67-CV-26-300` and its 9 genuine court PDFs from `downloads/67-CV-26-300` replayed through `GroundedMinnesotaAdapter`, production `mapRoa`, and worker pipeline. |
| **Synthetic Fixture** | Independent synthetic court fixture (`independent-fixture`) and error injection tests for crash recovery, lease expiry, and network fault classification. |

---

## Detailed Evaluation by Work Order Requirement

### MN-F01 — Browser Transport & Lifecycle

- **Standalone Mode (Verified):**
  - Added `findSystemChrome()` in `src/browser.js` with fallback discovery (`COURT_CHROME_BIN`, `CHROME_BIN`, macOS Google Chrome path, Linux paths).
  - Plumbed `headed`, `sessionPath`, and `executablePath` through `MinnesotaAdapter`, `createAdapters`, and `createApplication`.
  - Context isolation verified: creates isolated `browser.newContext({ serviceWorkers: 'block', acceptDownloads: true })`.
  - Source request gate verified: installs `context.route('**/*', ...)` to intercept and throttle outbound traffic without leaking into other contexts.
- **Extension Mode (Diagnosed as Unsupported for Isolation):**
  - Tested Playwriter CDP bridge connection.
  - Attempting `browser.newContext()` on the CDP extension connection fails with:
    `Protocol error (Target.createBrowserContext): No tab found for method Target.createBrowserContext sessionId: undefined params: {"disposeOnDetach":true}`
  - Because extension mode cannot isolate contexts, reusing the user's default browser context is strictly prohibited. Standalone mode is enforced.
- **Live Portal Probe & Human Confirmation Boundary:**
  - Navigated to `https://publicaccess.courts.state.mn.us/CaseSearch`:
    - Status: HTTP 200
    - Title: `Case Search - Minnesota Court Records Online (MCRO)`
    - Modal: `#tcModalContent` detected with `#tcModalAcceptBtn` ("Yes, I Accept")
    - Text: *"Required Acknowledgment for Minnesota Court Records Online ('MCRO'). Users must read and accept the following Terms and Conditions..."*
  - Enforced mandate: `ensureTermsAccepted` throws `{ code: 'blocked' }` with message `Minnesota Court Records Online Terms and Conditions modal detected; operator review and confirmation required (refusing automated terms acceptance on user's behalf)` unless `COURT_AUTO_ACCEPT_TERMS=true` is explicitly configured. Live search and live document downloads were not submitted pending operator authorization.

### MN-F02 — Grounded Case Replay Pipeline (`67-CV-26-300`)

- **Pipeline Execution:**
  - Case `67-CV-26-300` submitted via compiled `courtctl acquire --query '{"sourceId":"mn-mcro","searchType":"case","caseNumber":"67-CV-26-300"}'`.
  - Replayed through `GroundedMinnesotaAdapter` using authentic previously acquired files in `downloads/67-CV-26-300`.
  - Enqueued in durable PostgreSQL `jobs` table with deduplication key.
  - Worker drained 20 tasks:
    - 1 `source_search`
    - 1 `refresh_case`
    - 9 `download_artifact` (replaying authentic files from disk)
    - 9 `process_document` (embedded text extraction + OCR + NLP chunking)
- **Artifact Verification:**
  - All 9 authentic PDFs verified against ground truth SHA-256 hashes from `docket-export-index.json`.
  - Saved to isolated artifact storage; validated by `courtctl storage verify` (9 checked, 9 valid, 0 failures).
- **Interface Retrieval:**
  - **Compiled CLI:** `courtctl db search --state MN`, `courtctl case docket <id>`, `courtctl document text <id>`.
  - **Authenticated HTTP:** `GET /api/v1/cases`, `GET /api/v1/cases/:id/docket`, `GET /api/v1/documents/:id/content` (served HTTP 200 with `%PDF` bytes).
  - **MCP Stdio Server:** `get_case`, `get_case_docket`, `get_document_text` invoked via `@modelcontextprotocol/sdk` child process.

#### Reconciliation Table

| Category | Count | Status | Notes |
|---|---|---|---|
| **Source Events Observed** | 10 | Complete | 9 document events + 1 procedural hearing event |
| **Document References** | 9 | Complete | Summons, Complaint, Affidavits, Notices |
| **Replayed Authentic Artifacts** | 9 | Verified | Loaded from `downloads/67-CV-26-300`; SHA-256 matched |
| **Previously Verified** | 0 | Expected | Fresh run in isolated schema |
| **Restricted Documents** | 0 | Verified | All 9 public filings available |
| **Failed Acquisitions** | 0 | None | Zero failed downloads |
| **Pending Acquisitions** | 0 | None | All tasks drained to final status |
| **Stored Document Versions** | 9 | Active | Linked to `current_version_id` in DB |
| **Storage Integrity Failures** | 0 | Verified | `courtctl storage verify` 100% clean |

### MN-F03 — Search Modes Matrix & Bulk Query Proof

#### Search Modes Matrix

| Search Mode | Verified Query Fields | Status Classification | Notes |
|---|---|---|---|
| **case** | `caseNumber`, `citationNumber` | **Replay-Tested** | Tested against `67-CV-26-300`; validated format |
| **party** | `lastName`, `firstName`, `dobFrom`, `dobTo` | **Replay-Tested** | Tested with candidate mapping; omits pending criminal |
| **business** | `businessName` | **Validated** | Schema & source capability verified |
| **attorney** | `barNumber`, `attorneyLastName`, `attorneyFirstName` | **Validated** | Schema & source capability verified |
| **hearing** | `hearingFrom`, `hearingTo`, `judgeName` | **Validated** | Requires hearing date range per SCAO guide |
| **judgment** | `businessName`, `debtor`, `judgmentStatus` | **Validated** | Requires debtor name or business |
| **document** | `caseNumber` | **Replay-Tested** | Matches case documents; limits to public filings |

#### Mixed Bulk Query Verification
Submitted batch containing valid, duplicate, and invalid queries:
1. Valid case query (`67-CV-26-300`) -> Validated and processed
2. Duplicate case query -> Idempotent deduplication
3. Malformed query (`INVALID_NUMBER_FORMAT!@#`) -> Rejected at item validation with specific error
Outcome: Batch status `partial`, valid neighbors isolated and completed, lineage preserved.

### MN-F04 — Refresh, Efficiency & Recovery

- **Docket Reuse Efficiency:**
  - Before: `MinnesotaAdapter.fetchDocument()` executed search and ViewCaseDetails navigation for every single document (18 page loads for 9 documents).
  - After: `MinnesotaAdapter` caches active docket at session level (`this.cachedRoa`). Subsequent `fetchDocument` calls reuse the active case page, avoiding redundant searches and navigations.
  - Safe reacquire: If document token expires or form submission fails, cache invalidates and fresh docket is re-navigated automatically.
- **Refresh & Change Detection:**
  - Scheduled refresh triggered via `courtctl schedule due`.
  - Re-observation verified unchanged documents skip redownloading, preserving version immutability and artifact hash deduplication.
- **Crash Recovery:**
  - Enqueued `process_document` task.
  - Subprocess started and committed initial checkpoint, then killed via `SIGKILL`.
  - Lease expired in database.
  - Recovery worker claimed expired job and completed without duplicating rows or re-downloading files.

### MN-F05 — Operability & Subsystem Readiness

- **Subsystem Discrimination in `courtctl doctor`:**
  - Database: connection reachability, pool metrics (total, idle, waiting).
  - Browser: mode (`standalone`), headed status, system Chrome path, extension bridge limitation explanation.
  - Sources: durable enablement status, process opt-in status (`COURT_ALLOW_LIVE_MN`), pause timestamps, live readiness.
  - Credentials: presence check (`present: true/false`) for API tokens, DB URL, and session file **without printing secrets**.
  - Storage: health check verifying write/read/delete lifecycle on storage target.
  - Worker: active/queued job counts.
  - HTTP & MCP: service configuration status.
- **Command Entrypoint (`pnpm feasibility:mn`):**
  - Added `"feasibility:mn": "node scripts/feasibility-minnesota.mjs"` to `package.json`.
  - Isolated schema execution: generates unique `mn_feasibility_<runId>` schema, migrates, executes suite, and cleans up.
  - Produces machine-readable `.runtime/feasibility/<run-id>/report.json`.

---

## Residual Defects & Technical Gaps

1. **Live Source Access Gate:**
   - MCRO terms of service modal requires human acknowledgment. Automated bot bypass is prohibited by design.
   - Operating against the live portal requires either (a) an interactive headed session where the operator accepts terms and saves `~/.mcro-puller/session.json`, or (b) court authorization for automated programmatic access.
2. **Playwriter CDP Extension Bridge:**
   - Chrome DevTools Protocol extension bridge does not support `Target.createBrowserContext`. Consequently, extension mode cannot provide isolated contexts for multi-worker or background execution. Standalone Playwright Chrome is the supported transport.

---

## Verification Artifacts

- Feasibility Run Report: `.runtime/feasibility/a7e8940a/report.json`
- Feasibility Script: `scripts/feasibility-minnesota.mjs`
- Regression Test Suite: `test/feasibility-transport.test.ts`
- Total Passing Tests: 256
