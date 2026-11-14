-- Forward-only additions: queue-safe processing, current document version and shared API budgets.
ALTER TABLE documents ADD COLUMN current_version_id uuid REFERENCES document_versions(id);
ALTER TABLE sources ADD COLUMN next_request_at timestamptz;
CREATE TABLE job_links (
  parent_id uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  child_id uuid NOT NULL REFERENCES jobs(id),
  PRIMARY KEY(parent_id,child_id),
  CHECK(parent_id<>child_id)
);
CREATE INDEX job_links_child_idx ON job_links(child_id);
ALTER TABLE coverage_observations ADD COLUMN job_id uuid REFERENCES jobs(id);
ALTER TABLE coverage_observations ADD CONSTRAINT coverage_job_dimension_key UNIQUE(job_id,dimension);
CREATE INDEX documents_current_version_idx ON documents(current_version_id);
ALTER TABLE extraction_runs ADD COLUMN run_key text UNIQUE;
CREATE TABLE request_budgets (
  principal_hash text NOT NULL,
  window_start timestamptz NOT NULL,
  requests integer NOT NULL CHECK(requests > 0),
  PRIMARY KEY(principal_hash,window_start)
);
CREATE TABLE artifact_acquisition_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id uuid NOT NULL REFERENCES documents(id),
  artifact_id uuid REFERENCES artifacts(id),
  outcome text NOT NULL,
  observed_at timestamptz NOT NULL,
  details jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX artifact_attempt_document_idx ON artifact_acquisition_attempts(document_id,observed_at);
CREATE TABLE availability_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  resource_type text NOT NULL,
  resource_id uuid NOT NULL,
  before_state text,
  after_state text NOT NULL,
  observed_at timestamptz NOT NULL DEFAULT now()
);
CREATE FUNCTION record_availability_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    INSERT INTO availability_history(resource_type,resource_id,after_state) VALUES(TG_TABLE_NAME,NEW.id,NEW.availability);
  ELSIF NEW.availability IS DISTINCT FROM OLD.availability THEN
    INSERT INTO availability_history(resource_type,resource_id,before_state,after_state) VALUES(TG_TABLE_NAME,NEW.id,OLD.availability,NEW.availability);
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER cases_availability_history AFTER INSERT OR UPDATE ON cases FOR EACH ROW EXECUTE FUNCTION record_availability_change();
CREATE TRIGGER documents_availability_history AFTER INSERT OR UPDATE ON documents FOR EACH ROW EXECUTE FUNCTION record_availability_change();
CREATE TRIGGER entries_availability_history AFTER INSERT OR UPDATE ON docket_entries FOR EACH ROW EXECUTE FUNCTION record_availability_change();
