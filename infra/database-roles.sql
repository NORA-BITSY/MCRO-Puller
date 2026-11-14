-- Run as the migration/schema owner after migrations, in database court.
-- Passwords are set separately with psql \password (never in this file or Terraform).
\set ON_ERROR_STOP on
BEGIN;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'court_api') THEN
    CREATE ROLE court_api LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'court_worker') THEN
    CREATE ROLE court_worker LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
  END IF;
END
$$;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
REVOKE ALL ON DATABASE court FROM PUBLIC;
GRANT CONNECT ON DATABASE court TO court_api, court_worker;
GRANT USAGE ON SCHEMA public TO court_api, court_worker;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO court_api, court_worker;
GRANT INSERT, UPDATE ON sources, jobs, job_dependencies, job_links, audit_events,
  request_budgets, discovery_partitions, coverage_observations TO court_api;
GRANT UPDATE ON cases, documents, docket_entries, job_attempts TO court_api;
GRANT INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO court_worker;
REVOKE ALL ON schema_migrations FROM court_api, court_worker;
GRANT SELECT ON schema_migrations TO court_api, court_worker;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO court_api, court_worker;
-- Re-run this reviewed grant script after schema additions; no blanket future DDL access.
COMMIT;
