# infra AGENTS.md — Terraform, Docker, Compose, CI gates

## Layout

| Path | Purpose |
|---|---|
| `main.tf` | GCP architecture: private PostgreSQL 17 Enterprise, GCS bucket, Cloud Run API, browser VM |
| `modules/platform/main.tf`, `variables.tf`, `worker-startup.sh.tftpl` | Platform module |
| `database-roles.sql` | Applied separately after migrations; runtime SQL grants |
| `Dockerfile`, `compose.yaml` | Container and local Compose stack |
| `benchmark.mjs`, `benchmark-corpus.sql`, `healthcheck.mjs` | Benchmarking and health checks |
| `tests/benchmark.test.mjs`, `tests/deployment.test.mjs` | Infra tests |
| `.terraform.lock.hcl` | Provider lock |
| `.github/workflows/ci.yaml` | CI: typecheck → build → migrate twice → test → infra tests → terraform validate → compose config + docker build --check |

## Deployment gates

- Terraform defaults `deployment_approved=false`, `runtime_enabled=false` → creates no infra.
- No deploy workflow; CI never runs Terraform plan/apply, pushes images, or authenticates to GCP.
- `infra/database-roles.sql` predates integrated refresh/retention administrative writes; review/update and test dedicated runtime grants before enabling deployment.
- Cloud SQL: PITR/backups retained 14 copies / 7 days PITR logs; 500 GiB cap.
- GCS: versioning + 7-day soft delete; no automatic deletion lifecycle or locked retention.
- Cloud Run requires both IAM invocation and application authorization (distinct tokens).
- No public signed URLs, public bucket grants, or `allUsers` bindings.

## Local Docker/Compose

- PostgreSQL on loopback 5432, API on 127.0.0.1:3000.
- `docker compose down --volumes` destroys `postgres`/`artifacts` volumes — never use as recovery.
- Image `court-platform:local`; Node 24.22.2, pnpm 12.18.0, frozen lockfile, Poppler/Tesseract/Chromium, UID 1000 with tini.
- Deny-default context: only package/build inputs, `src`, migrations, health probe admitted. Excludes Git, env files, keys, transcripts, sessions, JSONL, PDFs, downloaded records. Exceptions: three named synthetic adapter fixture assets.

## Verification commands

```
pnpm typecheck
pnpm build
COURT_TEST_DATABASE_URL="$DISPOSABLE_DATABASE_URL" pnpm test
node --test infra/tests/*.test.mjs
terraform -chdir=infra init -backend=false
terraform -chdir=infra validate
docker compose config --quiet
docker buildx build --check .
```
