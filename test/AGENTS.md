# test AGENTS.md — test conventions

## How to run

| Scope | Command |
|---|---|
| All tests | `pnpm test` = `node --import tsx --test test/*.test.js test/*.test.ts` |
| One file | `node --import tsx --test test/adapter.test.ts` (tsx **required** for `.ts`) |
| One named test | `node --import tsx --test --test-name-pattern="<name>" test/<file>` |
| Infra tests | `node --test infra/tests/*.test.mjs` |
| Offline acceptance | `pnpm accept:mn` (synthetic, needs DB env) |
| Feasibility | `pnpm feasibility:mn` |

## DB tests

- Need `COURT_TEST_DATABASE_URL`; without it they **skip** (skipping ≠ acceptance).
- Tests create/drop isolated schemas `court_test_<uuid>`. `test/dev-database.test.ts` self-provisions (slower, 60s timeout).
- Never point tests at a production DB.

## Test files (25)

`acquisition-regressions.test.js`, `adapter.test.ts`, `adapter-dom.test.ts`, `downloader.test.js`, `feasibility-transport.test.ts`, `live-integration-review.test.ts`, `platform-failure.test.ts`, `platform-retention.test.ts`, `platform-service.test.ts`, `platform-storage.test.ts`, `processing.test.ts`, `search.test.js`, `state.test.js`, `statewide.test.js`, `platform-case-interpretation.test.ts`, `platform-database.test.ts`, `platform-geography.test.ts`, `platform-native-validation.test.ts`, `platform-processing.test.ts`, `platform-refresh.test.ts`, `imports.test.ts`, `interfaces-mcp.test.ts`, `interfaces.test.ts`, `native-tools.test.js`, `nlp.test.js`, `ocr.test.js`, `dev-database.test.ts`

Fixtures: `test/fixtures/adapters/{exhibit.pdf,independent.json,mn-roa-observed.html,petition.pdf}` — synthetic, not court records.

## Conventions

- Real PostgreSQL, real migrations, `CourtService`, `JobQueue`, local content-addressed storage, Fastify injection against the real service (per `platform-failure.test.ts`).
- Each DB test: random schema, schema-specific pool, drop only that schema.
- Disconnect tests terminate **only** their own transaction backend (`pg_terminate_backend(pg_backend_pid())`); never another session or the server.
- Storage-write faults are real local filesystem obstructions, not mock writes.
- Artifact tests require `pdfinfo` on PATH; PDF bytes generated in memory (complete catalog/page tree/text stream/xref/trailer). No downloaded user files copied into fixtures.
- Independent adapter's checked-in PDFs are explicitly synthetic.
- Native-tool fixture tests **skip** when binaries absent; a skip is not acceptance.
- No mock-only DB substitution or unexplained skip; no live cloud/model success claimed.
- New tests must catch plausible consumer-visible bugs: deterministic, isolated, full-suite-safe. Never test wiring/echoes/source text/incidental defaults/tautologies/bare-not-throw/length-grew. Update contract tests your change breaks; delete wording/implementation ones regardless of author.
