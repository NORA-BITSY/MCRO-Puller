# migrations AGENTS.md — migration rules and forward-only discipline

## Rules

- Migrations `migrations/0001..0013_*.sql` are **forward-only, no down, SHA-256 checksum-tracked**.
- Runner: `src/platform/database.ts`, `migrate()` — one transaction + advisory lock.
- Editing an applied file or reordering is **rejected** — corrections require a new forward migration.
- Naming: `####_lower_snake.sql` (4+ digit prefix, unique/sorted).
- Current files: `0001_platform.sql` through `0013_artifact_revalidation.sql`.

## Key migrations

| # | Name | Purpose |
|---|---|---|
| 0001 | platform | Sources, cases, identifiers, docket snapshots, entries, documents, artifacts, versions, participants, proceedings, jobs, attempts, links, coverage |
| 0002 | feed_imports | Metadata feed lineage tables |
| 0003 | service_governance | Source enable/pause/health controls |
| 0004 | reconciliation_states | Entry versions and changes |
| 0005 | query_safety | Query safety constraints |
| 0006 | retry_generations | Job retry/generation tracking |
| 0007 | artifact_observations | Artifact acquisition attempts |
| 0008 | canonical_geography | States, jurisdictions, courts projections |
| 0009 | refresh_policy | Adaptive refresh singleton policy |
| 0010 | case_interpretation | Optional case interpretation tables |
| 0011 | retention | Retention policy/requests/deletions/events |
| 0012 | discovery_recovery | Discovery partition generations/recovery |
| 0013 | artifact_revalidation | Artifact revalidation hours/fingerprints/deadlines |

## Running

- `pnpm courtctl db migrate` — applies forward migrations.
- CI runs migrations twice (idempotency check).
- Never point tests at a production DB; DB tests use `COURT_TEST_DATABASE_URL` with isolated schemas.
