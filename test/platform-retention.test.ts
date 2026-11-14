import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { Pool } from 'pg';
import { createApi } from '../src/platform/api.js';
import { migrate } from '../src/platform/database.js';
import { CourtService } from '../src/platform/service.js';
import { LocalArtifactStore, type ArtifactStore } from '../src/platform/storage.js';
import {
  processDueRetention, processRetentionRequest, readRetentionPolicy, readRetentionRequest,
  requestRetention, setRetentionPolicy, withArtifactWriteLease,
} from '../src/platform/retention.js';

const databaseUrl = process.env.COURT_TEST_DATABASE_URL;
const databaseTest = { skip: databaseUrl ? false : 'COURT_TEST_DATABASE_URL requires a disposable PostgreSQL database', timeout: 60_000 };

async function isolated(t: TestContext) {
  assert.ok(databaseUrl);
  const admin = new Pool({ connectionString: databaseUrl });
  const schema = `retention_${randomUUID().replaceAll('-', '')}`;
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema},public`, max: 12 });
  const directory = await mkdtemp(path.join(os.tmpdir(), 'court-retention-'));
  t.after(async () => {
    await pool.end();
    try { await admin.query(`DROP SCHEMA "${schema}" CASCADE`); }
    finally { await admin.end(); await rm(directory, { recursive: true, force: true }); }
  });
  await migrate(pool);
  await pool.query("INSERT INTO sources(id,state,name) VALUES('retention-fixture','MN','Synthetic retention fixture')");
  const store = new LocalArtifactStore(path.join(directory, 'copied-artifacts'));
  const service = new CourtService(pool, store, new Map());
  return { pool, store, service, directory };
}

async function seed(pool: Pool, store: ArtifactStore, bytes = Buffer.from('Synthetic copied evidence')) {
  const caseId = (await pool.query<{ id: string }>(`INSERT INTO cases(source_id,source_case_id,case_number,title)
    VALUES('retention-fixture',$1,'SYNTHETIC','Synthetic private title') RETURNING id`, [randomUUID()])).rows[0]!.id;
  const entryId = (await pool.query<{ id: string }>(`INSERT INTO docket_entries(case_id,identity_key,source_order,title,identity_confidence)
    VALUES($1,'synthetic-entry',0,'Synthetic filing','source') RETURNING id`, [caseId])).rows[0]!.id;
  const documentId = (await pool.query<{ id: string }>(`INSERT INTO documents(case_id,entry_id,source_document_id,title,availability)
    VALUES($1,$2,'synthetic-document','Synthetic filing','available') RETURNING id`, [caseId, entryId])).rows[0]!.id;
  const saved = await withArtifactWriteLease(pool, async client => {
    const stored = await store.put(bytes);
    const artifactId = (await client.query<{ id: string }>(`INSERT INTO artifacts(sha256,size_bytes,content_type,storage_key)
      VALUES($1,$2,'application/pdf',$3) ON CONFLICT(sha256) DO UPDATE SET sha256=EXCLUDED.sha256 RETURNING id`,
    [stored.sha256, stored.sizeBytes, stored.storageKey])).rows[0]!.id;
    const versionId = (await client.query<{ id: string }>(`INSERT INTO document_versions(document_id,artifact_id,filename,acquired_at)
      VALUES($1,$2,'copied.pdf',now()) RETURNING id`, [documentId, artifactId])).rows[0]!.id;
    await client.query("UPDATE documents SET current_version_id=$2,acquisition_status='complete' WHERE id=$1", [documentId, versionId]);
    await client.query("INSERT INTO artifact_acquisition_attempts(document_id,artifact_id,outcome,observed_at,details) VALUES($1,$2,'complete',now(),'{\"sourceNote\":\"private\"}')", [documentId, artifactId]);
    return { ...stored, artifactId, versionId };
  });
  const runId = (await pool.query<{ id: string }>(`INSERT INTO extraction_runs(document_version_id,pipeline_version,schema_version,status,result)
    VALUES($1,'synthetic','fixture','complete','{"summary":"Synthetic private text"}') RETURNING id`, [saved.versionId])).rows[0]!.id;
  const text = 'Synthetic retention needle';
  await pool.query("INSERT INTO pages(extraction_run_id,page_number,text,method) VALUES($1,1,$2,'fixture')", [runId, text]);
  await pool.query('INSERT INTO chunks(extraction_run_id,page_number,start_offset,end_offset,text) VALUES($1,1,0,$2,$3)', [runId, text.length, text]);
  await pool.query("INSERT INTO entity_mentions(extraction_run_id,page_number,start_offset,end_offset,kind,value,confidence) VALUES($1,1,0,9,'person','Synthetic',1)", [runId]);
  await pool.query("INSERT INTO assertions(extraction_run_id,kind,text,evidence,confidence) VALUES($1,'inference','Synthetic inferred claim','[]',0.5)", [runId]);
  return { caseId, documentId, entryId, runId, ...saved, bytes };
}

function request(caseId: string, action: 'restrict' | 'purge' = 'purge', dueAt = new Date(0)) {
  return { caseId, action, dueAt, reason: 'Explicit synthetic operator authorization', idempotencyKey: randomUUID() };
}

async function enable(pool: Pool, artifactGcEnabled = true) {
  return setRetentionPolicy(pool, { enabled: true, artifactGcEnabled }, 'synthetic-admin');
}

function deferred() {return Promise.withResolvers<void>();}

test('retention defaults disabled, including explicitly scheduled requests; no age-based deletion', databaseTest, async t => {
  const { pool, store, service } = await isolated(t);
  const saved = await seed(pool, store);
  assert.deepEqual(await readRetentionPolicy(pool), { enabled: false, artifactGcEnabled: false });
  const pending = await requestRetention(pool, request(saved.caseId), 'synthetic-admin');
  assert.deepEqual(await processDueRetention(pool, store), []);
  assert.equal((await processRetentionRequest(pool, store, pending.id)).status, 'scheduled');
  await service.getCase(saved.caseId);
  assert.deepEqual(await store.get(saved.storageKey), saved.bytes);
});

test('scheduled restrict-only expiration withdraws existing API/search reads without destroying evidence', databaseTest, async t => {
  const { pool, store, service } = await isolated(t);
  const saved = await seed(pool, store);
  await enable(pool);
  const pending = await requestRetention(pool, request(saved.caseId, 'restrict', new Date(Date.now() + 60_000)), 'synthetic-admin');
  assert.deepEqual(await processDueRetention(pool, store), []);
  await service.getCase(saved.caseId);
  await pool.query("UPDATE retention_requests SET due_at=clock_timestamp()-interval '1 second' WHERE id=$1", [pending.id]);
  assert.equal((await processDueRetention(pool, store))[0]!.status, 'complete');
  await assert.rejects(service.getCase(saved.caseId), { code: 'not_found' });
  await assert.rejects(service.getFiling(saved.documentId), { code: 'not_found' });
  assert.deepEqual((await service.searchFilingText({ q: 'needle' }) as { data: unknown[] }).data, []);
  const app = await createApi(service, { env: { API_TOKEN_READ: 'retention-read',API_TOKEN_WRITE:'retention-write',API_TOKEN_ADMIN:'retention-admin' } });
  t.after(() => app.close());
  const response = await app.inject({ method: 'GET', url: `/api/v1/cases/${saved.caseId}`, headers: { authorization: 'Bearer retention-read' } });
  assert.equal(response.statusCode, 404);
  assert.equal((await pool.query('SELECT id FROM pages WHERE extraction_run_id=$1', [saved.runId])).rowCount, 1);
  assert.deepEqual(await store.get(saved.storageKey), saved.bytes);
});

test('purge atomically fences related running jobs and clears derived text and cached ancestor evidence before GC', databaseTest, async t => {
  const { pool, store, service } = await isolated(t);
  const saved = await seed(pool, store);
  await enable(pool, false);
  const ancestor = await service.jobs.enqueue({ type: 'bulk_search', payload: { queries: ['Synthetic private query'] }, idempotencyKey: randomUUID() });
  const child = await service.jobs.enqueue({ type: 'process_document', payload: { documentVersionId: saved.versionId }, idempotencyKey: randomUUID(), priority: 10 });
  await pool.query('INSERT INTO job_links(parent_id,child_id) VALUES($1,$2)', [ancestor.id, child.id]);
  await pool.query('UPDATE jobs SET result=$2,error=$2 WHERE id=$1', [ancestor.id, { cached: 'Synthetic private text' }]);
  const running = await service.jobs.claim('retention-worker');
  assert.equal(running!.id, child.id);
  assert.ok(running!.leaseToken);
  const pending = await requestRetention(pool, request(saved.caseId), 'synthetic-admin');
  const result = await processRetentionRequest(pool, store, pending.id);
  assert.equal(result.status, 'cleanup_pending');
  assert.ok(result.withdrawnAt);
  assert.equal(await service.jobs.complete(child.id, running!.leaseToken!, { secret: 'late result' }), false);
  assert.equal(await service.jobs.heartbeat(child.id, running!.leaseToken!, 60_000), false);
  for (const table of ['pages', 'chunks', 'assertions', 'entity_mentions', 'extraction_runs', 'document_versions', 'artifact_acquisition_attempts']) {
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n, 0, table);
  }
  const jobs = (await pool.query('SELECT status,result,error,payload FROM jobs')).rows;
  assert.ok(jobs.every(job => job.status === 'restricted' && job.result === null && job.error === null));
  assert.ok(jobs.every(job => !JSON.stringify(job.payload).includes('Synthetic private')));
  assert.equal((await pool.query('SELECT status,error FROM job_attempts')).rows[0].status, 'cancelled');
  await assert.rejects(service.getDocumentText(saved.documentId), { code: 'not_found' });
  assert.deepEqual(await store.get(saved.storageKey), saved.bytes);
});

test('shared SHA objects remain while any retained version or acquisition reference needs them', databaseTest, async t => {
  const { pool, store, service } = await isolated(t);
  const first = await seed(pool, store);
  const second = await seed(pool, store, first.bytes);
  await enable(pool);
  const firstRequest = await requestRetention(pool, request(first.caseId), 'synthetic-admin');
  const result = await processRetentionRequest(pool, store, firstRequest.id);
  assert.equal(result.status, 'complete');
  assert.equal(result.artifacts[0]!.status, 'retained');
  await service.getFiling(second.documentId);
  assert.deepEqual(await store.get(second.storageKey), second.bytes);
  const secondRequest = await requestRetention(pool, request(second.caseId), 'synthetic-admin');
  assert.equal((await processRetentionRequest(pool, store, secondRequest.id)).artifacts[0]!.status, 'deleted');
  await assert.rejects(store.get(first.storageKey), { code: 'ENOENT' });
});

test('interrupted physical deletion stays pending, retries missing bytes safely, and replays idempotently', databaseTest, async t => {
  const { pool, store, service } = await isolated(t);
  const saved = await seed(pool, store);
  await enable(pool);
  let removes = 0;
  const interrupted: ArtifactStore = {
    put: bytes => store.put(bytes), get: key => store.get(key),
    remove: async key => { removes++; await store.remove(key); if (removes === 1) throw new Error('Synthetic interruption after unlink; never retain content in error'); },
  };
  const pending = await requestRetention(pool, request(saved.caseId), 'synthetic-admin');
  const failed = await processRetentionRequest(pool, interrupted, pending.id);
  assert.equal(failed.status, 'cleanup_pending');
  assert.equal(failed.artifacts[0]!.status, 'pending');
  assert.equal(failed.artifacts[0]!.attempts, 1);
  assert.equal(failed.lastErrorCode, 'artifact_delete_failed');
  await assert.rejects(service.getCase(saved.caseId), { code: 'not_found' });
  assert.equal((await pool.query('SELECT id FROM chunks')).rowCount, 0);
  assert.equal((await processRetentionRequest(pool, interrupted, pending.id)).status, 'complete');
  const final = await readRetentionRequest(pool, pending.id);
  assert.equal(final.artifacts[0]!.attempts, 2);
  assert.equal(final.lastErrorCode, null);
  await processRetentionRequest(pool, interrupted, pending.id);
  assert.equal(removes, 2);
});

test('document-only purge keeps other filings accessible and cannot be undone by later source upserts', databaseTest, async t => {
  const { pool, store, service } = await isolated(t);
  const saved = await seed(pool, store);
  await enable(pool);
  const pending = await requestRetention(pool, { ...request(saved.caseId), documentId: saved.documentId }, 'synthetic-admin');
  assert.equal((await processRetentionRequest(pool, store, pending.id)).status, 'complete');
  await service.getCase(saved.caseId);
  await pool.query("UPDATE documents SET availability='available',title='Republished secret',reference='{\"secret\":true}' WHERE id=$1", [saved.documentId]);
  const row = (await pool.query('SELECT availability,title,reference FROM documents WHERE id=$1', [saved.documentId])).rows[0];
  assert.deepEqual(row, { availability: 'restricted', title: '', reference: {} });
  await assert.rejects(service.getFiling(saved.documentId), { code: 'not_found' });
});

test('physical GC waits across upload and persistence and rechecks newly committed shared references', databaseTest, async t => {
  const { pool, store } = await isolated(t);
  const first = await seed(pool, store);
  const other = await seed(pool, store, Buffer.from('Different retained object'));
  await enable(pool, false);
  const pending = await requestRetention(pool, request(first.caseId), 'synthetic-admin');
  await processRetentionRequest(pool, store, pending.id);
  const uploaded = deferred(), release = deferred();
  const upload = withArtifactWriteLease(pool, async client => {
    await store.put(first.bytes);
    uploaded.resolve();
    await release.promise;
    await client.query("INSERT INTO document_versions(document_id,artifact_id,filename,acquired_at) VALUES($1,$2,'new-reference.pdf',now())", [other.documentId, first.artifactId]);
  });
  await uploaded.promise;
  await enable(pool);
  let removed = false;
  const tracking: ArtifactStore = { put: bytes => store.put(bytes), get: key => store.get(key), remove: async key => { removed = true; await store.remove(key); } };
  const cleanup = processRetentionRequest(pool, tracking, pending.id);
  // Commit only after GC has been submitted; the shared transaction lease covers
  // the interval in which bytes exist but their new reference has not committed.
  release.resolve();
  await upload;
  assert.equal((await cleanup).artifacts[0]!.status, 'retained');
  assert.equal(removed, false);
  assert.deepEqual(await store.get(first.storageKey), first.bytes);
});

test('purge never touches user originals in downloads and unsafe storage keys never report success', databaseTest, async t => {
  const { pool, store, directory } = await isolated(t);
  const saved = await seed(pool, store);
  const downloads = path.join(directory, 'downloads');
  await mkdir(downloads);
  const original = path.join(downloads, 'original.pdf');
  await writeFile(original, saved.bytes);
  await enable(pool);
  const pending = await requestRetention(pool, request(saved.caseId), 'synthetic-admin');
  await processRetentionRequest(pool, store, pending.id);
  assert.deepEqual(await readFile(original), saved.bytes);
  await assert.rejects(store.remove('../downloads/original.pdf'), /Invalid artifact key/);
  const unsafe = await seed(pool, store, Buffer.from('Another copied object'));
  await pool.query("UPDATE artifacts SET storage_key='../downloads/original.pdf' WHERE id=$1", [unsafe.artifactId]);
  const unsafeRequest = await requestRetention(pool, request(unsafe.caseId), 'synthetic-admin');
  const result = await processRetentionRequest(pool, store, unsafeRequest.id);
  assert.equal(result.status, 'cleanup_pending');
  assert.equal(result.lastErrorCode, 'invalid_artifact_key');
  assert.deepEqual(await readFile(original), saved.bytes);
});

test('request replay is immutable and conflicts are rejected; failed execution guard rolls back withdrawal', databaseTest, async t => {
  const { pool, store, service } = await isolated(t);
  const saved = await seed(pool, store);
  await enable(pool);
  const input = request(saved.caseId);
  const first = await requestRetention(pool, input, 'synthetic-admin');
  assert.equal((await requestRetention(pool, input, 'synthetic-admin')).id, first.id);
  await assert.rejects(requestRetention(pool, { ...input, action: 'restrict' }, 'synthetic-admin'), /Idempotency/);
  await assert.rejects(processRetentionRequest(pool, store, first.id, async () => { throw new Error('Synthetic lease lost'); }), /Synthetic lease lost/);
  assert.equal((await readRetentionRequest(pool, first.id)).status, 'scheduled');
  await service.getCase(saved.caseId);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM retention_events WHERE request_id=$1 AND event='requested'", [first.id])).rows[0].n, 1);
});
