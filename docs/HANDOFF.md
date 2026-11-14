# Minnesota-first application handoff

**Minnesota-first local application and technical feasibility verified; live collection gated on court/operator authorization.**

Controlling release boundary: [WO-MCRO-MN-FIRST-001](WO_MN_FIRST_001.md) and [WO-MCRO-MN-FEASIBILITY-002](WO_MN_FEASIBILITY_002.md). [Acceptance](MINNESOTA_ACCEPTANCE.md) and [Feasibility](MINNESOTA_FEASIBILITY.md) record MN-01–08, MN-F01–F05, actual commands/counts, browser transport findings, and external gates. [WORK_ORDER](WORK_ORDER.md) retains all national WO IDs and deferred work.

## Recoverable checkpoint and preserved material

- Repository: `/Users/pat/Projects/MCRO-Puller`; branch `refactor/wo-mcro-national-001`.
- Original source/test checkpoint `bb88e80` preserved. Application implementation: `819b512`; host-database restart correction: `e5a1140`. Feasibility milestone: `WO-MCRO-MN-FEASIBILITY-002`. No remote push/publication.
- Final checks: **263 passed, zero failed/skipped**; build exit 0; 3 infra tests passed. Repeatable feasibility harness `pnpm feasibility:mn` passed with 100% artifact reconciliation (9 authentic court PDFs replayed from `downloads/67-CV-26-300` and verified by SHA-256) and verified retrieval across compiled CLI, REST HTTP API, and real MCP child-process stdio.
- `downloads/67-CV-26-300/` originals/manifests/dossiers and historical session exports remain in place, excluded from commits. No original PDF was moved, rewritten or purged.
- Host development database: loopback 15439, database `court_dev`, schema `public`, thirteen migrations; persistent files `.runtime/postgres`, generated credentials `.runtime/database.env`/`.runtime/database.json` mode 0600. **Never print/share these files.**
- Copied immutable storage: `.runtime/artifacts`; 11 verified objects including 9 original PDFs and 2 synthetic files.
- Feasibility artifacts: `.runtime/feasibility/<run-id>/report.json` and retained live pilot runs under `.runtime/live-feasibility/<run-id>/` record machine-readable transport, readiness, reconciliation, search matrix, bulk query isolation, efficiency metrics, and crash recovery evidence.

## Start the local application

Prerequisites: Node 24+, pnpm 12.18.0, Poppler (`pdfinfo`,`pdftotext`,`pdftoppm`), Tesseract with English data. Standalone browser transport automatically discovers host Google Chrome (`/Applications/Google Chrome.app/Contents/MacOS/Google Chrome` on macOS, or via `COURT_CHROME_BIN`/`CHROME_BIN`).

Terminal 1, from the repository:

```sh
pnpm install --frozen-lockfile
pnpm dev:database
```

This reuses the existing isolated persistent cluster/credentials. Do not run a second database process on 15439. Ctrl-C stops it gracefully without deleting data.

Terminal 2:

```sh
set -a
. .runtime/database.env
set +a
export COURT_STORAGE_DIR="$PWD/.runtime/artifacts"
export COURT_ALLOW_LIVE_MN=false
export COURT_LLM_ENABLED=false
export COURT_CASE_INTERPRETATION_ENABLED=false
pnpm build
node dist/src/platform/courtctl.js db migrate
node dist/src/platform/courtctl.js doctor
node dist/src/platform/courtctl.js sources list
node dist/src/platform/courtctl.js source caps --state MN
```

`courtctl doctor` returns rich subsystem discrimination: database reachability and pool metrics, standalone browser availability and system Chrome path, extension bridge CDP limitation diagnosis, source enablement/pause status, credentials presence (without disclosing secrets), storage read/write integrity, worker queue counts, HTTP status, and MCP status.

For repeatable feasibility verification in an isolated database schema:

```sh
pnpm feasibility:mn
```

This executes all feasibility stages (MN-F01–F05): subsystem readiness, browser transport contracts and isolation, authentic case acquisition for `67-CV-26-300` through durable worker queue and selective OCR, reconciliation table accounting, 7 search modes verification, mixed bulk query error isolation, docket reuse efficiency (`navsAvoided > 0`), and worker crash/recovery.

## Human-assisted operator session & live acquisition (WO-MCRO-MN-LIVE-003)

Live court portal requests are gated on explicit operator authorization. Do not accept terms or bypass challenges automatically.

```sh
# 1. Option A: Establish an isolated operator session in headed Chrome
pnpm session:mn
# (Review terms in the browser window, click 'Yes, I Accept', then press ENTER in the terminal)

# 1. Option B: Import exported browser cookies (e.g. from Cookie-Editor)
node scripts/session-interactive.mjs --import /path/to/cookies.json

# 2. Inspect session status (verifies mode 0600 and cookies without secret disclosure)
node dist/src/platform/courtctl.js session status

# 3. Execute bounded live acquisition probe against real MinnesotaAdapter
export COURT_ALLOW_LIVE_MN=true
pnpm live:mn

# 4. Clear/revoke session state when completed or expired
node dist/src/platform/courtctl.js session clear
```

For repeatable offline acceptance:

```sh
pnpm check
pnpm accept:mn
node --test infra/tests/*.test.mjs
```

`accept:mn` creates/removes its own schema and temporary artifact directory. It parses clearly synthetic Minnesota-shaped HTML through production parsing, blocks browser network traffic, invokes compiled CLI/worker/HTTP/MCP, tests partial/change/restriction/recovery, and writes a report. It does not query MCRO or mutate the original corpus. Ordinary tests require `COURT_TEST_DATABASE_URL`; omitting it skips DB tests and does **not** reproduce this acceptance.

## Use stored Minnesota records now

These commands are local operations; no live access is needed:

```sh
node dist/src/platform/courtctl.js import-legacy --directory downloads
node dist/src/platform/worker.js --drain
node dist/src/platform/courtctl.js db search --state MN --case-number 67-CV-26-300
node dist/src/platform/courtctl.js db filing-search --state MN --document-type SUMMONS
node dist/src/platform/courtctl.js db filing-search --state MN --citation '123 N.W.2d 456'
node dist/src/platform/courtctl.js case get 87bf73bd-837a-461e-809d-c4064f8a9376
node dist/src/platform/courtctl.js case docket 87bf73bd-837a-461e-809d-c4064f8a9376 --limit 50
node dist/src/platform/courtctl.js document text 4c7ae765-4ac6-406b-8578-5c17748d6abd --limit 20
node dist/src/platform/courtctl.js storage verify
node dist/src/platform/courtctl.js coverage --state MN
node dist/src/platform/courtctl.js metrics
```

The two UUIDs identify this preserved local database's original case and Summons. A fresh database returns different UUIDs: use IDs returned by search/docket/filing operations. The citation is an illustrative filter, not a claim it occurs in the original corpus. Legacy import is non-destructive/idempotent and versioned processing preserves prior runs. Its incomplete original manifest remains `docketComplete=false`/partial; do not infer the full docket from nine PDFs.

Native extraction/OCR and deterministic classification/mentions work without inference. Current pipeline`poppler-tesseract-4`, schema`3`; original Summons corrected, older runs retained. Optional case interpretation and retention are integrated but default-off; consult [processing](PROCESSING.md) and [retention](RETENTION.md) before enabling either.

## Submit and inspect durable work

A safe packaged/local synthetic example:

```sh
node dist/src/platform/courtctl.js acquire --query '{"sourceId":"independent-fixture","searchType":"case","caseNumber":"FX-2024-0001"}' --idempotency-key demo-fixture-1
node dist/src/platform/worker.js --drain
node dist/src/platform/courtctl.js db search --source independent-fixture
```

The returned job UUID is used by `jobs status JOB_UUID`. Reuse the same idempotency key for uncertain delivery; a different request needs a different key.

Minnesota submission syntax below is supported but **queues gated source work**, not permission or proof of execution:

```sh
node dist/src/platform/courtctl.js source search --state MN --query '{"searchType":"case","caseNumber":"27-CV-24-1"}' --idempotency-key requested-observation-1
node dist/src/platform/courtctl.js acquire --state MN --query '{"searchType":"case","caseNumber":"27-CV-24-1"}' --idempotency-key requested-acquisition-1
node dist/src/platform/courtctl.js bulk --file queries.jsonl --idempotency-key requested-batch-1
node dist/src/platform/courtctl.js jobs status JOB_UUID
node dist/src/platform/courtctl.js jobs cancel JOB_UUID
```

`source search` observes search results only. `acquire` additionally requests docket/documents. Bulk supports JSON `{queries:[...],acquireResults:true}`, JSONL one object/line, or CSV headers matching query fields; maximum2MiB/validated bounded item count. Each query includes`sourceId`/`searchType` and only that mode's supported fields. Invalid query objects retain valid siblings; malformed JSON/CSV container syntax fails explicitly. JSONL/CSV and mixed-validity behavior were exercised by `accept:mn`.

Source`citationNumber` is a portal lookup; database`citation` searches extracted legal/case mentions. Never drop incompatible filters to manufacture a successful narrower search. The capability matrix distinguishes contract/fixture evidence from live verification.

## Refresh, pause, recovery and truthful status

```sh
node dist/src/platform/courtctl.js refresh-policy get
node dist/src/platform/courtctl.js case refresh CASE_UUID --idempotency-key explicit-refresh-1
node dist/src/platform/courtctl.js case watch CASE_UUID --enabled true
node dist/src/platform/courtctl.js discovery plan --query '{"sourceId":"mn-mcro","searchType":"party","lastName":"Anderson","firstName":"John","filedFrom":"2026-01-01","filedTo":"2026-01-31"}'
node dist/src/platform/courtctl.js schedule due
node dist/src/platform/courtctl.js source pause --source mn-mcro --reason 'Access review pending' --minutes 60
node dist/src/platform/courtctl.js source disable --source mn-mcro --reason 'No approved automated route'
```

`source resume --source SOURCE --reason TEXT` clears a shared pause only; `source enable` changes durable administrative state only. They do not authorize a source, grant process opt-in or erase retry deadlines. Under the current gate keep Minnesota disabled/opt-out. A read-only process cannot disable another worker at bootstrap; an opted-in process cannot reenable an admin-disabled source.

Continuous `node dist/src/platform/worker.js` schedules discovery and known-case refresh independently every60seconds. Each process runs one job at a time; shared PostgreSQL source limits coordinate multiple workers. **`--drain` only means no work runnable now.** Inspect workflow status, pending descendants, future retries, source pause/disable, queue age and failed processing. A complete source-search stage is not complete acquisition.

After correcting a diagnosed failure, `jobs retry JOB_UUID` preserves attempts and explicitly advances generation. Permanent/exhausted discovery partitions require `discovery plan --query ORIGINAL_QUERY_JSON` to replan; permanent errors do not spin forever. Automatic transient partition recovery is bounded to two generations with6h/12h backoff. Do not edit leases by hand in operation; forced expiry was isolated fault injection only.

Routine unchanged verified PDFs skip network acquisition until bounded revalidation; default168hours plus the next case observation. New/reappeared/revised references fetch sooner. A same-ID byte replacement without a trustworthy source revision may wait until that deadline. Hash deduplication alone is not network avoidance. No daily statewide completeness promise.

## Authenticated HTTP and actual MCP

Configure three **distinct strong** local API secrets in a protected environment. The local validation generated mode-0600`.runtime/compose.acceptance.env`; it contains test-only credentials and may be reused for local loopback experimentation, never production or publication. Do not print it.

```sh
# Load API_TOKEN_READ / API_TOKEN_WRITE / API_TOKEN_ADMIN securely first.
HOST=127.0.0.1 PORT=3000 node dist/src/platform/api.js
```

In another configured shell:

```sh
curl --fail -H "Authorization: Bearer $API_TOKEN_READ" http://127.0.0.1:3000/api/v1/health
curl --fail -H "Authorization: Bearer $API_TOKEN_READ" 'http://127.0.0.1:3000/api/v1/cases?state=MN'
curl --fail -H "Authorization: Bearer $API_TOKEN_READ" http://127.0.0.1:3000/api/v1/openapi.json
```

All routes require a bearer token. HTTP acquisition needs write role; controls/retry/retention need admin. Storage download is by authorized document UUID, never a caller-selected path. Do not expose the default server bind without reviewed TLS/access controls.

Configure your MCP client to launch `node` with argument`/Users/pat/Projects/MCRO-Puller/dist/src/platform/mcp.js`, working directory the repo, and the same DB/storage environment. Default`MCP_ROLE=read`; stdout is protocol-only. Actual SDK child-process stdio transport passed acceptance. Acquisition/admin additionally require`MCP_ROLE=acquire|admin` and`MCP_TOKEN` matching the corresponding configured API token. No request can elevate the process role. See [API](API.md) for full tool schemas/routes.

## Stop and resume safely

- Send Ctrl-C/SIGTERM to API, MCP and worker; stop producers before PostgreSQL. Worker aborts/fences in-flight work; committed checkpoints survive. Restart with the same DB/storage/config. Actual kill-after-commit/new-worker recovery passed.
- Stop`pnpm dev:database` with Ctrl-C; resume with the same command. Do not delete`.runtime/postgres` or regenerate credentials against existing data.
- Local validation used Colima profile`mcro-validation`, socket`unix:///Users/pat/.colima/mcro-validation/docker.sock`, Docker config`.runtime/docker-client`, Compose project`mcro-validation`, and`.runtime/compose.acceptance.yaml` to use loopback15440(DB)/15441(API). No default Docker context or unrelated stack was changed. Validation resources are stopped at handoff; volumes/profile and generated credentials are preserved.
- The owned development PostgreSQL service was also stopped gracefully after a successful compiled `doctor` check; its persistent data remain. The earlier browser-inspection tab had moved to an unrelated site at cleanup, so it was left untouched rather than closing a potentially repurposed user tab. No new portal navigation occurred.
- To resume that **existing validation** stack, start`colima start --profile mcro-validation`, securely load`.runtime/compose.acceptance.env`, set`DOCKER_CONFIG="$PWD/.runtime/docker-client"`, and run:

```sh
docker --host unix:///Users/pat/.colima/mcro-validation/docker.sock compose -p mcro-validation -f compose.yaml -f .runtime/compose.acceptance.yaml up -d --no-build --wait
# Stop without deleting records/volumes:
docker --host unix:///Users/pat/.colima/mcro-validation/docker.sock compose -p mcro-validation -f compose.yaml -f .runtime/compose.acceptance.yaml down
colima stop --profile mcro-validation
```

Never use`down --volumes`, reset, clean or a schema wipe as a recovery step. The isolated restore drill restored into a new database and verified artifacts before removing only that disposable target. [OPERATIONS](OPERATIONS.md) has backup/migration/rollback commands. For rollback preserve the new DB/storage, use a separate worktree/image, and never run an incompatible old binary on the new schema.

Temporary one-off smoke/crash scripts were removed after preserving reports; `scripts/accept-minnesota.mjs` is the maintained repeatable vertical/recovery command. No original record, session export, database, artifact or report was removed during that cleanup.

## Remaining blockers and next authorized milestone

No known local Minnesota acceptance failure remains. Keep these gates separate:

1. **Pat + Minnesota court:** obtain an approved automated route/budget/credentials or authorized bulk sample. Current MCRO terms prohibited bots; no terms acceptance/search performed. Then separately authorize bounded live search/acquire/refresh tests. No proxy cycling or WAF/CAPTCHA bypass.
2. **Pat + release operator:** approve cloud project/region/owners/budget and reviewed plan before spending/deploying. Supply exact release/proxy/COS digests, secrets and protected state. Restricted-role SQL grants need integration for refresh/retention writes and real role-based staging tests; physical GCS GC needs separate approved custodian permission. Neither is established by the local owner-backed test. Production monitoring/PITR/IAM/source behavior remain unverified.
3. **Pat + data-governance owner:** paid inference/subscription and data-sharing decisions remain closed. Required local functionality does not depend on them.
4. **Deferred national roadmap:** live second state, large-scale source/DB benchmark, advanced OCR comparison and calibrated NLP evaluation remain explicitly deferred, not complete.

The next step is an access or staging decision, not another architecture expansion. Preserve819b512/e5a1140 and this handoff; do not add optional features or rerun unchanged expensive checks merely to increase counts.
