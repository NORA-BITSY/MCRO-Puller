# Minnesota Real-Source Integration and Release Proof (WO-MCRO-MN-LIVE-003)

**Milestone:** WO-MCRO-MN-LIVE-003 — Minnesota Real-Source Integration & Release Proof  
**Controlling Work Order:** [WO_MN_LIVE_003.md](WO_MN_LIVE_003.md)  
**Independent Acceptance Review:** [WO_MN_LIVE_003_REVIEW.md](WO_MN_LIVE_003_REVIEW.md)  
**Branch:** `refactor/wo-mcro-national-001`  
**Baseline Test Suite:** **264 / 264 passed** (zero failed; includes 7 review regression tests and 2 worker-pool regressions)  
**Infrastructure Tests:** 3 / 3 passed  
**Retained Live Pilot Runs:** `3ffaeed0` (pre-parity, WAF blocked) and `a7aadc29` (browser-parity driver, **Gates L2/L3 passed**; Schema `mn_live_a7aadc29`, `.runtime/live-feasibility/a7aadc29/`)  

---

## 1. Executive Summary

This milestone directly investigates live Minnesota Court Records Online (MCRO) source acquisition through the production `MinnesotaAdapter` using standalone Google Chrome. Automated consent to court terms is refused on Pat's behalf; no CAPTCHA solving or mid-session proxy rotation is employed.

Following the independent review (`docs/WO_MN_LIVE_003_REVIEW.md`), all six review findings (R003-1 through R003-6) were corrected and empirically verified with 7 focused offline regression tests in `test/live-integration-review.test.ts`.

With operator approval, the F5 BIG-IP ASM bot-mitigation interception of Gate L2 was resolved by **browser-parity automation** (suppressing Playwright automation tells so the automated browser matches the operator's real Chrome), verified live:
1. **Gate L1 (Local Architecture & Replay):** **PASSED.** Prior replay, authentic corpus import (`downloads/67-CV-26-300`), text extraction, selective OCR, and multi-interface retrieval (CLI, REST, MCP) function with 100% data integrity.
2. **Gate L2 (Live Source Search):** **PASSED** (live run `a7aadc29`): a real production-adapter case-number search for `67-CV-26-300` returned 9 docket entries through the parity driver; no F5 rejection.
3. **Gate L3 (Live Document Acquisition):** **PASSED** (same run): a live PDF was downloaded through the production adapter (467,436 bytes, SHA-256 content-addressed).
4. **Gate L4 (Repeatability & Runbook):** **PENDING.** Repeat observation across sessions required.

---

## 2. Live Source Experiments & Observed Network Evidence

### Experiment A: Portal Navigation & Terms Modal Detection (Unauthenticated)
- **Command:** `node scripts/feasibility-minnesota.mjs --live-adapter` with `COURT_ALLOW_LIVE_MN=true`
- **Observed Transport:** Standalone Chromium successfully launched system Google Chrome (`/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`).
- **Endpoint:** `https://publicaccess.courts.state.mn.us/CaseSearch`
- **Response:** HTTP 200 OK.
- **Title:** `Case Search - Minnesota Court Records Online (MCRO)`
- **DOM Inspection:** Terms and Conditions modal detected:
  - Header: `#tcModalTitle` (*"Terms and Conditions"*)
  - Body: `#tcModalBody` (*"Required Acknowledgment for Minnesota Court Records Online ('MCRO'). Users must read and accept the following Terms and Conditions..."*)
  - Actions: `#tcModalAcceptBtn` (*"Yes, I Accept"*), `#tcModalRejectBtn` (*"No, I Do Not Accept"*)
- **Automated Consent Refusal:** Because automated acceptance on the user's behalf is forbidden, `ensureTermsAccepted` threw typed error `{ code: 'blocked' }`:
  `"Minnesota Court Records Online Terms and Conditions modal detected; operator review and confirmation required (refusing automated terms acceptance on user's behalf)"`

### Experiment B: Operator Session Import & Terms Modal Dismissal
- **Session Source:** Exported operator browser cookies (`publicaccess.courts.state.mn.us_json_1794651178348.json`).
- **Import Tool:** `node scripts/session-interactive.mjs --import /path/to/cookies.json`
- **State Written:** `~/.mcro-puller/session.json` with mode `0600` (owner read/write only).
- **Inspected Cookies:** 9 cookies verified without disclosing secret values (`IsAcceptedTerms`, `TermsExpirationTime`, `mcro-session`, `TS01dc4fc6`, `OClmoOot`).
- **Observed Result:** Navigating to `/CaseSearch` with loaded `storageState` confirmed:
  - `Terms modal visible: false` (terms modal dismissed by valid session cookies).
  - Search tabs `#MpaCaseSearchNameTypeTab` and `#MpaCaseSearchCaseNumberTypeTab` accessible.

### Experiment C: Search Submission & F5/Volterra ASM Interception
- **Form Navigation:** Clicked `#MpaCaseSearchCaseNumberTypeTab`, waited for CSS animation, filled `#CaseSearchNumber` with `67-CV-26-300`, and clicked `#btnCaseSearch`.
- **Submission:** Submitting a search POST request to `/CaseSearch/CaseSearchSearch` in an automated browser context was intercepted by F5 BIG-IP / Volterra Application Security Manager (ASM):
  ```html
  <div id="CaseSearchResultsWrapper" class="d-block">
    The requested URL was rejected. Please proceed to the next page via 
    <a href="https://courtapi.courts.state.mn.us/support/" target="_blank">this link</a> 
    to submit a support request; you will be asked to copy and paste diagnostic information into your support request.
  </div>
  ```
- **Driver Response:** The immediate WAF regex in `waitForSearchResults` matched `/the requested url was rejected/i` without dead timeouts, and surfaced typed error:
  `blocked (WAF block indicator found: "the requested url was rejected" at https://publicaccess.courts.state.mn.us/CaseSearch)`
- **Telemetry Script:** MCRO loads Shape/Volterra client telemetry (`/js/mcro3keulkju.js?async&seed0=...`), which validates browser environment, mouse movements, and proof-of-work before permitting form search execution.

---

## 3. Concrete Integration Fixes Implemented

1. **Immediate WAF Block Detection (`src/search.js`):**
   - *Problem:* `waitForSearchResults` previously timed out after 30 seconds before calling `checkWafBlock` when MCRO returned an inline rejection message.
   - *Fix:* Added `/the requested url was rejected/i` to the `waitForFunction` DOM regex. The search driver now detects F5/Volterra ASM rejection immediately, eliminating 30-second dead timeouts and throwing a typed `SourceError('blocked')`.

2. **Tab Transition & Control Wait in Form Interaction (`src/search.js`):**
   - *Problem:* Clicking `#MpaCaseSearchCaseNumberTypeTab` triggered Bootstrap tab transitions; querying `#CaseSearchNumber` immediately resulted in 0 visible elements.
   - *Fix:* Added `waitFor({ state: 'visible', timeout: 3000 })` and settling pauses in `choose()` and `field()`, ensuring inputs are interactive before filling.

3. **Isolated Human-Assisted Operator Session Tooling (`scripts/session-interactive.mjs`):**
   - Added `pnpm session:mn` command.
   - Supports `--import <file>` to convert standard browser cookie exports into Playwright `storageState` with mode `0600`.
   - Supports `--status` and `--clear` to inspect and clear session state without leaking secret tokens.
   - Implemented `validateSessionPage()` to verify modal dismissal, search elements, and cookies before saving.

4. **Session Status & Clear Commands in `courtctl` (`src/platform/courtctl.ts`):**
   - `courtctl session status`: Inspects session file existence, mode, size, and cookie expiration dates without requiring database connection.
   - `courtctl session clear`: Safely deletes session state file when revoked or expired.

5. **Live Adapter Opt-In Flag (`pnpm live:mn`):**
   - Extended `scripts/feasibility-minnesota.mjs` with `--live-adapter` option.
   - Offline/preflight replay remains the default. Real network requests occur only when `--live-adapter` is explicitly passed with `COURT_ALLOW_LIVE_MN=true`.


### Experiment D: Browser-Parity Driver Resolves the F5 ASM Rejection (Operator-Approved)
- **Root Cause:** Playwright launches Chromium with `--enable-automation` and `navigator.webdriver=true`, and the driver submitted the search immediately after `domcontentloaded`, before F5 client-telemetry beacons settled. The operator's manual browser passed; the automated context did not.
- **Fix (`src/browser.js`, `src/search.js`):**
  - `ignoreDefaultArgs: ['--enable-automation']` and `--disable-blink-features=AutomationControlled` on launch; `navigator.webdriver` masked via init script.
  - `serviceWorkers: 'allow'` (F5 telemetry service workers no longer blocked).
  - Best-effort `networkidle` settle after navigation and a cooperative `sleepJitter` pause before form submission.
- **Observed Result (live run `a7aadc29`):** Production-adapter search for `67-CV-26-300` returned 9 docket entries; first available document downloaded live (467,436 bytes). No F5 rejection, no CAPTCHA, no dead timeouts.

### Experiment E: Operator-Approved Automation Envelope (Proxy Pool & Concurrency)
- **Concurrency:** `WorkerQueue` runs up to 10 concurrent pull jobs (hard ceiling `MAX_PULL_CONCURRENCY`; `MCRO_CONCURRENCY` env, default 10). Cases already in flight when a source-wide challenge fires are durably retained for retry; no new case starts after a block.
- **Proxy pool:** `COURT_PROXIES` (comma-separated) or `COURT_PROXY` (single). Each worker is **stickily** assigned one pool proxy by worker index so F5/session cookies stay bound to one exit IP per worker; proxies are never rotated mid-session. Empty pool means direct connections.
- **Decodo integration (`scripts/decodo-provision.mjs`, `pnpm decodo:mn`):** Uses the operator's dashboard Decodo Residential proxy user to materialize 10 sticky **US** sessions on `us.decodo.com:10001-10010` (one port per worker; `gate.decodo.com` sticky ports are random-country and unsuitable for MCRO), verifies each session's US egress, and persists the pool as `COURT_PROXIES` in the gitignored `.runtime/decodo.env` (mode `0600`). `pnpm decodo:check` re-verifies egress only. Requires an active Decodo Residential subscription.
- **Single proxied live pass:** one live search and document download succeeded through a Decodo US sticky session: 9 entries and a 467,436-byte PDF. This proves that individual acquisition, not repeatability or ten-worker throughput; the corrected initial batch below was blocked.
- **Proxy handling (`src/browser.js`):** proxied contexts omit selected WAF cookies from imported state and supply Chromium credentials as separate Playwright fields. One subsequent pull succeeded, but the assertion that F5 cookies are IP-bound remains [INFERENCE], not a controlled finding. Later WAF rejections show that cookie filtering is not a reliable source-access solution.

### Experiment F: Corrected Initial Criminal-Case Batch
- **Targets:** `22-CR-26-####` (four-digit suffixes) and `46-CR-26-###` (three-digit suffixes). `46-CR-26-22222` is excluded; the superseded probe was cancelled and removed.
- **Initial candidates:** `22-CR-26-1000` through `1004` and `46-CR-26-100` through `104`. These are candidates, not verified existing records. Fresh state/output paths prevent unrelated pending targets from being resumed.
- **Execution:** actual `WorkerQueue` docket/PDF acquisition, ten standalone headed clients assigned to the ten US proxy endpoints, existing pacing and consent checks retained. After the bulk CLI returned a blocked status without per-case details, a landing-page diagnostic succeeded on proxy 1. An evidence-preserving resume used that landing warm-up and saved individual outcomes.
- **Observed result:** zero successful acquisitions; two WAF rejections, five terms/session blocks, and three jobs stopped before acquisition. All ten candidates remain pending; no inference about case existence or absence is supported by these blocked responses.
- **Retained evidence:** `.runtime/initial-pulls-2026-11-14T11-23-50-250Z/{candidates.json,scope.json,landing-diagnostic.json,results.json,state.json}`. No automatic terms acceptance or further challenge retries were performed. Repeatability remains unproven.


---

## 4. Resolution of Review Findings (WO-MN-LIVE-003-REVIEW)

The six findings identified in `docs/WO_MN_LIVE_003_REVIEW.md` were reproduced and verified with focused offline regression tests in `test/live-integration-review.test.ts`:

- **R003-1 (Explicit Live Contract):** Implemented `isLiveModeEnabled()`, enforcing a strict four-way truth table. Live portal probes run only when BOTH `COURT_ALLOW_LIVE_MN=true` AND the CLI flag (`--live-adapter` or `--live`) are supplied. If either is missing, the harness defaults to network-free offline replay even if the environment variable is present in the parent shell.
- **R003-2 (Accurate Gate Accounting):** Corrected `evaluateLiveGates()`. Zero search matches are explicitly categorized as `no_results` and do not satisfy Gate L2. A single document download leaves Gate L4 as `pending` until repeat observation and recovery evidence exist.
- **R003-3 (Durable Pipeline vs. Replay Separation):** The production `MinnesotaAdapter` is directly probed in live mode. Authentic grounded records from `downloads/67-CV-26-300` are strictly labeled as `replayed_authentic_corpus` and never substituted or misrepresented as fresh live downloads.
- **R003-4 (Error Isolation Across Stages):** Stage evaluation preserves completed evidence. A subsequent document download error (e.g. timeout or restricted) attributes the failure to Gate L3 and does NOT erase or overwrite a previously successful search/docket on Gate L2. Typed errors cleanly distinguish `blocked` from parser or networking faults.
- **R003-5 (Live Pilot Budget & Workspace Retention):** Live probes pass a shared `AcquisitionContext` enforcing pilot ceilings (max 50 requests, 64 MiB). Live workspaces (`.runtime/live-feasibility/<runId>/`) and PostgreSQL schemas (`mn_live_<runId>`) are durably retained upon completion or error for operator inspection and resumption.
- **R003-6 (Session State Verification):** Implemented `validateSessionPage()` in `scripts/session-interactive.mjs`. Checks that the terms dialog is dismissed, search tabs are accessible, and session cookies are present before saving state with `0600` permissions.

---

## 5. Gates Evaluation Summary

| Gate | Name | Status | Evidence & Controlling Boundary |
|---|---|---|---|
| **L1** | **Local Architecture & Replay** | **PASSED** | 264/264 unit and integration tests passing; compiled CLI (`courtctl`), Fastify REST API, and MCP stdio verified; 9 authentic court PDFs replayed from `downloads/67-CV-26-300` with 100% SHA-256 match. |
| **L2** | **Live Source Search** | **PASSED** (run `a7aadc29`) | Navigation HTTP 200; terms modal dismissed via imported operator session; production-adapter case-number search returned 9 docket entries through the browser-parity driver with no F5 rejection. |
| **L3** | **Live Document Acquisition** | **PASSED** (run `a7aadc29`) | Live PDF downloaded through the production adapter (467,436 bytes, content-addressed, integrity-verified). |
| **L4** | **Repeatability & Runbook** | **PENDING** | Repeat live observation across sessions and recovery evidence required. Operational commands and session lifecycle tools delivered. |

---

## 6. Operational Automation

The operator session is imported and verified (`~/.mcro-puller/session.json`, mode `0600`, 9 cookies). Bounded live pulls:
```sh
export COURT_ALLOW_LIVE_MN=true
# Option A — Decodo pool (requires active Residential subscription):
#   pnpm decodo:mn        # verifies proxy credentials and US egress; writes COURT_PROXIES
#   set -a && source .runtime/decodo.env && set +a
# Option B — manual proxy list (up to 10, one sticky proxy per worker):
export COURT_PROXIES="http://proxy1:8080,http://proxy2:8080,..."
pnpm live:mn          # bounded live pilot (search + document proof)
```
Concurrent case pulls (up to 10 workers, one sticky proxy each) use the `WorkerQueue` (`src/queue.js`); cooperative jitter pacing still applies between requests per worker, and a source-wide challenge pauses the whole queue while durably retaining pending work.

To clear/revoke the local session file:
```sh
node dist/src/platform/courtctl.js session clear
```
