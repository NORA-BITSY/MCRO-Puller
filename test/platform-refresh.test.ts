import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Pool } from 'pg';
import { migrate } from '../src/platform/database.js';
import { CourtService } from '../src/platform/service.js';
import { LocalArtifactStore } from '../src/platform/storage.js';
import { IndependentFixtureAdapter } from '../src/platform/adapters.js';
import type { CaseObservation } from '../src/platform/contracts.js';
import { defaultRefreshPolicy, refreshDecision, type RefreshEvidence } from '../src/platform/refresh.js';
import { invokeOperation } from '../src/platform/interfaces.js';
import { runCli } from '../src/platform/courtctl.js';
import { createApi } from '../src/platform/api.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../src/platform/mcp.js';

const url = process.env.COURT_TEST_DATABASE_URL;
const now = new Date('2026-11-13T00:00:00Z');
const day = 86_400_000;
const base: RefreshEvidence = {
  created_at: new Date(now.getTime() - 60 * day), status: 'Active', watched: false,
  latest_complete: true, last_meaningful_activity_at: null, latest_refresh_status: null,
};

test('adaptive refresh class boundaries use observed activity, with watched priority', () => {
  const decide = (patch: Partial<RefreshEvidence>) => refreshDecision({ ...base, ...patch }, defaultRefreshPolicy, now);
  assert.deepEqual(decide({}), { refreshClass: 'active', intervalMinutes: 1440, priority: 0 });
  assert.equal(decide({ created_at: new Date(now.getTime() - 7 * day + 1) }).refreshClass, 'new');
  assert.equal(decide({ created_at: new Date(now.getTime() - 7 * day) }).refreshClass, 'active');
  assert.equal(decide({ last_meaningful_activity_at: new Date(now.getTime() - 30 * day + 1) }).refreshClass, 'recent');
  assert.equal(decide({ last_meaningful_activity_at: new Date(now.getTime() - 30 * day) }).refreshClass, 'active');
  assert.equal(decide({ status: 'Closed' }).intervalMinutes, 43200);
  assert.equal(decide({ status: 'Inactive' }).intervalMinutes, 10080);
  assert.equal(decide({ status: 'Closed', latest_complete: false }).refreshClass, 'partial');
  assert.equal(decide({ latest_refresh_status: 'dead_letter' }).refreshClass, 'failed');
  assert.deepEqual(decide({ watched: true, status: 'Closed' }), { refreshClass: 'watched', intervalMinutes: 60, priority: 100 });
  assert.equal(decide({ status: 'Source-specific unknown label' }).intervalMinutes, 1440);
});

async function setup(t: TestContext, beforeRefreshMigration = false) {
  const schema = `refresh_${randomUUID().replaceAll('-', '')}`;
  const admin = new Pool({ connectionString: url });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({ connectionString: url, options: `-c search_path=${schema},public` });
  const directory = await mkdtemp(path.join(os.tmpdir(), 'court-refresh-'));
  t.after(async () => { await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); await rm(directory, { recursive: true, force: true }); });
  if (beforeRefreshMigration) {
    const migrations = (await readdir('migrations')).filter(name => /^\d+_.*\.sql$/.test(name) && name < '0009_').sort();
    for (const migration of migrations) await pool.query(await readFile(path.join('migrations', migration), 'utf8'));
  } else await migrate(pool);
  const adapter = new IndependentFixtureAdapter();
  const store = new LocalArtifactStore(directory);
  const adapters = new Map([[adapter.metadata().id, adapter]]);
  const service = new CourtService(pool, store, adapters);
  await service.registerSources();
  return { pool, service, store, adapters };
}

function observation(sourceCaseId: string, observedAt = new Date().toISOString(), overrides: Partial<CaseObservation> = {}): CaseObservation {
  return { sourceId: 'independent-fixture', sourceCaseId, caseNumber: sourceCaseId, title: 'Synthetic refresh test', court: 'Fixture court', status: 'Active', observedAt,
    complete: true, participants: [], sections: {}, raw: {}, entries: [{ identityKey: 'entry', sourceId: 'entry', sourceOrder: 1, date: '1900-01-01', title: 'Initial event', documents: [], identityConfidence: 'source', raw: {} }], ...overrides };
}

async function due(pool: Pool, id: string) {
  await pool.query("UPDATE cases SET next_refresh_at=now()-interval '1 minute' WHERE id=$1", [id]);
}

test('metadata-only source search remains unscheduled and root completion is not acquisition', { skip: !url }, async t => {
  const { pool, service } = await setup(t);
  await service.requestAcquisition({ sourceId: 'independent-fixture', searchType: 'party', lastName: 'Doe', firstName: 'Jane', acquireResults: false }, 'metadata-only');
  const root = await service.jobs.claim('metadata-worker'); assert.ok(root);
  const result = await service.executeJob(root);
  assert.equal(result.status, 'complete');
  assert.match(String(result.result.completionScope), /source observation only/);
  assert.deepEqual(result.result.childJobIds, []);
  await service.jobs.complete(root.id, root.leaseToken!, result.result, result.status);
  const rows = await pool.query('SELECT next_refresh_at FROM cases');
  assert.ok(rows.rowCount! > 0);
  assert.ok(rows.rows.every(row => row.next_refresh_at === null));
  await service.scheduleDue();
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM jobs WHERE type='refresh_case'")).rows[0].n, 0);
});

test('discovery and case refresh are independent, durable and concurrent scheduler calls dedupe', { skip: !url }, async t => {
  const { pool, service, store, adapters } = await setup(t);
  const saved = await service.ingestObservation(observation('tracked'));
  await due(pool, saved.caseId);
  await service.planDiscovery({ sourceId: 'independent-fixture', searchType: 'case', caseNumber: 'FX-2024-0001', acquireResults: false });
  await Promise.all(Array.from({ length: 6 }, () => service.scheduleDue()));
  const jobs = (await pool.query('SELECT id,type,status FROM jobs ORDER BY type')).rows;
  assert.deepEqual(jobs.map(row => row.type), ['refresh_case', 'source_search']);
  const restarted = new CourtService(pool, store, adapters);
  await restarted.scheduleDue();
  assert.deepEqual((await pool.query('SELECT id,type,status FROM jobs ORDER BY type')).rows, jobs);
  assert.ok(await restarted.jobs.claim('restarted-worker'));
});

test('terminal discovery failures stop scheduling and require explicit replanning', { skip: !url }, async t => {
  const { pool, service } = await setup(t);
  const query = { sourceId: 'independent-fixture', searchType: 'case', caseNumber: 'FX-2024-0001', acquireResults: false };
  const plan = await service.planDiscovery(query) as { partitionId: string };
  await service.scheduleDue();
  const first = await service.jobs.claim('discovery-failure'); assert.ok(first?.leaseToken);
  await service.jobs.fail(first.id, first.leaseToken, { code: 'permanent', message: 'Unsupported source contract' });
  for (let tick = 0; tick < 3; tick++) {
    assert.equal((await service.scheduleDue() as { scheduled: number }).scheduled, 0);
  }
  const stopped = (await pool.query('SELECT status,next_run_at FROM discovery_partitions WHERE id=$1', [plan.partitionId])).rows[0];
  assert.equal(stopped.status, 'failed');
  assert.equal(stopped.next_run_at, null);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM jobs')).rows[0].n, 1);
  await service.planDiscovery(query);
  await service.scheduleDue();
  const replacement = await service.jobs.claim('explicit-replan'); assert.ok(replacement);
  assert.notEqual(replacement.id, first.id);
  assert.equal((await pool.query('SELECT status FROM jobs WHERE id=$1', [first.id])).rows[0].status, 'dead_letter');
});

test('exhausted transient discovery uses bounded generations and durable backoff', { skip: !url }, async t => {
  const { pool, service, store, adapters } = await setup(t);
  const plan = await service.planDiscovery({ sourceId: 'independent-fixture', searchType: 'case', caseNumber: 'FX-2024-0001', acquireResults: false }) as { partitionId: string };
  const seen = new Set<string>();
  for (let generation = 0; generation < 3; generation++) {
    await service.scheduleDue();
    const job = await service.jobs.claim(`outage-${generation}`); assert.ok(job?.leaseToken);
    assert.ok(!seen.has(job.id)); seen.add(job.id);
    await pool.query('UPDATE jobs SET max_attempts=attempts WHERE id=$1', [job.id]);
    await service.jobs.fail(job.id, job.leaseToken, { code: 'retryable', message: 'Temporary outage' });
    await Promise.all(Array.from({ length: 4 }, () => service.scheduleDue()));
    const partition = (await pool.query('SELECT generation,recovery_count,status,next_run_at FROM discovery_partitions WHERE id=$1', [plan.partitionId])).rows[0];
    assert.equal(partition.generation, Math.min(generation + 1, 2));
    assert.equal(partition.recovery_count, Math.min(generation + 1, 2));
    assert.equal(partition.status, generation < 2 ? 'pending' : 'failed');
    if (generation < 2) {
      assert.ok(partition.next_run_at.getTime() > Date.now() + 5 * 60 * 60 * 1000);
      const restarted = new CourtService(pool, store, adapters);
      assert.equal((await restarted.scheduleDue() as { scheduled: number }).scheduled, 0);
      await pool.query("UPDATE discovery_partitions SET next_run_at=now()-interval '1 second' WHERE id=$1", [plan.partitionId]);
    } else assert.equal(partition.next_run_at, null);
  }
  assert.equal((await service.scheduleDue() as { scheduled: number }).scheduled, 0);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM jobs')).rows[0].n, 3);
  const coverage = await service.getCoverageReport({ sourceId: 'independent-fixture' }) as { data: { status: string; denominator: unknown }[] };
  assert.equal(coverage.data.length, 3);
  assert.ok(coverage.data.every(row => row.status === 'failed' && row.denominator === null));
});

test('expired final discovery lease enters the same bounded recovery path', { skip: !url }, async t => {
  const { pool, service } = await setup(t);
  const plan = await service.planDiscovery({ sourceId: 'independent-fixture', searchType: 'case', caseNumber: 'FX-2024-0001', acquireResults: false }) as { partitionId: string };
  await service.scheduleDue();
  const job = await service.jobs.claim('crashed-discovery'); assert.ok(job);
  await pool.query("UPDATE jobs SET max_attempts=attempts,lease_expires_at=now()-interval '1 second' WHERE id=$1", [job.id]);
  assert.equal(await service.jobs.claim('lease-reaper'), null);
  assert.equal((await service.scheduleDue() as { scheduled: number }).scheduled, 0);
  const partition = (await pool.query('SELECT generation,status,last_error_code FROM discovery_partitions WHERE id=$1', [plan.partitionId])).rows[0];
  assert.deepEqual(partition, { generation: 1, status: 'pending', last_error_code: 'lease_expired' });
});

test('manual and due refresh share active work without weakening idempotency conflicts', { skip: !url }, async t => {
  const { pool, service } = await setup(t);
  const saved = await service.ingestObservation(observation('overlap'));
  await due(pool, saved.caseId);
  await Promise.all([service.scheduleDue(), service.requestRefresh(saved.caseId, 'manual-overlap'), service.requestRefresh(saved.caseId, 'second-overlap')]);
  await pool.query('UPDATE sources SET enabled=false');
  for (let index = 0; index < 2; index++) {
    const request = await service.jobs.claim('manual-request'); assert.equal(request?.type, 'refresh_request'); assert.ok(request);
    const result = await service.executeJob(request);
    await service.jobs.complete(request.id, request.leaseToken!, result.result, result.status);
    assert.equal((await service.getJobStatus(request.id) as { workflowStatus: string }).workflowStatus, 'pending');
  }
  assert.equal((await pool.query('SELECT count(DISTINCT child_id)::integer AS n FROM job_links')).rows[0].n, 1);
  const original = await service.requestRefresh(saved.caseId, 'manual-overlap');
  assert.deepEqual(await service.requestRefresh(saved.caseId, 'manual-overlap'), original);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM jobs WHERE type='refresh_case'")).rows[0].n, 1);
  const other = await service.ingestObservation(observation('other'));
  const first = (await pool.query('SELECT idempotency_key FROM jobs')).rows[0].idempotency_key;
  await assert.rejects(service.requestRefresh(other.caseId, first), /Idempotency key/);
});

test('watch and validated policy persist, reprioritize due work, and never opt metadata-only cases in implicitly', { skip: !url }, async t => {
  const { pool, service, store, adapters } = await setup(t);
  const ordinary = await service.ingestObservation(observation('ordinary'));
  const watched = await service.ingestObservation(observation('watched'));
  const metadata = (await pool.query("INSERT INTO cases(source_id,source_case_id,case_number) VALUES('independent-fixture','metadata','M') RETURNING id")).rows[0].id;
  await service.setRefreshPolicy({ watchedMinutes: 15, activeMinutes: 1000 });
  await service.setCaseWatch(watched.caseId, true);
  assert.equal((await pool.query('SELECT next_refresh_at FROM cases WHERE id=$1', [metadata])).rows[0].next_refresh_at, null);
  await due(pool, ordinary.caseId); await due(pool, watched.caseId);
  await service.scheduleDue();
  const claimed = await service.jobs.claim('priority-worker'); assert.equal(claimed?.payload.caseId, watched.caseId);
  const row = (await pool.query('SELECT refresh_class,refresh_interval_minutes FROM cases WHERE id=$1', [watched.caseId])).rows[0];
  assert.deepEqual(row, { refresh_class: 'watched', refresh_interval_minutes: 15 });
  const restarted = new CourtService(pool, store, adapters);
  assert.equal((await restarted.getRefreshPolicy()).policy.watchedMinutes, 15);
  await assert.rejects(service.setRefreshPolicy({ watchedMinutes: 0 }));
  await assert.rejects(service.setRefreshPolicy({ activeMinutes: 1441 }));
  await assert.rejects(service.setRefreshPolicy({ bogus: 5 }));
  await service.setCaseWatch(watched.caseId, false);
  assert.equal((await pool.query('SELECT watched FROM cases WHERE id=$1', [watched.caseId])).rows[0].watched, false);
  await service.setCaseWatch(metadata, true);
  assert.ok((await pool.query('SELECT next_refresh_at FROM cases WHERE id=$1', [metadata])).rows[0].next_refresh_at);
});

test('activity projection backfills existing evidence and ignores source event dates, replay and reordering', { skip: !url }, async t => {
  const { pool, service } = await setup(t);
  const initial = observation('activity', '2026-01-01T00:00:00Z');
  const saved = await service.ingestObservation(initial);
  await service.ingestObservation({ ...initial, observedAt: '2026-01-02T00:00:00Z', entries: [{ ...initial.entries[0]!, sourceOrder: 2 }] });
  let evidence = (await pool.query('SELECT * FROM case_refresh_evidence WHERE case_id=$1', [saved.caseId])).rows[0];
  assert.equal(evidence.meaningful_change_count, 0);
  assert.equal(evidence.last_meaningful_activity_at, null);
  const changed = { ...initial, observedAt: '2026-01-03T00:00:00Z', entries: [{ ...initial.entries[0]!, sourceOrder: 2, title: 'Amended event' }] };
  await service.ingestObservation(changed); await service.ingestObservation(changed);
  evidence = (await pool.query('SELECT * FROM case_refresh_evidence WHERE case_id=$1', [saved.caseId])).rows[0];
  assert.equal(evidence.snapshot_count, 3);
  assert.equal(evidence.meaningful_change_count, 1);
  assert.equal(evidence.change_frequency, 0.5);
  assert.equal(evidence.last_meaningful_activity_at.toISOString(), changed.observedAt.replace('Z', '.000Z'));
});

test('disabled and paused sources retain due work; permanent refresh failure requires explicit retry', { skip: !url }, async t => {
  const { pool, service } = await setup(t);
  const saved = await service.ingestObservation(observation('failed'));
  await due(pool, saved.caseId);
  await pool.query('UPDATE sources SET enabled=false');
  await service.scheduleDue(); assert.equal(await service.jobs.claim('disabled'), null);
  await pool.query("UPDATE sources SET enabled=true,paused_until=now()+interval '1 hour'");
  await service.scheduleDue(); assert.equal(await service.jobs.claim('paused'), null);
  await pool.query('UPDATE sources SET paused_until=NULL');
  await service.scheduleDue();
  const job = await service.jobs.claim('failure'); assert.ok(job);
  await service.jobs.fail(job.id, job.leaseToken!, { code: 'permanent', message: 'Fixture failure' });
  await pool.query("UPDATE jobs SET updated_at=now()-interval '7 hours' WHERE id=$1", [job.id]);
  await service.scheduleDue();
  assert.equal((await pool.query('SELECT next_refresh_at FROM cases WHERE id=$1',[saved.caseId])).rows[0].next_refresh_at,null);
  assert.equal(await service.jobs.claim('no-automatic-permanent-retry'),null);
  await service.retryJob(job.id);
  assert.equal((await service.jobs.claim('explicit-retry'))!.id,job.id);
});

test('shared authorization, CLI and HTTP expose watch and refresh policy operations', { skip: !url }, async t => {
  const { service } = await setup(t);
  const saved = await service.ingestObservation(observation('interfaces'));
  await assert.rejects(invokeOperation(service, 'set_case_watch', { id: saved.caseId, enabled: true }, 'read'), /permission/);
  await assert.rejects(invokeOperation(service, 'set_refresh_policy', { policy: { watchedMinutes: 10 } }, 'acquire'), /permission/);
  await runCli(['case', 'watch', saved.caseId, '--enabled', 'true'], service);
  await runCli(['refresh-policy', 'set', '--policy', '{"watchedMinutes":10}'], service);
  assert.equal((await service.getRefreshPolicy()).policy.watchedMinutes, 10);
  const app = await createApi(service, { env: { API_TOKEN_READ: 'read', API_TOKEN_WRITE: 'write', API_TOKEN_ADMIN: 'admin' } });
  t.after(() => app.close());
  assert.equal((await app.inject({ method: 'GET', url: '/api/v1/refresh-policy', headers: { authorization: 'Bearer read' } })).statusCode, 200);
  assert.equal((await app.inject({ method: 'POST', url: `/api/v1/cases/${saved.caseId}/watch`, headers: { authorization: 'Bearer write' }, payload: { enabled: false } })).statusCode, 200);
  assert.equal((await app.inject({ method: 'POST', url: '/api/v1/refresh-policy', headers: { authorization: 'Bearer admin' }, payload: { policy: { watchedMinutes: -1 } } })).statusCode, 400);
});

test('migration clears legacy implicit schedules/jobs but preserves explicit intent and existing observations', { skip: !url }, async t => {
  const { pool, service } = await setup(t, true);
  const metadata = (await pool.query("INSERT INTO cases(source_id,source_case_id,case_number) VALUES('independent-fixture','legacy-metadata','M') RETURNING id")).rows[0].id;
  const explicit = (await pool.query("INSERT INTO cases(source_id,source_case_id,case_number) VALUES('independent-fixture','explicit','E') RETURNING id")).rows[0].id;
  await service.jobs.enqueue({ type: 'refresh_case', sourceId: 'independent-fixture', payload: { caseId: metadata, sourceCaseId: 'legacy-metadata' }, idempotencyKey: `refresh:${metadata}:2026-01-01T00:00:00.000Z` });
  await service.jobs.enqueue({ type: 'refresh_case', sourceId: 'independent-fixture', payload: { caseId: explicit, sourceCaseId: 'explicit' }, idempotencyKey: 'explicit-intent' });
  const saved = await service.ingestObservation(observation('observed', '2026-01-01T00:00:00Z'));
  await service.ingestObservation(observation('observed', '2026-01-02T00:00:00Z', { status: 'Closed' }));
  await pool.query(await readFile('migrations/0009_refresh_policy.sql', 'utf8'));
  assert.equal((await pool.query('SELECT next_refresh_at FROM cases WHERE id=$1', [metadata])).rows[0].next_refresh_at, null);
  assert.ok((await pool.query('SELECT next_refresh_at FROM cases WHERE id=$1', [explicit])).rows[0].next_refresh_at);
  assert.ok((await pool.query('SELECT next_refresh_at FROM cases WHERE id=$1', [saved.caseId])).rows[0].next_refresh_at);
  assert.equal((await pool.query("SELECT status FROM jobs WHERE payload->>'caseId'=$1", [metadata])).rows[0].status, 'cancelled');
  assert.equal((await pool.query('SELECT meaningful_change_count FROM case_refresh_evidence WHERE case_id=$1', [saved.caseId])).rows[0].meaningful_change_count, 1);
  const future = (await pool.query("INSERT INTO cases(source_id,source_case_id,case_number) VALUES('independent-fixture','future-metadata','F') RETURNING next_refresh_at")).rows[0];
  assert.equal(future.next_refresh_at, null);
});

test('PostgreSQL scheduling records new, changed, older active, partial, inactive and closed decisions', { skip: !url }, async t => {
  const { pool, service } = await setup(t);
  const old = new Date(Date.now() - 60 * day).toISOString();
  for (const kind of ['new', 'recent', 'active', 'partial', 'inactive', 'closed']) {
    const initial = observation(kind, old, { status: kind === 'inactive' ? 'Inactive' : kind === 'closed' ? 'Closed' : 'Active', complete: kind !== 'partial' });
    const saved = await service.ingestObservation(initial);
    if (kind !== 'new') await pool.query("UPDATE cases SET created_at=now()-interval '60 days' WHERE id=$1", [saved.caseId]);
    if (kind === 'recent') await service.ingestObservation({ ...initial, observedAt: new Date().toISOString(), entries: [{ ...initial.entries[0]!, title: 'Newly observed amendment' }] });
    await due(pool, saved.caseId);
  }
  await service.scheduleDue();
  const rows = (await pool.query('SELECT source_case_id,refresh_class,refresh_interval_minutes FROM cases ORDER BY source_case_id')).rows;
  assert.deepEqual(rows, [
    { source_case_id: 'active', refresh_class: 'active', refresh_interval_minutes: 1440 },
    { source_case_id: 'closed', refresh_class: 'closed', refresh_interval_minutes: 43200 },
    { source_case_id: 'inactive', refresh_class: 'inactive', refresh_interval_minutes: 10080 },
    { source_case_id: 'new', refresh_class: 'new', refresh_interval_minutes: 360 },
    { source_case_id: 'partial', refresh_class: 'partial', refresh_interval_minutes: 120 },
    { source_case_id: 'recent', refresh_class: 'recent', refresh_interval_minutes: 720 },
  ]);
});

test('explicit fixture acquisition schedules its next observation using persisted policy, not root completion', { skip: !url }, async t => {
  const { pool, service } = await setup(t);
  await service.setRefreshPolicy({ newMinutes: 45 });
  await service.requestAcquisition({ sourceId: 'independent-fixture', searchType: 'case', caseNumber: 'FX-2024-0001' }, 'acquiring-search');
  const root = await service.jobs.claim('search'); assert.ok(root);
  const search = await service.executeJob(root);
  await service.jobs.complete(root.id, root.leaseToken!, search.result, search.status);
  assert.equal(search.status, 'complete');
  assert.equal((await service.getJobStatus(root.id) as { workflowStatus: string }).workflowStatus, 'pending');
  const refresh = await service.jobs.claim('docket'); assert.equal(refresh?.type, 'refresh_case'); assert.ok(refresh);
  const observed = await service.executeJob(refresh);
  await service.jobs.complete(refresh.id, refresh.leaseToken!, observed.result, observed.status);
  const schedule = (await pool.query('SELECT refresh_interval_minutes,extract(epoch FROM next_refresh_at-clock_timestamp())/60 AS remaining FROM cases')).rows[0];
  assert.equal(schedule.refresh_interval_minutes, 45);
  assert.ok(Number(schedule.remaining) > 44 && Number(schedule.remaining) <= 45);
});

test('MCP watch and policy operations use the real database and enforce role visibility', { skip: !url }, async t => {
  const { pool, service } = await setup(t);
  const saved = await service.ingestObservation(observation('mcp-watch'));
  const credentials = { API_TOKEN_READ: 'read', API_TOKEN_WRITE: 'write', API_TOKEN_ADMIN: 'admin' };
  for (const role of ['read', 'acquire', 'admin'] as const) {
    const server = createMcpServer(service, { env: { ...credentials, MCP_ROLE: role, MCP_TOKEN: role === 'acquire' ? 'write' : role } });
    const client = new Client({ name: `refresh-${role}`, version: '1.0.0' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    t.after(async () => { await client.close(); await server.close(); });
    await server.connect(b); await client.connect(a);
    const { tools } = await client.listTools();
    assert.ok(tools.some(tool => tool.name === 'get_refresh_policy'));
    assert.equal(tools.some(tool => tool.name === 'set_case_watch'), role !== 'read');
    assert.equal(tools.some(tool => tool.name === 'set_refresh_policy'), role === 'admin');
    if (role === 'acquire') {
      assert.notEqual((await client.callTool({ name: 'set_case_watch', arguments: { id: saved.caseId, enabled: true } })).isError, true);
      assert.equal((await pool.query('SELECT watched FROM cases WHERE id=$1', [saved.caseId])).rows[0].watched, true);
    }
    if (role === 'admin') {
      assert.notEqual((await client.callTool({ name: 'set_refresh_policy', arguments: { policy: { watchedMinutes: 20 } } })).isError, true);
      assert.equal((await service.getRefreshPolicy()).policy.watchedMinutes, 20);
      assert.equal((await client.callTool({ name: 'set_refresh_policy', arguments: { policy: { unknownMinutes: 20 } } })).isError, true);
    }
  }
});

test('capped discovery persists bounded splits and irreducible gaps across scheduler restart', { skip: !url }, async t => {
  const { pool, service, store, adapters } = await setup(t);
  class Saturated extends IndependentFixtureAdapter {
    override async searchCases(...args: Parameters<IndependentFixtureAdapter['searchCases']>) {
      const observed = await super.searchCases(...args);
      return { ...observed, complete: false, truncated: true, limitations: ['Synthetic source result cap'] };
    }
  }
  adapters.set('independent-fixture', new Saturated());
  const plan = await service.planDiscovery({ sourceId: 'independent-fixture', searchType: 'business', businessName: 'Example*',
    filedFrom: '2024-01-01', filedTo: '2024-01-02', acquireResults: false }) as { partitionId: string };
  await service.scheduleDue();
  const parent = await service.jobs.claim('capped-parent'); assert.ok(parent?.leaseToken);
  const result = await service.executeJob(parent);
  assert.equal(result.status, 'partial');
  assert.equal(await service.jobs.complete(parent.id, parent.leaseToken, result.result, result.status), true);
  const children = (await pool.query("SELECT id,query,status FROM discovery_partitions WHERE parent_id=$1 ORDER BY query->>'filedFrom'", [plan.partitionId])).rows;
  assert.deepEqual(children.map(row => [row.query.filedFrom, row.query.filedTo, row.status]), [
    ['2024-01-01', '2024-01-01', 'pending'], ['2024-01-02', '2024-01-02', 'pending'],
  ]);
  const restarted = new CourtService(pool, store, adapters);
  await restarted.scheduleDue();
  for (const child of children) {
    const job = await restarted.jobs.claim(`capped-${child.id}`); assert.ok(job?.leaseToken);
    const observation = await restarted.executeJob(job);
    assert.equal(observation.status, 'partial');
    await restarted.jobs.complete(job.id, job.leaseToken, observation.result, observation.status);
  }
  assert.deepEqual((await pool.query('SELECT status,next_run_at FROM discovery_partitions ORDER BY parent_id NULLS FIRST,id')).rows,
    [{ status: 'split', next_run_at: null }, { status: 'saturated', next_run_at: null }, { status: 'saturated', next_run_at: null }]);
  assert.deepEqual((await pool.query("SELECT status,denominator FROM coverage_observations WHERE dimension='discovery' ORDER BY id")).rows,
    Array.from({ length: 3 }, () => ({ status: 'truncated', denominator: null })));
  const cases = (await pool.query('SELECT source_case_id,next_refresh_at FROM cases')).rows;
  assert.deepEqual(cases, [{ source_case_id: 'civil:alpha/2024', next_refresh_at: null }]);
  assert.deepEqual(await restarted.scheduleDue(), { scheduled: 0, jobIds: [] });
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM jobs')).rows[0].count, 3);
});
