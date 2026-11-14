# WO-MCRO-MN-LIVE-003 — Independent acceptance review

Reviewed 2026-11-14 against branch `refactor/wo-mcro-national-001`, HEAD `b5abf08`, and the uncommitted WO-003 implementation. This is a correction to the existing milestone, not a new platform build.

## Verified current state

- WO-002 is committed locally as `b5abf08`; WO-003 source, scripts, and documentation remain uncommitted.
- The Gemini CLI process in `/Users/pat/Projects/MCRO-Puller` was idle at its prompt during inspection. No input was injected and no second implementation agent was started.
- Fresh `pnpm typecheck` and `git diff --check` completed successfully. The full 256-test suite was not rerun in this review.
- The compiled `courtctl session status` command works without database environment variables. It reported that `/Users/pat/.mcro-puller/session.json` does not exist.
- No live court requests, terms acceptance, browser challenge handling, cloud changes, or source-state changes were performed by this review.

## Findings requiring correction before acceptance

### R003-1 — Explicit live-mode contract is not implemented

`scripts/feasibility-minnesota.mjs:340` uses environment opt-in OR `--live-adapter`, not both. An inherited `COURT_ALLOW_LIVE_MN=true` makes the default command navigate to MCRO; the flag alone also enables the direct landing-page probe even without process opt-in. The production adapter has a separate opt-in check, but that does not protect the earlier direct probe.

Require both explicit live mode and process opt-in before any live-runner request. Offline/replay mode must remain network-free even when the parent shell contains the environment flag. Add four-way truth-table tests. Do not disable the existing source gates.

### R003-2 — Gate results are assigned before their acceptance conditions

At lines 372–383, zero search results still produce `L2 = passed (0 matches)`, and a single downloaded buffer sets `L4 = passed` without a second observation or recovery test on live-derived records. A valid empty search is useful evidence of a search response, but it does not satisfy the work order's selected-case identity/docket gate.

Require actual matching case/docket evidence for L2. Keep L4 pending until repeat observation and the specified recovery/operability evidence exist. Preserve separate no-result, unavailable, failed, blocked, and verified outcomes.

### R003-3 — Real downloads do not exercise the durable end-to-end path

The live block calls `MinnesotaAdapter` directly and holds the returned PDF in memory. The durable database/storage/CLI/API/MCP portion then creates `GroundedMinnesotaAdapter` at line 431 and uses historical corpus replay. Therefore even a successful source download would not establish fresh-source-to-database-to-interface acceptance.

Execute the live case through the production durable service/worker using an isolated retained workspace. Verify the actual newly downloaded document hash, source identity, persisted version, extraction, and retrieval through all three interfaces. Keep replay results separately labeled. Do not silently substitute corpus files when live acquisition fails.

### R003-4 — Exceptions erase successful earlier stages and misidentify faults

Lines 386–391 classify any live exception as an L2 block. The offline reproduction showed a simulated download/network failure after successful search and docket retrieval rewriting L2 to blocked and L3 to pending.

Preserve completed stage evidence. Attribute a failure to the stage and typed cause that actually failed. Only actual source rejection/operator boundaries are blocked; parser, storage, networking, and configuration failures must not all become permission problems.

### R003-5 — Live budgets and retained evidence need real enforcement

The direct live calls use an empty acquisition context (`{}`), without passing the work order's shared request/byte budgets. The script drops its schema in `finally` at line 678. Request ceilings described only in documentation are not enforcement, and a deleted observation database is not a retained resumable pilot.

Use the existing bounded queue/source controls, enforce the pilot budget, and retain live-derived observation/job/version state. Keep disposable offline-test cleanup separate from retained live experiments. Persist failure reports as well as successful reports.

### R003-6 — Session save is not session verification

`scripts/session-interactive.mjs:114–144` saves state for any response other than `cancel` or `timeout`, without checking that the terms modal disappeared or that the page is usable. A saved file is not proof that a subsequent browser can search. The later probe also uses a fresh preliminary browser context without the saved session; distinguish that context from the session-restored adapter.

Before claiming a verified session, validate the observed page state after the human action. Test restoration separately; do not promise it resolves a source rejection. Save state with restrictive permissions from initial creation, guarantee browser cleanup on errors/EOF/cancellation, and avoid calling local-file deletion server-side revocation. Do not accept terms or complete human checks automatically.

## Reproduction evidence

The existing live-branch source was evaluated in a temporary in-memory harness with stub page and adapter methods. No production source, browser, database, or repository implementation was invoked or altered.

| Input/scenario | Actual runner behavior |
|---|---|
| Neither opt-in | No portal call |
| Environment only | Portal navigation occurs |
| Flag only | Portal navigation occurs; the mocked adapter branch runs |
| Both, zero matches | L2 passes with zero matches |
| Both, one PDF | L4 passes with zero repeat observations |
| Download throws after successful search/docket | Successful L2 overwritten as blocked |

The flag-only mock result demonstrates branch selection, not a claim that the real adapter's separate opt-in check is absent.

## Bounded continuation

Remain on WO-003. Correct these reproducible integration and reporting defects with focused offline regression tests first. No broad refactor, additional state, new UI, policy research, live retry loop, paid inference, cloud deployment, remote publication, or duplicate implementation agent.

Re-run the coherent local acceptance checks after the corrections. Then leave one genuinely bounded live test ready for the operator's voluntary browser action. Any actual source rejection remains a separately recorded blocker, not proof of a software defect or proof that accepting terms will resolve it. Report L2–L4 pending until the corresponding observations exist.
