ALTER TABLE sources ADD COLUMN artifact_revalidation_hours integer NOT NULL DEFAULT 168 CHECK(artifact_revalidation_hours BETWEEN 1 AND 720);
ALTER TABLE documents ADD COLUMN reference_fingerprint text;
ALTER TABLE documents ADD COLUMN last_verified_at timestamptz;
ALTER TABLE documents ADD COLUMN next_revalidation_at timestamptz;
-- Existing objects remain intact. Their next observation validates once before
-- the bounded no-refetch policy can apply; missing revision hints are not proof.
CREATE INDEX documents_revalidation_idx ON documents(next_revalidation_at) WHERE availability='available';
