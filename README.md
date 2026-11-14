# MCRO-Puller / courtctl

A source-grounded court-record acquisition platform, beginning with Minnesota MCRO. It separates discovery, observed dockets, immutable PDF bytes, derived text, and interpretation. Unknown statewide populations remain unknown; downloading every discovered PDF is not statewide completeness.

**Minnesota-first local application verified; live collection/cloud operation not yet verified.** The controlling milestone is [WO-MCRO-MN-FIRST-001](docs/WO_MN_FIRST_001.md). Start with the [handoff](docs/HANDOFF.md); exact evidence and limitations are in [Minnesota acceptance](docs/MINNESOTA_ACCEPTANCE.md).

## Runtime

Node.js 24+, pnpm 12.18.0, PostgreSQL 17+, Poppler (`pdfinfo`, `pdftotext`, `pdftoppm`), Tesseract English, and Playwright Chromium for browser work. LLM processing is optional and disabled by default. No proxy rotation, stealth plugin, CAPTCHA solver, or unattended challenge bypass is provided.

```sh
pnpm install --frozen-lockfile
pnpm exec playwright install chromium
pnpm dev:database
```

The development database command runs an isolated persistent PostgreSQL cluster on loopback port 15439 under ignored `.runtime/postgres`. It creates random development credentials in mode-0600 `.runtime/database.env`; keep the process running. It does not reuse another local database. In a second shell:

```sh
set -a
. .runtime/database.env
set +a
pnpm courtctl db migrate
pnpm courtctl sources list
pnpm courtctl source caps --state MN
pnpm build
```

For Docker/Google Cloud configuration and approval boundaries, see [deployment](docs/DEPLOYMENT.md). Do not point integration tests at a production database.

## Offline end-to-end acquisition

The second adapter uses independent **synthetic** records, not a second live state. It exercises different case IDs, cursor pagination, attachments and availability states without contacting a court.

```sh
pnpm courtctl acquire --query '{"sourceId":"independent-fixture","searchType":"party","lastName":"Doe","firstName":"Jane"}' --idempotency-key demo-doe-1
pnpm worker --drain
pnpm courtctl db search --source independent-fixture
pnpm courtctl db filing-search --source independent-fixture --q petition
pnpm courtctl storage verify
```

Use an actual fixture name from `test/fixtures/adapters/independent.json` when selecting a different scenario. `jobs status UUID` exposes workflow completion separately from an individual stage. A successful search does not mean descendant downloads or OCR finished.

## Minnesota and bulk requests

All supported search modes expose validated, source-specific combinations through `source caps`. Case, citation, party, business, attorney, hearing, judgment and document modes are distinct; filters cannot be combined arbitrarily. Current source evidence levels distinguish documented controls from live verification.

```sh
pnpm courtctl source search --state MN --query '{"searchType":"case","caseNumber":"67-CV-26-300"}' --idempotency-key search-example-1
pnpm courtctl acquire --state MN --query '{"searchType":"case","caseNumber":"67-CV-26-300"}' --idempotency-key acquire-example-1
pnpm courtctl bulk --file queries.jsonl --idempotency-key batch-example-1
pnpm courtctl discovery plan --query '{"sourceId":"mn-mcro","searchType":"party","lastName":"Anderson","firstName":"John","filedFrom":"2026-01-01","filedTo":"2026-01-31"}'
pnpm courtctl schedule due
```

These commands enqueue durable work, not immediate live access. Minnesota defaults disabled. Execution requires **both** persisted operator enablement and that worker process's `COURT_ALLOW_LIVE_MN=true`, only after separate source permission/access review. Neither setting is authorization. Read-only process startup cannot change administrative enablement. Challenge/rate-limit responses pause the shared source. Continuous `pnpm worker` schedules due discovery and known-case refresh independently; `--once` executes one due job and `--drain` stops when no job is currently runnable. Delayed retries, paused work and failed descendants are not completion.

JSON batches use `{ "queries": [...], "acquireResults": true }`; JSONL uses one query object per line. CSV uses query-field headers. Invalid query objects remain item-level errors; malformed container syntax cannot be interpreted safely. See [API and CLI](docs/API.md) and [feed imports](docs/IMPORTS.md).

## Persistence and processing

- PostgreSQL migrations: source registry, scoped case identifiers, snapshots, stable entries, changes, participants, proceedings, document versions, processing provenance, jobs, leases and coverage.
- Local or GCS content-addressed storage: structurally validated PDFs, SHA-256, immutable originals, current-version pointers and acquisition observations.
- Every observed docket entry persists, including entries without files. Partial observations never imply removal of unseen entries.
- Embedded text first, page-level quality checks, selective OCR, bounded processing workers, exact page/text spans and versioned classification/entity extraction.
- Optional model output remains separate from court facts. Allegations are not findings. Exact evidence quotes are necessary provenance, not proof that a model interpretation is correct.

Existing files are imported without moving/deleting originals:

```sh
pnpm courtctl import-legacy --directory downloads
```

Older download-only manifests remain incomplete dockets; missing events are not fabricated. Legacy `node cli.js --help` commands remain for local acquisition, but the PostgreSQL platform is the durable cloud path. Obsolete proxy and unsupported filter-only statewide enumeration commands were removed rather than retained as misleading aliases.

## HTTP and MCP

Set distinct strong `API_TOKEN_READ`, `API_TOKEN_WRITE`, `API_TOKEN_ADMIN`, then `pnpm api`. Versioned routes and authenticated OpenAPI are under `/api/v1`. Bearer roles control acquisition and administration. Shared PostgreSQL admission budgets complement source-specific request budgets. Downloadable artifacts are authorized by document ID, not arbitrary paths.

`pnpm mcp` serves official MCP SDK stdio tools. Local MCP defaults read-only; acquisition/admin require configured matching credentials. CLI and MCP are local processes with database access, not a public remote shell. See [API](docs/API.md) for tool names and authorization.

## Verification and operations

```sh
pnpm check
pnpm build
pnpm accept:mn
node --test infra/tests/*.test.mjs
```

PostgreSQL tests require `COURT_TEST_DATABASE_URL`; the development environment file supplies the isolated database. Tests use separate schemas. `accept:mn` creates/drops its own schema and temporary copied-artifact store, parses synthetic Minnesota-shaped HTML with the production parser, and exercises compiled CLI/worker/HTTP/MCP, refresh, restriction and crash recovery. It blocks browser network requests and leaves originals untouched. It uses installed system Chrome on macOS, otherwise installed Playwright Chromium. See [acceptance](docs/MINNESOTA_ACCEPTANCE.md) for the exercised 252-test checkpoint, including persistent database restart, not just commands.

- [Coverage methodology](docs/COVERAGE.md)
- [Processing](docs/PROCESSING.md)
- [Failure matrix](docs/FAILURE_MATRIX.md)
- [Deployment](docs/DEPLOYMENT.md)
- [Operations and recovery](docs/OPERATIONS.md)
- [Security](docs/SECURITY.md)
- [Opt-in retention](docs/RETENTION.md)
- [Capacity and cost](docs/CAPACITY.md)

Production provisioning, material cloud expenditure, external model inference and newly authorized source interfaces require their respective approval/configuration. No production cloud resources are created by the local development workflow.
