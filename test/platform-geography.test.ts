import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { Pool } from 'pg';
import type { CaseObservation } from '../src/platform/contracts.js';
import { migrate, transaction } from '../src/platform/database.js';
import { importFeed } from '../src/platform/imports.js';
import { reconcileObservation } from '../src/platform/reconcile.js';

const databaseUrl = process.env.COURT_TEST_DATABASE_URL;
const databaseTest = { skip: databaseUrl ? false : 'COURT_TEST_DATABASE_URL is required for real PostgreSQL geography integration' };

async function isolatedDatabase(t: TestContext, historical = false): Promise<Pool> {
  assert.ok(databaseUrl, 'Use a disposable PostgreSQL database');
  const admin = new Pool({ connectionString: databaseUrl });
  const schema = `geography_${randomUUID().replaceAll('-', '')}`;
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema},public`, max: 12 });
  t.after(async () => {
    try {
      await pool.end();
    } finally {
      try {
        await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      } finally {
        await admin.end();
      }
    }
  });
  if (historical) {
    // Install the real immutable pre-geography history, including its checksum
    // ledger, so the public migrator must upgrade populated existing tables.
    const candidates = [new URL('../migrations/', import.meta.url), new URL('../../migrations/', import.meta.url)];
    let directory: URL | undefined;
    let names: string[] = [];
    for (const candidate of candidates) {
      try {
        names = await readdir(candidate);
        directory = candidate;
        break;
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
      }
    }
    assert.ok(directory, 'Repository migrations must be deployed alongside tests');
    const root = directory;
    await transaction(pool, async client => {
      await client.query(`CREATE TABLE schema_migrations (
        version text PRIMARY KEY, sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
        applied_at timestamptz NOT NULL DEFAULT now())`);
      for (const version of names.filter(name => /^000[1-7]_[a-z0-9_]+\.sql$/.test(name)).sort()) {
        const sql = await readFile(new URL(version, root), 'utf8');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations(version,sha256) VALUES($1,$2)', [version, createHash('sha256').update(sql).digest('hex')]);
      }
    });
  } else {
    await migrate(pool);
  }
  return pool;
}

async function source(pool: Pool, id = 'portal-a', state = 'MN'): Promise<void> {
  await pool.query('INSERT INTO sources(id,state,name) VALUES($1,$2,$1)', [id, state]);
}

function observation(overrides: Partial<CaseObservation> = {}): CaseObservation {
  return {
    sourceId: 'portal-a', sourceCaseId: 'case-1', caseNumber: 'DISPLAY-1', title: 'Synthetic case',
    court: 'District Court', status: 'Active', observedAt: '2026-01-01T00:00:00.000Z', complete: true,
    entries: [], participants: [], sections: {}, raw: { fixture: true }, ...overrides,
  };
}

async function current(pool: Pool, id: string) {
  const result = await pool.query<{ source_id: string; court: string; court_id: string | null; jurisdiction_id: string }>(
    'SELECT source_id,court,court_id,jurisdiction_id FROM cases WHERE id=$1', [id],
  );
  assert.ok(result.rows[0]);
  return result.rows[0];
}

test('geography migration backfills populated sources and cases without rewriting labels, snapshots, or acquisition intent', databaseTest, async t => {
  const pool = await isolatedDatabase(t, true);
  await source(pool);
  await source(pool, 'unknown-source', ' \t ');
  const saved = await reconcileObservation(pool, observation({ court: '  District Court  ' }));
  await pool.query(`INSERT INTO cases(source_id,source_case_id,case_number,court,next_refresh_at,acquisition_status,metadata)
    VALUES('unknown-source','metadata-only','METADATA','',NULL,'pending','{"provenance":"feed"}')`);
  const before = (await pool.query('SELECT * FROM docket_snapshots')).rows;
  await migrate(pool);
  const projected = await current(pool, saved.caseId);
  assert.equal(projected.court, '  District Court  ');
  assert.ok(projected.court_id);
  assert.ok(projected.jurisdiction_id);
  const court = (await pool.query('SELECT source_id,source_key,name,provenance FROM courts WHERE id=$1', [projected.court_id])).rows[0];
  assert.equal(court.source_id, 'portal-a');
  assert.equal(court.source_key, 'District Court');
  assert.equal(court.name, '  District Court  ');
  assert.equal(court.provenance.field, 'cases.court');
  assert.equal(court.provenance.version, 1);
  assert.deepEqual((await pool.query('SELECT * FROM docket_snapshots')).rows, before);
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM jurisdictions')).rows[0].count, 2);
  assert.equal((await pool.query('SELECT label FROM states')).rows[0].label, 'MN');
  assert.equal((await pool.query("SELECT state_id FROM sources WHERE id='unknown-source'")).rows[0].state_id, null);
  const metadataOnly = (await pool.query("SELECT court_id,jurisdiction_id,next_refresh_at,acquisition_status,metadata FROM cases WHERE source_id='unknown-source'")).rows[0];
  assert.equal(metadataOnly.court_id, null);
  assert.ok(metadataOnly.jurisdiction_id);
  assert.equal(metadataOnly.next_refresh_at, null);
  assert.equal(metadataOnly.acquisition_status, 'pending');
  assert.deepEqual(metadataOnly.metadata, { provenance: 'feed' });
  assert.equal((await pool.query('SELECT id FROM jobs')).rowCount, 0);
  assert.ok((await pool.query('SELECT enabled FROM sources')).rows.every(row => row.enabled === false));
});

test('matching court labels remain source-scoped and do not merge portals or case identities', databaseTest, async t => {
  const pool = await isolatedDatabase(t);
  await source(pool);
  await source(pool, 'portal-b');
  const first = await reconcileObservation(pool, observation());
  const second = await reconcileObservation(pool, observation({ sourceId: 'portal-b' }));
  const a = await current(pool, first.caseId);
  const b = await current(pool, second.caseId);
  assert.notEqual(first.caseId, second.caseId);
  assert.notEqual(a.court_id, b.court_id);
  assert.notEqual(a.jurisdiction_id, b.jurisdiction_id);
  assert.equal((await pool.query('SELECT id FROM states')).rowCount, 1);
  assert.equal((await pool.query('SELECT id FROM courts')).rowCount, 2);
  await assert.rejects(pool.query('UPDATE cases SET court_id=$1 WHERE id=$2', [b.court_id, first.caseId]), /foreign key/i);
  await assert.rejects(pool.query('UPDATE cases SET jurisdiction_id=$1 WHERE id=$2', [b.jurisdiction_id, first.caseId]), /foreign key/i);
  await assert.rejects(pool.query("UPDATE courts SET source_id='portal-b' WHERE id=$1", [a.court_id]), /foreign key/i);
});

test('missing and whitespace court labels remain unknown and exact matching does not invent aliases', databaseTest, async t => {
  const pool = await isolatedDatabase(t);
  await source(pool);
  for (const [index, court] of ['', ' \t\n ', 'District Court', ' District Court ', 'district court', 'District  Court'].entries()) {
    await pool.query('INSERT INTO cases(source_id,source_case_id,case_number,court,next_refresh_at) VALUES($1,$2,$2,$3,NULL)', ['portal-a', `metadata-${index}`, court]);
  }
  const rows = (await pool.query('SELECT court,court_id FROM cases ORDER BY source_case_id')).rows;
  assert.equal(rows[0].court_id, null);
  assert.equal(rows[1].court_id, null);
  assert.equal(rows[1].court, ' \t\n ');
  assert.equal(rows[2].court_id, rows[3].court_id);
  assert.notEqual(rows[2].court_id, rows[4].court_id);
  assert.notEqual(rows[2].court_id, rows[5].court_id);
  assert.equal((await pool.query('SELECT id FROM courts')).rowCount, 3);
  assert.equal((await pool.query('SELECT id FROM docket_snapshots')).rowCount, 0);
  assert.equal((await pool.query('SELECT id FROM jobs')).rowCount, 0);
});

test('court transfers replace only current court projection while retaining old court and immutable observations', databaseTest, async t => {
  const pool = await isolatedDatabase(t);
  await source(pool);
  const initial = observation();
  const first = await reconcileObservation(pool, initial);
  const before = await current(pool, first.caseId);
  const moved = observation({ court: 'Transferee Court', observedAt: '2026-01-02T00:00:00.000Z' });
  const second = await reconcileObservation(pool, moved);
  const after = await current(pool, second.caseId);
  assert.equal(first.caseId, second.caseId);
  assert.equal(before.jurisdiction_id, after.jurisdiction_id);
  assert.notEqual(before.court_id, after.court_id);
  assert.equal(after.court, 'Transferee Court');
  assert.equal((await pool.query('SELECT name FROM courts WHERE id=$1', [before.court_id])).rows[0].name, initial.court);
  assert.deepEqual((await pool.query('SELECT raw FROM docket_snapshots ORDER BY observed_at')).rows.map(row => row.raw), [initial, moved]);
  await reconcileObservation(pool, observation({ court: '', observedAt: '2026-01-03T00:00:00.000Z' }));
  assert.equal((await current(pool, first.caseId)).court_id, null);
  assert.equal((await pool.query('SELECT id FROM courts')).rowCount, 2);
});

test('changing case source and source state reprojects scope without cross-source court references', databaseTest, async t => {
  const pool = await isolatedDatabase(t);
  await source(pool);
  await source(pool, 'portal-b', 'WI');
  const saved = await reconcileObservation(pool, observation());
  const original = await current(pool, saved.caseId);
  await pool.query("UPDATE cases SET source_id='portal-b' WHERE id=$1", [saved.caseId]);
  const resourced = await current(pool, saved.caseId);
  assert.notEqual(resourced.court_id, original.court_id);
  assert.notEqual(resourced.jurisdiction_id, original.jurisdiction_id);
  assert.equal((await pool.query('SELECT source_id FROM courts WHERE id=$1', [resourced.court_id])).rows[0].source_id, 'portal-b');
  await pool.query("UPDATE sources SET state='IA' WHERE id='portal-b'");
  const relocated = await current(pool, saved.caseId);
  assert.notEqual(relocated.jurisdiction_id, resourced.jurisdiction_id);
  assert.notEqual(relocated.court_id, resourced.court_id);
  assert.equal((await pool.query(`SELECT s.label FROM jurisdictions j JOIN states s ON s.id=j.state_id WHERE j.id=$1`, [relocated.jurisdiction_id])).rows[0].label, 'IA');
  await assert.rejects(pool.query('UPDATE cases SET court_id=$1 WHERE id=$2', [resourced.court_id, saved.caseId]), /foreign key/i);
  assert.equal((await pool.query('SELECT raw FROM docket_snapshots')).rows[0].raw.sourceId, 'portal-a');
  assert.equal((await pool.query('SELECT id FROM courts')).rowCount, 3);
});

test('concurrent source and case ingestion deduplicates states, scoped jurisdictions, and courts', databaseTest, async t => {
  const pool = await isolatedDatabase(t);
  await Promise.all(Array.from({ length: 8 }, (_, index) => source(pool, `portal-${index}`)));
  assert.equal((await pool.query('SELECT id FROM states')).rowCount, 1);
  assert.equal((await pool.query('SELECT id FROM jurisdictions')).rowCount, 8);
  const results = await Promise.all(Array.from({ length: 12 }, (_, index) => reconcileObservation(pool, observation({ sourceId: 'portal-0', sourceCaseId: `case-${index}` }))));
  assert.equal(new Set(results.map(result => result.caseId)).size, 12);
  const references = (await pool.query('SELECT court_id,jurisdiction_id FROM cases')).rows;
  assert.equal(new Set(references.map(row => row.court_id)).size, 1);
  assert.equal(new Set(references.map(row => row.jurisdiction_id)).size, 1);
  assert.equal((await pool.query('SELECT id FROM courts')).rowCount, 1);
  await Promise.all(Array.from({ length: 6 }, () => reconcileObservation(pool, observation({ sourceId: 'portal-0', sourceCaseId: 'case-0' }))));
  assert.equal((await pool.query('SELECT id FROM courts')).rowCount, 1);
  assert.equal((await pool.query('SELECT id FROM cases')).rowCount, 12);
  assert.equal((await pool.query('SELECT id FROM docket_snapshots')).rowCount, 12);
});

test('real metadata feed imports populate geography without acquiring cases or manufacturing an absent court', databaseTest, async t => {
  const pool = await isolatedDatabase(t);
  const directory = await mkdtemp(path.join(tmpdir(), 'court-geography-feed-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filename = path.join(directory, 'synthetic.jsonl');
  await writeFile(filename, [
    JSON.stringify({ CaseNumber: '01-CV-26-1', Court: 'Synthetic District Court' }),
    JSON.stringify({ CaseNumber: '01-CV-26-2' }),
    JSON.stringify({ CaseNumber: '01-CV-26-3', County: 'Synthetic County' }),
  ].join('\n') + '\n');
  const result = await importFeed(pool, filename, { sourceId: 'mn-mcro', format: 'jsonl' });
  assert.equal(result.acceptedRows, 3);
  const rows = (await pool.query('SELECT court,court_id,jurisdiction_id,next_refresh_at FROM cases ORDER BY case_number')).rows;
  assert.ok(rows[0].court_id);
  assert.equal(rows[1].court_id, null);
  assert.equal(rows[0].jurisdiction_id, rows[1].jurisdiction_id);
  assert.equal(rows[1].court, '');
  assert.equal(rows[2].court, '');
  assert.equal(rows[2].court_id, null);
  assert.equal(rows[0].jurisdiction_id, rows[2].jurisdiction_id);
  assert.equal((await pool.query("SELECT metadata->'raw'->>'county' AS county FROM cases WHERE case_number='01-CV-26-3'")).rows[0].county, 'Synthetic County');
  assert.ok(rows.every(row => row.next_refresh_at === null));
  assert.equal((await pool.query('SELECT enabled FROM sources')).rows[0].enabled, false);
  assert.equal((await pool.query('SELECT id FROM docket_snapshots')).rowCount, 0);
  assert.equal((await pool.query('SELECT id FROM jobs')).rowCount, 0);
  assert.equal((await pool.query('SELECT import_id FROM feed_import_refreshes')).rowCount, 0);
});

test('synthetic state labels remain explicitly observed labels rather than invented US geography', databaseTest, async t => {
  const pool = await isolatedDatabase(t);
  await source(pool, 'synthetic-benchmark', 'TEST');
  await source(pool, 'independent-fixture', 'ZZ');
  assert.deepEqual((await pool.query('SELECT label FROM states ORDER BY label')).rows.map(row => row.label), ['TEST', 'ZZ']);
  assert.equal((await pool.query('SELECT id FROM jurisdictions')).rowCount, 2);
  assert.equal((await pool.query('SELECT id FROM courts')).rowCount, 0);
  assert.equal((await pool.query("SELECT provenance->>'sourceId' AS source FROM states WHERE label='TEST'")).rows[0].source, 'synthetic-benchmark');
});
