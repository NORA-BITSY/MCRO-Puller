-- Forward-only initial schema. Roll back an unused installation by dropping its
-- dedicated database/schema; never drop a populated production schema to downgrade.
-- Future changes belong in new checksum-tracked migrations, not edits to this file.

CREATE TABLE sources (
  id text PRIMARY KEY CHECK (id <> ''),
  state text NOT NULL,
  name text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}',
  capabilities jsonb NOT NULL DEFAULT '{}',
  enabled boolean NOT NULL DEFAULT false,
  paused_until timestamptz,
  health text NOT NULL DEFAULT 'unknown',
  min_interval_ms integer NOT NULL DEFAULT 15000 CHECK (min_interval_ms >= 0),
  max_concurrency integer NOT NULL DEFAULT 1 CHECK (max_concurrency > 0),
  last_request_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE cases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id text NOT NULL REFERENCES sources(id),
  source_case_id text NOT NULL CHECK (source_case_id <> ''),
  case_number text NOT NULL,
  title text NOT NULL DEFAULT '',
  court text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT '',
  availability text NOT NULL DEFAULT 'public' CHECK (availability IN ('public','available','restricted','sealed','unavailable','unknown')),
  acquisition_status text NOT NULL DEFAULT 'pending' CHECK (acquisition_status IN ('pending','queued','acquiring','running','acquired','complete','partial','blocked','restricted','unavailable','failed','retry_wait','cancelled')),
  metadata jsonb NOT NULL DEFAULT '{}',
  last_observed_at timestamptz,
  next_refresh_at timestamptz DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_id,source_case_id)
);
CREATE INDEX cases_number_idx ON cases(case_number);
CREATE INDEX cases_source_status_idx ON cases(source_id,status);
CREATE INDEX cases_refresh_idx ON cases(next_refresh_at,id) WHERE availability IN ('public','available');
CREATE INDEX cases_search_idx ON cases USING gin (to_tsvector('simple', title || ' ' || case_number));

CREATE TABLE case_identifiers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id uuid NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind <> ''),
  value text NOT NULL,
  provenance text NOT NULL DEFAULT 'source',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (case_id,kind,value)
);
CREATE INDEX case_identifiers_lookup_idx ON case_identifiers(kind,value);
CREATE FUNCTION synchronize_case_identifiers() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM case_identifiers WHERE case_id=NEW.id AND kind IN ('source_case_id','case_number') AND provenance='canonical';
  INSERT INTO case_identifiers(case_id,kind,value,provenance)
  VALUES (NEW.id,'source_case_id',NEW.source_case_id,'canonical'),(NEW.id,'case_number',NEW.case_number,'canonical')
  ON CONFLICT (case_id,kind,value) DO UPDATE SET provenance='canonical';
  RETURN NEW;
END;
$$;
CREATE TRIGGER cases_identifiers AFTER INSERT OR UPDATE OF source_case_id,case_number ON cases
  FOR EACH ROW EXECUTE FUNCTION synchronize_case_identifiers();

CREATE TABLE docket_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id uuid NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  observed_at timestamptz NOT NULL,
  complete boolean NOT NULL,
  sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  raw jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX docket_snapshots_case_time_idx ON docket_snapshots(case_id,observed_at DESC);
CREATE INDEX docket_snapshots_hash_idx ON docket_snapshots(case_id,sha256);

CREATE TABLE docket_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id uuid NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  identity_key text NOT NULL CHECK (identity_key <> ''),
  source_id text,
  source_order integer NOT NULL CHECK (source_order >= 0),
  event_date text,
  title text NOT NULL DEFAULT '',
  identity_confidence text NOT NULL CHECK (identity_confidence IN ('source','derived','ambiguous')),
  availability text NOT NULL DEFAULT 'public' CHECK (availability IN ('public','available','restricted','sealed','unavailable','unknown')),
  raw jsonb NOT NULL DEFAULT '{}',
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (case_id,identity_key),
  UNIQUE (id,case_id)
);
CREATE INDEX docket_entries_case_order_idx ON docket_entries(case_id,source_order,id);
CREATE INDEX docket_entries_date_idx ON docket_entries(event_date);
CREATE INDEX docket_entries_search_idx ON docket_entries USING gin (to_tsvector('simple',title));

CREATE TABLE entry_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entry_id uuid NOT NULL REFERENCES docket_entries(id) ON DELETE CASCADE,
  snapshot_id uuid NOT NULL REFERENCES docket_snapshots(id) ON DELETE CASCADE,
  sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  data jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (entry_id,snapshot_id)
);
CREATE INDEX entry_versions_snapshot_idx ON entry_versions(snapshot_id);

CREATE TABLE entry_changes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id uuid NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  snapshot_id uuid NOT NULL REFERENCES docket_snapshots(id) ON DELETE CASCADE,
  entry_id uuid REFERENCES docket_entries(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind <> ''),
  before_data jsonb,
  after_data jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX entry_changes_case_time_idx ON entry_changes(case_id,created_at DESC);
CREATE INDEX entry_changes_snapshot_idx ON entry_changes(snapshot_id);
CREATE INDEX entry_changes_entry_idx ON entry_changes(entry_id);

CREATE TABLE documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id uuid NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  entry_id uuid,
  source_document_id text NOT NULL CHECK (source_document_id <> ''),
  title text NOT NULL DEFAULT '',
  reference jsonb NOT NULL DEFAULT '{}',
  availability text NOT NULL DEFAULT 'unknown' CHECK (availability IN ('public','available','restricted','sealed','unavailable','unknown')),
  acquisition_status text NOT NULL DEFAULT 'pending' CHECK (acquisition_status IN ('pending','queued','acquiring','running','acquired','complete','partial','blocked','restricted','unavailable','failed','retry_wait','cancelled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (case_id,source_document_id),
  FOREIGN KEY (entry_id,case_id) REFERENCES docket_entries(id,case_id)
);
CREATE INDEX documents_entry_idx ON documents(entry_id);
CREATE INDEX documents_pending_idx ON documents(acquisition_status,case_id) WHERE acquisition_status IN ('pending','failed','partial');

-- Relational filing/attachment projections remain populated by the canonical
-- docket/document writes; they do not require a second, divergent write path.
CREATE VIEW filings AS
  SELECT id,case_id,identity_key,source_order,event_date,title,availability,raw,first_seen_at,last_seen_at
  FROM docket_entries;
CREATE VIEW document_attachments AS
  SELECT id AS document_id,entry_id AS filing_id,case_id,source_document_id,title,reference,availability
  FROM documents WHERE entry_id IS NOT NULL;

CREATE TABLE artifacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sha256 text NOT NULL UNIQUE CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  size_bytes bigint NOT NULL CHECK (size_bytes >= 0),
  content_type text NOT NULL,
  storage_key text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE document_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  artifact_id uuid NOT NULL REFERENCES artifacts(id),
  filename text NOT NULL,
  source_url text,
  acquired_at timestamptz NOT NULL,
  UNIQUE (document_id,artifact_id)
);
CREATE INDEX document_versions_artifact_idx ON document_versions(artifact_id);
CREATE INDEX document_versions_document_time_idx ON document_versions(document_id,acquired_at DESC);

CREATE TABLE participants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id uuid NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  source_key text NOT NULL,
  kind text NOT NULL,
  name text NOT NULL DEFAULT '',
  role text,
  raw jsonb NOT NULL DEFAULT '{}',
  UNIQUE (case_id,source_key)
);
CREATE INDEX participants_name_idx ON participants(name);
CREATE TABLE participant_roles (
  participant_id uuid NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  role text NOT NULL,
  provenance text NOT NULL DEFAULT 'source',
  PRIMARY KEY (participant_id,role)
);
CREATE INDEX participant_roles_role_idx ON participant_roles(role);
CREATE FUNCTION synchronize_participant_roles() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM participant_roles WHERE participant_id=NEW.id AND provenance='canonical';
  IF NEW.role IS NOT NULL AND NEW.role <> '' THEN
    INSERT INTO participant_roles(participant_id,role,provenance) VALUES (NEW.id,NEW.role,'canonical')
    ON CONFLICT (participant_id,role) DO UPDATE SET provenance='canonical';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER participants_roles AFTER INSERT OR UPDATE OF role ON participants
  FOR EACH ROW EXECUTE FUNCTION synchronize_participant_roles();

CREATE TABLE proceedings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id uuid NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  kind text NOT NULL,
  source_key text NOT NULL,
  data jsonb NOT NULL DEFAULT '{}',
  UNIQUE (case_id,kind,source_key)
);
CREATE TABLE case_status_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id uuid NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  status text NOT NULL,
  observed_at timestamptz NOT NULL
);
CREATE INDEX case_status_history_case_time_idx ON case_status_history(case_id,observed_at DESC);

CREATE TABLE extraction_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_version_id uuid NOT NULL REFERENCES document_versions(id) ON DELETE CASCADE,
  pipeline_version text NOT NULL,
  model text,
  prompt_version text,
  schema_version text NOT NULL,
  status text NOT NULL CHECK (status IN ('pending','running','complete','partial','failed','restricted','cancelled')),
  result jsonb,
  error jsonb,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE INDEX extraction_runs_version_idx ON extraction_runs(document_version_id,started_at DESC);
CREATE INDEX extraction_runs_status_idx ON extraction_runs(status,started_at);
CREATE TABLE pages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  extraction_run_id uuid NOT NULL REFERENCES extraction_runs(id) ON DELETE CASCADE,
  page_number integer NOT NULL CHECK (page_number > 0),
  text text NOT NULL,
  method text NOT NULL,
  quality jsonb NOT NULL DEFAULT '{}',
  UNIQUE (extraction_run_id,page_number)
);
CREATE TABLE chunks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  extraction_run_id uuid NOT NULL REFERENCES extraction_runs(id) ON DELETE CASCADE,
  page_number integer NOT NULL CHECK (page_number > 0),
  start_offset integer NOT NULL CHECK (start_offset >= 0),
  end_offset integer NOT NULL CHECK (end_offset >= start_offset),
  text text NOT NULL,
  search_vector tsvector GENERATED ALWAYS AS (to_tsvector('english',text)) STORED,
  FOREIGN KEY (extraction_run_id,page_number) REFERENCES pages(extraction_run_id,page_number) ON DELETE CASCADE
);
CREATE INDEX chunks_page_idx ON chunks(extraction_run_id,page_number,start_offset);
CREATE INDEX chunks_text_idx ON chunks USING gin(search_vector);
CREATE TABLE entity_mentions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  extraction_run_id uuid NOT NULL REFERENCES extraction_runs(id) ON DELETE CASCADE,
  page_number integer NOT NULL CHECK (page_number > 0),
  start_offset integer NOT NULL CHECK (start_offset >= 0),
  end_offset integer NOT NULL CHECK (end_offset >= start_offset),
  kind text NOT NULL,
  value text NOT NULL,
  confidence real NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  data jsonb NOT NULL DEFAULT '{}',
  FOREIGN KEY (extraction_run_id,page_number) REFERENCES pages(extraction_run_id,page_number) ON DELETE CASCADE
);
CREATE INDEX entity_mentions_run_idx ON entity_mentions(extraction_run_id,page_number);
CREATE INDEX entity_mentions_lookup_idx ON entity_mentions(kind,value);
CREATE VIEW citations AS
  SELECT id,extraction_run_id,page_number,start_offset,end_offset,value,confidence,data
  FROM entity_mentions WHERE lower(kind) IN ('citation','legal_citation','case_citation','statute','statute_citation');
CREATE TABLE assertions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  extraction_run_id uuid NOT NULL REFERENCES extraction_runs(id) ON DELETE CASCADE,
  kind text NOT NULL,
  text text NOT NULL,
  evidence jsonb NOT NULL,
  confidence real NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  data jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX assertions_run_idx ON assertions(extraction_run_id);
CREATE INDEX assertions_kind_idx ON assertions(kind);
CREATE TABLE relationships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id uuid NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  kind text NOT NULL,
  source_ref jsonb NOT NULL,
  target_ref jsonb NOT NULL,
  evidence jsonb NOT NULL
);
CREATE INDEX relationships_case_kind_idx ON relationships(case_id,kind);

CREATE TABLE discovery_partitions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id text NOT NULL REFERENCES sources(id),
  query jsonb NOT NULL,
  query_hash text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','queued','running','complete','partial','truncated','split','saturated','blocked','restricted','failed','cancelled')),
  parent_id uuid REFERENCES discovery_partitions(id),
  observed_count integer NOT NULL DEFAULT 0 CHECK (observed_count >= 0),
  denominator bigint CHECK (denominator >= 0),
  limitations jsonb NOT NULL DEFAULT '[]',
  next_run_at timestamptz DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_id,query_hash),
  CHECK (parent_id IS DISTINCT FROM id)
);
CREATE INDEX discovery_partitions_parent_idx ON discovery_partitions(parent_id);
CREATE INDEX discovery_partitions_due_idx ON discovery_partitions(status,next_run_at);
CREATE TABLE coverage_observations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id text NOT NULL REFERENCES sources(id),
  partition_id uuid REFERENCES discovery_partitions(id),
  dimension text NOT NULL,
  scope jsonb NOT NULL,
  observed_count bigint NOT NULL CHECK (observed_count >= 0),
  denominator bigint CHECK (denominator >= 0),
  status text NOT NULL CHECK (status IN ('unknown','observed','complete','partial','truncated','saturated','blocked','restricted','failed')),
  limitations jsonb NOT NULL DEFAULT '[]',
  observed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX coverage_observations_source_idx ON coverage_observations(source_id,dimension,observed_at DESC);
CREATE INDEX coverage_observations_partition_idx ON coverage_observations(partition_id,observed_at DESC);

CREATE TABLE jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id text REFERENCES sources(id),
  type text NOT NULL CHECK (type <> ''),
  payload jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(payload)='object'),
  idempotency_key text NOT NULL UNIQUE CHECK (idempotency_key <> ''),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','retry_wait','complete','partial','blocked','restricted','cancelled','dead_letter')),
  priority integer NOT NULL DEFAULT 0,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts integer NOT NULL DEFAULT 5 CHECK (max_attempts > 0),
  available_at timestamptz NOT NULL DEFAULT now(),
  lease_owner text,
  lease_token uuid,
  lease_expires_at timestamptz,
  result jsonb,
  error jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (attempts <= max_attempts),
  CHECK ((status='running' AND lease_owner IS NOT NULL AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)
    OR (status<>'running' AND lease_owner IS NULL AND lease_token IS NULL AND lease_expires_at IS NULL))
);
CREATE INDEX jobs_runnable_idx ON jobs(priority DESC,available_at,created_at,id) WHERE status IN ('queued','retry_wait','blocked');
CREATE INDEX jobs_source_active_idx ON jobs(source_id,lease_expires_at) WHERE status='running';
CREATE INDEX jobs_expiration_idx ON jobs(lease_expires_at) WHERE status='running';
CREATE INDEX jobs_source_idx ON jobs(source_id,status);
CREATE TABLE job_dependencies (
  job_id uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  depends_on uuid NOT NULL REFERENCES jobs(id),
  PRIMARY KEY (job_id,depends_on),
  CHECK (job_id <> depends_on)
);
CREATE INDEX job_dependencies_parent_idx ON job_dependencies(depends_on);
CREATE TABLE job_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  attempt integer NOT NULL CHECK (attempt > 0),
  worker_id text NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running','complete','partial','retry_wait','blocked','restricted','cancelled','dead_letter','expired')),
  error jsonb,
  UNIQUE (job_id,attempt),
  CHECK ((status='running' AND finished_at IS NULL) OR (status<>'running' AND finished_at IS NOT NULL))
);
CREATE TABLE audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor text NOT NULL,
  action text NOT NULL,
  resource_type text NOT NULL,
  resource_id text NOT NULL,
  details jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_events_resource_idx ON audit_events(resource_type,resource_id,created_at DESC);
CREATE INDEX audit_events_time_idx ON audit_events(created_at);
