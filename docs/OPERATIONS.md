# Operations

## Boundaries and routine observation

PostgreSQL is authoritative for leases, retries, versions and restrictions; object storage is authoritative for artifact bytes. Browser profiles, container filesystems and local temporary OCR output are not backups. No portal availability, throughput, or cloud restore is claimed by this runbook. Record observed evidence in the release/work ledger after exercising the procedures.

Monitor authenticated `/api/v1/health`, API error/latency percentiles, database connections/locks/disk, queue age by source/type, lease renewals, retries/partial results, source pause/challenge events, OCR warnings, extraction failures and GCS integrity mismatches. A listening port does not prove readiness. Do not put names, DOBs, document bodies, SQL connection URLs, bearer tokens or complete source URLs in monitoring labels. External alerts and service-level objectives require operator configuration; Terraform currently provisions resources, not a staffed monitoring service.

Useful read-only queries (through a trusted SQL session):

```sql
SELECT type,status,count(*),min(created_at) AS oldest_created
FROM jobs GROUP BY type,status ORDER BY type,status;
SELECT id,type,lease_owner,lease_expires_at FROM jobs
WHERE lease_expires_at < now() ORDER BY lease_expires_at;
SELECT id,enabled,health,paused_until,min_interval_ms,max_concurrency
FROM sources ORDER BY id;
SELECT pg_size_pretty(pg_database_size(current_database()));
SELECT version,sha256,applied_at FROM schema_migrations ORDER BY version;
```

An old lease is not evidence that work never ran. Completion is fenced by lease token; retry actions must use the queue/service API, not arbitrary SQL edits to lease columns. Partial results and explicit source restrictions are not successes. Do not change source budgets to drain a backlog faster without source-policy review.

Use explicit audited controls rather than editing source rows:

```sh
node dist/src/platform/courtctl.js source pause --source mn-mcro --reason 'Access review pending' --minutes 60
node dist/src/platform/courtctl.js source disable --source mn-mcro --reason 'No approved automation route'
node dist/src/platform/courtctl.js sources list
node dist/src/platform/courtctl.js jobs status JOB_UUID
node dist/src/platform/courtctl.js metrics
node dist/src/platform/courtctl.js coverage --state MN
```

`source resume --source SOURCE --reason TEXT` clears only the pause; `source enable` changes administrative enablement. Neither is access permission or worker opt-in, and neither erases retry deadlines. Do not enable Minnesota under the current closed gate. Fixture pause/resume and durable administration were tested through the compiled CLI and authenticated API.

Retry only after diagnosing the failure: `jobs retry JOB_UUID` preserves history and advances the processing generation. A permanent/exhausted discovery partition requires explicit `discovery plan --query ORIGINAL_SUPPORTED_QUERY_JSON`; scheduler ticks do not resurrect permanent errors. Transient partition recovery is bounded to two generations with6h/12h backoff. Use the same submission key for uncertain delivery, not a new job per retry.

Continuous worker checks due discovery/refresh every60seconds. `--drain` stops when nothing is runnable **now**; inspect workflow status, future `available_at`, paused/disabled sources and descendants before declaring completion. SIGTERM/SIGINT aborts current work and closes resources; lease/fencing recovery handles abrupt process loss. Never manually expire a production lease to imitate the isolated acceptance fault injection.

## Migration and rollback

1. Stop/suspend producers and workers, record image digest/schema history, and take/verify a pre-release backup. For local development: `docker compose stop worker api` (do not remove volumes). Production change control chooses the corresponding service stop/traffic procedure.
2. Run `node dist/src/platform/courtctl.js db migrate` with the migration-owner URL from the same release image. The migrator serializes concurrent migrations with an advisory lock, applies transactions and checks immutable migration hashes. Never edit an applied migration or its hash ledger to make a check pass.
3. Reapply reviewed runtime grants using `infra/database-roles.sql` as the schema owner, then start the API and one worker. Check authenticated health, expected schema history, an approved fixture acquisition and lease behavior before increasing load.
4. For an application-only regression with compatible schema, route back to the recorded previous image digest and previous secret versions. Do not roll an old binary onto an incompatible schema.
5. There is no automatic down migration. For a destructive/incompatible schema regression, stop writes, restore a pre-release backup/PITR **into a separate instance**, validate data/object references, and switch the database secret plus image together. Preserve the failed database for investigation. A forward corrective migration is usually safer than rewriting history. Document records/jobs acquired after the selected restore point; reconcile or replay idempotently.

## Backups and restore drills

Cloud SQL is configured for regional HA, daily backups retained 14 copies and seven days of PITR transaction logs. HA is not protection against bad writes, access mistakes or corruption. GCS has versioning and seven-day soft delete; both live/noncurrent/soft-deleted bytes incur charges. There is deliberately no automatic deletion lifecycle or locked retention policy: legal retention/restriction requirements must be decided before data collection. A retention lock is irreversible and must not be casually enabled.

For a local logical backup, use a trusted session and an external encrypted destination:

```sh
pg_dump --dbname="$COURT_DATABASE_URL" --format=custom --no-owner --file="$BACKUP_FILE"
pg_restore --list "$BACKUP_FILE"
# RESTORE_DATABASE_URL must identify a new disposable database, never the source.
pg_restore --dbname="$RESTORE_DATABASE_URL" --no-owner --exit-on-error "$BACKUP_FILE"
```

A listing is not a restore drill. Against the isolated restore, run migration-history validation, counts/FK checks, fixture/read queries, and application artifact verification. Sample content hashes and PDF parsing against restored GCS object generations; preserve an object manifest (key, hash, generation, size) with the DB backup. Do not delete orphaned objects merely because they are absent from a restored older database. Never run `pg_restore --clean` against production. Backups contain personal data and require the same access/audit controls as production.

Production PITR/backup restoration is a separately approved cloud operation; choose the documented Cloud SQL restore-to-new-instance procedure, network and IAM controls first. Define RPO/RTO from a measured restore, not the seven-day retention setting. Target objectives must remain unclaimed until drills measure restore duration and the newest recoverable transaction. Verify project-level deletion protection and remote-state recovery separately.

Local restore evidence on2026-11-14: a synthetic PostgreSQL17 database was dumped with `pg_dump --format=custom --no-owner`, restored with `pg_restore --no-owner --exit-on-error` into a new disposable database, and inspected through the compiled application. Thirteen migrations, one case, three docket entries, two documents/pages and six jobs survived; both copied artifact references verified. The disposable restore database was removed afterward. This does not establish cloud PITR, large-corpus RPO/RTO or backup-object-generation recovery. See `.runtime/container-acceptance.json` and [acceptance](MINNESOTA_ACCEPTANCE.md).

Logical withdrawal/purge is explicit and default-off; see [retention](RETENTION.md). Original downloads are outside the copied artifact store and never purge targets. Backups and object generations need their own approved access/retention policy.

## Failure recovery

| Failure | Safe response |
| --- | --- |
| CAPTCHA, WAF/challenge, denial or source-policy change | Pause that source and preserve a sanitized reason. Stop automation. Human review/authorized access only; no solver, identity cycling, proxy rotation or retry storm. |
| Worker/container/VM dies | Restore worker service with the same release/config. Allow lease expiry/reclaim; inspect attempts and content hashes. Never assume exactly-once execution. |
| Database unavailable | Stop accepting readiness as healthy; preserve queued work. Diagnose private routing, Cloud SQL proxy and pool pressure. Restore connectivity before retrying; do not switch to an in-memory queue. |
| Duplicate request after client timeout | Reuse the original idempotency key and inspect the existing job. A new key is a new request, not a safe retry. |
| GCS write succeeds but DB transaction fails | Retry through the queue. Content addressing permits reuse; retain orphan bytes until reconciliation proves deletion safe. |
| Invalid/truncated PDF or OCR/parser timeout | Preserve the failed job and provenance; do not mark an artifact verified or fabricate text. Inspect tool limits and the source document. |
| Restricted/sealed/unavailable record | Restrict access through the supported administrative operation and preserve audit history. Do not circumvent portal access. Determine retention/removal duties before physical deletion. |
| LLM/schema/evidence validation failure | Record an incomplete processing result; deterministic text/OCR evidence stays distinct. Never convert a model guess into sourced fact. |
| API health 401/403 | Confirm distinct runtime tokens and (Cloud Run) the IAM identity/audience. Rotate/redeploy rather than disabling authorization. |
| Secret rotation | Add a new secret version, roll processes, verify both layers of auth, revoke old material. `latest` is not hot-reloaded into existing containers. |
| Storage/SQL disk growth | Review real byte/index/version usage; Cloud SQL growth is capped at 500 GiB. Raise caps only with approval, or partition/archive under a retention plan. No blanket delete. |

VM startup writes only its DB URL secret to root-readable `/run/court/worker.env` (RAM-backed). systemd supervises `court-sql-proxy` and `court-worker`; `docker stop` gives the worker a bounded graceful shutdown. Secret access failure prevents startup; it does not generate credentials. VM replacement loses only temporary files; durable jobs/objects remain external. Browser/OS/container patches require a reviewed new digest/image and a controlled restart. Access for emergency diagnosis must use an explicitly approved private/IAP administrative path; no SSH firewall is shipped.

## Verification commands (operator/CI, not evidence of execution)

```sh
pnpm typecheck
pnpm build
COURT_TEST_DATABASE_URL="$DISPOSABLE_DATABASE_URL" pnpm test
node --test infra/tests/*.test.mjs
terraform -chdir=infra init -backend=false
terraform -chdir=infra validate
docker compose config --quiet
docker buildx build --check .
docker build -t court-platform:validation .
```

CI installs real native tools, runs migrations twice and the PostgreSQL integration tests, validates Terraform without apply, builds the image, opens an offline Chromium page, and checks authenticated API health against real PostgreSQL. These checks cannot establish live portal completeness, regional cloud availability, external LLM correctness, production IAM correctness or disaster-recovery duration.
