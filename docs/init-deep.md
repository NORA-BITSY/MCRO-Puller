# /init-deep — deep-dive skill for MCRO-Puller / courtctl

**Purpose:** Enable an agent (or a fresh human) to work accurately and efficiently in this repo by giving a complete, source-grounded deep dive of the repository, the application, and the per-directory `AGENTS.md` documentation.

## What this repo is

MCRO-Puller (`courtctl`, legacy bin `mcro`) is a **source-grounded court-record collection, reconciliation and query platform**, beginning with Minnesota MCRO (`publicaccess.courts.state.mn.us`).

Two stacks coexist — **do not treat them as one**:

| Stack | Entry | Status | Role |
|---|---|---|---|
| Legacy browser pipeline | root `cli.js` (bin `mcro`) + `src/*.js` | Preserved, local-only | Playwright scrape → local files under `downloads/` |
| Durable typed platform | `src/platform/*.ts` (bin `courtctl`, compiles to `dist/`) | **The real product** | PostgreSQL + content-addressed storage + jobs; `courtctl acquire` enqueues work a separate `worker` executes |

**Controlling boundary:** Minnesota-first local application verified; live MN collection + cloud operation **NOT verified**. See `docs/HANDOFF.md`, `docs/WORK_ORDER.md`, `docs/MINNESOTA_ACCEPTANCE.md`.

## Application model (read before changing anything)

- Discovery ≠ observed docket ≠ immutable PDF bytes ≠ derived text ≠ interpretation. Keep these layers separate.
- "All discovered PDFs downloaded" ≠ statewide completeness. Unknown populations stay unknown (`denominator = null`); partial observations never imply removal.
- Artifacts are content-addressed (SHA-256), originals immutable. HTTP artifact access is by authorized document UUID, never caller-chosen paths.
- CLI, Fastify HTTP (`/api/v1`, bearer read/write/admin), and MCP stdio all share **one** `CourtService`; all three use the narrower `interfaces.ts` boundary.
- `worker --drain` = "nothing runnable now", not "complete". A successful search stage ≠ descendant downloads/OCR finished.
- `dist/` may contain stale nested `dist/dist/…` — never treat that as canonical; rebuild with `pnpm build`.

## Runtime & toolchain

- Node **>=24**; pnpm **exactly 12.18.0** (`packageManager` + `devEngines`). ESM only (`"type":"module"`).
- System: PostgreSQL 17+, Poppler (`pdfinfo`/`pdftotext`/`pdftoppm`), Tesseract English, Playwright Chromium / system Chrome.
- TS is strict: `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `noImplicitReturns`, `verbatimModuleSyntax`, `isolatedModules`. `allowJs:true` but **`checkJs:false`** → `src/*.js` is never typechecked; only tests guard it.
- `dist/`, `.runtime/`, `downloads/`, `node_modules/`, `.review/` are build/runtime output, not source.
## Commands (repo root)

| Purpose | Command |
|---|---|
| Full gate | `pnpm check` → `typecheck && node --check cli.js && pnpm test` |
| Typecheck / build | `pnpm typecheck` / `pnpm build` |
| All tests | `node --import tsx --test test/*.test.js test/*.test.ts` |
| One test file | `node --import tsx --test test/adapter.test.ts` (tsx **required** for `.ts`) |
| One named test | `node --import tsx --test --test-name-pattern="cursor" test/adapter.test.ts` |
| Infra tests | `node --test infra/tests/*.test.mjs` |
| Offline acceptance | `pnpm accept:mn` (synthetic, `liveTraffic:0`, needs DB env; does not contact MCRO) |
| Feasibility harness | `pnpm feasibility:mn` (offline corpus replay; `--live-adapter` only for gated live) |
| Durable CLI | `pnpm courtctl …` (tsx) or `node dist/src/platform/courtctl.js …` (**after** `pnpm build`) |
| API / MCP / worker | `pnpm api` / `pnpm mcp` / `pnpm worker [--once|--drain]` |
| Dev database | `pnpm dev:database` (embedded PG on `127.0.0.1:15439`) |
| Legacy CLI | `node cli.js <search|download-case|bulk_download|sync|statewide|daemon|verify|ocr|status|counties>` |

## Database, migrations, env

- `pnpm dev:database` starts/reuses an isolated persistent cluster on `127.0.0.1:15439`, data in `.runtime/postgres`, creds in `.runtime/database.env` (mode 0600). Keep it running; **never start a second process on 15439**; never delete `.runtime/postgres` or regenerate creds against existing data.
- New shell: `set -a && . .runtime/database.env && set +a`, then `pnpm courtctl db migrate`.
- Migrations `migrations/0001..0013_*.sql` are **forward-only, no down, SHA-256 checksum-tracked** (runner: `src/platform/database.ts`, one transaction + advisory lock). Editing an applied file or reordering is **rejected** — corrections require a new forward migration. Naming: `####_lower_snake.sql` (4+ digit prefix, unique/sorted).
- DB tests need `COURT_TEST_DATABASE_URL`; without it they **skip** (skipping ≠ acceptance). Tests create/drop isolated schemas `court_test_<uuid>`. `test/dev-database.test.ts` self-provisions (slower, 60s timeout). Never point tests at a production DB.
- Common env: `COURT_DATABASE_URL`, `COURT_TEST_DATABASE_URL`, `COURT_STORAGE_DIR`, `COURT_ALLOW_LIVE_MN`, `API_TOKEN_{READ,WRITE,ADMIN}`, `COURT_BROWSER_{MODE,HEADED}`, `COURT_CHROME_BIN`, `COURT_SESSION_FILE`, `MCRO_{OUTPUT_DIR,STATE_FILE,MIN_DELAY_MS,MAX_DELAY_MS,CONCURRENCY,MAX_RETRIES}`, `COURT_PROXY` / `COURT_PROXIES`, `DECODO_*`, `MCP_ROLE`/`MCP_TOKEN`.

## Where to look (subsystem → location)

| Task | Location |
|---|---|
| Adapter contract (schemas, `CourtSourceAdapter`, `SourceError` codes) | `src/platform/contracts.ts` |
| Adapter impls: `MinnesotaAdapter` (live), `GroundedMinnesotaAdapter` (replay), `IndependentFixtureAdapter` | `src/platform/adapters.ts` |
| Orchestration / durable service (validate → enqueue → execute → reconcile → persist) | `src/platform/service.ts` |
| Delivery surfaces (share one `CourtService`) | `src/platform/{courtctl,api,mcp,worker}.ts`, `bootstrap.ts`, `interfaces.ts` |
| Jobs / leases / retries · discovery · refresh · retention · reconcile · storage · DB | `src/platform/{jobs,discovery,refresh,retention,reconcile,storage,database}.ts` |
| Processing (OCR/NLP/LLM provenance) | `src/platform/processing*.ts`, `src/ocr.js`, `src/nlp.js`, `src/native-tools.js` |
| Legacy crawl primitives (MN adapter reuses these) | `src/{browser,waf,search,roa,crawler,downloader,state,queue,sync,statewide,config}.js` |
| Scripts | `scripts/{accept-minnesota,feasibility-minnesota,session-interactive,decodo-provision}.mjs`, `scripts/dev-database.ts`, `scripts/import-feed.ts` |
| Container / infra / CI | `Dockerfile`, `compose.yaml`, `infra/` (Terraform), `.github/workflows/ci.yaml` |

## Per-directory agent documentation

Each directory below has its own focused `AGENTS.md` so an agent working in that slice doesn't need to hold the whole repo in memory:

- `src/platform/AGENTS.md` — durable platform (service, jobs, storage, adapters, contracts)
- `src/AGENTS.md` — legacy browser pipeline (`cli.js`, `src/*.js`)
- `test/AGENTS.md` — test conventions and running tests
- `migrations/AGENTS.md` — migration rules and forward-only discipline
- `infra/AGENTS.md` — Terraform, Docker, Compose, CI gates
- `scripts/AGENTS.md` — maintenance scripts
- `docs/AGENTS.md` — documentation conventions (this file is the entry)

## How to use /init-deep

1. Read `docs/HANDOFF.md` first (operator handoff, exact run/preflight commands, gates, recovery).
2. Read `docs/WORK_ORDER.md` (WO ledger + milestone status) and `docs/MINNESOTA_ACCEPTANCE.md` (controlling milestone + evidence).
3. Read the relevant per-directory `AGENTS.md` for your slice.
4. Before editing: `pnpm typecheck`, read the contract (`contracts.ts`), run `xd://lsp` references on any exported symbol you change.
5. After changing: run the narrowest test covering the change once (`pnpm test` or a single file), then `pnpm build`.
6. Never rerun checks to confirm user-reported errors; treat them as ground truth.
7. Live MN needs **all**: persisted source enablement, `COURT_ALLOW_LIVE_MN=true` in the worker process, explicit `--live-adapter` (`pnpm live:mn`), and a verified saved session. Bounded pilot: 150 source requests / 15 PDFs / 128 MiB.

## Safety gates (non-negotiable)

- **Doc/code drift:** `README` claims "No proxy rotation, stealth plugin, CAPTCHA solver, or unattended challenge bypass," yet `src/browser.js` masks `navigator.webdriver` + `--disable-blink-features=AutomationControlled`, `src/config.js` supports `COURT_PROXIES`/`COURT_PROXY`, and `scripts/decodo-provision.mjs` provisions sticky US residential proxies. `ensureTermsAccepted` now clicks acceptance for the operator. CAPTCHA/challenge bypass and header/referer spoofing remain out of scope; require explicit owner sign-off before adding them.
- `ensureTermsAccepted` accepts the Minnesota terms modal automatically when present; it no longer refuses or throws `blocked`. A visible terms modal no longer halts work.
- `checkWafBlock` **detects** blocks/CAPTCHAs and throws `blocked`; it does not solve or bypass. On `403`/`429` the shared source pauses — stop; do not retry or rotate identity.
- Never use `docker compose down --volumes`, reset, or schema wipe as recovery (deletes `postgres`/`artifacts` volumes).
- `.runtime/*` and `downloads/` are protected: never print/share secrets, never move/rewrite/purge originals.
