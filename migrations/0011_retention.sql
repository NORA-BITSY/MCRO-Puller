-- Forward-only, opt-in retention. No existing evidence is expired or deleted.
-- Destruction is irreversible; rollback requires a reviewed forward migration.
CREATE TABLE retention_policy (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  enabled boolean NOT NULL DEFAULT false,
  artifact_gc_enabled boolean NOT NULL DEFAULT false,
  updated_by text NOT NULL DEFAULT 'installation',
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO retention_policy(singleton) VALUES(true);

CREATE TABLE retention_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key text NOT NULL UNIQUE CHECK (length(idempotency_key) BETWEEN 1 AND 200),
  case_id uuid NOT NULL REFERENCES cases(id),
  document_id uuid REFERENCES documents(id),
  action text NOT NULL CHECK (action IN ('restrict','purge')),
  due_at timestamptz NOT NULL,
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 2000),
  requested_by text NOT NULL CHECK (length(requested_by) BETWEEN 1 AND 200),
  status text NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','cleanup_pending','complete')),
  withdrawn_at timestamptz,
  purged_at timestamptz,
  completed_at timestamptz,
  last_error_code text CHECK (last_error_code IN ('artifact_delete_failed','invalid_artifact_key')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((status='scheduled' AND withdrawn_at IS NULL AND completed_at IS NULL)
    OR (status='cleanup_pending' AND withdrawn_at IS NOT NULL AND completed_at IS NULL AND action='purge')
    OR (status='complete' AND withdrawn_at IS NOT NULL AND completed_at IS NOT NULL))
);
CREATE INDEX retention_requests_due_idx ON retention_requests(due_at,id) WHERE status<>'complete';
CREATE INDEX retention_requests_case_idx ON retention_requests(case_id,created_at);
CREATE INDEX retention_requests_document_idx ON retention_requests(document_id) WHERE document_id IS NOT NULL;

-- Deliberately no artifact FK: the checkpoint survives deletion of the artifact
-- row and a crash after unlink but before committing the deletion acknowledgement.
CREATE TABLE retention_artifact_deletions (
  request_id uuid NOT NULL REFERENCES retention_requests(id),
  artifact_id uuid NOT NULL,
  sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  storage_key text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','deleted','retained')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts>=0),
  last_error_code text CHECK (last_error_code IN ('artifact_delete_failed','invalid_artifact_key')),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(request_id,artifact_id)
);
CREATE INDEX retention_artifact_pending_idx ON retention_artifact_deletions(request_id) WHERE status='pending';
CREATE TABLE retention_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  request_id uuid REFERENCES retention_requests(id),
  actor text NOT NULL,
  event text NOT NULL CHECK (event IN ('policy_changed','requested','withdrawn','data_purged','artifact_deleted','artifact_retained','artifact_failed','complete')),
  details jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(details)='object'),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX retention_events_request_idx ON retention_events(request_id,id);

ALTER TABLE cases ADD COLUMN retention_withdrawn_at timestamptz;
ALTER TABLE cases ADD COLUMN retention_purged_at timestamptz;
ALTER TABLE documents ADD COLUMN retention_withdrawn_at timestamptz;
ALTER TABLE documents ADD COLUMN retention_purged_at timestamptz;
ALTER TABLE jobs ADD COLUMN retention_request_id uuid REFERENCES retention_requests(id);

-- Source observations cannot undo an operator withdrawal or refill purged
-- projections. These are local policy states, never assertions of court sealing.
CREATE FUNCTION enforce_case_retention() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.retention_withdrawn_at := COALESCE(OLD.retention_withdrawn_at,NEW.retention_withdrawn_at);
  NEW.retention_purged_at := COALESCE(OLD.retention_purged_at,NEW.retention_purged_at);
  IF NEW.retention_withdrawn_at IS NOT NULL THEN
    NEW.availability := 'restricted'; NEW.acquisition_status := 'restricted';
    NEW.next_refresh_at := NULL; NEW.watched := false;
  END IF;
  IF NEW.retention_purged_at IS NOT NULL THEN
    NEW.case_number := ''; NEW.title := ''; NEW.court := ''; NEW.court_id := NULL;
    NEW.status := ''; NEW.metadata := '{}'; NEW.refresh_class := NULL; NEW.refresh_interval_minutes := NULL;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER cases_aaa_retention BEFORE UPDATE ON cases FOR EACH ROW EXECUTE FUNCTION enforce_case_retention();
CREATE FUNCTION enforce_document_retention() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.retention_withdrawn_at := COALESCE(OLD.retention_withdrawn_at,NEW.retention_withdrawn_at);
  NEW.retention_purged_at := COALESCE(OLD.retention_purged_at,NEW.retention_purged_at);
  IF NEW.retention_withdrawn_at IS NOT NULL THEN
    NEW.availability := 'restricted'; NEW.acquisition_status := 'restricted';
  END IF;
  IF NEW.retention_purged_at IS NOT NULL THEN
    NEW.title := ''; NEW.reference := '{}'; NEW.current_version_id := NULL; NEW.current_observed_at := NULL;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER documents_retention BEFORE UPDATE ON documents FOR EACH ROW EXECUTE FUNCTION enforce_document_retention();
CREATE FUNCTION enforce_job_retention() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.retention_request_id := COALESCE(OLD.retention_request_id,NEW.retention_request_id);
  IF NEW.retention_request_id IS NOT NULL THEN
    NEW.status := 'restricted'; NEW.lease_owner := NULL; NEW.lease_token := NULL; NEW.lease_expires_at := NULL;
    NEW.result := NULL; NEW.error := NULL;
    IF OLD.retention_request_id IS NOT NULL THEN NEW.payload := OLD.payload; END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER jobs_retention BEFORE UPDATE ON jobs FOR EACH ROW EXECUTE FUNCTION enforce_job_retention();

-- Preserve import row ordinals/checkpoints without retaining the copied content;
-- later feed replays cannot reintroduce that content through the import ledger.
CREATE FUNCTION enforce_import_retention() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM cases WHERE id=NEW.case_id AND retention_purged_at IS NOT NULL) THEN
    NEW.raw_text := ''; NEW.raw_bytes := ''::bytea; NEW.raw := NULL; NEW.normalized := '{}'; NEW.error := NULL;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER feed_import_rows_retention BEFORE INSERT OR UPDATE ON feed_import_rows FOR EACH ROW EXECUTE FUNCTION enforce_import_retention();
CREATE FUNCTION enforce_identifier_retention() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM cases WHERE id=NEW.case_id AND retention_purged_at IS NOT NULL) THEN RETURN NULL; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER case_identifiers_retention BEFORE INSERT OR UPDATE ON case_identifiers FOR EACH ROW EXECUTE FUNCTION enforce_identifier_retention();
