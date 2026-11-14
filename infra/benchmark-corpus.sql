-- Requires the real migrated schema in a dedicated database named *_benchmark.
-- Run with psql -v scale=10000 (or 100000 / 1000000); no court traffic.
\set ON_ERROR_STOP on
\timing on
BEGIN;
DO $$
BEGIN
  IF current_database() !~ '_benchmark$' THEN
    RAISE EXCEPTION 'Only a disposable *_benchmark database is permitted';
  END IF;
END
$$;
INSERT INTO sources(id,state,name,metadata,capabilities,enabled)
VALUES ('synthetic-benchmark','TEST','Synthetic capacity corpus',
  '{"fixture":true}', '{}', false);
INSERT INTO cases(source_id,source_case_id,case_number,title,court,status,metadata)
SELECT 'synthetic-benchmark', 'synthetic-' || n, 'BENCH-' || lpad(n::text, 9, '0'),
  'Synthetic capacity record ' || n, 'Synthetic Tribunal', 'active',
  jsonb_build_object('fixture',true,'sequence',n)
FROM generate_series(1, :scale) AS n;
ANALYZE cases;
SELECT count(*) AS synthetic_cases FROM cases WHERE source_id='synthetic-benchmark';
SELECT pg_size_pretty(pg_total_relation_size('cases')) AS case_table_and_indexes;
EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
SELECT id,case_number,title FROM cases
WHERE source_id='synthetic-benchmark' AND source_case_id='synthetic-5000';
EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
SELECT id,case_number,title FROM cases
WHERE source_id='synthetic-benchmark' ORDER BY id LIMIT 100;
ROLLBACK;
-- Rollback removes rows but PostgreSQL can retain allocated disk space. Drop the
-- dedicated benchmark database after retaining sanitized measurements.
