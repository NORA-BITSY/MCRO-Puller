# Deployment

This repository does not authorize deployment or spending. Terraform has not been applied by this work. Live portal acquisition and external inference remain disabled until separately approved. Local Docker/CI checks are distinct from live court or cloud verification.

Local implementation checkpoint819b512 passed a real image/Compose/PostgreSQL/native/Chromium fixture run; details and digests are in [Minnesota acceptance](MINNESOTA_ACCEPTANCE.md). **Cloud operations remain NOT VERIFIED.** Before enabling the restricted-role deployment, update/review `infra/database-roles.sql` for integrated refresh/retention administrative writes and test those roles; local acceptance used isolated development-owner credentials. The shipped create/get-only worker GCS role intentionally cannot perform physical retention deletion: that needs a separately approved custodian permission/workflow. These are deployment gates, not permission to broaden IAM now.

## Reproducible image

`Dockerfile` uses Node 24.22.2 with an observed multi-architecture image digest, pnpm 12.18.0, the committed frozen lockfile, and a dated Debian snapshot. Compose and CI pin the PostgreSQL 17 Bookworm image digest observed on 2026-11-14. It builds `dist/src/platform/{api,courtctl,mcp,worker}.js`; the API is the default process. Runtime includes real Poppler (`pdfinfo`, `pdftotext`, `pdftoppm`), English Tesseract and the Chromium version selected by the locked Playwright package. It runs as UID 1000 with tini. Browser libraries are installed during image creation, not at startup.

The digests are reproducibility pins, not indefinite security guarantees. Before production, review current Node/PostgreSQL security releases, dependency advisories, Debian snapshot and browser release together; update reviewed pins and rerun CI. The slim base lacks system CA certificates: the image first installs `ca-certificates` through the base image's configured Debian repositories, authenticated by its Debian archive keyring, then switches to the dated HTTPS snapshot. TLS certificate checks and apt signature checks remain enabled. This trust-bootstrap package and its dependencies resolve against the current base-configured repositories, so that step is not snapshot-reproducible; record its installed versions with the release image digest. Subsequent native PDF/OCR/browser package resolution uses the snapshot. Builds need access to npm, Debian repositories/snapshot and Playwright distribution servers. Byte-identical image manifests and completely frozen native dependency resolution across rebuild dates are not claimed. Terraform provider binaries are constrained by the committed `.terraform.lock.hcl`; Google provider 6.50.0 passed `terraform init -backend=false` and `terraform validate` locally.

The Docker context is deny-by-default. Only package/build inputs, `src`, migrations and the health probe are admitted; final denies exclude Git, environment files, keys, transcripts, sessions, JSONL, PDFs and downloaded records. The only record-file exceptions are the three explicitly named synthetic adapter fixture assets (`independent.json`, `petition.pdf`, `exhibit.pdf`), copied into `test/fixtures/adapters` so the independent fixture source works in the image. These are not court records or evidence of another live state. Do not widen the allowlist to arbitrary downloaded data.

## Local PostgreSQL

Requirements: Docker Engine with Compose v2, enough memory for PostgreSQL plus Chromium/OCR, and a free loopback port 5432/3000. Use unique ephemeral values in your shell (do not commit `.env`):

```sh
export POSTGRES_PASSWORD="$(openssl rand -hex 24)"
export API_TOKEN_READ="$(openssl rand -hex 32)"
export API_TOKEN_WRITE="$(openssl rand -hex 32)"
export API_TOKEN_ADMIN="$(openssl rand -hex 32)"
docker compose up --build -d
docker compose ps
docker compose exec api node infra/healthcheck.mjs
curl --fail --header "Authorization: Bearer $API_TOKEN_READ" http://127.0.0.1:3000/api/v1/health
```

The one-shot `migrate` service waits for real PostgreSQL, then API/worker wait for migration success. Database and artifact volumes survive `docker compose down`; `down --volumes` destroys them. Keep `POSTGRES_PASSWORD` available across restarts: replacing an environment value does not change an existing PostgreSQL role password. The local shared database owner is development-only, not the production privilege model. Credentials must be URL-safe hexadecimal here; percent-encode credentials in general connection URLs.

To run from the host against this database:

```sh
export COURT_DATABASE_URL="postgresql://court:$POSTGRES_PASSWORD@127.0.0.1:5432/court"
export COURT_TEST_DATABASE_URL="$COURT_DATABASE_URL" # disposable database only
pnpm install --frozen-lockfile
pnpm build
node dist/src/platform/courtctl.js db migrate
```

CLI/MCP are trusted local processes and require database/storage access. They do not inherit the HTTP authorization boundary. Never expose MCP stdio through an unauthenticated network bridge.

## Runtime configuration

| Variable | Contract |
| --- | --- |
| `COURT_DATABASE_URL` | Real PostgreSQL connection URL. Migration owner for migration command; separate runtime role for API/worker. |
| `COURT_STORAGE_DIR` | Local content-addressed artifact directory (Compose volume). |
| `COURT_GCS_BUCKET` | Production GCS artifact bucket; use attached service-account ADC, not JSON keys. |
| `COURT_ALLOW_LIVE_MN` | `false` in all shipped configurations; a separate authorization/source review is required to set `true`. |
| `API_TOKEN_READ`, `API_TOKEN_WRITE`, `API_TOKEN_ADMIN` | Mandatory distinct nonempty API bearer tokens; write/admin imply lower access. Never build arguments. |
| `PORT`, `HOST` | API defaults 3000 and 0.0.0.0. Cloud Run provides its port. |
| `PLAYWRIGHT_BROWSERS_PATH` | Image sets `/ms-playwright`; do not override with a host path. |

The production image starts the standalone worker directly; it does not provide a browser extension/session or solve a challenge. Source adapters enforce explicit live opt-in independently of infrastructure.

## GCP architecture and approval gates

`infra/main.tf` has `deployment_approved=false` and `runtime_enabled=false`. Default resource count is zero. There is no deploy workflow and CI never runs Terraform plan/apply, pushes images or authenticates to GCP.

The module defines private PostgreSQL 17 Enterprise (2 vCPU/7.5 GiB, regional HA), 100 GiB SSD with bounded growth, PITR/backups; a private versioned GCS bucket; a maximum-three-instance Cloud Run API; and one e2-standard-2 Container-Optimized OS browser VM without public IP or inbound firewall rules. Cloud Run uses Direct VPC egress and an explicit `--private-ip` Cloud SQL Auth Proxy sidecar (not a socket integration with an implicit public-IP choice). The VM runs a private-IP proxy on a nonpublished Docker bridge. Cloud NAT permits ordinary HTTPS egress, not identity cycling or proxy rotation. VM worker egress is limited to HTTPS and its SQL proxy connection; metadata/DNS are platform-local. There is no browser debug endpoint. A VM is chosen because browser sessions and durable workers must not depend on request-scoped Cloud Run CPU.

A separately approved release operator must:

1. Select project/region, account owners, budget alerts/quotas and protected encrypted remote Terraform state with locking. Set nonempty `labels` keys `owner`, `env`, and `cost-center`; the provider applies these to label-capable resources and approval validation requires them. Configure actual/forecast budget notifications at 50%, 80% and 100%, verify consumption daily and review idle VM/disks/NAT/SQL resources before any new launch. Budgets are alerts, not hard caps. Bootstrap state and billing controls outside this module; never commit local state/plan files. Review provider lock/checksums. `terraform -chdir=infra init -backend=false` and `terraform -chdir=infra validate` are offline configuration gates after provider download, not deployment proof.
2. Build/test the reviewed image, publish to an existing regional Artifact Registry repository and record its digest. Select an exact COS image and reviewed Cloud SQL Auth Proxy v2 image digest. Terraform deliberately has no guessed defaults for these release artifacts.
3. Obtain explicit spending approval before planning with `deployment_approved=true`. Keep `runtime_enabled=false` for infrastructure bootstrap. Review a saved plan and its IAM/network/cost deltas under the organization's approval process. Do not infer authorization from these instructions.
4. From a private-network administrative session, create a dedicated migration owner, migrate the `court` database and run `infra/database-roles.sql` as schema owner. Set each runtime role password through `psql`'s `\password` prompt (not command-line SQL). Review grants against the release's operations. No runtime identity receives database ownership, CREATE/ALTER, superuser or migration-write access.
5. Populate the five Terraform-created Secret Manager secret IDs out of band. Terraform stores references/metadata only, not payloads or secret versions. API URL shape: `postgresql://court_api:ENCODED_PASSWORD@127.0.0.1:5432/court` (same-instance proxy sidecar). Worker URL shape: `postgresql://court_worker:ENCODED_PASSWORD@court-sql-proxy:5432/court` (private Docker bridge). The proxies authenticate/encrypt the upstream connection; these local transport URLs must not demand a second PostgreSQL TLS layer. Grant secret access only to the matching runtime service account.
6. Set `runtime_enabled=true`, the digest-pinned `image`, existing `artifact_repository`, `proxy_image`, exact `cos_image`, and explicit `invokers` principals. After separate plan approval, the operator may release. Secret `latest` is resolved at instance start; rotate by creating versions and rolling instances. Record version numbers in the release manifest for rollback. Applications do not auto-migrate at startup.
7. Verify authenticated HTTP, migration history, worker lease renewal and a separately approved fixture smoke. Do not enable live sources as a smoke test. Confirm backups restore before accepting production records.

## Authentication and health

`GET /api/v1/health` requires a read-or-higher API bearer token. The Docker healthcheck sends that token to loopback with a four-second deadline and fails on non-200, missing token, timeout or connection error. It never prints credentials or response bodies.

Cloud Run requires **both** IAM invocation and application authorization. Supply the IAM identity token separately so it does not replace the application token:

```sh
curl --fail "$API_URL/api/v1/health" \
  --header "X-Serverless-Authorization: Bearer $(gcloud auth print-identity-token --audiences="$API_URL")" \
  --header "Authorization: Bearer $API_TOKEN_READ"
```

Use a principal/token issuance method approved for the service audience. No `allUsers` binding exists. Cloud Run's native startup probe is TCP only: it confirms listening, **not** database readiness. An authenticated monitor must check the HTTP health route; never embed a bearer token into a probe's Terraform literal headers. CI explicitly checks authenticated success and unauthenticated 401 locally.
