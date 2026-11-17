import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { Pool } from 'pg';
import { z } from 'zod';
import { createApi } from '../src/platform/api.js';
import { IndependentFixtureAdapter,MinnesotaAdapter,mapRoa } from '../src/platform/adapters.js';
import { SourceError } from '../src/platform/contracts.js';
import type { AcquisitionContext, ArtifactObservation, CaseObservation, CourtSourceAdapter, DocketEntry, DocumentReference } from '../src/platform/contracts.js';
import { migrate } from '../src/platform/database.js';
import type { Job } from '../src/platform/jobs.js';
import { CourtService } from '../src/platform/service.js';
import { LocalArtifactStore, sha256 } from '../src/platform/storage.js';
import { runOne } from '../src/platform/worker.js';
import { analyzePages } from '../src/platform/processing.js';
import { runCli } from '../src/platform/courtctl.js';
import { createMcpServer } from '../src/platform/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
const databaseUrl = process.env.COURT_TEST_DATABASE_URL;
const databaseTest = {
  skip: databaseUrl ? false : 'COURT_TEST_DATABASE_URL is required for real PostgreSQL failure acceptance',
  timeout: 60_000,
};
const sourceId = 'independent-fixture';
const apiEnv = { API_TOKEN_READ: 'failure-read', API_TOKEN_WRITE: 'failure-write', API_TOKEN_ADMIN: 'failure-admin' };
const readHeaders = { authorization: `Bearer ${apiEnv.API_TOKEN_READ}` };
const pageSchema = z.object({
  data: z.array(z.object({ id: z.string() }).passthrough()),
  meta: z.object({ limit: z.number(), offset: z.number(), hasMore: z.boolean() }),
});
const submissionSchema = z.object({ jobId: z.string().uuid(), status: z.string() });

async function isolated(t: TestContext, adapter: CourtSourceAdapter = new IndependentFixtureAdapter(), applyMigrations = true) {
  assert.ok(databaseUrl, 'Use a disposable PostgreSQL database, never a production connection');
  const admin = new Pool({ connectionString: databaseUrl });
  const schema = `failure_${randomUUID().replaceAll('-', '')}`;
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema},public`, max: 12 });
  let directory: string | undefined;
  t.after(async () => {
    try {
      await pool.end();
    } finally {
      try {
        await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      } finally {
        await admin.end();
        if (directory) await rm(directory, { recursive: true, force: true });
      }
    }
  });
  directory = await mkdtemp(path.join(os.tmpdir(), 'court-failure-'));
  const store = new LocalArtifactStore(directory);
  const service = new CourtService(pool, store, new Map([[adapter.metadata().id, adapter]]));
  t.after(() => adapter.close());
  if (applyMigrations) {
    await migrate(pool);
    await service.registerSources();
  }
  return { pool, service, store, directory };
}

function document(sourceDocumentId: string, entryKey: string): DocumentReference {
  return { sourceDocumentId, entryKey, caseNumber: 'SYNTHETIC-1', title: 'Synthetic filing', filename: 'filing.pdf', availability: 'available', raw: { fixture: true } };
}

function event(identityKey: string, sourceOrder: number, title = 'Synthetic docket event', documents: DocumentReference[] = []): DocketEntry {
  return { identityKey, sourceId: identityKey, sourceOrder, date: '2026-01-01', title, documents, raw: { fixture: true }, identityConfidence: 'source' };
}

function observation(overrides: Partial<CaseObservation> = {}): CaseObservation {
  return {
    sourceId, sourceCaseId: 'synthetic:case/1', caseNumber: 'SYNTHETIC-1', title: 'Synthetic acceptance case',
    court: 'Synthetic first court', status: 'Active', observedAt: '2026-01-01T00:00:00.000Z', complete: true,
    entries: [event('entry-a', 0, 'Synthetic filing', [document('document-a', 'entry-a')])],
    participants: [{ id: 'party-a', kind: 'person', name: 'Synthetic Party', role: 'Petitioner' }],
    sections: { hearings: [{ id: 'hearing-a', date: '2026-02-01', type: 'Synthetic review' }] }, raw: { fixture: true },
    ...overrides,
  };
}

// A complete locally generated one-page PDF, not source downloads or header camouflage.
// This follows the xref/page-tree fixture convention in ocr.test.js.
function pdf(text: string): Buffer {
  const escaped = text.replaceAll('\\', '\\\\').replaceAll('(', '\\(').replaceAll(')', '\\)');
  const stream = `BT /F1 10 Tf 40 720 Td (${escaped}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let output = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(output));
    output += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(output);
  output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  output += offsets.map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  output += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(output);
}

async function checkpoint(service: CourtService, documentId: string, bytes = pdf('Synthetic searchable filing'), at = '2026-01-01T01:00:00.000Z', filename = 'filing.pdf') {
  return service.persistArtifact(documentId, bytes, filename, 'application/pdf', 'https://fixture.invalid/filing', at);
}

// Seed search evidence explicitly; these rows test access/pagination, not OCR accuracy.
async function seedText(pool: Pool, versionId: string, texts: string[]) {
  const run = await pool.query<{ id: string }>(
    `INSERT INTO extraction_runs(document_version_id,pipeline_version,schema_version,status,result,finished_at)
     VALUES($1,'acceptance-seeded-evidence','fixture-1','complete','{}',clock_timestamp()) RETURNING id`, [versionId],
  );
  const runId = run.rows[0]!.id;
  for (const [index, text] of texts.entries()) {
    await pool.query("INSERT INTO pages(extraction_run_id,page_number,text,method,quality) VALUES($1,$2,$3,'fixture_seed','{}')", [runId, index + 1, text]);
    await pool.query('INSERT INTO chunks(extraction_run_id,page_number,start_offset,end_offset,text) VALUES($1,$2,0,$3,$4)', [runId, index + 1, text.length, text]);
  }
}

function running(job: Job | null): asserts job is Job & { leaseToken: string } {
  assert.ok(job);
  assert.equal(typeof job.leaseToken, 'string');
}

test('concurrent duplicate observations retain one case, snapshot, document, and status transition', databaseTest, async t => {
  const { pool, service } = await isolated(t);
  const input = observation();
  const results = await Promise.all(Array.from({ length: 8 }, () => service.ingestObservation(structuredClone(input))));
  assert.equal(new Set(results.map(result => result.caseId)).size, 1);
  assert.equal(new Set(results.map(result => result.snapshotId)).size, 1);
  for (const table of ['cases', 'docket_snapshots', 'docket_entries', 'entry_versions', 'entry_changes', 'documents', 'case_status_history']) {
    assert.equal((await pool.query(`SELECT count(*)::int AS count FROM ${table}`)).rows[0].count, 1, table);
  }
  assert.deepEqual((await pool.query('SELECT raw FROM docket_snapshots')).rows[0].raw, input);
});

test('inserted and reordered same-description events preserve identities without spurious versions', databaseTest, async t => {
  const { pool, service } = await isolated(t);
  const original = observation({ entries: [event('a', 0, 'Notice filed'), event('b', 1, 'Notice filed')] });
  await service.ingestObservation(original);
  const before = (await pool.query<{ id: string; identity_key: string }>('SELECT id,identity_key FROM docket_entries')).rows;
  const saved = await service.ingestObservation({ ...original, observedAt: '2026-01-02T00:00:00.000Z', entries: [event('new', 0, 'Non-document hearing scheduled'), event('b', 1, 'Notice filed'), event('a', 2, 'Notice filed')] });
  const after = (await pool.query<{ id: string; identity_key: string; source_order: number }>('SELECT id,identity_key,source_order FROM docket_entries ORDER BY source_order')).rows;
  assert.deepEqual(after.map(row => row.identity_key), ['new', 'b', 'a']);
  for (const old of before) assert.equal(after.find(row => row.identity_key === old.identity_key)?.id, old.id);
  assert.equal((await pool.query('SELECT id FROM entry_versions')).rowCount, 3);
  const changes = await pool.query('SELECT kind FROM entry_changes WHERE snapshot_id=$1 ORDER BY kind', [saved.snapshotId]);
  assert.deepEqual(changes.rows.map(row => row.kind), ['added', 'reordered']);
  assert.equal((await pool.query('SELECT id FROM documents')).rowCount, 0);
});

test('partial snapshots preserve absent entries, attachments, participants, and proceedings', databaseTest, async t => {
  const { pool, service } = await isolated(t);
  const original = observation();
  const saved = await service.ingestObservation(original);
  await service.ingestObservation({ ...original, observedAt: '2026-01-02T00:00:00.000Z', complete: false, entries: [], participants: [], sections: {} });
  assert.equal((await pool.query('SELECT availability FROM docket_entries')).rows[0].availability, 'public');
  assert.equal((await pool.query('SELECT availability FROM documents')).rows[0].availability, 'available');
  assert.equal((await pool.query('SELECT id FROM participants')).rowCount, 1);
  assert.equal((await pool.query('SELECT id FROM proceedings')).rowCount, 1);
  assert.equal((await pool.query("SELECT id FROM entry_changes WHERE kind='removed'")).rowCount, 0);
  assert.equal((await pool.query('SELECT acquisition_status FROM cases WHERE id=$1', [saved.caseId])).rows[0].acquisition_status, 'partial');
  assert.equal((await pool.query('SELECT complete FROM docket_snapshots ORDER BY observed_at DESC')).rows[0].complete, false);
});

test('complete disappearance and reappearance retain document bytes and entry history', databaseTest, async t => {
  const { pool, service, store } = await isolated(t);
  const original = observation();
  const first = await service.ingestObservation(original);
  const documentId = first.documents[0]!;
  const bytes = pdf('Retained synthetic source document');
  const versionId = await checkpoint(service, documentId, bytes);
  const entryId = (await pool.query('SELECT id FROM docket_entries')).rows[0].id;
  await service.ingestObservation({ ...original, observedAt: '2026-01-02T00:00:00.000Z', entries: [] });
  assert.equal(pageSchema.parse(await service.getCaseDocket(first.caseId)).data.length, 0);
  await assert.rejects(service.getFiling(documentId), { code: 'not_found' });
  assert.equal((await pool.query('SELECT id FROM document_versions WHERE id=$1', [versionId])).rowCount, 1);
  const artifact = (await pool.query<{ storage_key: string }>('SELECT storage_key FROM artifacts')).rows[0]!;
  assert.deepEqual(await store.get(artifact.storage_key), bytes);
  await service.ingestObservation({ ...original, observedAt: '2026-01-03T00:00:00.000Z' });
  assert.equal((await pool.query('SELECT id FROM docket_entries')).rows[0].id, entryId);
  assert.equal((await pool.query('SELECT id FROM documents')).rows[0].id, documentId);
  assert.equal((await pool.query("SELECT id FROM entry_changes WHERE kind='removed'")).rowCount, 1);
  assert.equal((await pool.query("SELECT id FROM entry_changes WHERE kind='reappeared'")).rowCount, 1);
});

test('stale observations and duplicate entry identities cannot mutate persisted state', databaseTest, async t => {
  const { pool, service } = await isolated(t);
  const current = observation({ observedAt: '2026-01-05T00:00:00.000Z', status: 'Closed' });
  await service.ingestObservation(current);
  await assert.rejects(service.ingestObservation({ ...current, observedAt: '2026-01-04T00:00:00.000Z', title: 'Stale title', status: 'Active', entries: [] }), { code: 'permanent' });
  await assert.rejects(service.ingestObservation({ ...current, observedAt: '2026-01-06T00:00:00.000Z', entries: [event('duplicate', 0), event('duplicate', 1)] }), { code: 'parse_error' });
  assert.equal((await pool.query('SELECT title,status,last_observed_at FROM cases')).rows[0].title, current.title);
  assert.equal((await pool.query('SELECT status FROM cases')).rows[0].status, 'Closed');
  assert.equal((await pool.query('SELECT id FROM docket_snapshots')).rowCount, 1);
  assert.equal((await pool.query('SELECT id FROM case_status_history')).rowCount, 1);
  assert.equal((await pool.query('SELECT id FROM documents')).rowCount, 1);
});

test('status changes, reopening, and court transfer preserve canonical identity and observation history', databaseTest, async t => {
  const { pool, service } = await isolated(t);
  const first = await service.ingestObservation(observation({ entries: [] }));
  const closed = await service.ingestObservation(observation({ entries: [], status: 'Closed', observedAt: '2026-01-02T00:00:00.000Z' }));
  const reopened = await service.ingestObservation(observation({ entries: [], status: 'Active', court: 'Synthetic transferee court', observedAt: '2026-01-03T00:00:00.000Z' }));
  assert.equal(first.caseId, closed.caseId);
  assert.equal(first.caseId, reopened.caseId);
  assert.deepEqual((await pool.query('SELECT status FROM case_status_history ORDER BY observed_at')).rows.map(row => row.status), ['Active', 'Closed', 'Active']);
  assert.equal((await pool.query('SELECT court FROM cases')).rows[0].court, 'Synthetic transferee court');
  assert.deepEqual((await pool.query('SELECT raw->>\'court\' AS court FROM docket_snapshots ORDER BY observed_at')).rows.map(row => row.court), ['Synthetic first court', 'Synthetic first court', 'Synthetic transferee court']);
});

test('conflicting human case numbers never merge distinct source case identifiers', databaseTest, async t => {
  const { pool, service } = await isolated(t);
  const first = await service.ingestObservation(observation({ entries: [] }));
  const second = await service.ingestObservation(observation({ sourceCaseId: 'synthetic:case/2', entries: [] }));
  assert.notEqual(first.caseId, second.caseId);
  const result = pageSchema.parse(await service.searchCases({ caseNumber: 'SYNTHETIC-1' }));
  assert.equal(result.data.length, 2);
  assert.equal((await pool.query("SELECT DISTINCT case_id FROM case_identifiers WHERE kind='case_number' AND value='SYNTHETIC-1'")).rowCount, 2);
});

test('changed bytes under the same filename create versions while byte-identical retries deduplicate', databaseTest, async t => {
  const { pool, service, store } = await isolated(t);
  const saved = await service.ingestObservation(observation());
  const documentId = saved.documents[0]!;
  const firstBytes = pdf('Original synthetic petition');
  const changedBytes = pdf('Replacement synthetic petition with changed facts');
  const first = await checkpoint(service, documentId, firstBytes);
  const repeats = await Promise.all(Array.from({ length: 4 }, () => checkpoint(service, documentId, firstBytes, '2026-01-02T01:00:00.000Z', 'renamed.pdf')));
  assert.ok(repeats.every(version => version === first));
  const changed = await checkpoint(service, documentId, changedBytes, '2026-01-03T01:00:00.000Z');
  assert.notEqual(changed, first);
  const versions = await pool.query<{ id: string; filename: string; sha256: string; storage_key: string }>('SELECT v.id,v.filename,a.sha256,a.storage_key FROM document_versions v JOIN artifacts a ON a.id=v.artifact_id ORDER BY v.acquired_at');
  assert.equal(versions.rows.length, 2);
  assert.deepEqual(versions.rows.map(row => row.filename), ['filing.pdf', 'filing.pdf']);
  assert.deepEqual(versions.rows.map(row => row.sha256), [sha256(firstBytes), sha256(changedBytes)]);
  assert.deepEqual(await store.get(versions.rows[0]!.storage_key), firstBytes);
  assert.deepEqual(await store.get(versions.rows[1]!.storage_key), changedBytes);
  assert.deepEqual((await service.getDocumentArtifact(documentId)).bytes, changedBytes);
});

test('storage write failure leaves no successful checkpoint and can resume without duplicate versions', databaseTest, async t => {
  const { pool, service, directory } = await isolated(t);
  const saved = await service.ingestObservation(observation());
  const obstruction = path.join(directory, 'sha256');
  await writeFile(obstruction, 'Synthetic filesystem failure: expected a directory');
  await assert.rejects(checkpoint(service, saved.documents[0]!));
  assert.equal((await pool.query('SELECT id FROM artifacts')).rowCount, 0);
  assert.equal((await pool.query('SELECT id FROM document_versions')).rowCount, 0);
  assert.notEqual((await pool.query('SELECT acquisition_status FROM documents')).rows[0].acquisition_status, 'complete');
  await rm(obstruction);
  const version = await checkpoint(service, saved.documents[0]!);
  assert.equal(await checkpoint(service, saved.documents[0]!), version);
  assert.equal((await pool.query('SELECT id FROM document_versions')).rowCount, 1);
});

test('database disconnect during artifact checkpoint rolls back and a new service resumes immutable bytes', databaseTest, async t => {
  const { pool, service, store } = await isolated(t);
  const saved = await service.ingestObservation(observation());
  // Terminate only the current fixture transaction's backend, never an arbitrary session.
  await pool.query(`CREATE FUNCTION disconnect_checkpoint() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN PERFORM pg_terminate_backend(pg_backend_pid()); RETURN NEW; END; $$`);
  await pool.query('CREATE TRIGGER disconnect_checkpoint BEFORE INSERT ON document_versions FOR EACH ROW EXECUTE FUNCTION disconnect_checkpoint()');
  const bytes = pdf('Synthetic interrupted checkpoint');
  await assert.rejects(checkpoint(service, saved.documents[0]!, bytes));
  assert.equal((await pool.query('SELECT id FROM artifacts')).rowCount, 0);
  assert.equal((await pool.query('SELECT id FROM document_versions')).rowCount, 0);
  assert.notEqual((await pool.query('SELECT acquisition_status FROM documents')).rows[0].acquisition_status, 'complete');
  const hash = sha256(bytes);
  assert.deepEqual(await store.get(`sha256/${hash.slice(0, 2)}/${hash}`), bytes);
  await pool.query('DROP TRIGGER disconnect_checkpoint ON document_versions');
  const restarted = new CourtService(pool, store, service.adapters);
  const version = await checkpoint(restarted, saved.documents[0]!, bytes);
  assert.equal(await checkpoint(restarted, saved.documents[0]!, bytes), version);
  assert.equal((await pool.query('SELECT id FROM artifacts')).rowCount, 1);
  assert.equal((await pool.query('SELECT id FROM document_versions')).rowCount, 1);
});

test('reconciliation interruption rolls back every projection and restart preserves the last committed snapshot', databaseTest, async t => {
  const { pool, service, store } = await isolated(t);
  const original = observation();
  const first = await service.ingestObservation(original);
  await pool.query(`CREATE FUNCTION fail_reconciliation() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.identity_key='fault' THEN RAISE EXCEPTION 'synthetic reconciliation fault'; END IF; RETURN NEW; END; $$`);
  await pool.query('CREATE TRIGGER fail_reconciliation BEFORE INSERT ON docket_entries FOR EACH ROW EXECUTE FUNCTION fail_reconciliation()');
  const replacement = observation({ observedAt: '2026-01-02T00:00:00.000Z', title: 'Updated fixture case', entries: [event('new', 0), event('fault', 1)] });
  await assert.rejects(service.ingestObservation(replacement), /synthetic reconciliation fault/);
  assert.equal((await pool.query('SELECT title FROM cases')).rows[0].title, original.title);
  assert.equal((await pool.query('SELECT id FROM docket_snapshots')).rows[0].id, first.snapshotId);
  assert.deepEqual((await pool.query('SELECT identity_key FROM docket_entries')).rows.map(row => row.identity_key), ['entry-a']);
  assert.equal((await pool.query('SELECT id FROM entry_versions')).rowCount, 1);
  await pool.query('DROP TRIGGER fail_reconciliation ON docket_entries');
  const restarted = new CourtService(pool, store, service.adapters);
  const second = await restarted.ingestObservation(replacement);
  assert.equal(second.caseId, first.caseId);
  assert.notEqual(second.snapshotId, first.snapshotId);
  assert.equal((await pool.query('SELECT id FROM docket_snapshots')).rowCount, 2);
  assert.deepEqual(pageSchema.parse(await restarted.getCaseDocket(first.caseId)).data.map(row => row['identity_key']), ['new', 'fault']);
});

test('SQL migration failure rolls back its ledger and tables before a clean retry', databaseTest, async t => {
  const { pool } = await isolated(t, new IndependentFixtureAdapter(), false);
  await pool.query('CREATE TABLE sources (sentinel text)');
  await pool.query("INSERT INTO sources(sentinel) VALUES ('preexisting fixture')");
  await assert.rejects(migrate(pool), /already exists/);
  assert.equal((await pool.query("SELECT to_regclass(current_schema() || '.schema_migrations') AS ledger")).rows[0].ledger, null);
  assert.equal((await pool.query("SELECT to_regclass(current_schema() || '.cases') AS cases")).rows[0].cases, null);
  assert.equal((await pool.query('SELECT sentinel FROM sources')).rows[0].sentinel, 'preexisting fixture');
  await pool.query('DROP TABLE sources');
  await migrate(pool);
  assert.ok((await pool.query('SELECT version FROM schema_migrations')).rowCount);
  assert.equal((await pool.query('SELECT id FROM cases')).rowCount, 0);
});

test('restricted cases disappear from service and REST search, text, metadata, and artifact access', databaseTest, async t => {
  const { pool, service } = await isolated(t);
  const saved = await service.ingestObservation(observation());
  const documentId = saved.documents[0]!;
  const versionId = await checkpoint(service, documentId);
  await seedText(pool, versionId, ['Synthetic confidentialityneedle filing text']);
  assert.equal(pageSchema.parse(await service.searchFilingText({ q: 'confidentialityneedle' })).data.length, 1);
  const app = await createApi(service, { env: apiEnv });
  t.after(() => app.close());
  const routes = [`/cases/${saved.caseId}`, `/cases/${saved.caseId}/docket`, `/filings/${documentId}`, `/documents/${documentId}/text`];
  for (const route of routes) assert.equal((await app.inject({ method: 'GET', url: `/api/v1${route}`, headers: readHeaders })).statusCode, 200);
  await service.restrictCase(saved.caseId, 'Synthetic restriction acceptance');
  for (const query of [service.searchCases({}), service.searchDocketEntries({}), service.searchFilingText({ q: 'confidentialityneedle' })]) {
    assert.equal(pageSchema.parse(await query).data.length, 0);
  }
  for (const get of [() => service.getCase(saved.caseId), () => service.getCaseDocket(saved.caseId), () => service.getFiling(documentId), () => service.getDocumentText(documentId), () => service.getDocumentArtifact(documentId)]) {
    await assert.rejects(get(), { code: 'not_found' });
  }
  for (const route of routes) assert.equal((await app.inject({ method: 'GET', url: `/api/v1${route}`, headers: readHeaders })).statusCode, 404);
  for (const route of ['/cases', '/docket-entries', '/filing-text?q=confidentialityneedle']) {
    const response = await app.inject({ method: 'GET', url: `/api/v1${route}`, headers: readHeaders });
    assert.equal(response.statusCode, 200);
    assert.equal(pageSchema.parse(response.json()).data.length, 0);
  }
  await assert.rejects(service.ingestObservation(observation({ observedAt: '2026-01-02T00:00:00.000Z' })), { code: 'restricted' });
  assert.equal((await pool.query('SELECT id FROM pages')).rowCount, 1, 'restriction gates access without destroying provenance');
  assert.equal((await pool.query("SELECT id FROM audit_events WHERE action='restrict'")).rowCount, 1);
});

test('restriction cancels active case work and closes its durable attempt without allowing a stale completion', databaseTest, async t => {
  const { pool, service } = await isolated(t);
  const saved = await service.ingestObservation(observation());
  const queued = await service.jobs.enqueue({ type: 'download_artifact', sourceId, payload: { caseId: saved.caseId, documentId: saved.documents[0] }, idempotencyKey: 'restricted-active' });
  const job = await service.jobs.claim('restriction-worker');
  running(job);
  await service.restrictCase(saved.caseId, 'Synthetic restriction during acquisition');
  assert.equal(await service.jobs.complete(job.id, job.leaseToken, { unsafe: true }), false);
  const status = z.object({ status: z.literal('cancelled'), attemptsHistory: z.array(z.object({ status: z.literal('cancelled'), finished_at: z.unknown().refine(value => value !== null) })) }).parse(await service.getJobStatus(queued.id));
  assert.equal(status.attemptsHistory.length, 1);
  assert.equal((await pool.query('SELECT lease_token FROM jobs WHERE id=$1', [job.id])).rows[0].lease_token, null);
});

test('replacement versions never expose the older version text as current before reprocessing', databaseTest, async t => {
  const { pool, service } = await isolated(t);
  const saved = await service.ingestObservation(observation());
  const documentId = saved.documents[0]!;
  const first = await checkpoint(service, documentId, pdf('Superseded text'));
  await seedText(pool, first, ['Supersededneedle text']);
  assert.equal(pageSchema.parse(await service.getDocumentText(documentId)).data.length, 1);
  await checkpoint(service, documentId, pdf('New source bytes not processed yet'), '2026-01-02T01:00:00.000Z');
  assert.equal(pageSchema.parse(await service.getDocumentText(documentId)).data.length, 0);
  assert.equal(pageSchema.parse(await service.searchFilingText({ q: 'Supersededneedle' })).data.length, 0);
  assert.equal((await pool.query('SELECT id FROM pages')).rowCount, 1, 'historical extracted evidence stays preserved');
});

test('service and REST pagination preserve boundaries, deterministic offsets, and maximum limits', databaseTest, async t => {
  const { pool, service } = await isolated(t);
  const saved = await service.ingestObservation(observation({ entries: Array.from({ length: 103 }, (_, index) => event(`paged-${index}`, index, `Synthetic event ${index}`, index === 0 ? [document('paged-document', 'paged-0')] : [])) }));
  const documentId = saved.documents[0]!;
  const version = await checkpoint(service, documentId);
  await seedText(pool, version, Array.from({ length: 103 }, (_, index) => `Synthetic pagination page ${index + 1}`));
  const first = pageSchema.parse(await service.getCaseDocket(saved.caseId, { limit: 100 }));
  const last = pageSchema.parse(await service.getCaseDocket(saved.caseId, { limit: 100, offset: 100 }));
  assert.equal(first.data.length, 100);
  assert.deepEqual(first.meta, { limit: 100, offset: 0, hasMore: true });
  assert.equal(last.data.length, 3);
  assert.deepEqual(last.meta, { limit: 100, offset: 100, hasMore: false });
  assert.equal(new Set([...first.data, ...last.data].map(row => row.id)).size, 103);
  assert.deepEqual(pageSchema.parse(await service.getCaseDocket(saved.caseId, { limit: 100 })).data.map(row => row.id), first.data.map(row => row.id));
  assert.equal(pageSchema.parse(await service.getCaseDocket(saved.caseId, {})).data.length, 50);
  const app = await createApi(service, { env: apiEnv });
  t.after(() => app.close());
  const endpoints = ['/cases', '/docket-entries', '/filing-text', `/cases/${saved.caseId}/docket`, `/documents/${documentId}/text`, '/coverage'];
  for (const endpoint of endpoints) {
    for (const query of ['limit=0', 'limit=101', 'limit=1.5', 'offset=-1', 'offset=100001', 'limit=NaN']) {
      assert.equal((await app.inject({ method: 'GET', url: `/api/v1${endpoint}?${query}`, headers: readHeaders })).statusCode, 400, `${endpoint}?${query}`);
    }
  }
  for (const operation of [service.searchCases.bind(service), service.searchDocketEntries.bind(service), service.searchFilingText.bind(service), service.getCoverageReport.bind(service)]) {
    await assert.rejects(operation({ limit: 101 }));
    await assert.rejects(operation({ offset: -1 }));
  }
  await assert.rejects(service.getCaseDocket(saved.caseId, { limit: 101 }));
  await assert.rejects(service.getDocumentText(documentId, { limit: 101 }));
  for (const endpoint of [`/cases/${saved.caseId}/docket`, `/documents/${documentId}/text`, '/filing-text']) {
    const response = await app.inject({ method: 'GET', url: `/api/v1${endpoint}?limit=100&offset=100`, headers: readHeaders });
    assert.equal(response.statusCode, 200);
    const data = pageSchema.parse(response.json());
    assert.equal(data.data.length, 3);
    assert.deepEqual(data.meta, { limit: 100, offset: 100, hasMore: false });
  }
});

test('mixed bulk input retains valid siblings, item errors, ordering, and idempotent child submissions', databaseTest, async t => {
  const { pool, service } = await isolated(t);
  const valid = { sourceId, searchType: 'case', caseNumber: 'FX-2024-0001' };
  const input = { queries: [valid, { searchType: 'invalid-mode' }, { sourceId, searchType: 'business', businessName: 'Example*' }], acquireResults: false };
  const request = z.object({ jobId: z.string(), validation: z.array(z.object({ index: z.number(), valid: z.boolean().optional(), error: z.string().optional() })) }).parse(await service.requestBulk(input, 'mixed-batch'));
  assert.deepEqual(request.validation.map(item => [item.index, item.valid ?? false]), [[0, true], [1, false], [2, true]]);
  assert.ok(request.validation[1]!.error);
  const job = await service.jobs.claim('batch-worker');
  running(job);
  assert.equal(job.id, request.jobId);
  const result = await service.executeJob(job);
  assert.equal(result.status, 'partial');
  const items = z.array(z.object({ index: z.number(), jobId: z.string().optional(), error: z.string().optional() })).parse(result.result['items']);
  assert.deepEqual(items.map(item => item.index), [0, 1, 2]);
  assert.ok(items[0]!.jobId);
  assert.ok(items[1]!.error);
  assert.ok(items[2]!.jobId);
  assert.equal((await pool.query("SELECT id FROM jobs WHERE type='source_search'")).rowCount, 2);
  assert.deepEqual(await service.executeJob(job), result);
  assert.equal((await pool.query("SELECT id FROM jobs WHERE type='source_search'")).rowCount, 2);
  assert.equal(await service.jobs.complete(job.id, job.leaseToken, result.result, result.status), true);
  const status = z.object({
    status: z.literal('pending'), stageStatus: z.literal('partial'), workflowStatus: z.literal('pending'),
    children: z.array(z.object({ id: z.string(), type: z.literal('source_search'), status: z.literal('queued') })),
  }).parse(await service.getJobStatus(job.id));
  assert.equal(status.children.length, 2);
  assert.deepEqual(new Set(status.children.map(child => child.id)), new Set(items.flatMap(item => item.jobId ? [item.jobId] : [])));
  const app = await createApi(service, { env: apiEnv });
  t.after(() => app.close());
  const response = await app.inject({ method: 'POST', url: '/api/v1/acquisitions/bulk', headers: { authorization: `Bearer ${apiEnv.API_TOKEN_WRITE}`, 'idempotency-key': 'mixed-api-batch' }, payload: { input } });
  assert.equal(response.statusCode, 202);
  const accepted = submissionSchema.parse(response.json());
  assert.equal((await pool.query('SELECT jsonb_array_length(payload->\'queries\') AS count FROM jobs WHERE id=$1', [accepted.jobId])).rows[0].count, 3);
});

test('cancellation during bulk submission stops later children and preserves the committed child', databaseTest, async t => {
  const { pool, service } = await isolated(t);
  const queries = ['FX-2024-0001', 'FX-2024-0002', 'FX-2024-0003'].map(caseNumber => ({ sourceId, searchType: 'case', caseNumber }));
  const request = submissionSchema.parse(await service.requestBulk({ queries }, 'cancel-bulk'));
  const job = await service.jobs.claim('bulk-cancellation-worker');
  running(job);
  assert.equal(job.id, request.jobId);
  // Revoke the parent lease in the first real child+lineage checkpoint transaction.
  // The next enqueue must fence against the persisted cancellation, not publish another child.
  await pool.query(`CREATE FUNCTION cancel_bulk_after_link() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.parent_id=TG_ARGV[0]::uuid THEN
        UPDATE jobs SET status='cancelled',lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,
          error='{"code":"cancelled","message":"Synthetic cancellation during bulk checkpoint"}'::jsonb,
          updated_at=clock_timestamp() WHERE id=NEW.parent_id AND status='running';
        UPDATE job_attempts SET status='cancelled',finished_at=clock_timestamp(),
          error='{"code":"cancelled","message":"Synthetic cancellation during bulk checkpoint"}'::jsonb
          WHERE job_id=NEW.parent_id AND status='running';
      END IF;
      RETURN NEW;
    END; $$`);
  await pool.query(`CREATE TRIGGER cancel_bulk_after_link AFTER INSERT ON job_links
    FOR EACH ROW EXECUTE FUNCTION cancel_bulk_after_link('${job.id}')`);
  await assert.rejects(service.executeJob(job), { code: 'permanent' });
  const children = await pool.query("SELECT id,idempotency_key FROM jobs WHERE type='source_search'");
  assert.equal(children.rowCount, 1);
  assert.equal(children.rows[0].idempotency_key, `bulk:${job.id}:0`);
  assert.deepEqual((await pool.query('SELECT child_id FROM job_links WHERE parent_id=$1', [job.id])).rows.map(row => row.child_id), [children.rows[0].id]);
  assert.equal((await pool.query('SELECT status FROM jobs WHERE id=$1', [job.id])).rows[0].status, 'cancelled');
  assert.equal((await pool.query('SELECT status FROM job_attempts WHERE job_id=$1', [job.id])).rows[0].status, 'cancelled');
  assert.equal(await service.jobs.complete(job.id, job.leaseToken, {}), false);
});

class PausedFixtureAdapter extends IndependentFixtureAdapter {
  private readonly arrival = Promise.withResolvers<void>();
  private readonly resumed = Promise.withResolvers<void>();
  readonly entered = this.arrival.promise;
  release(): void { this.resumed.resolve(); }
  override async fetchCase(identifier: string, context: AcquisitionContext): Promise<CaseObservation> {
    const result = await super.fetchCase(identifier, context);
    this.arrival.resolve();
    await this.resumed.promise;
    return result;
  }
}

for (const interruption of ['cancelled', 'expired'] as const) {
  test(`${interruption} in-flight refresh cannot checkpoint observations or enqueue children after losing its lease`, databaseTest, async t => {
    const adapter = new PausedFixtureAdapter();
    const { pool, service } = await isolated(t, adapter);
    t.after(() => adapter.release());
    const candidate = await pool.query<{ id: string }>(
      `INSERT INTO cases(source_id,source_case_id,case_number,title,court,status)
       VALUES($1,'civil:alpha/2024','FX-2024-0001','Unrefreshed fixture candidate','Fixture North Tribunal','Active') RETURNING id`, [sourceId],
    );
    const caseId = candidate.rows[0]!.id;
    const queued = await service.jobs.enqueue({ type: 'refresh_case', sourceId, payload: { caseId, sourceCaseId: 'civil:alpha/2024' }, idempotencyKey: `late-${interruption}` });
    const first = await service.jobs.claim('old-worker');
    running(first);
    const outcome = service.executeJob(first).then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error }));
    await Promise.race([adapter.entered, outcome.then(() => assert.fail('Fixture fetch settled before reaching its gate'))]);
    try {
      if (interruption === 'cancelled') {
        assert.deepEqual(await service.cancelJob(first.id), { cancelled: true });
      } else {
        await pool.query("UPDATE jobs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [first.id]);
        const replacement = await service.jobs.claim('replacement-worker');
        running(replacement);
        assert.equal(replacement.id, queued.id);
        assert.notEqual(replacement.leaseToken, first.leaseToken);
      }
    } finally {
      adapter.release();
    }
    const settled = await outcome;
    assert.equal(settled.ok, false, 'late source responses must not write after cancellation or lease reassignment');
    const unchanged = await pool.query('SELECT title,last_observed_at FROM cases WHERE id=$1', [caseId]);
    assert.equal(unchanged.rows[0].title, 'Unrefreshed fixture candidate');
    assert.equal(unchanged.rows[0].last_observed_at, null);
    assert.equal((await pool.query('SELECT id FROM docket_snapshots')).rowCount, 0);
    assert.equal((await pool.query("SELECT id FROM jobs WHERE type='download_artifact'")).rowCount, 0);
    assert.equal((await pool.query('SELECT status FROM jobs WHERE id=$1', [queued.id])).rows[0].status, interruption === 'cancelled' ? 'cancelled' : 'running');
  });
}

test('artifact observations select current bytes by source time including a later return to an existing version', databaseTest, async t => {
  const { pool, service } = await isolated(t);
  const saved = await service.ingestObservation(observation());
  const documentId = saved.documents[0]!;
  const bytesA = pdf('Synthetic original document A');
  const bytesB = pdf('Synthetic replacement document B');
  const versionB = await checkpoint(service, documentId, bytesB, '2026-01-02T01:00:00.000Z');
  const versionA = await checkpoint(service, documentId, bytesA, '2026-01-01T01:00:00.000Z');
  assert.notEqual(versionA, versionB);
  assert.deepEqual((await service.getDocumentArtifact(documentId)).bytes, bytesB, 'late older observation must not move the current pointer backwards');
  assert.equal((await pool.query('SELECT current_version_id FROM documents WHERE id=$1', [documentId])).rows[0].current_version_id, versionB);
  const returnedA = await checkpoint(service, documentId, bytesA, '2026-01-03T01:00:00.000Z');
  assert.equal(returnedA, versionA);
  assert.deepEqual((await service.getDocumentArtifact(documentId)).bytes, bytesA);
  const current = (await pool.query<{ current_version_id: string; current_observed_at: Date }>('SELECT current_version_id,current_observed_at FROM documents WHERE id=$1', [documentId])).rows[0]!;
  assert.equal(current.current_version_id, versionA);
  assert.equal(current.current_observed_at.toISOString(), '2026-01-03T01:00:00.000Z');
  assert.equal((await pool.query('SELECT id FROM document_versions WHERE document_id=$1', [documentId])).rowCount, 2);
  assert.equal((await pool.query('SELECT id FROM artifacts')).rowCount, 2);
  const attempts = await pool.query<{ outcome: string; sha256: string }>(
    'SELECT aa.outcome,a.sha256 FROM artifact_acquisition_attempts aa JOIN artifacts a ON a.id=aa.artifact_id WHERE aa.document_id=$1 ORDER BY aa.observed_at', [documentId],
  );
  assert.deepEqual(attempts.rows, [
    { outcome: 'complete', sha256: sha256(bytesA) },
    { outcome: 'complete', sha256: sha256(bytesB) },
    { outcome: 'complete', sha256: sha256(bytesA) },
  ]);
});

for (const restriction of ['case', 'document'] as const) {
  test(`${restriction} restriction redacts completed processing evidence and attempt errors through ancestor job status`, databaseTest, async t => {
    const { pool, service } = await isolated(t);
    const saved = await service.ingestObservation(observation());
    const documentId = saved.documents[0]!;
    const versionId = await checkpoint(service, documentId);
    const evidence = 'Syntheticprivateevidence from a now restricted filing';
    const historyError = 'Syntheticprivatefailure containing source text';
    const jobs: string[] = [];
    for (const definition of [
      { type: 'bulk_search', payload: { queries: [] } },
      { type: 'process_document', payload: { documentVersionId: versionId, caseId: saved.caseId } },
    ]) {
      const queued = await service.jobs.enqueue({ ...definition, idempotencyKey: `privacy-${definition.type}` });
      jobs.push(queued.id);
      const first = await service.jobs.claim('privacy-first');
      running(first);
      assert.equal(first.id, queued.id);
      assert.equal(await service.jobs.fail(first.id, first.leaseToken, { code: 'retryable', message: historyError }), true);
      await pool.query('UPDATE jobs SET available_at=clock_timestamp() WHERE id=$1', [first.id]);
      const retried = await service.jobs.claim('privacy-retry');
      running(retried);
      assert.equal(retried.id, first.id);
      assert.equal(await service.jobs.complete(retried.id, retried.leaseToken, { classification: { label: 'ORDER', evidence, confidence: 1 } }), true);
    }
    const rootId = jobs[0]!;
    const processId = jobs[1]!;
    await pool.query('INSERT INTO job_links(parent_id,child_id) VALUES($1,$2)', [rootId, processId]);
    for (const jobId of jobs) {
      const before = JSON.stringify(await service.getJobStatus(jobId));
      assert.ok(before.includes(evidence));
      assert.ok(before.includes(historyError));
    }
    // Change only one access predicate, so case gating cannot pass merely because the document was also restricted.
    if (restriction === 'case') await pool.query("UPDATE cases SET availability='restricted' WHERE id=$1", [saved.caseId]);
    else await pool.query("UPDATE documents SET availability='restricted' WHERE id=$1", [documentId]);
    for (const jobId of jobs) {
      const value = await service.getJobStatus(jobId);
      const redacted = z.object({
        contentRestricted: z.literal(true), result: z.null(), error: z.null(),
        stageStatus: z.literal('complete'), workflowStatus: z.literal('complete'),
        attemptsHistory: z.array(z.object({ attempt: z.number(), status: z.string() }).passthrough()),
      }).parse(value);
      assert.equal(redacted.attemptsHistory.length, 2);
      assert.ok(redacted.attemptsHistory.every(attempt => !('error' in attempt)));
      assert.ok(!JSON.stringify(value).includes(evidence));
      assert.ok(!JSON.stringify(value).includes(historyError));
    }
    assert.equal((await pool.query("SELECT id FROM jobs WHERE result->'classification'->>'evidence'=$1", [evidence])).rowCount, 2, 'privacy gating does not destroy processing provenance');
    assert.equal((await pool.query("SELECT id FROM job_attempts WHERE error->>'message'=$1", [historyError])).rowCount, 2);
  });
}

for (const diagnostic of ['ECONNRESET', 'ETIMEDOUT', '57P03', 'EACCES', 'UNRECOGNIZED_DRIVER_CODE', undefined]) {
  test(`worker classifies ${diagnostic ?? 'untyped errors'} without losing diagnostic evidence`, databaseTest, async t => {
    const transient = ['ECONNRESET', 'ETIMEDOUT', '57P03'].includes(diagnostic ?? '');
    const adapter = new class extends IndependentFixtureAdapter {
      calls = 0;
      override async fetchCase(): Promise<CaseObservation> {
        this.calls++;
        if (this.calls === 1) {
          const error = new Error('Synthetic transport or permission failure');
          throw diagnostic ? Object.assign(error, { code: diagnostic }) : error;
        }
        return observation({ entries: [], observedAt: new Date().toISOString() });
      }
    }();
    const { pool, service } = await isolated(t, adapter);
    const saved = await service.ingestObservation(observation({ entries: [] }));
    const job = await service.jobs.enqueue({ type: 'refresh_case', sourceId,
      payload: { caseId: saved.caseId, sourceCaseId: 'synthetic:case/1' }, idempotencyKey: 'diagnostic-recovery' });
    await runOne(service, 'diagnostic-worker');
    const failed = (await pool.query('SELECT status,attempts,error FROM jobs WHERE id=$1', [job.id])).rows[0];
    assert.equal(failed.status, transient ? 'retry_wait' : 'dead_letter');
    assert.equal(failed.attempts, 1);
    assert.equal(failed.error.code, transient ? 'retryable' : 'permanent');
    assert.equal(failed.error.originalCode, diagnostic);
    if (transient) {
      await pool.query('UPDATE jobs SET available_at=now() WHERE id=$1', [job.id]);
      assert.equal(await runOne(service, 'recovered-worker'), true);
      assert.equal((await pool.query('SELECT status FROM jobs WHERE id=$1', [job.id])).rows[0].status, 'complete');
      assert.equal(adapter.calls, 2);
      assert.equal((await pool.query('SELECT error FROM job_attempts WHERE job_id=$1 AND attempt=1', [job.id])).rows[0].error.originalCode, diagnostic);
    } else {
      assert.equal((await pool.query('SELECT next_refresh_at FROM cases WHERE id=$1', [saved.caseId])).rows[0].next_refresh_at, null);
      assert.equal(await runOne(service, 'not-retried-worker'), false);
      assert.equal(adapter.calls, 1);
    }
  });
}

test('worker source restriction atomically withdraws a previously complete document and preserves its bytes', databaseTest, async t => {
  const adapter = new class extends IndependentFixtureAdapter {
    requests = 0;
    override async fetchDocument(_reference: DocumentReference, context: AcquisitionContext): Promise<ArtifactObservation> {
      context.signal?.throwIfAborted();
      this.requests++;
      throw new SourceError('restricted', 'Synthetic source now withholds this document');
    }
  }();
  const { pool, service, store } = await isolated(t, adapter);
  const saved = await service.ingestObservation(observation());
  const documentId = saved.documents[0]!;
  const bytes = pdf('Synthetic formerly public source artifact');
  const versionId = await checkpoint(service, documentId, bytes);
  await seedText(pool, versionId, ['Formerlypublicneedle source text']);
  assert.equal(pageSchema.parse(await service.searchFilingText({ q: 'Formerlypublicneedle' })).data.length, 1);
  assert.equal((await pool.query('SELECT acquisition_status FROM documents WHERE id=$1', [documentId])).rows[0].acquisition_status, 'complete');
  const queued = await service.jobs.enqueue({ type: 'download_artifact', sourceId, payload: { documentId, caseId: saved.caseId }, idempotencyKey: 'new-source-restriction' });
  await pool.query('CREATE TABLE restriction_transactions(resource text NOT NULL, transaction_id bigint NOT NULL)');
  await pool.query(`CREATE FUNCTION record_restriction_transaction() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN INSERT INTO restriction_transactions VALUES(TG_TABLE_NAME,txid_current()); RETURN NEW; END; $$`);
  await pool.query(`CREATE TRIGGER record_restriction_transaction AFTER UPDATE OF status ON jobs
    FOR EACH ROW WHEN(NEW.status='restricted') EXECUTE FUNCTION record_restriction_transaction()`);
  await pool.query(`CREATE TRIGGER record_restriction_transaction AFTER UPDATE OF status ON job_attempts
    FOR EACH ROW WHEN(NEW.status='restricted') EXECUTE FUNCTION record_restriction_transaction()`);
  await pool.query(`CREATE TRIGGER record_restriction_transaction AFTER UPDATE OF availability ON documents
    FOR EACH ROW WHEN(NEW.availability='restricted') EXECUTE FUNCTION record_restriction_transaction()`);
  assert.equal(await runOne(service, 'source-restriction-worker'), true);
  assert.equal(adapter.requests, 1);
  const transitions = await pool.query<{ resource: string; transaction_id: string }>('SELECT resource,transaction_id FROM restriction_transactions ORDER BY resource');
  assert.deepEqual(transitions.rows.map(row => row.resource), ['documents', 'job_attempts', 'jobs']);
  assert.equal(new Set(transitions.rows.map(row => row.transaction_id)).size, 1, 'attempt, job and access-policy changes must commit atomically');
  const doc = (await pool.query('SELECT availability,acquisition_status,current_version_id FROM documents WHERE id=$1', [documentId])).rows[0];
  assert.deepEqual(doc, { availability: 'restricted', acquisition_status: 'restricted', current_version_id: versionId });
  const job = (await pool.query('SELECT status,lease_token FROM jobs WHERE id=$1', [queued.id])).rows[0];
  assert.deepEqual(job, { status: 'restricted', lease_token: null });
  const attempt = (await pool.query('SELECT status,finished_at FROM job_attempts WHERE job_id=$1', [queued.id])).rows[0];
  assert.equal(attempt.status, 'restricted');
  assert.ok(attempt.finished_at);
  assert.equal((await pool.query('SELECT acquisition_status FROM cases WHERE id=$1', [saved.caseId])).rows[0].acquisition_status, 'partial');
  assert.equal((await pool.query("SELECT id FROM artifact_acquisition_attempts WHERE document_id=$1 AND outcome='restricted'", [documentId])).rowCount, 1);
  await assert.rejects(service.getDocumentArtifact(documentId), { code: 'not_found' });
  await assert.rejects(service.getDocumentText(documentId), { code: 'not_found' });
  assert.equal(pageSchema.parse(await service.searchFilingText({ q: 'Formerlypublicneedle' })).data.length, 0);
  assert.equal((await pool.query('SELECT id FROM document_versions')).rowCount, 1);
  assert.equal((await pool.query('SELECT id FROM pages')).rowCount, 1);
  const artifact = (await pool.query<{ storage_key: string }>('SELECT storage_key FROM artifacts')).rows[0]!;
  assert.deepEqual(await store.get(artifact.storage_key), bytes);
});

test('manual retry reprocesses a partial checkpoint while automatic retry reuses its generation', databaseTest, async t => {
  const priorLlmSetting = process.env.COURT_LLM_ENABLED;
  process.env.COURT_LLM_ENABLED = 'false';
  t.after(() => {
    if (priorLlmSetting === undefined) delete process.env.COURT_LLM_ENABLED;
    else process.env.COURT_LLM_ENABLED = priorLlmSetting;
  });
  const { pool, service } = await isolated(t);
  const saved = await service.ingestObservation(observation());
  // Enough short embedded words fit on one line to avoid an OCR/network dependency.
  const versionId = await checkpoint(service, saved.documents[0]!, pdf(`Syntheticnative ${'a '.repeat(50)}`));
  const queued = await service.jobs.enqueue({ type: 'process_document', payload: { documentVersionId: versionId, caseId: saved.caseId }, idempotencyKey: 'generation-retry' });
  const first = await service.jobs.claim('native-first');
  running(first);
  assert.equal(first.id, queued.id);
  assert.equal(first.retryGeneration, 0);
  const initial = await service.executeJob(first);
  assert.equal(initial.status, 'complete');
  const firstRun = (await pool.query<{ id: string; run_key: string }>('SELECT id,run_key FROM extraction_runs')).rows[0]!;
  assert.equal(firstRun.run_key, `${first.id}:0`);
  const firstPages = (await pool.query<{ method: string; text: string }>('SELECT method,text FROM pages WHERE extraction_run_id=$1', [firstRun.id])).rows;
  assert.equal(firstPages.length, 1);
  assert.equal(firstPages[0]!.method, 'vector_text');
  assert.match(firstPages[0]!.text, /Syntheticnative/);
  // Persist a partial-checkpoint fault, retaining the actual native extraction rows.
  // This tests retry policy, not whether this valid searchable PDF naturally fails extraction.
  await pool.query(`UPDATE extraction_runs SET status='partial',
    result=jsonb_set(result,'{warnings}','["Synthetic partial checkpoint fault"]'::jsonb)
    WHERE id=$1`, [firstRun.id]);
  await pool.query("UPDATE jobs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [first.id]);
  const automatic = await service.jobs.claim('native-automatic');
  running(automatic);
  assert.equal(automatic.id, first.id);
  assert.equal(automatic.retryGeneration, 0);
  assert.equal(automatic.attempts, 2);
  const reused = await service.executeJob(automatic);
  assert.equal(reused.status, 'partial');
  assert.deepEqual(reused.result['warnings'], ['Synthetic partial checkpoint fault']);
  assert.equal((await pool.query('SELECT id FROM extraction_runs')).rowCount, 1);
  assert.equal((await pool.query('SELECT id FROM pages')).rowCount, 1);
  assert.equal(await service.jobs.complete(automatic.id, automatic.leaseToken, reused.result, reused.status), true);
  assert.deepEqual(await service.retryJob(automatic.id), { retried: true });
  const manual = await service.jobs.claim('native-manual');
  running(manual);
  assert.equal(manual.id, first.id);
  assert.equal(manual.retryGeneration, 1);
  assert.equal(manual.attempts, 3);
  const reprocessed = await service.executeJob(manual);
  assert.equal(reprocessed.status, 'complete');
  assert.equal(await service.jobs.complete(manual.id, manual.leaseToken, reprocessed.result, reprocessed.status), true);
  const runs = await pool.query<{ id: string; run_key: string; status: string }>('SELECT id,run_key,status FROM extraction_runs ORDER BY run_key');
  assert.equal(runs.rows.length, 2);
  assert.deepEqual(runs.rows.map(row => [row.run_key, row.status]), [[`${first.id}:0`, 'partial'], [`${first.id}:1`, 'complete']]);
  assert.equal(runs.rows[0]!.id, firstRun.id);
  assert.notEqual(runs.rows[1]!.id, firstRun.id);
  const newPages = (await pool.query<{ method: string; text: string }>('SELECT method,text FROM pages WHERE extraction_run_id=$1', [runs.rows[1]!.id])).rows;
  assert.deepEqual(newPages, firstPages);
  assert.equal((await pool.query('SELECT id FROM document_versions')).rowCount, 1);
  assert.deepEqual((await pool.query('SELECT status FROM job_attempts WHERE job_id=$1 ORDER BY attempt', [first.id])).rows.map(row => row.status), ['expired', 'partial', 'complete']);
});

test('stored citation taxonomy and latest filing classification correlate through CLI HTTP and MCP',databaseTest,async t=>{
  const {pool,service}=await isolated(t);
  const saved=await service.ingestObservation(observation({entries:[event('order',0,'Order',[document('order','order')]),event('complaint',1,'Complaint',[document('complaint','complaint')])]}));
  for(const [index,documentId] of saved.documents.entries()){
    const version=await checkpoint(service,documentId);
    const text=index===0?'ORDER\nSee 123 N.W.2d 456 and 27-CV-24-1.':'COMPLAINT\nPlaintiff requests relief.';
    if(index===1)await pool.query("INSERT INTO extraction_runs(document_version_id,pipeline_version,schema_version,status,result,finished_at) VALUES($1,'old','1','complete','{\"classification\":{\"label\":\"ORDER\"}}',now()-interval '1 day')",[version]);
    const result=analyzePages([{pageNumber:1,text,method:'fixture',quality:{}}]);
    const run=(await pool.query<{id:string}>("INSERT INTO extraction_runs(document_version_id,pipeline_version,schema_version,status,result,finished_at) VALUES($1,$2,$3,'complete',$4,clock_timestamp()) RETURNING id",[version,result.pipelineVersion,result.schemaVersion,{classification:result.classification}])).rows[0]!.id;
    await pool.query("INSERT INTO pages(extraction_run_id,page_number,text,method) VALUES($1,1,$2,'fixture')",[run,text]);
    await pool.query('INSERT INTO chunks(extraction_run_id,page_number,start_offset,end_offset,text) VALUES($1,1,0,$2,$3)',[run,text.length,text]);
    for(const entity of result.entities)await pool.query('INSERT INTO entity_mentions(extraction_run_id,page_number,start_offset,end_offset,kind,value,confidence,data) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[run,entity.pageNumber,entity.startOffset,entity.endOffset,entity.kind,entity.value,entity.confidence,entity.data]);
  }
  const results=z.object({data:z.array(z.object({document_id:z.string(),text:z.string()}))});
  const cli=results.parse(await runCli(['db','filing-search','--document-type','ORDER','--citation','123 N.W.2d 456'],service));
  assert.deepEqual(cli.data.map(row=>row.document_id),[saved.documents[0]]);
  assert.equal(pageSchema.parse(await service.searchCases({citation:'27-CV-24-1'})).data[0]!.id,saved.caseId);
  assert.deepEqual(results.parse(await service.searchFilingText({documentType:'COMPLAINT',citation:'27-CV-24-1'})).data,[]);
  const api=await createApi(service,{env:apiEnv});t.after(()=>api.close());
  const response=await api.inject({method:'GET',url:'/api/v1/filing-text?documentType=ORDER&citation=27-CV-24-1',headers:readHeaders});
  assert.equal(response.statusCode,200);assert.deepEqual(results.parse(response.json()).data.map(row=>row.document_id),[saved.documents[0]]);
  const server=createMcpServer(service,{env:{COURT_MCP_ROLE:'read'}});
  const client=new Client({name:'citation-regression',version:'1'});
  const [clientTransport,serverTransport]=InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);await client.connect(clientTransport);
  t.after(async()=>{await client.close();await server.close();});
  const tool=await client.callTool({name:'search_filing_text',arguments:{documentType:'ORDER',citation:'123 N.W.2d 456'}});
  const content=z.object({content:z.array(z.object({type:z.literal('text'),text:z.string()}))}).parse(tool);
  assert.deepEqual(results.parse(JSON.parse(content.content[0]!.text)).data.map(row=>row.document_id),[saved.documents[0]]);
});

test('Minnesota observed participant labels and judicial officer persist searchable roles without inferred organizations',databaseTest,async t=>{
  const {service,pool}=await isolated(t,new MinnesotaAdapter());
  const normalized=mapRoa({caseInfo:{caseNumber:'27-CV-24-1',caseTitle:'Synthetic',caseLocation:'Hennepin',caseStatus:'Active',judicialOfficer:'Alex Judge'},parties:['Jane Doe — Plaintiff','Attorney: Sam Counsel','Organization: Example Entity','Ambiguous LLC'],events:[],sections:[],rawText:'Synthetic labeled source'});
  const saved=await service.ingestObservation(normalized);
  for(const filter of [{party:'Jane Doe'},{attorney:'Sam Counsel'},{judge:'Alex Judge'},{organization:'Example Entity'}])assert.equal(pageSchema.parse(await service.searchCases(filter)).data[0]!.id,saved.caseId);
  assert.deepEqual(pageSchema.parse(await service.searchCases({organization:'Ambiguous LLC'})).data,[]);
  assert.equal((await pool.query("SELECT raw->>'rawLabel' AS label FROM participants WHERE name='Jane Doe'")).rows[0].label,'Jane Doe — Plaintiff');
});

for(const action of ['disable','pause'] as const)test(`source ${action} during reserved wait prevents dispatch`,databaseTest,async t=>{
  let dispatches=0;
  class Gated extends IndependentFixtureAdapter{
    override async searchCases(query:Parameters<IndependentFixtureAdapter['searchCases']>[0],context:AcquisitionContext){await context.beforeRequest?.();dispatches++;return super.searchCases(query,context);}
  }
  const {pool,service}=await isolated(t,new Gated());
  await service.requestAcquisition({sourceId,searchType:'party',lastName:'Doe',firstName:'Jane'},`gate-${action}`);
  const job=await service.jobs.claim('gate');running(job);
  await pool.query("UPDATE sources SET next_request_at=clock_timestamp()+interval '800 milliseconds',min_interval_ms=1 WHERE id=$1",[sourceId]);
  const initial=(await pool.query('SELECT next_request_at FROM sources WHERE id=$1',[sourceId])).rows[0].next_request_at.getTime();
  const executing=service.executeJob(job);const rejection=assert.rejects(executing,{code:'blocked'});
  for(let attempt=0;attempt<100;attempt++){
    const state=(await pool.query('SELECT next_request_at FROM sources WHERE id=$1',[sourceId])).rows[0];
    if(state.next_request_at.getTime()>initial)break;
    if(attempt===99)assert.fail('Reservation did not occur');
    // PostgreSQL owns the reservation clock; yield while observing its actual state.
    const turn=Promise.withResolvers<void>();setImmediate(turn.resolve);await turn.promise;
  }
  await pool.query(action==='disable'?'UPDATE sources SET enabled=false WHERE id=$1':"UPDATE sources SET paused_until=clock_timestamp()+interval '1 hour' WHERE id=$1",[sourceId]);
  await rejection;assert.equal(dispatches,0);
});

test('bootstrap preserves durable source administration and process opt-in never claims unauthorized jobs',databaseTest,async t=>{
  const prior=process.env.COURT_ALLOW_LIVE_MN;t.after(()=>{if(prior===undefined)delete process.env.COURT_ALLOW_LIVE_MN;else process.env.COURT_ALLOW_LIVE_MN=prior;});
  process.env.COURT_ALLOW_LIVE_MN='false';
  const {pool,service}=await isolated(t,new MinnesotaAdapter());
  await pool.query("UPDATE sources SET enabled=true WHERE id='mn-mcro'");
  await service.registerSources();
  assert.equal((await pool.query("SELECT enabled FROM sources WHERE id='mn-mcro'")).rows[0].enabled,true);
  await service.jobs.enqueue({type:'source_search',sourceId:'mn-mcro',payload:{},idempotencyKey:'no-live'});
  assert.equal(await runOne(service),false);
  await pool.query("UPDATE sources SET enabled=false WHERE id='mn-mcro'");
  process.env.COURT_ALLOW_LIVE_MN='true';await service.registerSources();
  assert.equal((await pool.query("SELECT enabled FROM sources WHERE id='mn-mcro'")).rows[0].enabled,false);
  assert.equal(await runOne(service),false);
  assert.equal((await pool.query('SELECT attempts FROM jobs')).rows[0].attempts,0);
});

test('live pilot request and byte budgets are enforced by durable worker before artifact persistence',databaseTest,async t=>{
  let dispatched=0;
  class Budgeted extends IndependentFixtureAdapter{
    override async fetchDocument(_reference:DocumentReference,context:AcquisitionContext):Promise<ArtifactObservation>{
      await context.beforeRequest?.();dispatched++;
      return {bytes:pdf(`Budget fixture ${'searchable text '.repeat(12)}`),filename:'budget.pdf',contentType:'application/pdf',acquiredAt:new Date().toISOString()};
    }
  }
  const adapter=new Budgeted();const {pool,service,store}=await isolated(t,adapter);
  const saved=await service.ingestObservation(observation());
  const budgetedService=new CourtService(pool,store,new Map([[sourceId,adapter]]));
  const first=await budgetedService.jobs.enqueue({type:'download_artifact',sourceId,payload:{documentId:saved.documents[0],caseId:saved.caseId},idempotencyKey:'budget-first'});
  const second=await budgetedService.jobs.enqueue({type:'download_artifact',sourceId,payload:{documentId:saved.documents[0],caseId:saved.caseId},idempotencyKey:'budget-second'});
  assert.equal(await runOne(budgetedService,'budget-worker'),true);
  assert.equal(await runOne(budgetedService,'budget-worker'),true);
  assert.equal(dispatched,1);
  assert.equal(budget.bytesReceived,0);
});

test('routine refresh skips verified bytes while revision changes and bounded revalidation acquire replacements',databaseTest,async t=>{
  let downloads=0,revision='first',clock=Date.now();
  class Changing extends IndependentFixtureAdapter{
    override async fetchCase():Promise<CaseObservation>{const value=observation({observedAt:new Date(++clock).toISOString()});value.entries[0]!.documents[0]!.revision=revision;return value;}
    override async fetchDocument():Promise<ArtifactObservation>{downloads++;return {bytes:pdf(`Replacement ${downloads} ${'searchable text '.repeat(12)}`),filename:'same.pdf',contentType:'application/pdf',acquiredAt:new Date(++clock).toISOString()};}
  }
  const adapter=new Changing();const {pool,service}=await isolated(t,adapter);
  const saved=await service.ingestObservation(await adapter.fetchCase());
  async function refresh(key:string){await service.jobs.enqueue({type:'refresh_case',sourceId,payload:{caseId:saved.caseId,sourceCaseId:'synthetic:case/1'},idempotencyKey:key});for(let count=0;count<10&&await runOne(service);count++){}}
  await refresh('initial');assert.equal(downloads,1);
  await refresh('unchanged');assert.equal(downloads,1);
  revision='revised';await refresh('revision');assert.equal(downloads,2);
  await pool.query("UPDATE documents SET next_revalidation_at=now()-interval '1 second' WHERE case_id=$1",[saved.caseId]);
  await refresh('periodic');assert.equal(downloads,3);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM document_versions')).rows[0].n,3);
  assert.equal((await pool.query('SELECT acquisition_status FROM cases WHERE id=$1',[saved.caseId])).rows[0].acquisition_status,'complete');
  assert.deepEqual((await pool.query("SELECT status,count(*)::int AS n FROM jobs GROUP BY status")).rows,[{status:'complete',n:10}]);
});

test('operator source controls persist across bootstraps and enforce administrative HTTP roles',databaseTest,async t=>{
  const {service,pool}=await isolated(t);const api=await createApi(service,{env:apiEnv});t.after(()=>api.close());
  await runCli(['source','disable','--source',sourceId,'--reason','Synthetic maintenance'],service);
  await service.registerSources();assert.equal((await pool.query('SELECT enabled FROM sources WHERE id=$1',[sourceId])).rows[0].enabled,false);
  await service.jobs.enqueue({type:'source_search',sourceId,payload:{},idempotencyKey:'administration-gate'});
  assert.equal(await runOne(service),false);
  const denied=await api.inject({method:'POST',url:`/api/v1/sources/${sourceId}/control`,headers:readHeaders,payload:{action:'enable',reason:'No privilege'}});assert.equal(denied.statusCode,403);
  const adminHeaders={authorization:`Bearer ${apiEnv.API_TOKEN_ADMIN}`};
  assert.equal((await api.inject({method:'POST',url:`/api/v1/sources/${sourceId}/control`,headers:adminHeaders,payload:{action:'enable',reason:'Synthetic permission'}})).statusCode,200);
  await runCli(['source','pause','--source',sourceId,'--reason','Synthetic pause','--minutes','5'],service);assert.equal(await runOne(service),false);
  await assert.rejects(runCli(['source','resume','--source',sourceId,'--reason','Invalid duration','--minutes','1'],service));
  await runCli(['source','resume','--source',sourceId,'--reason','Synthetic reviewed recovery'],service);
  const claimed=await service.jobs.claim('resumed');assert.ok(claimed);assert.equal(claimed.idempotencyKey,'administration-gate');
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM audit_events WHERE action='source_policy'")).rows[0].n,4);
});
