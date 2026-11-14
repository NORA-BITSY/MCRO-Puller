-- Forward-only. To withdraw this feature, disable it; remove populated tables only
-- through an explicitly approved later retention/downgrade migration.
CREATE TABLE case_interpretation_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id uuid NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  run_key text NOT NULL UNIQUE CHECK (run_key <> ''),
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  input_hash text NOT NULL CHECK (input_hash ~ '^[a-f0-9]{64}$'),
  provider text NOT NULL CHECK (provider IN ('vertex','openai')),
  model text NOT NULL,
  prompt_version text NOT NULL,
  schema_version text NOT NULL,
  status text NOT NULL CHECK (status = 'complete'),
  coverage jsonb NOT NULL,
  validation jsonb NOT NULL,
  provenance jsonb NOT NULL,
  started_at timestamptz NOT NULL,
  finished_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX case_interpretation_runs_case_idx ON case_interpretation_runs(case_id,finished_at DESC,id);

CREATE TABLE case_interpretation_inputs (
  run_id uuid NOT NULL REFERENCES case_interpretation_runs(id) ON DELETE CASCADE,
  document_id uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  document_version_id uuid NOT NULL REFERENCES document_versions(id) ON DELETE CASCADE,
  extraction_run_id uuid NOT NULL REFERENCES extraction_runs(id) ON DELETE CASCADE,
  artifact_sha256 text NOT NULL,
  pipeline_version text NOT NULL,
  extraction_schema_version text NOT NULL,
  page_count integer NOT NULL CHECK (page_count > 0),
  PRIMARY KEY (run_id,document_version_id,extraction_run_id),
  UNIQUE (run_id,document_id)
);
CREATE INDEX case_interpretation_inputs_document_idx ON case_interpretation_inputs(document_id);
CREATE INDEX case_interpretation_inputs_extraction_idx ON case_interpretation_inputs(extraction_run_id);
CREATE INDEX case_interpretation_inputs_version_idx ON case_interpretation_inputs(document_version_id);

CREATE TABLE case_interpretation_assertions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES case_interpretation_runs(id) ON DELETE CASCADE,
  ordinal integer NOT NULL CHECK (ordinal >= 0),
  kind text NOT NULL CHECK (kind IN ('allegation','testimony','representation','judicial_finding','requested_relief','procedural_statement','disposition','claim','evidence_reference','legal_citation','relationship','contradiction')),
  text text NOT NULL CHECK (text <> ''),
  confidence real NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  verified_fact boolean NOT NULL DEFAULT false CHECK (NOT verified_fact),
  entailment_verified boolean NOT NULL DEFAULT false CHECK (NOT entailment_verified),
  UNIQUE (run_id,ordinal),
  UNIQUE (id,run_id)
);

CREATE TABLE case_interpretation_evidence (
  assertion_id uuid NOT NULL,
  run_id uuid NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal >= 0),
  document_version_id uuid NOT NULL,
  extraction_run_id uuid NOT NULL,
  page_number integer NOT NULL CHECK (page_number > 0),
  start_offset integer NOT NULL CHECK (start_offset >= 0),
  end_offset integer NOT NULL CHECK (end_offset > start_offset),
  quote text NOT NULL CHECK (quote <> ''),
  statement_type text NOT NULL CHECK (statement_type IN ('allegation','testimony','representation','judicial_finding','procedural_statement','unknown')),
  PRIMARY KEY (assertion_id,ordinal),
  FOREIGN KEY (assertion_id,run_id) REFERENCES case_interpretation_assertions(id,run_id) ON DELETE CASCADE,
  FOREIGN KEY (run_id,document_version_id,extraction_run_id)
    REFERENCES case_interpretation_inputs(run_id,document_version_id,extraction_run_id) ON DELETE CASCADE,
  FOREIGN KEY (extraction_run_id,page_number) REFERENCES pages(extraction_run_id,page_number) ON DELETE CASCADE
);
CREATE INDEX case_interpretation_evidence_input_idx ON case_interpretation_evidence(run_id,document_version_id,extraction_run_id);
CREATE INDEX case_interpretation_evidence_page_idx ON case_interpretation_evidence(extraction_run_id,page_number);

-- Losing any source invalidates the entire cross-document interpretation, not
-- just the local quotes: remaining prose may depend on the deleted source.
CREATE FUNCTION invalidate_case_interpretation_input() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM case_interpretation_runs WHERE id=OLD.run_id;
  RETURN OLD;
END;
$$;
CREATE TRIGGER case_interpretation_input_removed AFTER DELETE ON case_interpretation_inputs
  FOR EACH ROW EXECUTE FUNCTION invalidate_case_interpretation_input();
