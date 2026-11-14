ALTER TABLE documents ADD COLUMN current_observed_at timestamptz;
UPDATE documents d SET current_observed_at=v.acquired_at FROM document_versions v WHERE v.id=d.current_version_id;
