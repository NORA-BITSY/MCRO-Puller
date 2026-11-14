-- Forward-only: explicit operator retries start a new processing generation.
-- Automatic retries and expired-lease recovery retain the same generation so
-- idempotent processing can reuse committed work after a worker crash.
ALTER TABLE jobs ADD COLUMN retry_generation integer NOT NULL DEFAULT 0
  CHECK (retry_generation >= 0);
