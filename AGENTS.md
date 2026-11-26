# AGENTS.md

Source-grounded Minnesota court-record acquisition (`MCRO-Puller` / `courtctl`). **Two stacks coexist — do not treat them as one:**
- **Legacy browser pipeline** — root `cli.js` (bin `mcro`) + `src/*.js` (Playwright scrape → local files).
- **Durable typed platform** — `src/platform/*.ts` (bin `courtctl`, compiles to `dist/`), backed by PostgreSQL + content-addressed storage + jobs. This is the real product; `courtctl acquire` **enqueues** work that a separate `worker` executes.

## Read first (source of truth)
- `docs/HANDOFF.md` — operator handoff, exact run/preflight commands, gates, recovery.
- `docs/WORK_ORDER.md` — WO ledger + milestone status.
- `docs/MINNESOTA_LIVE_INTEGRATION.md` — live gates L1–L4; what is/isn't verified.
- `docs/MINNESOTA_ACCEPTANCE.md`, `docs/WO_MN_FIRST_001.md` — controlling milestone + evidence.
- Historical/stale (don't quote as current): `docs/MINNESOTA_FEASIBILITY.md`, older test-counts embedded in the above. Current boundary: **local MN verified; live MN + cloud NOT verified.**

## Runtime & toolchain
- Node **>=24**; pnpm **exactly 12.18.0** (`packageManager` + `devEngines`). ESM only (`"type":"module"`).
- System: PostgreSQL 17+, Poppler (`pdfinfo`/`pdftotext`/`pdftoppm`), Tesseract English, Playwright Chromium / system Chrome.
- TS is strict: `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `noImplicitReturns`, `verbatimModuleSyntax`, `isolatedModules`. `allowJs:true` but **`checkJs:false`** → `src/*.js` is never typechecked; only tests guard it.
- `dist/`, `.runtime/`, `downloads/`, `node_modules/`, `.review/` are build/runtime output, not source. `dist/` may contain stale nested `dist/dist/…` — never treat that as canonical.

## Commands (repo root)
| Purpose | Command |
|---|---|
| Full gate | `pnpm check` → `typecheck && node --check cli.js && pnpm test` |
| Typecheck / build | `pnpm typecheck` (`tsc --noEmit`) / `pnpm build` (`tsc` → `dist/`) |
| All tests | `pnpm test` = `node --import tsx --test test/*.test.js test/*.test.ts` |
| One test file | `node --import tsx --test test/adapter.test.ts` (tsx loader **required** for `.ts`; `.js` optionally) |
| One named test | `node --import tsx --test --test-name-pattern="cursor" test/adapter.test.ts` |
| Infra tests | `node --test infra/tests/*.test.mjs` |
| Offline acceptance | `pnpm accept:mn` (synthetic, `liveTraffic:0`, needs DB env; does not contact MCRO) |
| Feasibility harness | `pnpm feasibility:mn` (offline corpus replay; `--live-adapter` only for gated live) |
| Durable CLI | `pnpm courtctl …` (tsx) or `node dist/src/platform/courtctl.js …` (**after** `pnpm build`) |
| API / MCP / worker | `pnpm api` / `pnpm mcp` / `pnpm worker [--once\|--drain]` |
| Dev database | `pnpm dev:database` (embedded PG on `127.0.0.1:15439`) |
| Legacy CLI | `node cli.js <search\|download-case\|bulk-download\|sync\|statewide\|daemon\|verify\|ocr\|status\|counties>` |

`bin` `courtctl` points at `dist/src/platform/courtctl.js` → `pnpm build` first, or use `pnpm courtctl` (tsx). No legacy `pull`/`run` commands exist.

## Database, migrations, env
- `pnpm dev:database` starts/reuses an isolated persistent cluster on `127.0.0.1:**15439**`, data in `.runtime/postgres`, creds in `.runtime/database.env` (mode 0600). Keep it running; **never start a second process on 15439**; never delete `.runtime/postgres` or regenerate creds against existing data.
- New shell: `set -a && . .runtime/database.env && set +a`, then `pnpm courtctl db migrate`.
- Migrations `migrations/0001..0013_*.sql` are **forward-only, no down, SHA-256 checksum-tracked** (runner: `src/platform/database.ts`, one transaction + advisory lock). Editing an applied file or reordering is **rejected** — corrections require a new forward migration. Naming: `####_lower_snake.sql` (4+ digit prefix, unique/sorted).
- DB tests need `COURT_TEST_DATABASE_URL`; without it they **skip** (skipping ≠ acceptance). Tests create/drop isolated schemas `court_test_<uuid>`. `test/dev-database.test.ts` self-provisions (slower, 60s timeout). Never point tests at a production DB.
- Common env: `COURT_DATABASE_URL`, `COURT_TEST_DATABASE_URL`, `COURT_STORAGE_DIR`, `COURT_ALLOW_LIVE_MN`, `API_TOKEN_{READ,WRITE,ADMIN}`, `COURT_BROWSER_{MODE,HEADED}`, `COURT_CHROME_BIN`, `COURT_SESSION_FILE`, `MCRO_{OUTPUT_DIR,STATE_FILE,MIN_DELAY_MS,MAX_DELAY_MS,CONCURRENCY,MAX_RETRIES}`, `COURT_PROXY` / `COURT_PROXIES`, `DECODO_*`, `MCP_ROLE`/`MCP_TOKEN`.

## Where to look
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

Dependency direction: `bootstrap → CourtService → contracts ← adapters → legacy browser/search/roa/downloader → waf/config`. New source behavior: start at `contracts.ts`, implement in `adapters.ts`, check job/persistence effects in `service.ts`.

## Architecture invariants
- Keep layers separate: discovery ≠ observed docket ≠ immutable PDF bytes ≠ derived text ≠ interpretation. "All discovered PDFs downloaded" ≠ statewide completeness; unknown populations stay unknown; partial observations never imply removal. Legacy `downloads/` manifests are `docketComplete=false` — don't infer a full docket.
- Artifacts are content-addressed (SHA-256), originals immutable. HTTP artifact access is by authorized document UUID, never caller-chosen paths.
- CLI, Fastify HTTP (`/api/v1`, bearer read/write/admin), and MCP stdio all share one `CourtService`; API/MCP/CLI use the narrower `interfaces.ts` boundary.
- `worker --drain` = "nothing runnable now", not "complete". A successful search stage ≠ descendant downloads/OCR finished.
- Terraform defaults `deployment_approved=false`, `runtime_enabled=false` → creates no infra. `infra/database-roles.sql` is applied separately after migrations. Production does not auto-migrate on startup.

## Compliance boundary
- `ensureTermsAccepted` (`src/waf.js`) accepts the Minnesota terms modal automatically when present; it no longer refuses or throws `blocked`. A visible terms modal no longer halts work.
- `checkWafBlock` **detects** blocks/CAPTCHAs and throws `blocked`; it does not solve or bypass. On `403`/`429` the shared source pauses — stop; do not retry or rotate identity.
- Live MN needs **all** of: persisted source enablement, `COURT_ALLOW_LIVE_MN=true` in the worker process, explicit `--live-adapter` (`pnpm live:mn`), and a verified saved session. Bounded pilot: 150 source requests / 15 PDFs / 128 MiB.
- **Doc/code drift:** `README` claims "No proxy rotation, stealth plugin, CAPTCHA solver, or unattended challenge bypass," yet `src/browser.js` masks `navigator.webdriver` + `--disable-blink-features=AutomationControlled`, `src/config.js` supports `COURT_PROXIES`/`COURT_PROXY`, and `scripts/decodo-provision.mjs` provisions sticky US residential proxies (commit `047b0c8` "WAF bypass, sticky proxy pool"). `ensureTermsAccepted` now clicks acceptance for the operator. CAPTCHA/challenge bypass and header/referer spoofing remain out of scope; require explicit owner sign-off before adding them.

## Gotchas
- Never use `docker compose down --volumes`, reset, or schema wipe as recovery (deletes `postgres`/`artifacts` volumes). Stack: PG only on loopback `5432`, API on `127.0.0.1:3000`.
- `.runtime/*` (`postgres`, `artifacts`, `feasibility/`, `live-feasibility/`, `decodo.env`, `database.env`, `compose.acceptance.env`) and `downloads/` are protected: never print/share secrets, never move/rewrite/purge originals.
- CI (`.github/workflows/ci.yaml`): typecheck → build → `db migrate` twice (idempotency) → `pnpm test` against real PG → infra tests → `terraform validate` (no plan/apply) → compose config + `docker build --check`; `COURT_ALLOW_LIVE_MN=false`.
- `.codegraph/` is a symlink to an external index — pass `projectPath` to codegraph tools.
