-- Forward-only metadata import ledger. No existing court records are removed or
-- reclassified. Rollback requires a forward migration after archiving this lineage.
CREATE TABLE feed_imports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id text NOT NULL REFERENCES sources(id) CHECK (source_id = 'mn-mcro'),
  sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  format text NOT NULL CHECK (format IN ('csv','pipe','jsonl')),
  mapping_version text NOT NULL,
  file_path text NOT NULL,
  size_bytes bigint NOT NULL CHECK (size_bytes >= 0),
  headers jsonb,
  checkpoint bigint NOT NULL DEFAULT 0 CHECK (checkpoint >= 0),
  accepted_rows bigint NOT NULL DEFAULT 0 CHECK (accepted_rows >= 0),
  rejected_rows bigint NOT NULL DEFAULT 0 CHECK (rejected_rows >= 0),
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running','complete','partial','failed')),
  error jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  UNIQUE (source_id,sha256,format,mapping_version),
  CHECK (checkpoint = accepted_rows + rejected_rows)
);

CREATE TABLE feed_import_rows (
  import_id uuid NOT NULL REFERENCES feed_imports(id),
  row_number bigint NOT NULL CHECK (row_number > 0),
  source_line bigint NOT NULL CHECK (source_line > 0),
  sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  raw_text text NOT NULL,
  raw_bytes bytea NOT NULL,
  raw jsonb,
  normalized jsonb,
  case_id uuid REFERENCES cases(id),
  error jsonb,
  observed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (import_id,row_number),
  CHECK ((error IS NULL AND case_id IS NOT NULL AND normalized IS NOT NULL)
      OR (error IS NOT NULL AND case_id IS NULL AND normalized IS NULL))
);
CREATE INDEX feed_import_rows_case_idx ON feed_import_rows(case_id,observed_at);
CREATE INDEX feed_import_rows_errors_idx ON feed_import_rows(import_id,row_number) WHERE error IS NOT NULL;

-- Transactional outbox: row/checkpoint commit stores acquisition intent. Queue
-- insertion and acknowledgement are restart-safe through the stable job key.
CREATE TABLE feed_import_refreshes (
  import_id uuid NOT NULL REFERENCES feed_imports(id),
  case_id uuid NOT NULL REFERENCES cases(id),
  job_id uuid REFERENCES jobs(id),
  PRIMARY KEY (import_id,case_id)
);
