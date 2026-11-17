import type { Pool, PoolClient } from 'pg';
import { transaction } from './database.js';

export type JobStatus = 'queued' | 'running' | 'retry_wait' | 'complete' | 'partial' | 'blocked' | 'restricted' | 'cancelled' | 'dead_letter';

export interface Job {
  id: string;
  sourceId: string | null;
  type: string;
  payload: Record<string, unknown>;
  idempotencyKey: string;
  status: JobStatus;
  priority: number;
  attempts: number;
  maxAttempts: number;
  retryGeneration: number;
  availableAt: Date;
  leaseOwner: string | null;
  leaseToken: string | null;
  leaseExpiresAt: Date | null;
  result: Record<string, unknown> | null;
  error: Record<string, unknown> | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface EnqueueInput {
  type: string;
  sourceId?: string;
  payload: Record<string, unknown>;
  idempotencyKey: string;
  priority?: number;
  maxAttempts?: number;
  availableAt?: Date;
  dependencies?: string[];
}

export interface JobFailure {
  code: string;
  message: string;
  originalCode?: string;
  retryAfterMs?: number;
}

export class JobConflictError extends Error {
  readonly code = 'conflict';

  constructor() {
    super('Idempotency key already belongs to different job input or dependencies');
    this.name = 'JobConflictError';
  }
}

const columns = `id, source_id AS "sourceId", type, payload,
  idempotency_key AS "idempotencyKey", status, priority, attempts,
  max_attempts AS "maxAttempts", retry_generation AS "retryGeneration", available_at AS "availableAt",
  lease_owner AS "leaseOwner", lease_token AS "leaseToken", lease_expires_at AS "leaseExpiresAt",
  result, error, created_at AS "createdAt", updated_at AS "updatedAt"`;

function integer(value: number, name: string, minimum: number): void {
  if (!Number.isInteger(value) || value < minimum || value > 2_147_483_647) {
    throw new RangeError(`${name} must be an integer between ${minimum} and 2147483647`);
  }
}

async function finishAttempt(client: PoolClient, job: Pick<Job, 'id' | 'attempts'>, status: JobStatus, error: JobFailure | null = null): Promise<void> {
  await client.query(
    `UPDATE job_attempts SET status=$3,error=$4::jsonb,finished_at=clock_timestamp()
     WHERE job_id=$1 AND attempt=$2 AND status='running'`,
    [job.id, job.attempts, status, error === null ? null : JSON.stringify(error)],
  );
}

/** Durable at-least-once work. A token fences queue transitions, not external side effects. */
export class JobQueue {
  constructor(private readonly pool: Pool) {}

  /** With a client, the caller owns the encompassing transaction and parent fence. */
  async enqueue(input: EnqueueInput, client?: PoolClient): Promise<Job> {
    if (!input.type.trim() || !input.idempotencyKey.trim()) throw new Error('Job type and idempotency key are required');
    integer(input.priority ?? 0, 'priority', -2_147_483_648);
    integer(input.maxAttempts ?? 5, 'maxAttempts', 1);
    if (input.availableAt && !Number.isFinite(input.availableAt.getTime())) throw new Error('availableAt must be a valid date');
    const dependencies = [...new Set(input.dependencies ?? [])].sort();
    const payload = JSON.stringify(input.payload);
    const execute = async (client: PoolClient): Promise<Job> => {
      const inserted = await client.query<Job>(
        `INSERT INTO jobs(type,source_id,payload,idempotency_key,priority,max_attempts,available_at)
         VALUES ($1,$2,$3::jsonb,$4,$5,$6,COALESCE($7::timestamptz,clock_timestamp()))
         ON CONFLICT (idempotency_key) DO NOTHING RETURNING ${columns}`,
        [input.type, input.sourceId ?? null, payload, input.idempotencyKey, input.priority ?? 0, input.maxAttempts ?? 5, input.availableAt ?? null],
      );
      const created = inserted.rows[0];
      if (created) {
        if (dependencies.length > 0) {
          await client.query('INSERT INTO job_dependencies(job_id,depends_on) SELECT $1,unnest($2::uuid[])', [created.id, dependencies]);
        }
        return created;
      }
      // ON CONFLICT waits for the winning transaction; this new READ COMMITTED
      // statement sees its job and the dependencies committed atomically with it.
      const existing = await client.query<Job & { matches: boolean }>(
        `SELECT ${columns}, (type=$2 AND source_id IS NOT DISTINCT FROM $3 AND payload=$4::jsonb) AS matches
         FROM jobs WHERE idempotency_key=$1 FOR UPDATE`,
        [input.idempotencyKey, input.type, input.sourceId ?? null, payload],
      );
      const job = existing.rows[0];
      if (!job) throw new Error('Idempotent job disappeared during enqueue');
      const edges = await client.query<{ depends_on: string }>('SELECT depends_on FROM job_dependencies WHERE job_id=$1 ORDER BY depends_on', [job.id]);
      if (!job.matches || edges.rows.length !== dependencies.length || edges.rows.some((edge, index) => edge.depends_on !== dependencies[index])) {
        throw new JobConflictError();
      }
      const { matches: _matches, ...result } = job;
      return result;
    };
    return client ? execute(client) : transaction(this.pool, execute);
  }

  async claim(workerId: string, leaseMs = 60_000): Promise<Job | null> {
    if (!workerId.trim()) throw new Error('workerId is required');
    integer(leaseMs, 'leaseMs', 1);
    return transaction(this.pool, async (client) => {
      await this.recoverExpired(client);
      await this.reconcileDependencies(client);
      for (;;) {
        const selected = await client.query<{ id: string; source_id: string | null }>(
          `SELECT j.id,j.source_id FROM jobs j
           WHERE j.status IN ('queued','retry_wait','blocked')
             AND j.attempts < j.max_attempts AND j.available_at <= clock_timestamp()
             AND (j.error->>'code' IS DISTINCT FROM 'dependency_failed')
             AND NOT EXISTS (
               SELECT 1 FROM job_dependencies d JOIN jobs parent ON parent.id=d.depends_on
               WHERE d.job_id=j.id AND parent.status<>'complete'
             )
           ORDER BY j.priority DESC,j.available_at,j.created_at,j.id
           FOR UPDATE OF j SKIP LOCKED LIMIT 1`,
          [],
        );
        const candidate = selected.rows[0];
        if (!candidate) return null;
        const claimed = await client.query<Job>(
          `UPDATE jobs SET status='running',attempts=attempts+1,lease_owner=$2,
             lease_token=gen_random_uuid(),lease_expires_at=clock_timestamp()+$3 * interval '1 millisecond',
             error=NULL,updated_at=clock_timestamp()
           WHERE id=$1 RETURNING ${columns}`,
          [candidate.id, workerId, leaseMs],
        );
        const job = claimed.rows[0];
        if (!job) throw new Error('Locked job disappeared during claim');
        await client.query('INSERT INTO job_attempts(job_id,attempt,worker_id) VALUES ($1,$2,$3)', [job.id, job.attempts, workerId]);
        return job;
      }
    });
  }

  async heartbeat(id: string, token: string, leaseMs: number): Promise<boolean> {
    integer(leaseMs, 'leaseMs', 1);
    return transaction(this.pool, async (client) => {
      // Check expiry only after taking the row lock, never before waiting on it.
      await client.query('SELECT id FROM jobs WHERE id=$1 FOR UPDATE', [id]);
      const updated = await client.query(
        `UPDATE jobs SET lease_expires_at=clock_timestamp()+$3 * interval '1 millisecond',updated_at=clock_timestamp()
         WHERE id=$1 AND lease_token=$2 AND status='running' AND lease_expires_at>clock_timestamp()`,
        [id, token, leaseMs],
      );
      return updated.rowCount === 1;
    });
  }

  async complete(id: string, token: string, result: Record<string, unknown>, status: 'complete' | 'partial' = 'complete'): Promise<boolean> {
    if (status !== 'complete' && status !== 'partial') throw new Error('Completion status must be complete or partial');
    return transaction(this.pool, async (client) => {
      await client.query('SELECT id FROM jobs WHERE id=$1 FOR UPDATE', [id]);
      const updated = await client.query<Job>(
        `UPDATE jobs SET status=$3,result=$4::jsonb,error=NULL,
           lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,updated_at=clock_timestamp()
         WHERE id=$1 AND lease_token=$2 AND status='running' AND lease_expires_at>clock_timestamp()
         RETURNING ${columns}`,
        [id, token, status, JSON.stringify(result)],
      );
      const job = updated.rows[0];
      if (!job) return false;
      await finishAttempt(client, job, status);
      return true;
    });
  }

  async fail(id: string, token: string, error: JobFailure, connection?: PoolClient): Promise<boolean> {
    if (error.retryAfterMs !== undefined) integer(error.retryAfterMs, 'retryAfterMs', 0);
    const persist = async (client: PoolClient): Promise<boolean> => {
      const selected = await client.query<Job>(`SELECT ${columns} FROM jobs WHERE id=$1 FOR UPDATE`, [id]);
      const current = selected.rows[0];
      if (!current || current.status !== 'running' || current.leaseToken !== token) return false;
      const retryable = error.code === 'retryable' || error.code === 'parse_error';
      const exhausted = current.attempts >= current.maxAttempts;
      const status: JobStatus = error.code === 'restricted' ? 'restricted'
        : exhausted ? 'dead_letter'
          : error.code === 'blocked' ? 'blocked'
            : retryable ? 'retry_wait' : 'dead_letter';
      const delay = error.code === 'blocked' ? Math.max(error.retryAfterMs ?? 900_000, 1_000)
        : Math.max(error.retryAfterMs ?? 0, Math.min(60_000, 1_000 * 2 ** Math.min(current.attempts - 1, 6)));
      const updated = await client.query<Job>(
        `UPDATE jobs SET status=$3,error=$4::jsonb,available_at=clock_timestamp()+$5 * interval '1 millisecond',
           lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,updated_at=clock_timestamp()
         WHERE id=$1 AND lease_token=$2 AND status='running' AND lease_expires_at>clock_timestamp()
         RETURNING ${columns}`,
        [id, token, status, JSON.stringify(error), delay],
      );
      const job = updated.rows[0];
      if (!job) return false;
      await finishAttempt(client, job, status, error);
      if (error.code === 'blocked' && job.sourceId !== null) {
        await client.query(
          `UPDATE sources SET health='blocked',paused_until=GREATEST(
             COALESCE(paused_until,clock_timestamp()),clock_timestamp()+GREATEST($2,min_interval_ms) * interval '1 millisecond'
           ),updated_at=clock_timestamp() WHERE id=$1`,
          [job.sourceId, delay],
        );
      }
      return true;
    };
    return connection ? persist(connection) : transaction(this.pool, persist);
  }

  async cancel(id: string): Promise<boolean> {
    return transaction(this.pool, async (client) => {
      // Workflow graphs can share descendants or contain historical cycles.
      // Serialize cancellations so overlapping traversals cannot lock them in
      // opposite orders. Normal claims and publication remain independent.
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended(current_database() || ':' || current_schema() || ':court:job-cancellation', 0))");
      const visited = new Set([id]);
      let pending = [id];
      let cancelled = false;
      while (pending.length > 0) {
        const locked = await client.query<{ id: string }>(
          'SELECT id FROM jobs WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE',
          [pending],
        );
        const lockedIds = locked.rows.map((job) => job.id);
        if (lockedIds.length === 0) break;
        const updated = await client.query<{ id: string }>(
          `UPDATE jobs SET status='cancelled',lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,
             error='{"code":"cancelled","message":"Job cancelled"}'::jsonb,updated_at=clock_timestamp()
           WHERE id=ANY($1::uuid[]) AND status IN ('queued','running','retry_wait','blocked') RETURNING id`,
          [lockedIds],
        );
        if (updated.rows.length > 0) {
          cancelled = true;
          await client.query(
            `UPDATE job_attempts SET status='cancelled',finished_at=clock_timestamp(),
               error='{"code":"cancelled","message":"Job cancelled"}'::jsonb
             WHERE job_id=ANY($1::uuid[]) AND status='running'`,
            [updated.rows.map((job) => job.id)],
          );
        }
        // Read links in a fresh statement AFTER taking parent locks. A child
        // publisher must fence/lock its parent in its enqueue+link transaction,
        // so children committed while we waited cannot escape cancellation.
        // Terminal parents still participate: stage completion is not pipeline
        // completion, and their queued or active descendants must also stop.
        const children = await client.query<{ child_id: string }>(
          'SELECT DISTINCT child_id FROM job_links WHERE parent_id=ANY($1::uuid[]) ORDER BY child_id',
          [lockedIds],
        );
        pending = [];
        for (const child of children.rows) {
          if (visited.has(child.child_id)) continue;
          visited.add(child.child_id);
          pending.push(child.child_id);
        }
      }
      return cancelled;
    });
  }

  async retry(id: string): Promise<boolean> {
    return transaction(this.pool, async (client) => {
      await client.query('SELECT id FROM jobs WHERE id=$1 FOR UPDATE', [id]);
      // Restrictions require a separate access-policy change, not a retry button.
      // Do not reset attempts: historical attempt ordinals and errors stay durable.
      const updated = await client.query(
        `UPDATE jobs SET status='queued',available_at=clock_timestamp(),error=NULL,result=NULL,
           max_attempts=GREATEST(max_attempts,attempts+1),retry_generation=retry_generation+1,updated_at=clock_timestamp()
         WHERE id=$1 AND status IN ('partial','blocked','dead_letter','cancelled','retry_wait')`,
        [id],
      );
      return updated.rowCount === 1;
    });
  }

  private async recoverExpired(client: PoolClient): Promise<void> {
    await client.query(`WITH expired AS (
        SELECT id FROM jobs WHERE status='running' AND lease_expires_at<=clock_timestamp()
        ORDER BY id FOR UPDATE SKIP LOCKED
      ), recovered AS (
        UPDATE jobs j SET status=CASE WHEN j.attempts>=j.max_attempts THEN 'dead_letter' ELSE 'retry_wait' END,
          available_at=clock_timestamp(),lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,
          error='{"code":"lease_expired","message":"Worker lease expired before completion"}'::jsonb,
          updated_at=clock_timestamp()
        FROM expired WHERE j.id=expired.id RETURNING j.id,j.attempts,j.error
      ) UPDATE job_attempts a SET status='expired',finished_at=clock_timestamp(),error=recovered.error
        FROM recovered WHERE a.job_id=recovered.id AND a.attempt=recovered.attempts AND a.status='running'`);
  }

  private async reconcileDependencies(client: PoolClient): Promise<void> {
    await client.query(`WITH failed AS (
        SELECT j.id FROM jobs j WHERE j.status IN ('queued','retry_wait','blocked')
          AND j.error->>'code' IS DISTINCT FROM 'dependency_failed'
          AND EXISTS (
            SELECT 1 FROM job_dependencies d JOIN jobs parent ON parent.id=d.depends_on WHERE d.job_id=j.id
              AND (parent.status IN ('partial','restricted','cancelled','dead_letter')
                OR (parent.status='blocked' AND parent.error->>'code'='dependency_failed'))
          ) FOR UPDATE OF j SKIP LOCKED
      ) UPDATE jobs j SET status='blocked',updated_at=clock_timestamp(),
        error='{"code":"dependency_failed","message":"A prerequisite did not complete successfully"}'::jsonb
        FROM failed WHERE j.id=failed.id`);
    await client.query(`WITH ready AS (
        SELECT j.id FROM jobs j WHERE j.status='blocked' AND j.error->>'code'='dependency_failed'
          AND NOT EXISTS (
            SELECT 1 FROM job_dependencies d JOIN jobs parent ON parent.id=d.depends_on
              WHERE d.job_id=j.id AND parent.status<>'complete'
          ) FOR UPDATE OF j SKIP LOCKED
      ) UPDATE jobs j SET status='queued',error=NULL,updated_at=clock_timestamp() FROM ready WHERE j.id=ready.id`);
  }
}
