import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { Pool } from 'pg';
import { migrate } from '../src/platform/database.js';
import { importFeed } from '../src/platform/imports.js';

const url = process.env.COURT_TEST_DATABASE_URL;
const integration = { skip: url ? false : 'COURT_TEST_DATABASE_URL is required for real PostgreSQL integration' };
async function setup(t: TestContext) {
  assert.ok(url);
  const admin = new Pool({ connectionString: url });
  const schema = `feed_test_${randomUUID().replaceAll('-', '')}`;
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const pool = new Pool({ connectionString: url, options: `-c search_path=${schema},public` });
  const directory = await mkdtemp(path.join(tmpdir(), 'court-feed-test-'));
  t.after(async () => {
    await pool.end();
    try { await admin.query(`DROP SCHEMA "${schema}" CASCADE`); }
    finally { await admin.end(); await rm(directory, { recursive: true, force: true }); }
  });
  await migrate(pool);
  async function file(name: string, content: string) {
    const filename = path.join(directory, name);
    await writeFile(filename, content);
    return filename;
  }
  return { pool, file };
}

// These are synthetic local extracts, not a representation that an official feed was fetched.
test('CSV preserves distinct charge rows, quoted multiline text, checksum and metadata-only semantics', integration, async t => {
  const { pool, file } = await setup(t);
  const content = 'Case Number,Case ID,Case Title,County,Case Status,Filed Date,Charge ID\r\n27-CR-24-1,internal-7,"State, Minnesota\nvs Person",Hennepin,Open,01/02/2024,charge-1\r\n27-CR-24-1,internal-7,,Hennepin,,,charge-2\r\n';
  const report = await importFeed(pool, await file('charges.csv', content), { sourceId: 'mn-mcro', format: 'csv' });
  assert.equal(report.acceptedRows, 2);
  assert.equal(report.rejectedRows, 0);
  assert.equal(report.sha256, createHash('sha256').update(content).digest('hex'));
  const cases = (await pool.query('SELECT * FROM cases')).rows;
  assert.equal(cases.length, 1);
  assert.equal(cases[0].source_id, 'mn-mcro');
  assert.equal(cases[0].source_case_id, '27-CR-24-1');
  assert.equal(cases[0].title, 'State, Minnesota\nvs Person');
  assert.equal(cases[0].status, 'Open');
  assert.equal(cases[0].metadata.filedDate, '2024-01-02');
  assert.equal(cases[0].next_refresh_at, null);
  assert.equal((await pool.query('SELECT * FROM docket_snapshots')).rowCount, 0);
  assert.equal((await pool.query('SELECT * FROM jobs')).rowCount, 0);
  const rows = (await pool.query('SELECT * FROM feed_import_rows ORDER BY row_number')).rows;
  assert.deepEqual(rows.map(r => r.raw['Charge ID']), ['charge-1', 'charge-2']);
  assert.equal(rows[0].normalized.sourceCaseId, '27-CR-24-1');
  assert.equal(rows[0].normalized.feedCaseId, 'internal-7');
  assert.match(rows[0].raw_text, /"State, Minnesota\nvs Person"/);
  assert.equal((await pool.query("SELECT * FROM case_identifiers WHERE kind='feed_case_id' AND value='internal-7'")).rowCount, 1);
});

test('malformed JSONL rows persist errors while subsequent rows import with safe unknown status', integration, async t => {
  const { pool, file } = await setup(t);
  const filename = await file('extract.jsonl', '{"CaseNumber":"01-CV-24-1"}\nnot json\n{"id":"not-a-case-number"}\n{"CaseNumber":"01-CV-24-2","CaseStatus":"Unmapped official code"}\n');
  const result = await importFeed(pool, filename, { sourceId: 'mn-mcro', format: 'jsonl' });
  assert.equal(result.status, 'partial');
  assert.equal(result.acceptedRows, 2);
  assert.equal(result.rejectedRows, 2);
  assert.equal((await pool.query("SELECT status FROM cases WHERE case_number='01-CV-24-1'")).rows[0].status, 'unknown');
  assert.equal((await pool.query("SELECT status FROM cases WHERE case_number='01-CV-24-2'")).rows[0].status, 'Unmapped official code');
  assert.equal((await pool.query("SELECT * FROM feed_import_rows WHERE error IS NOT NULL")).rowCount, 2);
  const again = await importFeed(pool, filename, { sourceId: 'mn-mcro', format: 'jsonl' });
  assert.equal(again.importId, result.importId);
  assert.equal(again.resumedRows, 4);
  assert.equal((await pool.query('SELECT * FROM feed_import_rows')).rowCount, 4);
});

test('pipe format rejects inconsistent columns and continues; generic IDs never infer case numbers', integration, async t => {
  const { pool, file } = await setup(t);
  const filename = await file('extract.txt', 'CaseNumber|CaseTitle|Status\n01-CV-24-1|One|Open\n01-CV-24-2|too|many|fields\n01-CV-24-3|Three|\n');
  const result = await importFeed(pool, filename, { sourceId: 'mn-mcro', format: 'pipe' });
  assert.equal(result.acceptedRows, 2);
  assert.equal(result.rejectedRows, 1);
  const wrong = await importFeed(pool, await file('wrong.csv', 'ID,Title\n27-CR-24-99,Not explicit\n'), { sourceId: 'mn-mcro', format: 'csv' });
  assert.equal(wrong.acceptedRows, 0);
  assert.equal(wrong.rejectedRows, 1);
});

test('concurrent identical imports and explicit acquisition deduplicate durable refresh jobs', integration, async t => {
  const { pool, file } = await setup(t);
  const filename = await file('extract.jsonl', '{"caseNumber":"01-CV-24-1","chargeId":"1"}\n{"caseNumber":"01-CV-24-1","chargeId":"2"}\n');
  const options = { sourceId: 'mn-mcro', format: 'jsonl' as const };
  const results = await Promise.all([importFeed(pool, filename, options), importFeed(pool, filename, options)]);
  assert.equal(results[0]!.importId, results[1]!.importId);
  assert.equal((await pool.query('SELECT * FROM feed_import_rows')).rowCount, 2);
  await importFeed(pool, filename, { ...options, acquireResults: true });
  await importFeed(pool, filename, { ...options, acquireResults: true });
  const jobs = (await pool.query('SELECT * FROM jobs')).rows;
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].type, 'refresh_case');
  assert.equal(jobs[0].source_id, 'mn-mcro');
  assert.equal(jobs[0].payload.sourceCaseId, '01-CV-24-1');
  assert.equal((await pool.query('SELECT enabled FROM sources')).rows[0].enabled, false);
});

test('database interruption rolls back row and checkpoint together and restart resumes', integration, async t => {
  const { pool, file } = await setup(t);
  const filename = await file('extract.jsonl', '{"caseNumber":"01-CV-24-1"}\n{"caseNumber":"01-CV-24-2"}\n');
  await pool.query(`CREATE FUNCTION fail_second_feed_row() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.row_number=2 THEN RAISE EXCEPTION 'simulated database interruption'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER fail_feed BEFORE INSERT ON feed_import_rows FOR EACH ROW EXECUTE FUNCTION fail_second_feed_row()`);
  await assert.rejects(importFeed(pool, filename, { sourceId: 'mn-mcro', format: 'jsonl' }), /simulated database interruption/);
  assert.equal((await pool.query('SELECT checkpoint FROM feed_imports')).rows[0].checkpoint, '1');
  assert.equal((await pool.query('SELECT * FROM cases')).rowCount, 1);
  await pool.query('DROP TRIGGER fail_feed ON feed_import_rows');
  const result = await importFeed(pool, filename, { sourceId: 'mn-mcro', format: 'jsonl' });
  assert.equal(result.resumedRows, 1);
  assert.equal(result.acceptedRows, 2);
  assert.equal((await pool.query('SELECT * FROM cases')).rowCount, 2);
});

test('queue failure leaves durable acquisition intent recoverable without duplicate rows', integration, async t => {
  const { pool, file } = await setup(t);
  const filename = await file('extract.jsonl', '{"caseNumber":"01-CV-24-1"}\n');
  await pool.query(`CREATE FUNCTION fail_feed_job() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'queue interruption'; END $$;
    CREATE TRIGGER fail_job BEFORE INSERT ON jobs FOR EACH ROW EXECUTE FUNCTION fail_feed_job()`);
  const options = { sourceId: 'mn-mcro', format: 'jsonl' as const, acquireResults: true };
  await assert.rejects(importFeed(pool, filename, options), /queue interruption/);
  assert.equal((await pool.query('SELECT * FROM feed_import_rows')).rowCount, 1);
  await pool.query('DROP TRIGGER fail_job ON jobs');
  await importFeed(pool, filename, { sourceId: 'mn-mcro', format: 'jsonl' });
  assert.equal((await pool.query('SELECT * FROM jobs')).rowCount, 0);
  await importFeed(pool, filename, options);
  assert.equal((await pool.query('SELECT * FROM jobs')).rowCount, 1);
  assert.equal((await pool.query('SELECT * FROM feed_import_rows')).rowCount, 1);
});

test('metadata imports never restrict missing cases or revive restricted cases', integration, async t => {
  const { pool, file } = await setup(t);
  await importFeed(pool, await file('first.jsonl', '{"caseNumber":"01-CV-24-1"}\n{"caseNumber":"01-CV-24-2"}\n'), { sourceId: 'mn-mcro', format: 'jsonl' });
  await pool.query("UPDATE cases SET availability='restricted' WHERE case_number='01-CV-24-1'");
  await importFeed(pool, await file('second.jsonl', '{"caseNumber":"01-CV-24-1","status":"Open"}\n'), { sourceId: 'mn-mcro', format: 'jsonl', acquireResults: true });
  const cases = (await pool.query('SELECT case_number,availability FROM cases ORDER BY case_number')).rows;
  assert.deepEqual(cases.map(c => c.availability), ['restricted', 'public']);
  assert.equal((await pool.query('SELECT * FROM jobs')).rowCount, 0);
});

test('unsupported sources and remote URLs are refused without source registration', integration, async t => {
  const { pool, file } = await setup(t);
  const filename = await file('extract.csv', 'CaseNumber\n01-CV-24-1\n');
  await assert.rejects(importFeed(pool, filename, { sourceId: 'other-state', format: 'csv' }), /mn-mcro/);
  await assert.rejects(importFeed(pool, 'https://example.invalid/subscription.csv', { sourceId: 'mn-mcro', format: 'csv' }), /local/i);
  assert.equal((await pool.query('SELECT * FROM sources')).rowCount, 0);
});

test('invalid Unicode and NUL records retain exact source bytes without stopping subsequent rows', integration, async t => {
  const { pool, file } = await setup(t);
  const filename = await file('invalid.jsonl', '');
  const invalid = Buffer.from('{"caseNumber":"01-CV-24-1","title":"bad\0value"}\n');
  const invalidUtf8 = Buffer.concat([Buffer.from('{"caseNumber":"01-CV-24-3","title":"'), Buffer.from([0xff]), Buffer.from('"}\n')]);
  await writeFile(filename, Buffer.concat([invalid, invalidUtf8, Buffer.from('{"caseNumber":"01-CV-24-2"}\n')]));
  const result = await importFeed(pool, filename, { sourceId: 'mn-mcro', format: 'jsonl' });
  assert.equal(result.rejectedRows, 2);
  assert.equal(result.acceptedRows, 1);
  assert.deepEqual((await pool.query('SELECT raw_bytes FROM feed_import_rows WHERE row_number=1')).rows[0].raw_bytes, invalid);
});
