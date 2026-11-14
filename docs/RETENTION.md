# Explicit local retention

Retention is off by default (`enabled=false`, `artifactGcEnabled=false`). No age-based deletion runs at installation. Requests apply only to the platform's copied artifacts and derived records, never the original `downloads` directory. Restriction is local policy, not a claim that a court sealed a record.

Administrator workflow (compiled CLI; use only authorized case/document UUIDs):

```sh
node dist/src/platform/courtctl.js retention-policy get
node dist/src/platform/courtctl.js retention-policy set --policy '{"enabled":true,"artifactGcEnabled":false}'
node dist/src/platform/courtctl.js retention request --query '{"caseId":"CASE_UUID","action":"restrict","dueAt":"2026-12-01T00:00:00Z","reason":"Reviewed local restriction"}' --idempotency-key restriction-1
node dist/src/platform/courtctl.js retention run REQUEST_UUID --idempotency-key execute-restriction-1
node dist/src/platform/courtctl.js retention status REQUEST_UUID
```

Requests and execution are separate explicit steps. `run` creates a durable job that cannot execute before `dueAt`. `restrict` withdraws reads without destroying evidence. `purge` also removes versions, extraction text/entities/assertions and affected case interpretation; a case purge removes docket/participant/proceeding projections and copied feed content. Case/document identity tombstones prevent later source observations from republishing purged projections. Operator reasons must not contain copied sensitive filing text.

Physical deletion additionally requires `artifactGcEnabled=true`. Without it, logical purge commits but reports `cleanup_pending`, never complete physical deletion. Failed object deletion stays in a durable outbox; worker retries are bounded. After correcting policy/storage, explicitly retry the partial/dead job or submit a new execution key. No automatic infinite retry loop or silent cleanup success. Unknown/unsafe storage keys remain explicit failures.

Upload plus artifact/reference persistence takes a shared PostgreSQL advisory lease. GC takes the exclusive lease, checks all retained version/acquisition references, and only then removes an unreferenced object. Identical bytes shared by another document remain. Deletion is idempotent when a crash occurred after unlink but before acknowledgement. **One artifact namespace must belong to exactly one database/schema**; sharing a bucket/root across independently locked databases is unsupported.

Withdrawal fences affected jobs and redacts cached ancestor results without cancelling unrelated sibling workflows. Read projections hide withdrawn documents and redact opaque case/docket metadata that may contain their contents. CLI, REST and MCP use the same visibility checks. Existing backups/object generations are separate retention obligations: restrict backup access and apply an approved lifecycle; the application does not silently delete external backups.

REST: administrator-only `/api/v1/retention-policy`, `/retention`, `/retention/:id`, `/retention/:id/run`; write submissions use the documented Idempotency-Key header. MCP equivalents are `get_retention_policy`, `set_retention_policy`, `request_retention`, `get_retention_request`, `run_retention`, visible only to authenticated administrator processes.

Evidence: nine real-PostgreSQL retention regressions cover default-off/due dates, read withdrawal, job fencing, shared hashes, interrupted unlink replay, sticky document-only purge, upload/GC serialization, unsafe keys/original preservation, and idempotency/guard rollback. These tests use synthetic copied material in disposable schemas/storage, never original filings.
