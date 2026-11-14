import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp,rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Pool } from 'pg';
import { migrate } from '../src/platform/database.js';
import { CourtService } from '../src/platform/service.js';
import { LocalArtifactStore } from '../src/platform/storage.js';
import type { CaseObservation } from '../src/platform/contracts.js';
import { reconcileObservation } from '../src/platform/reconcile.js';
import { SourceError } from '../src/platform/contracts.js';
import { eventIdentity } from '../src/platform/identity.js';
const url=process.env.COURT_TEST_DATABASE_URL;
test('case reconciliation preserves non-document events, stable rows, history and restrictions',{skip:!url},async t=>{
  const schema=`acceptance_${randomUUID().replaceAll('-','')}`;
  const admin=new Pool({connectionString:url});await admin.query(`CREATE SCHEMA ${schema}`);
  const pool=new Pool({connectionString:url,options:`-c search_path=${schema},public`});
  const dir=await mkdtemp(path.join(os.tmpdir(),'court-acceptance-'));
  t.after(async()=>{await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();await rm(dir,{recursive:true,force:true});});
  await migrate(pool);
  await pool.query("INSERT INTO sources(id,state,name,metadata,capabilities,enabled) VALUES('acceptance','ZZ','Fixture','{}','{}',true)");
  const service=new CourtService(pool,new LocalArtifactStore(dir),new Map());
  const initial:CaseObservation={sourceId:'acceptance',sourceCaseId:'C:1',caseNumber:'C-1',title:'Fixture case',court:'Fixture court',status:'Active',observedAt:'2026-01-01T00:00:00Z',complete:true,participants:[],sections:{hearings:[{date:'2026-02-01',type:'Review'}]},raw:{source:'fixture'},entries:[{identityKey:'event-a',sourceId:'a',sourceOrder:1,date:'2026-01-01',title:'Hearing set',identityConfidence:'source',documents:[],raw:{}}]};
  const saved=await service.ingestObservation(initial);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM docket_entries')).rows[0].n,1);
  await service.ingestObservation({...initial,observedAt:'2026-01-02T00:00:00Z',entries:[{...initial.entries[0]!,identityKey:'event-b',sourceId:'b',title:'New event',sourceOrder:1},{...initial.entries[0]!,sourceOrder:2}]});
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM docket_entries')).rows[0].n,2);
  await service.ingestObservation({...initial,observedAt:'2026-01-03T00:00:00Z',complete:false,entries:[]});
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM docket_entries WHERE availability='public'")).rows[0].n,2);
  await service.ingestObservation({...initial,observedAt:'2026-01-04T00:00:00Z',entries:[]});
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM docket_entries WHERE availability='removed'")).rows[0].n,2);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM docket_snapshots')).rows[0].n,4);
  await service.restrictCase(saved.caseId,'test restriction');
  await assert.rejects(service.getCase(saved.caseId),/not found|restricted/i);
});

async function reconciliationDatabase(t: TestContext): Promise<Pool> {
  const schema = `reconcile_${randomUUID().replaceAll('-', '')}`;
  const admin = new Pool({ connectionString: url });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({ connectionString: url, options: `-c search_path=${schema},public` });
  t.after(async () => {
    await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  });
  await migrate(pool);
  await pool.query("INSERT INTO sources(id,state,name,metadata,capabilities,enabled) VALUES('reconciliation','ZZ','Regression fixture','{}','{}',true)");
  return pool;
}

function observation(overrides: Partial<CaseObservation> = {}): CaseObservation {
  return {
    sourceId: 'reconciliation', sourceCaseId: 'case:1', caseNumber: 'C-1',
    title: 'Reconciliation fixture', court: 'Example County', status: 'Active',
    observedAt: '2026-01-01T00:00:00Z', complete: true, participants: [], sections: {}, raw: {},
    entries: [{
      identityKey: 'event-1', sourceId: 'source-event-1', sourceOrder: 1, date: '2026-01-01',
      title: 'Order', identityConfidence: 'source', raw: { index: 1, indexText: 'Docket #42' },
      documents: [{
        sourceDocumentId: 'document-1', entryKey: 'event-1', caseNumber: 'C-1', title: 'Order',
        filename: 'Order.pdf', availability: 'available', raw: {},
      }],
    }],
    ...overrides,
  };
}

test('reconciliation normalizes metadata and preserves absent partial fields', { skip: !url }, async (t) => {
  const pool = await reconciliationDatabase(t);
  const initial = observation({
    entries: [],
    raw: { caseInfo: { caseLocation: 'Hennepin', caseType: 'Civil', dateFiled: '1/2/2025' }, origin: 'fixture' },
    participants: [{ id: 'p1', name: 'Alice', role: 'Petitioner', kind: 'party', details: { address: 'Private fixture address', counsel: 'Example lawyer' } }],
    sections: { hearings: [{ id: 'h1', date: '2026-03-01', judge: 'Example judge' }], disposition: { status: 'Pending', detail: 'Unresolved' } },
  });
  const saved = await reconcileObservation(pool, initial);
  await reconcileObservation(pool, observation({
    observedAt: '2026-01-02T00:00:00Z', complete: false, entries: [], raw: {},
    participants: [{ id: 'p1', name: 'Alice Updated', details: { counsel: 'New lawyer' } }],
    sections: { hearings: [{ id: 'h1', date: '2026-04-01' }], disposition: { status: 'Under review' } },
  }));
  const row = (await pool.query('SELECT metadata FROM cases WHERE id=$1', [saved.caseId])).rows[0];
  assert.equal(row.metadata.county, 'Hennepin');
  assert.equal(row.metadata.category, 'Civil');
  assert.equal(row.metadata.filedDate, '2025-01-02');
  assert.deepEqual(row.metadata.sections.disposition, { status: 'Under review', detail: 'Unresolved' });
  assert.deepEqual(row.metadata.sections.hearings, [{ id: 'h1', date: '2026-04-01', judge: 'Example judge' }]);
  assert.equal(row.metadata.raw.origin, 'fixture');
  const participant = (await pool.query("SELECT name,kind,role,raw FROM participants WHERE source_key='p1'")).rows[0];
  assert.equal(participant.name, 'Alice Updated');
  assert.equal(participant.role, 'Petitioner');
  assert.equal(participant.kind, 'party');
  assert.deepEqual(participant.raw.details, { address: 'Private fixture address', counsel: 'New lawyer' });
  const proceedings = (await pool.query("SELECT data FROM proceedings WHERE kind='hearings'")).rows;
  assert.equal(proceedings.length, 1);
  assert.deepEqual(proceedings[0].data, { id: 'h1', date: '2026-04-01', judge: 'Example judge' });
  await reconcileObservation(pool, observation({ observedAt: '2026-01-03T00:00:00Z', complete: false, entries: [], participants: [], sections: {}, raw: {} }));
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM participants')).rows[0].n, 1);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM proceedings')).rows[0].n, 2);
});

test('reconciliation normalizes independent source metadata and rejects impossible filed dates', { skip: !url }, async (t) => {
  const pool = await reconciliationDatabase(t);
  const saved = await reconcileObservation(pool, observation({ raw: { region: 'North', category: 'Civil', filedOn: '2025-02-03' } }));
  let metadata = (await pool.query('SELECT metadata FROM cases WHERE id=$1', [saved.caseId])).rows[0].metadata;
  assert.equal(metadata.county, 'North');
  assert.equal(metadata.category, 'Civil');
  assert.equal(metadata.filedDate, '2025-02-03');
  await reconcileObservation(pool, observation({ observedAt: '2026-01-02T00:00:00Z', complete: false, raw: { filedOn: '02/31/2025' } }));
  metadata = (await pool.query('SELECT metadata FROM cases WHERE id=$1', [saved.caseId])).rows[0].metadata;
  assert.equal(metadata.filedDate, '2025-02-03');
});

test('claimed completion without a verified document version is reacquired without duplicating snapshot replay', { skip: !url }, async (t) => {
  const pool = await reconciliationDatabase(t);
  const saved = await reconcileObservation(pool, observation());
  await pool.query("UPDATE documents SET acquisition_status='complete' WHERE case_id=$1", [saved.caseId]);
  await pool.query("UPDATE cases SET acquisition_status='complete' WHERE id=$1", [saved.caseId]);
  const later = observation({ observedAt: '2026-01-02T00:00:00Z' });
  const refreshed = await reconcileObservation(pool, later);
  assert.deepEqual(refreshed.documents, saved.documents);
  assert.equal((await pool.query('SELECT acquisition_status FROM documents')).rows[0].acquisition_status, 'pending');
  assert.equal((await pool.query('SELECT acquisition_status FROM cases')).rows[0].acquisition_status, 'partial');
  await pool.query("UPDATE documents SET acquisition_status='complete'");
  await pool.query("UPDATE cases SET acquisition_status='complete'");
  const replayed = await reconcileObservation(pool, later);
  assert.equal(replayed.snapshotId, refreshed.snapshotId);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM docket_snapshots')).rows[0].n, 2);
  assert.equal((await pool.query('SELECT acquisition_status FROM documents')).rows[0].acquisition_status, 'complete');
  assert.equal((await pool.query('SELECT acquisition_status FROM cases')).rows[0].acquisition_status, 'complete');
});

test('complete removals and later reappearance retain stable docket and document rows', { skip: !url }, async (t) => {
  const pool = await reconciliationDatabase(t);
  const saved = await reconcileObservation(pool, observation());
  await reconcileObservation(pool, observation({ observedAt: '2026-01-02T00:00:00Z', complete: false, entries: [] }));
  assert.equal((await pool.query('SELECT availability FROM docket_entries')).rows[0].availability, 'public');
  assert.equal((await pool.query('SELECT availability FROM documents')).rows[0].availability, 'available');
  await reconcileObservation(pool, observation({ observedAt: '2026-01-03T00:00:00Z', entries: [] }));
  assert.equal((await pool.query('SELECT availability FROM docket_entries')).rows[0].availability, 'removed');
  assert.equal((await pool.query('SELECT availability FROM documents')).rows[0].availability, 'removed');
  const restored = await reconcileObservation(pool, observation({ observedAt: '2026-01-04T00:00:00Z' }));
  assert.deepEqual(restored.documents, saved.documents);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM docket_entries')).rows[0].n, 1);
  assert.equal((await pool.query('SELECT acquisition_status FROM documents')).rows[0].acquisition_status, 'pending');
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM entry_changes WHERE kind='reappeared'")).rows[0].n, 1);
});

test('DOM row reordering records order changes without semantic entry versions', { skip: !url }, async (t) => {
  const pool = await reconciliationDatabase(t);
  const initial = observation();
  await reconcileObservation(pool, initial);
  const entry = initial.entries[0]!;
  await reconcileObservation(pool, observation({ observedAt: '2026-01-02T00:00:00Z',
    entries: [{ ...entry, sourceOrder: 7, raw: { ...entry.raw, index: 7, formIndex: 6 } }],
  }));
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM entry_versions')).rows[0].n, 1);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM entry_changes WHERE kind='reordered'")).rows[0].n, 1);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM entry_changes WHERE kind='modified'")).rows[0].n, 0);
  const current = (await pool.query('SELECT source_order,raw FROM docket_entries')).rows[0];
  assert.equal(current.source_order, 7);
  assert.equal(current.raw.index, 7);
});

test('same-title documents retain independent source IDs and identity collisions fail atomically', { skip: !url }, async (t) => {
  const pool = await reconciliationDatabase(t);
  const initial = observation();
  const entry = initial.entries[0]!;
  const reference = entry.documents[0]!;
  const saved = await reconcileObservation(pool, { ...initial, entries: [{ ...entry, documents: [reference, { ...reference, sourceDocumentId: 'document-2' }] }] });
  assert.equal(saved.documents.length, 2);
  await assert.rejects(reconcileObservation(pool, observation({
    observedAt: '2026-01-02T00:00:00Z',
    entries: [entry, { ...entry, identityKey: 'event-2', documents: [{ ...reference, entryKey: 'event-2' }] }],
  })), /duplicate|collision|ambiguous/i);
  await assert.rejects(reconcileObservation(pool, observation({
    observedAt: '2026-01-02T00:00:00Z',
    entries: [{ ...entry, documents: [{ ...reference, entryKey: 'wrong-event' }] }],
  })), /entry|reference/i);
  await assert.rejects(reconcileObservation(pool, observation({
    observedAt: '2026-01-02T00:00:00Z', complete: false,
    entries: [{ ...entry, identityKey: 'event-2', documents: [{ ...reference, entryKey: 'event-2' }] }],
  })), /collision|another entry|different entry/i);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM docket_snapshots')).rows[0].n, 1);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM documents')).rows[0].n, 2);
});

test('stale observations cannot change rows or add snapshots', { skip: !url }, async (t) => {
  const pool = await reconciliationDatabase(t);
  await reconcileObservation(pool, observation({ observedAt: '2026-01-02T00:00:00Z' }));
  await assert.rejects(reconcileObservation(pool, observation({ title: 'Stale title' })), /Older|stale/i);
  await assert.rejects(reconcileObservation(pool, observation({ observedAt: '2026-01-02T00:00:00Z', title: 'Concurrent conflicting title' })), /Conflicting|timestamp/i);
  assert.equal((await pool.query('SELECT title FROM cases')).rows[0].title, 'Reconciliation fixture');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM docket_snapshots')).rows[0].n, 1);
});

test('a lease guard executes inside the transaction before reconciliation writes', { skip: !url }, async (t) => {
  const pool = await reconciliationDatabase(t);
  let guarded = false;
  await assert.rejects(reconcileObservation(pool, observation(), async (client) => {
    guarded = true;
    assert.equal((await client.query('SELECT count(*)::int AS n FROM cases')).rows[0].n, 0);
    await client.query("INSERT INTO audit_events(actor,action,resource_type,resource_id) VALUES('fixture','guard','job','lease-test')");
    throw new SourceError('permanent', 'Lease expired');
  }), /Lease expired/);
  assert.equal(guarded, true);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM cases')).rows[0].n, 0);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM audit_events')).rows[0].n, 0);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM docket_snapshots')).rows[0].n, 0);
  const saved = await reconcileObservation(pool, observation());
  await assert.rejects(reconcileObservation(pool, observation({ observedAt: '2026-01-02T00:00:00Z', title: 'Fenced write' }), async () => {
    throw new SourceError('permanent', 'Lease expired');
  }), /Lease expired/);
  assert.equal((await pool.query('SELECT title FROM cases WHERE id=$1', [saved.caseId])).rows[0].title, 'Reconciliation fixture');
});

test('event identity matches the adapter and excludes DOM ordering', () => {
  assert.equal(eventIdentity({ sourceId: 'court-event-42', indexText: 'display', date: '2025-01-02', description: 'Order' }), 'court-event-42');
  assert.equal(eventIdentity({ indexText: '42', date: '2025-01-02', description: 'Order' }),
    createHash('sha256').update(JSON.stringify(['42', '2025-01-02', 'Order'])).digest('hex'));
  assert.notEqual(eventIdentity({ indexText: '42', date: '', description: 'Order' }), eventIdentity({ indexText: '43', date: '', description: 'Order' }));
});

test('lease guard precedes case locks and is rechecked after lock acquisition', { skip: !url }, async (t) => {
  const pool = await reconciliationDatabase(t);
  await reconcileObservation(pool, observation());
  const locks: number[] = [];
  await reconcileObservation(pool, observation({ observedAt: '2026-01-02T00:00:00Z' }), async (client) => {
    const result = await client.query<{ n: number }>("SELECT count(*)::int AS n FROM pg_locks WHERE pid=pg_backend_pid() AND (locktype='advisory' OR (relation='cases'::regclass AND mode='RowShareLock'))");
    locks.push(result.rows[0]!.n);
  });
  assert.equal(locks.length, 2);
  assert.equal(locks[0], 0);
  assert.ok(locks[1]! > 0);
  let checks = 0;
  await assert.rejects(reconcileObservation(pool, observation({ observedAt: '2026-01-03T00:00:00Z' }), async () => {
    if (++checks === 2) throw new SourceError('permanent', 'Lease expired while waiting for case lock');
  }), /expired while waiting/);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM docket_snapshots')).rows[0].n, 2);
});

test('verified full legacy references migrate entry identity while preserving history', { skip: !url }, async (t) => {
  const pool = await reconciliationDatabase(t);
  const initial = observation();
  const entry = initial.entries[0]!;
  const document = entry.documents[0]!;
  const legacy = observation({
    complete: false, raw: { imported: true },
    entries: [{ ...entry, identityKey: 'legacy-event-key', documents: [{ ...document, entryKey: 'legacy-event-key', raw: { legacy: true, legacyFullManifest: true, sourceIdentityVerified: true } }] }],
  });
  const saved = await reconcileObservation(pool, legacy);
  const restored = await reconcileObservation(pool, observation({ observedAt: '2026-01-02T00:00:00Z' }));
  assert.deepEqual(restored.documents, saved.documents);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM documents')).rows[0].n, 1);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM docket_entries')).rows[0].n, 2);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM entry_versions')).rows[0].n, 2);
  const migration = (await pool.query("SELECT before_data,after_data FROM entry_changes WHERE kind='identity_migrated'")).rows[0];
  assert.equal(migration.before_data.entryKey, 'legacy-event-key');
  assert.equal(migration.after_data.entryKey, 'event-1');
  assert.equal(migration.after_data.sourceDocumentId, 'document-1');
  assert.equal((await pool.query("SELECT availability FROM docket_entries WHERE identity_key='legacy-event-key'")).rows[0].availability, 'removed');
});

test('download-only legacy references without verified source identity cannot reparent', { skip: !url }, async (t) => {
  const pool = await reconciliationDatabase(t);
  const entry = observation().entries[0]!;
  const document = entry.documents[0]!;
  await reconcileObservation(pool, observation({
    complete: false, raw: { imported: true },
    entries: [{ ...entry, identityKey: 'unresolved-legacy-entry', documents: [{ ...document, entryKey: 'unresolved-legacy-entry', raw: { legacy: true, legacyFullManifest: false, sourceIdentityVerified: false } }] }],
  }));
  await assert.rejects(reconcileObservation(pool, observation({ observedAt: '2026-01-02T00:00:00Z' })), /collision|another entry/i);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM docket_snapshots')).rows[0].n, 1);
  const existing = (await pool.query('SELECT e.identity_key FROM documents d JOIN docket_entries e ON e.id=d.entry_id')).rows[0];
  assert.equal(existing.identity_key, 'unresolved-legacy-entry');
});
