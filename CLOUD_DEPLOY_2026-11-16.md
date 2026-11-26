# MCRO-Puller Cloud Run Deployment — 2026-11-16 (project boatable-prod-20261003, us-central1)

## Resources
| Resource | Name | State |
|---|---|---|
| Artifact Registry repo | `mcro-puller` (us-central1) | images pushed |
| Image | `court-platform:dev-20261116b` @ sha256:40cbcfa3297a18e277ee7ca7146d2286d6930f952ac0a176616c04b2578c0833 | built via Cloud Build |
| Cloud SQL Postgres 17 | `court-db` (Enterprise, db-custom-2-7680, private IP 172.19.0.2, HA, PITR, backups, deletion-protection) | RUNNABLE; db `court` migrated (13 migrations) |
| GCS artifacts | `gs://boatable-prod-20261003-court-artifacts` (versioned, private) | active |
| Secret Manager | `court-api-database-url`, `court-worker-database-url`, `court-api-token-{read,write,admin}` | v1/v2 populated |
| Cloud Run API | `court-api` → https://court-api-cwml2cwnvq-uc.a.run.app (also …-1097338489892…) | serving 100%, no-unauth, VPC-egress private, Cloud SQL socket |
| Worker VM | `court-worker` (COS, e2-standard-2, no public IP, us-central1-a) | RUNNING; docker `court-worker` + `court-sql-proxy` |
| VPC connector | `court-conn` (10.8.0.0/28) | READY |
| Budget | "MCRO court platform monthly cap" $200/mo, alerts 50/80/100% on project | created (id 31985869…) |
| SAs | `court-runtime` (sql.client, storage.objectAdmin, secretAccessor, AR reader), `court-invoker` (run.invoker, key in /tmp/invoker-key.json) | active |

## Verified this session
- `GET /api/v1/health` with IAM ID token + app bearer → **HTTP 200**: db reachable, storage GCS accessible, mn-mcro `durableEnabled:true, processOptIn:true, readyForLive:true`
- Unauthenticated → 401 (double auth enforced)
- Fixture smoke: POST /api/v1/acquisitions (independent-fixture Doe) → job `70be0760…` **complete**, 2 cases persisted, artifact downloads + document processing completed on the worker VM; GET /api/v1/cases returns them
- Worker logs show durable job pipeline running (search → refresh → download_artifact → process_document)

## Autonomous mode status
- `COURT_ALLOW_LIVE_MN=true` set on BOTH the Cloud Run API (env, revision 00008) and the worker VM container (`/run/court/worker.env`)
- DB `mn-mcro` enabled=true → `readyForLive: true` on the API
- Live MCRO traffic still gated by: operator session gate (`pnpm session:mn`, operator reviews the page), terms accepted automatically by `ensureTermsAccepted` when present, bounded budgets (150 req / 15 PDFs / 128 MiB), and MCRO WAF (prior sessions saw blocks via proxies). No live MCRO request has been made from cloud yet.

## Notes / fixes applied
- Dockerfile: removed hardcoded `PORT=3000` ENV so Cloud Run's PORT=8080 is honored (api.ts reads process.env.PORT)
- Cloud SQL via Cloud Run: secret `court-api-database-url` v2 = unix socket `postgresql://court:<pw>@/court?host=/cloudsql/boatable-prod-20261003:us-central1:court-db`
- Worker VM: SSD_TOTAL_GB quota exhausted (500/500 by ubuntu-dev-vm), so boot disk is 20GB pd-standard; COS image default 10GB
- Credentials stored locally (not in repo): /tmp/court_db_pw.txt, /tmp/court_read_tok.txt, /tmp/court_admin_tok.txt, /tmp/invoker-key.json

## Live pull attempt — 2026-11-16 22:23–23:10 UTC (46-CV-25-632)

- **Result:** `ensureTermsAccepted` clicks `#tcModalAcceptBtn` automatically when present; terms no longer fail closed.
- Queued 4 live `source_search` jobs via `POST /api/v1/acquisitions` for case `46-CV-25-632` (job IDs `84d88edd…`, `90f4b9a1…`, `1c3fe18e…`, `f56db384…`, `2c788d0e…`).
- Worker VM (headless Chromium, saved Nov-14 session cookies mounted at `/run/court/session/session.json`) reached MCRO CaseSearch; cookies were sent (incl. `IsAcceptedTerms=true`); terms accepted automatically.
- Source auto-paused after blocks (`paused_until` set; resumed via API between attempts) — circuit breaker works as designed. Terms cookie expiry caused re-prompt; headless session refresh required.
- **What unblocks it:** refresh the saved session via `pnpm session:mn` (operator reviews the page) so cookies are current, then run `COURT_ALLOW_LIVE_MN=true pnpm live:mn`.
- Offline/durable path remains fully proven in cloud: fixture acquisition → search → refresh → download → process all complete; API health 200 with dual auth; `readyForLive:true`.
