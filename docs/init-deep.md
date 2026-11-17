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
