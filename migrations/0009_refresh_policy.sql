-- Forward-only: retain observation history; rollback requires a forward migration.
-- A discovered identifier is not consent to acquire its docket.
ALTER TABLE cases ALTER COLUMN next_refresh_at DROP DEFAULT;
ALTER TABLE cases ADD COLUMN watched boolean NOT NULL DEFAULT false;
ALTER TABLE cases ADD COLUMN refresh_class text CHECK (refresh_class IN ('watched','new','recent','active','inactive','closed','partial','failed'));
ALTER TABLE cases ADD COLUMN refresh_interval_minutes integer CHECK (refresh_interval_minutes > 0);

CREATE TABLE refresh_policy (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  policy jsonb NOT NULL CHECK (jsonb_typeof(policy)='object'),
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO refresh_policy(policy) VALUES ('{"watchedMinutes":60,"newMinutes":360,"recentMinutes":720,"activeMinutes":1440,"inactiveMinutes":10080,"closedMinutes":43200,"partialMinutes":120,"failedMinutes":360,"newWindowDays":7,"recentWindowDays":30}');

-- Old implicit due jobs are not explicit refresh intents. Preserve manual and
-- acquiring-search child jobs, even if their first attempt has not observed a docket.
WITH metadata_only AS (
  SELECT c.id FROM cases c
  WHERE NOT EXISTS (SELECT 1 FROM docket_snapshots ds WHERE ds.case_id=c.id)
    AND NOT EXISTS (
      SELECT 1 FROM jobs j WHERE j.type='refresh_case'
        AND j.payload->>'caseId'=c.id::text
        AND j.idempotency_key NOT LIKE 'refresh:' || c.id::text || ':%'
    )
)
UPDATE cases SET next_refresh_at=NULL WHERE id IN (SELECT id FROM metadata_only);
-- Stop previously queued implicit acquisition too, rather than merely stopping
-- future scheduler submissions. Historical attempts/results remain available.
UPDATE job_attempts SET status='cancelled',finished_at=clock_timestamp()
WHERE status='running' AND job_id IN (
  SELECT j.id FROM jobs j JOIN cases c ON c.id::text=j.payload->>'caseId'
  WHERE c.next_refresh_at IS NULL AND j.type='refresh_case'
    AND j.idempotency_key LIKE 'refresh:' || c.id::text || ':%'
    AND j.status IN ('queued','running','retry_wait','blocked')
);
UPDATE jobs j SET status='cancelled',lease_token=NULL,lease_owner=NULL,lease_expires_at=NULL,updated_at=now()
FROM cases c WHERE c.id::text=j.payload->>'caseId' AND c.next_refresh_at IS NULL
  AND j.type='refresh_case' AND j.idempotency_key LIKE 'refresh:' || c.id::text || ':%'
  AND j.status IN ('queued','running','retry_wait','blocked');

-- A live projection backfills all historic evidence automatically and cannot
-- drift from immutable snapshots. Initial inventory is a baseline, not a change;
-- DOM reordering and local identity migration are not meaningful court activity.
-- Times are observation times, never filing/event/hearing dates guessed from text.
CREATE VIEW case_refresh_evidence AS
SELECT c.id AS case_id, snapshots.first_observed_at, snapshots.last_snapshot_at,
  snapshots.snapshot_count, latest.complete AS latest_complete,
  activity.meaningful_change_count, activity.last_meaningful_activity_at,
  CASE WHEN snapshots.snapshot_count>1
    THEN activity.meaningful_change_count::double precision/(snapshots.snapshot_count-1)
    ELSE 0::double precision END AS change_frequency
FROM cases c
CROSS JOIN LATERAL (
  SELECT min(ds.observed_at) AS first_observed_at,max(ds.observed_at) AS last_snapshot_at,count(*)::integer AS snapshot_count
  FROM docket_snapshots ds WHERE ds.case_id=c.id
) snapshots
LEFT JOIN LATERAL (
  SELECT ds.complete FROM docket_snapshots ds WHERE ds.case_id=c.id ORDER BY ds.observed_at DESC,ds.id DESC LIMIT 1
) latest ON true
CROSS JOIN LATERAL (
  SELECT count(*)::integer AS meaningful_change_count,max(ds.observed_at) AS last_meaningful_activity_at
  FROM docket_snapshots ds WHERE ds.case_id=c.id AND ds.observed_at>snapshots.first_observed_at
    AND (EXISTS (SELECT 1 FROM entry_changes ec WHERE ec.snapshot_id=ds.id AND ec.kind IN ('added','modified','removed','reappeared'))
      OR EXISTS (SELECT 1 FROM case_status_history h WHERE h.case_id=c.id AND h.observed_at=ds.observed_at))
) activity;

-- Populate initial scheduling decisions for already tracked cases without
-- enrolling metadata-only cases. Subsequent decisions use the persisted policy.
UPDATE cases c SET refresh_class=CASE
  WHEN e.latest_complete=false THEN 'partial'
  WHEN lower(trim(c.status)) IN ('closed','disposed') THEN 'closed'
  WHEN lower(trim(c.status))='inactive' THEN 'inactive'
  WHEN c.created_at>now()-interval '7 days' THEN 'new'
  WHEN e.last_meaningful_activity_at>now()-interval '30 days' THEN 'recent'
  ELSE 'active' END
FROM case_refresh_evidence e WHERE e.case_id=c.id AND c.next_refresh_at IS NOT NULL;
UPDATE cases SET refresh_interval_minutes=CASE refresh_class
  WHEN 'new' THEN 360 WHEN 'recent' THEN 720 WHEN 'active' THEN 1440
  WHEN 'inactive' THEN 10080 WHEN 'closed' THEN 43200 WHEN 'partial' THEN 120 END
WHERE refresh_class IS NOT NULL;
CREATE INDEX jobs_refresh_case_active_idx ON jobs ((payload->>'caseId'),created_at DESC)
  WHERE type='refresh_case';
