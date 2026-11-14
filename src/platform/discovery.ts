import type { PoolClient } from 'pg';

interface TerminalPartition {
  id: string;
  source_id: string;
  query: Record<string, unknown>;
  job_id: string;
  attempts: number;
  job_status: string;
  error_code: string | null;
  recovery_count: number;
  max_recoveries: number;
}

/** Called after a job transition or by the scheduler to recover expired-worker outcomes. */
export async function settleDiscoveryFailures(client: PoolClient, jobId?: string): Promise<void> {
  const terminal = await client.query<TerminalPartition>(`SELECT p.id,p.source_id,p.query,j.id AS job_id,j.attempts,j.status AS job_status,
    j.error->>'code' AS error_code,p.recovery_count,p.max_recoveries
    FROM discovery_partitions p JOIN jobs j ON j.id=p.last_job_id
    WHERE j.status IN ('dead_letter','restricted','cancelled')
      AND (p.settled_job_id IS DISTINCT FROM j.id OR p.settled_job_attempt<>j.attempts)
      AND ($1::uuid IS NULL OR j.id=$1)
    ORDER BY p.id FOR UPDATE OF p SKIP LOCKED`, [jobId ?? null]);
  for (const partition of terminal.rows) {
    const recover = partition.job_status === 'dead_letter'
      && ['retryable', 'lease_expired'].includes(partition.error_code ?? '')
      && partition.recovery_count < partition.max_recoveries;
    const status = recover ? 'pending' : partition.job_status === 'restricted' ? 'restricted'
      : partition.job_status === 'cancelled' ? 'cancelled' : 'failed';
    const delaySeconds = Math.min(86400, 21600 * 2 ** partition.recovery_count);
    await client.query(`UPDATE discovery_partitions SET status=$2,
      next_run_at=CASE WHEN $3 THEN clock_timestamp()+($4::integer*interval '1 second') ELSE NULL END,
      generation=generation+CASE WHEN $3 THEN 1 ELSE 0 END,
      recovery_count=recovery_count+CASE WHEN $3 THEN 1 ELSE 0 END,
      settled_job_id=$5,settled_job_attempt=$6,last_error_code=$7,last_failure_at=clock_timestamp(),updated_at=clock_timestamp()
      WHERE id=$1`, [partition.id, status, recover, delaySeconds, partition.job_id, partition.attempts, partition.error_code ?? 'unknown']);
    await client.query(`INSERT INTO coverage_observations(source_id,partition_id,dimension,scope,observed_count,denominator,status,limitations,job_id)
      VALUES($1,$2,$3,$4,0,NULL,$5,$6,$7) ON CONFLICT(job_id,dimension) DO NOTHING`,
      [partition.source_id,partition.id,`discovery_failure:${partition.attempts}`,JSON.stringify(partition.query),
        status==='restricted'?'restricted':'failed',JSON.stringify([
          'No successful source observation was established by this failed attempt.',
          `Error category: ${partition.error_code??'unknown'}.`,
          recover?'Bounded recovery scheduled; coverage remains unknown.':'Automatic discovery stopped; explicit operator replanning is required.',
        ]),partition.job_id]);
  }
}
