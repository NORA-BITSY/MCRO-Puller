# Local Minnesota bulk metadata imports

`importFeed(pool, filePath, {sourceId: 'mn-mcro', format: 'csv' | 'pipe' | 'jsonl', acquireResults?: boolean})` imports a locally supplied Minnesota court extract into PostgreSQL. It does not obtain a subscription, authenticate to a feed, make HTTP requests, or enable a court source. Operators must obtain authorized official extracts separately and comply with their distribution/access terms. The importer cannot independently authenticate the provenance of a supplied file. Tests use explicitly synthetic extracts; no live feed acceptance is claimed.

## Command

```sh
export COURT_DATABASE_URL='postgresql://USER:PASSWORD@HOST/DATABASE'
pnpm exec tsx scripts/import-feed.ts /secure/extract.csv --format csv
pnpm exec tsx scripts/import-feed.ts /secure/extract.txt --format pipe
pnpm exec tsx scripts/import-feed.ts /secure/extract.jsonl --format jsonl --source-id mn-mcro
```

The command applies checksum-tracked migrations before importing. A **host** `pnpm build` also produces `node dist/scripts/import-feed.js` with the same arguments; the minimal production image does not package host import/development scripts. Run an authorized local feed import from the host build with the approved database connection, not a nonexistent image path. Exit status is0 for an import without rejected rows,2 for a completed import with row errors, and1 for an interrupted/failed import. Standard output contains the JSON report; failures go to stderr.

Only an explicit `--acquire-results` (or `acquireResults: true` in code) requests docket acquisition:

```sh
pnpm exec tsx scripts/import-feed.ts /secure/extract.csv --format csv --acquire-results
```

This enqueues `refresh_case` jobs through `JobQueue`, one per import/case, using stable idempotency keys. It does not enable `mn-mcro`, bypass its rate limits, or authorize live source access. Source opt-in and a running worker are separate operational prerequisites. Default imports, including retries, never enqueue source work. New metadata-only cases have `next_refresh_at = NULL`, preventing the scheduler from silently acquiring them. Previously scheduled cases retain their existing schedule.

## Input and mapping

Files are UTF-8. CSV and pipe-delimited files require a header record and use standard double-quote escaping, including quoted delimiters and multiline fields. JSONL requires one JSON object per physical line. Empty data records are errors rather than silently skipped observations. Headers are matched case-insensitively after removing spaces, underscores and hyphens. Unsupported fields are retained, not discarded or guessed into court identifiers.

| Normalized field | Explicit accepted field names (normalized spelling) |
| --- | --- |
| Required case number | `casenumber`, `courtcasenumber`, `courtfilenumber`, `mncourtcasenumber` |
| Feed-internal case identifier | `caseid`, `sourcecaseid` |
| Feed row identifier | `recordid`, `sourcerecordid` |
| Title | `casetitle`, `casename`, `casecaption`, `title` |
| Court | `court`, `courtname`, `caselocation`; otherwise county |
| Status | `casestatus`, `status` |
| County | `county`, `countyname` |
| Case type | `casetype`, `casecategory`, `category` |
| Filed date | `fileddate`, `datefiled`, `filingdate`, `casefileddate` |

Thus `Case Number`, `case_number`, and `CaseNumber` refer to the same explicit field. Generic `ID`, `CaseID`, and the first column are **never** inferred to be a case number. Duplicate normalized headers and conflicting aliases are rejected. The adapter's `mn-mcro` source identity is the uppercase case number; feed-internal identifiers are separately preserved in normalized row lineage and `case_identifiers` with `feed_case_id` provenance. Other source namespaces are refused.

Dates accept validated `YYYY-MM-DD` or `MM/DD/YYYY`; unknown date encodings are rejected rather than guessed. Missing status becomes `unknown`. Supplied source-specific statuses remain verbatim and never imply public/restricted availability, docket completeness, or a terminal acquisition state. Existing nonempty canonical title/court/status are not overwritten by a metadata extract; each incoming value remains available in its immutable row observation.

Each accepted row has a `case_id` foreign key, source-scoped identifiers, normalized metadata, source line number, row SHA-256, and raw source fields in `feed_import_rows`. Exact record bytes, including original line endings, are retained in `raw_bytes`; `raw_text` is a convenience UTF-8 view (NUL is escaped). Distinct charge or other detail rows for the same case are retained separately, including duplicates at different row positions. They are not collapsed into a single mutable raw field or misrepresented as docket events. No docket snapshots, entries, documents, or complete-population coverage assertions are fabricated.

## Checkpoints, recovery and errors

The importer streams a private, mode-0600 temporary snapshot while hashing the exact input bytes, then streams logical records from that snapshot. This avoids loading an extract into memory and prevents later path replacement from assigning rows to an incorrect checksum. Memory scales with the largest logical record, not file size; temporary disk space must accommodate the file. The snapshot is removed on normal completion or error. An uncatchable process termination can leave a private `court-feed-*` directory in the operating system temporary directory; apply the same retention/security controls there as to the source extract.

`feed_imports` identifies a run by source, whole-file SHA-256, format and mapping version. A row's case metadata, raw/normalized observation, optional acquisition intent, counters and contiguous checkpoint commit in one transaction. A database failure rolls back that entire row. Restart with the same file and options: committed observations are not reapplied and the first uncommitted row resumes. Re-reading the local file to its checkpoint is intentional and bounded-memory. Concurrent identical imports serialize each checkpoint transaction. Changed file bytes create a separate ledger and preserve earlier observations.

Malformed JSON, invalid row fields, mismatched CSV columns, and malformed closed CSV records are recorded as persistent row errors while remaining framed records continue. An unterminated quoted CSV field makes subsequent physical lines part of that same ambiguous logical record; the complete trailing bytes are preserved as one rejected record rather than guessing boundaries or manufacturing cases. Invalid headers reject every following row; a missing header or invalid header with no data produces a failed ledger. Database/I/O errors stop the run, preserving previously committed checkpoints. Fix malformed source data in a new file; changing bytes creates a new checksum, and rejected observations in the original ledger remain intact.

Optional acquisition uses a transactional outbox (`feed_import_refreshes`). If a process stops after queue insertion but before acknowledgement, another explicit acquisition invocation reuses the same `JobQueue` key. To recover pending intent, rerun **with** `--acquire-results`; a default retry never drains acquisition intent. An already-imported file may also be rerun with that flag to request acquisition without replaying metadata rows. Restricted cases are not queued. Completion reports contain total accepted/rejected counts for the ledger, initial `resumedRows`, final checkpoint, associated refresh job count, and `coverage: "metadata-only"`.

Inspect rejected rows without exposing their sensitive raw content unnecessarily:

```sql
SELECT row_number, source_line, error
FROM feed_import_rows
WHERE import_id = 'IMPORT_UUID' AND error IS NOT NULL
ORDER BY row_number;
```

An extract is **not a full docket or proof of a complete authoritative case population**. Missing cases, charges, parties, or filings never cause deletion, restriction, sealing, or unavailability updates. Existing restricted cases are not reopened. Raw imports may contain sensitive information; restrict database, input file, temporary-directory, backup and operator access accordingly.

## Verification

The PostgreSQL integration tests create and drop unique isolated schemas in the disposable database named by `COURT_TEST_DATABASE_URL`:

```sh
COURT_TEST_DATABASE_URL='postgresql://USER:PASSWORD@HOST/TEST_DATABASE' \
  node --import tsx --test test/imports.test.ts
```

Coverage includes real migrations, streaming CSV/pipe/JSONL parsing, malformed-row continuation, per-charge preservation, source scoping, checksum deduplication, concurrent imports, transactional interruption/restart, durable queue recovery, metadata-only defaults and non-destructive availability behavior. No PostgreSQL behavior is replaced by an in-memory mock. Without the environment variable these integration tests explicitly skip.
