-- Forward-only: preserve removed records and their provenance after a complete
-- source observation no longer contains them. A removal is not physical deletion.
-- Downgrades must explicitly reconcile existing 'removed' rows in a new migration.
ALTER TABLE cases
  DROP CONSTRAINT cases_availability_check,
  ADD CONSTRAINT cases_availability_check
    CHECK (availability IN ('public','available','restricted','sealed','unavailable','unknown','removed'));

ALTER TABLE docket_entries
  DROP CONSTRAINT docket_entries_availability_check,
  ADD CONSTRAINT docket_entries_availability_check
    CHECK (availability IN ('public','available','restricted','sealed','unavailable','unknown','removed'));

ALTER TABLE documents
  DROP CONSTRAINT documents_availability_check,
  ADD CONSTRAINT documents_availability_check
    CHECK (availability IN ('public','available','restricted','sealed','unavailable','unknown','removed'));
