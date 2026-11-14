-- Collection-level audit actions have no single resource ID.
ALTER TABLE audit_events ALTER COLUMN resource_id DROP NOT NULL;
-- A current version must belong to this document, not merely exist somewhere.
ALTER TABLE documents DROP CONSTRAINT documents_current_version_id_fkey;
ALTER TABLE document_versions ADD CONSTRAINT document_versions_document_id_id_key UNIQUE(document_id,id);
ALTER TABLE documents ADD CONSTRAINT documents_current_version_same_document_fk
  FOREIGN KEY(id,current_version_id) REFERENCES document_versions(document_id,id);
CREATE INDEX cases_normalized_number_idx ON cases(upper(regexp_replace(case_number,'[^a-zA-Z0-9]','','g')));
CREATE INDEX cases_filed_date_idx ON cases((metadata->>'filedDate'));
CREATE INDEX artifact_attempt_outcome_idx ON artifact_acquisition_attempts(outcome,observed_at);
