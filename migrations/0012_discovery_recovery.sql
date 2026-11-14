ALTER TABLE discovery_partitions
  ADD COLUMN generation integer NOT NULL DEFAULT 0 CHECK (generation >= 0),
  ADD COLUMN recovery_count integer NOT NULL DEFAULT 0 CHECK (recovery_count >= 0),
  ADD COLUMN max_recoveries integer NOT NULL DEFAULT 2 CHECK (max_recoveries BETWEEN 0 AND 10),
  ADD COLUMN last_job_id uuid REFERENCES jobs(id),
  ADD COLUMN settled_job_id uuid REFERENCES jobs(id),
  ADD COLUMN settled_job_attempt integer NOT NULL DEFAULT 0 CHECK (settled_job_attempt >= 0),
  ADD COLUMN last_error_code text,
  ADD COLUMN last_failure_at timestamptz;

-- Associate existing work without changing its immutable idempotency keys.
UPDATE discovery_partitions p SET last_job_id=(
  SELECT j.id FROM jobs j WHERE j.type='source_search' AND j.payload->>'partitionId'=p.id::text
  ORDER BY j.created_at DESC,j.id DESC LIMIT 1
);
CREATE INDEX discovery_partitions_last_job_idx ON discovery_partitions(last_job_id);
