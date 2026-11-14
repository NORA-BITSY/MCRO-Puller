import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import { Pool } from 'pg';
import { createDatabase, migrate, transaction } from '../src/platform/database.js';
import { JobQueue, type Job } from '../src/platform/jobs.js';

const databaseUrl = process.env.COURT_TEST_DATABASE_URL;
const databaseTest = { skip: databaseUrl ? false : 'COURT_TEST_DATABASE_URL is required for real PostgreSQL integration' };

async function isolatedDatabase(t: TestContext, applyMigrations = true): Promise<Pool> {
  assert.ok(databaseUrl, 'COURT_TEST_DATABASE_URL must point to a disposable test database');
  const admin = createDatabase(databaseUrl);
  const schema = `court_test_${randomUUID().replaceAll('-', '')}`;
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema},public`, max: 12 });
  t.after(async () => {
    await pool.end();
    try {
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    } finally {
      await admin.end();
    }
  });
  if (applyMigrations) await migrate(pool);
  return pool;
}

async function addSource(pool: Pool, id = 'fixture', interval = 0, concurrency = 1): Promise<void> {
  await pool.query(
    `INSERT INTO sources (id,state,name,enabled,min_interval_ms,max_concurrency)
     VALUES ($1,'fixture',$1,true,$2,$3)`,
    [id, interval, concurrency],
  );
}

function lease(job: Job | null): asserts job is Job & { leaseToken: string } {
  assert.ok(job);
  assert.equal(typeof job.leaseToken, 'string');
}

async function expire(pool: Pool, id: string): Promise<void> {
  await pool.query("UPDATE jobs SET lease_expires_at = clock_timestamp() - interval '1 second' WHERE id=$1", [id]);
}

test('migrations are concurrent-safe, idempotent, and reject checksum drift', databaseTest, async (t) => {
  const pool = await isolatedDatabase(t, false);
  await Promise.all([migrate(pool), migrate(pool), migrate(pool)]);
  await migrate(pool);
  const versions = await pool.query<{ version: string; sha256: string }>('SELECT version,sha256 FROM schema_migrations ORDER BY version');
  assert.ok(versions.rows.length > 0);
  assert.match(versions.rows[0]!.sha256, /^[a-f0-9]{64}$/);
  await pool.query("UPDATE schema_migrations SET sha256=repeat('0',64) WHERE version=$1", [versions.rows[0]!.version]);
  await assert.rejects(migrate(pool), /checksum/i);
});

test('transactions roll back writes and release clients after errors', databaseTest, async (t) => {
  const pool = await isolatedDatabase(t);
  await assert.rejects(transaction(pool, async (client) => {
    await client.query("INSERT INTO sources(id,state,name) VALUES ('rollback','XX','Rollback')");
    throw new Error('deliberate rollback');
  }), /deliberate rollback/);
  assert.equal((await pool.query('SELECT id FROM sources')).rowCount, 0);
  assert.equal(await transaction(pool, async (client) => (await client.query('SELECT 42 AS answer')).rows[0].answer), 42);
});

test('schema enforces references and status constraints and integrates normalized identifiers and roles', databaseTest, async (t) => {
  const pool = await isolatedDatabase(t);
  await addSource(pool);
  const inserted = await pool.query<{ id: string }>(
    `INSERT INTO cases(source_id,source_case_id,case_number,title,court,status)
     VALUES ('fixture','external-1','01-CV-1','Case','Court','Source-specific status') RETURNING id`,
  );
  const caseId = inserted.rows[0]!.id;
  assert.equal((await pool.query('SELECT value FROM case_identifiers WHERE case_id=$1 ORDER BY kind', [caseId])).rowCount, 2);
  await pool.query("UPDATE cases SET case_number='01-CV-2' WHERE id=$1", [caseId]);
  assert.equal((await pool.query("SELECT value FROM case_identifiers WHERE case_id=$1 AND kind='case_number'", [caseId])).rows[0].value, '01-CV-2');
  await pool.query("INSERT INTO participants(case_id,source_key,kind,name,role) VALUES ($1,'p1','person','Person','Petitioner')", [caseId]);
  assert.equal((await pool.query('SELECT role FROM participant_roles')).rows[0].role, 'Petitioner');
  await assert.rejects(pool.query("INSERT INTO jobs(type,payload,idempotency_key,status) VALUES ('x','{}','bad','invented')"), /check constraint/i);
  await assert.rejects(pool.query("INSERT INTO documents(case_id,source_document_id,title,reference,availability) VALUES ($1,'d1','Document','{}','available')", [randomUUID()]), /foreign key/i);
});

test('enqueue deduplicates concurrent requests and rejects conflicting idempotency reuse', databaseTest, async (t) => {
  const pool = await isolatedDatabase(t);
  const queue = new JobQueue(pool);
  const input = { type: 'fixture-work', payload: { nested: { a: 1, b: 2 } }, idempotencyKey: 'same' };
  const jobs = await Promise.all(Array.from({ length: 12 }, () => queue.enqueue(input)));
  assert.equal(new Set(jobs.map((job) => job.id)).size, 1);
  const reordered = await queue.enqueue({ ...input, payload: { nested: { b: 2, a: 1 } } });
  assert.equal(reordered.id, jobs[0]!.id);
  await assert.rejects(queue.enqueue({ ...input, payload: { different: true } }), /idempotency/i);
  assert.equal((await pool.query('SELECT id FROM jobs')).rowCount, 1);
});

test('dependency jobs wait for complete outcomes and remain blocked by partial work', databaseTest, async (t) => {
  const pool = await isolatedDatabase(t);
  const queue = new JobQueue(pool);
  const first = await queue.enqueue({ type: 'parent', payload: {}, idempotencyKey: 'parent' });
  const child = await queue.enqueue({ type: 'child', payload: {}, idempotencyKey: 'child', dependencies: [first.id], priority: 100 });
  const running = await queue.claim('worker');
  lease(running);
  assert.equal(running.id, first.id);
  assert.equal(await queue.claim('other'), null);
  assert.equal(await queue.complete(running.id, running.leaseToken, {}, 'partial'), true);
  assert.equal(await queue.claim('other'), null);
  const blocked = await pool.query('SELECT status,error FROM jobs WHERE id=$1', [child.id]);
  assert.equal(blocked.rows[0].status, 'blocked');
  assert.equal(blocked.rows[0].error.code, 'dependency_failed');
  assert.equal(await queue.retry(first.id), true);
  const rerun = await queue.claim('worker');
  lease(rerun);
  assert.equal(await queue.complete(rerun.id, rerun.leaseToken, {}), true);
  const dependent = await queue.claim('worker');
  lease(dependent);
  assert.equal(dependent.id, child.id);
});

test('unknown dependencies roll back enqueue and dependency sets are immutable for a key', databaseTest, async (t) => {
  const pool = await isolatedDatabase(t);
  const queue = new JobQueue(pool);
  await assert.rejects(queue.enqueue({ type: 'child', payload: {}, idempotencyKey: 'missing', dependencies: [randomUUID()] }), /foreign key|dependency/i);
  assert.equal((await pool.query('SELECT id FROM jobs')).rowCount, 0);
  const first = await queue.enqueue({ type: 'parent', payload: {}, idempotencyKey: 'parent' });
  const input = { type: 'child', payload: {}, idempotencyKey: 'child', dependencies: [first.id] };
  await queue.enqueue(input);
  await assert.rejects(queue.enqueue({ ...input, dependencies: [] }), /idempotency/i);
});

test('workers share source concurrency limits without blocking independent sources', databaseTest, async (t) => {
  const pool = await isolatedDatabase(t);
  await addSource(pool, 'one', 0, 2);
  await addSource(pool, 'two', 0, 1);
  const queue = new JobQueue(pool);
  await Promise.all(Array.from({ length: 6 }, (_, index) => queue.enqueue({ type: 'fetch', sourceId: 'one', payload: {}, idempotencyKey: `one-${index}` })));
  await queue.enqueue({ type: 'fetch', sourceId: 'two', payload: {}, idempotencyKey: 'two' });
  const attempts = await Promise.all(Array.from({ length: 8 }, (_, index) => queue.claim(`worker-${index}`)));
  const running = attempts.filter((job) => job !== null);
  // SKIP LOCKED callers may return null during a simultaneous source reservation;
  // subsequent workers must be able to fill, but never exceed, the shared limit.
  for (let index = 0; index < 3; index += 1) {
    const next = await queue.claim(`fill-${index}`);
    if (next) running.push(next);
  }
  assert.equal(running.filter((job) => job.sourceId === 'one').length, 2);
  assert.equal(running.filter((job) => job.sourceId === 'two').length, 1);
  assert.equal(new Set(running.map((job) => job.id)).size, 3);
});

test('source budgets apply after completion, pauses and disabled sources prevent claims', databaseTest, async (t) => {
  const pool = await isolatedDatabase(t);
  await addSource(pool, 'limited', 60_000, 5);
  const queue = new JobQueue(pool);
  const first = await queue.enqueue({ type: 'fetch', sourceId: 'limited', payload: {}, idempotencyKey: 'first' });
  await queue.enqueue({ type: 'fetch', sourceId: 'limited', payload: {}, idempotencyKey: 'second' });
  const running = await queue.claim('worker');
  lease(running);
  assert.equal(running.id, first.id);
  await queue.complete(running.id, running.leaseToken, {});
  assert.equal(await queue.claim('worker'), null);
  await pool.query("UPDATE sources SET last_request_at=clock_timestamp()-interval '2 minutes',paused_until=clock_timestamp()+interval '1 hour'");
  assert.equal(await queue.claim('worker'), null);
  await pool.query('UPDATE sources SET paused_until=NULL,enabled=false');
  assert.equal(await queue.claim('worker'), null);
  await pool.query('UPDATE sources SET enabled=true');
  assert.ok(await queue.claim('worker'));
});

test('leases fence stale owners, heartbeat live claims, and durably record expiration', databaseTest, async (t) => {
  const pool = await isolatedDatabase(t);
  const queue = new JobQueue(pool);
  await queue.enqueue({ type: 'work', payload: {}, idempotencyKey: 'lease', maxAttempts: 3 });
  const first = await queue.claim('first');
  lease(first);
  assert.equal(await queue.heartbeat(first.id, randomUUID(), 60_000), false);
  assert.equal(await queue.heartbeat(first.id, first.leaseToken, 60_000), true);
  await expire(pool, first.id);
  assert.equal(await queue.heartbeat(first.id, first.leaseToken, 60_000), false);
  assert.equal(await queue.complete(first.id, first.leaseToken, {}), false);
  assert.equal(await queue.fail(first.id, first.leaseToken, { code: 'retryable', message: 'stale' }), false);
  const second = await queue.claim('second');
  lease(second);
  assert.equal(second.id, first.id);
  assert.notEqual(second.leaseToken, first.leaseToken);
  assert.equal(second.attempts, 2);
  assert.equal(await queue.complete(second.id, first.leaseToken, {}), false);
  assert.equal(await queue.complete(second.id, second.leaseToken, { done: true }), true);
  assert.equal(await queue.complete(second.id, second.leaseToken, {}), false);
  const attempts = await pool.query('SELECT attempt,status,finished_at FROM job_attempts ORDER BY attempt');
  assert.deepEqual(attempts.rows.map((row) => [row.attempt, row.status]), [[1, 'expired'], [2, 'complete']]);
  assert.ok(attempts.rows.every((row) => row.finished_at));
});

test('expired final attempts dead-letter rather than executing beyond the budget', databaseTest, async (t) => {
  const pool = await isolatedDatabase(t);
  const queue = new JobQueue(pool);
  const job = await queue.enqueue({ type: 'work', payload: {}, idempotencyKey: 'final', maxAttempts: 1 });
  const first = await queue.claim('worker');
  lease(first);
  await expire(pool, first.id);
  assert.equal(await queue.claim('other'), null);
  assert.equal((await pool.query('SELECT status FROM jobs WHERE id=$1', [job.id])).rows[0].status, 'dead_letter');
  assert.equal(await queue.retry(job.id), true);
  const retried = await queue.claim('worker');
  lease(retried);
  assert.equal(retried.attempts, 2);
});

test('retries respect retry-after and stop permanently at max attempts', databaseTest, async (t) => {
  const pool = await isolatedDatabase(t);
  const queue = new JobQueue(pool);
  const job = await queue.enqueue({ type: 'work', payload: {}, idempotencyKey: 'retry', maxAttempts: 2 });
  const first = await queue.claim('worker');
  lease(first);
  assert.equal(await queue.fail(first.id, first.leaseToken, { code: 'retryable', message: 'busy', retryAfterMs: 60_000 }), true);
  assert.equal(await queue.claim('worker'), null);
  const delayed = await pool.query("SELECT status,available_at > clock_timestamp()+interval '50 seconds' AS delayed FROM jobs WHERE id=$1", [job.id]);
  assert.equal(delayed.rows[0].status, 'retry_wait');
  assert.equal(delayed.rows[0].delayed, true);
  await pool.query('UPDATE jobs SET available_at=clock_timestamp() WHERE id=$1', [job.id]);
  const second = await queue.claim('worker');
  lease(second);
  await queue.fail(second.id, second.leaseToken, { code: 'retryable', message: 'still busy' });
  assert.equal((await pool.query('SELECT status FROM jobs WHERE id=$1', [job.id])).rows[0].status, 'dead_letter');
  assert.equal(await queue.claim('worker'), null);
});

test('blocked errors pause the shared source and restrictions are never automatically retried', databaseTest, async (t) => {
  const pool = await isolatedDatabase(t);
  await addSource(pool);
  const queue = new JobQueue(pool);
  const input = { type: 'fetch', sourceId: 'fixture', payload: {} };
  const blocked = await queue.enqueue({ ...input, idempotencyKey: 'block' });
  await queue.enqueue({ ...input, idempotencyKey: 'sibling' });
  const first = await queue.claim('worker');
  lease(first);
  await queue.fail(first.id, first.leaseToken, { code: 'blocked', message: 'Access challenge', retryAfterMs: 120_000 });
  assert.equal((await pool.query('SELECT status FROM jobs WHERE id=$1', [blocked.id])).rows[0].status, 'blocked');
  const source = await pool.query('SELECT health,paused_until > clock_timestamp() AS paused FROM sources');
  assert.equal(source.rows[0].health, 'blocked');
  assert.equal(source.rows[0].paused, true);
  assert.equal(await queue.claim('worker'), null);
  await pool.query('UPDATE sources SET paused_until=NULL');
  const sibling = await queue.claim('worker');
  lease(sibling);
  await queue.fail(sibling.id, sibling.leaseToken, { code: 'restricted', message: 'Sealed record' });
  assert.equal((await pool.query('SELECT status FROM jobs WHERE id=$1', [sibling.id])).rows[0].status, 'restricted');
  assert.equal(await queue.retry(sibling.id), false);
});

test('cancellation fences active work, persists attempt outcome, and manual retries retain history', databaseTest, async (t) => {
  const pool = await isolatedDatabase(t);
  const queue = new JobQueue(pool);
  const original = await queue.enqueue({ type: 'work', payload: {}, idempotencyKey: 'cancel' });
  const first = await queue.claim('worker');
  lease(first);
  assert.equal(await queue.cancel(original.id), true);
  assert.equal(await queue.cancel(original.id), false);
  assert.equal(await queue.complete(first.id, first.leaseToken, {}), false);
  assert.equal((await pool.query('SELECT status FROM job_attempts')).rows[0].status, 'cancelled');
  assert.equal(await queue.retry(original.id), true);
  const second = await queue.claim('worker');
  lease(second);
  assert.equal(second.attempts, 2);
  assert.equal(await queue.fail(second.id, second.leaseToken, { code: 'permanent', message: 'Bad request' }), true);
  assert.equal((await pool.query('SELECT status FROM jobs')).rows[0].status, 'dead_letter');
  assert.equal((await pool.query('SELECT id FROM job_attempts')).rowCount, 2);
});

test('future availability and queue priority are honored without acquiring empty attempts', databaseTest, async (t) => {
  const pool = await isolatedDatabase(t);
  const queue = new JobQueue(pool);
  await queue.enqueue({ type: 'work', payload: {}, idempotencyKey: 'future', priority: 100, availableAt: new Date(Date.now() + 60_000) });
  await queue.enqueue({ type: 'work', payload: {}, idempotencyKey: 'low', priority: 0 });
  const high = await queue.enqueue({ type: 'work', payload: {}, idempotencyKey: 'high', priority: 10 });
  const claimed = await queue.claim('worker');
  lease(claimed);
  assert.equal(claimed.id, high.id);
  assert.equal((await pool.query('SELECT id FROM job_attempts')).rowCount, 1);
  await assert.rejects(queue.claim('worker', 0), /lease/i);
});

test('reconciled removals remain stored across cases, docket entries, and documents', databaseTest, async (t) => {
  const pool = await isolatedDatabase(t);
  await addSource(pool);
  const cases = await pool.query<{ id: string }>(
    `INSERT INTO cases(source_id,source_case_id,case_number,availability)
     VALUES ('fixture','removed-case','01-CV-removed','removed') RETURNING id`,
  );
  const caseId = cases.rows[0]!.id;
  const entries = await pool.query<{ id: string }>(
    `INSERT INTO docket_entries(case_id,identity_key,source_order,identity_confidence,availability)
     VALUES ($1,'removed-entry',1,'source','removed') RETURNING id`,
    [caseId],
  );
  await pool.query(
    `INSERT INTO documents(case_id,entry_id,source_document_id,availability)
     VALUES ($1,$2,'removed-document','removed')`,
    [caseId, entries.rows[0]!.id],
  );
  const retained = await pool.query(
    `SELECT c.availability AS case_availability,e.availability AS entry_availability,d.availability AS document_availability
     FROM cases c JOIN docket_entries e ON e.case_id=c.id JOIN documents d ON d.entry_id=e.id WHERE c.id=$1`,
    [caseId],
  );
  assert.deepEqual(retained.rows[0], { case_availability: 'removed', entry_availability: 'removed', document_availability: 'removed' });
  await assert.rejects(pool.query("UPDATE cases SET availability='invented' WHERE id=$1", [caseId]), /check constraint/i);
});

test('enqueue joins a caller transaction so jobs, dependencies, and workflow links roll back together', databaseTest, async (t) => {
  const pool = await isolatedDatabase(t);
  const queue = new JobQueue(pool);
  const parent = await queue.enqueue({ type: 'parent', payload: {}, idempotencyKey: 'transaction-parent' });
  const input = { type: 'child', payload: {}, idempotencyKey: 'transaction-child', dependencies: [parent.id] };
  await assert.rejects(transaction(pool, async (client) => {
    const child = await queue.enqueue(input, client);
    await client.query('INSERT INTO job_links(parent_id,child_id) VALUES ($1,$2)', [parent.id, child.id]);
    throw new Error('roll back complete publication');
  }), /roll back complete publication/);
  assert.equal((await pool.query('SELECT id FROM jobs')).rowCount, 1);
  assert.equal((await pool.query('SELECT * FROM job_dependencies')).rowCount, 0);
  assert.equal((await pool.query('SELECT * FROM job_links')).rowCount, 0);
  const committed = await transaction(pool, async (client) => {
    const child = await queue.enqueue(input, client);
    assert.equal((await queue.enqueue(input, client)).id, child.id);
    await client.query('INSERT INTO job_links(parent_id,child_id) VALUES ($1,$2)', [parent.id, child.id]);
    return child;
  });
  assert.equal((await pool.query('SELECT child_id FROM job_links')).rows[0].child_id, committed.id);
  assert.equal((await pool.query('SELECT * FROM job_dependencies')).rowCount, 1);
});

test('cancellation follows workflow descendants through duplicate paths and cycles while preserving completed stages', databaseTest, async (t) => {
  const pool = await isolatedDatabase(t);
  const queue = new JobQueue(pool);
  const root = await queue.enqueue({ type: 'parent', payload: {}, idempotencyKey: 'tree-root' });
  const parentStage = await queue.claim('parent-worker');
  lease(parentStage);
  await queue.complete(parentStage.id, parentStage.leaseToken, { discoveryFinished: true });
  const first = await queue.enqueue({ type: 'child', payload: {}, idempotencyKey: 'tree-first', priority: 100 });
  const second = await queue.enqueue({ type: 'child', payload: {}, idempotencyKey: 'tree-second' });
  const shared = await queue.enqueue({ type: 'grandchild', payload: {}, idempotencyKey: 'tree-shared', dependencies: [first.id] });
  const unrelated = await queue.enqueue({ type: 'unrelated', payload: {}, idempotencyKey: 'tree-unrelated' });
  await pool.query(
    `INSERT INTO job_links(parent_id,child_id) VALUES ($1,$2),($1,$3),($2,$4),($3,$4),($4,$2)`,
    [root.id, first.id, second.id, shared.id],
  );
  const active = await queue.claim('child-worker');
  lease(active);
  assert.equal(active.id, first.id);
  assert.equal(await queue.cancel(root.id), true);
  assert.equal(await queue.cancel(root.id), false);
  const statuses = await pool.query<{ id: string; status: string }>('SELECT id,status FROM jobs');
  const byId = new Map(statuses.rows.map((row) => [row.id, row.status]));
  assert.equal(byId.get(root.id), 'complete');
  for (const child of [first, second, shared]) assert.equal(byId.get(child.id), 'cancelled');
  assert.equal(byId.get(unrelated.id), 'queued');
  assert.equal(await queue.complete(active.id, active.leaseToken, {}), false);
  assert.equal(await queue.heartbeat(active.id, active.leaseToken, 60_000), false);
  const attempt = await pool.query('SELECT status,finished_at FROM job_attempts WHERE job_id=$1', [active.id]);
  assert.equal(attempt.rows[0].status, 'cancelled');
  assert.ok(attempt.rows[0].finished_at);
});

test('only explicit retries advance the processing generation, not heartbeat or automatic recovery', databaseTest, async (t) => {
  const pool = await isolatedDatabase(t);
  const queue = new JobQueue(pool);
  const input = { type: 'process_document', payload: {}, idempotencyKey: 'processing-generations', maxAttempts: 5 };
  const initial = await queue.enqueue(input);
  assert.equal(initial.retryGeneration, 0);
  assert.equal(await queue.retry(initial.id), false);
  const first = await queue.claim('first');
  lease(first);
  assert.equal(first.retryGeneration, 0);
  await queue.complete(first.id, first.leaseToken, { warnings: ['OCR incomplete'] }, 'partial');
  assert.equal(await queue.retry(first.id), true);
  const manual = await queue.claim('manual');
  lease(manual);
  assert.equal(manual.retryGeneration, 1);
  assert.equal(await queue.heartbeat(manual.id, manual.leaseToken, 60_000), true);
  assert.equal((await queue.enqueue(input)).retryGeneration, 1);
  await queue.fail(manual.id, manual.leaseToken, { code: 'retryable', message: 'Temporary processing outage' });
  await pool.query('UPDATE jobs SET available_at=clock_timestamp() WHERE id=$1', [initial.id]);
  const automatic = await queue.claim('automatic');
  lease(automatic);
  assert.equal(automatic.retryGeneration, 1);
  await expire(pool, automatic.id);
  const recovered = await queue.claim('recovered');
  lease(recovered);
  assert.equal(recovered.retryGeneration, 1);
  assert.equal(recovered.attempts, 4);
  await queue.complete(recovered.id, recovered.leaseToken, {}, 'partial');
  assert.equal(await queue.retry(recovered.id), true);
  assert.equal((await queue.enqueue(input)).retryGeneration, 2);
  assert.equal(await queue.retry(recovered.id), false);
  assert.equal((await queue.enqueue(input)).retryGeneration, 2);
  await assert.rejects(pool.query('UPDATE jobs SET retry_generation=-1 WHERE id=$1', [initial.id]), /check constraint/i);
});

test('idempotency conflicts expose a stable conflict code for HTTP mapping', databaseTest, async (t) => {
  const pool = await isolatedDatabase(t);
  const queue = new JobQueue(pool);
  const parent = await queue.enqueue({ type: 'parent', payload: {}, idempotencyKey: 'conflict-parent' });
  const input = { type: 'child', payload: { documentId: 'one' }, idempotencyKey: 'typed-conflict', dependencies: [parent.id] };
  await queue.enqueue(input);
  for (const conflicting of [{ ...input, payload: { documentId: 'two' } }, { ...input, dependencies: [] }]) {
    await assert.rejects(queue.enqueue(conflicting), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.ok('code' in error);
      assert.equal(error.code, 'conflict');
      assert.match(error.message, /idempotency/i);
      return true;
    });
  }
});
