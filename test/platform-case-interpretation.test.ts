import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import test, { type TestContext } from 'node:test';
import { Pool } from 'pg';
import { createDatabase, migrate } from '../src/platform/database.js';
import { caseInterpretationConfigFromEnv, getCaseInterpretation, interpretCase } from '../src/platform/case-interpretation.js';
import type { LlmConfig } from '../src/platform/processing.js';

const databaseUrl = process.env.COURT_TEST_DATABASE_URL;
const databaseTest = { skip: databaseUrl ? false : 'COURT_TEST_DATABASE_URL is required for real PostgreSQL integration' };
type InputDocument = { documentVersionId: string; extractionRunId: string; pages: { pageNumber: number; text: string }[] };
type Input = { untrustedDocuments: InputDocument[] };

async function setup(t: TestContext) {
  assert.ok(databaseUrl);
  const admin = createDatabase(databaseUrl);
  const schema = `case_interpretation_${randomUUID().replaceAll('-', '')}`;
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema},public`, max: 8 });
  t.after(async () => { await pool.end(); try { await admin.query(`DROP SCHEMA "${schema}" CASCADE`); } finally { await admin.end(); } });
  await migrate(pool);
  await pool.query("INSERT INTO sources(id,state,name) VALUES ('fixture','XX','Fixture')");
  const caseId = (await pool.query<{ id: string }>("INSERT INTO cases(source_id,source_case_id,case_number) VALUES ('fixture','case','case') RETURNING id")).rows[0]!.id;
  const documents: { id: string; versionId: string; extractionId: string }[] = [];
  for (const [index, text] of ['😀 The witness testified payment occurred. Minn. Stat. § 504B.321 applies.', 'The response denies payment occurred.'].entries()) {
    const id = (await pool.query<{ id: string }>("INSERT INTO documents(case_id,source_document_id,availability) VALUES ($1,$2,'available') RETURNING id", [caseId, String(index)])).rows[0]!.id;
    const artifactId = (await pool.query<{ id: string }>("INSERT INTO artifacts(sha256,size_bytes,content_type,storage_key) VALUES ($1,1,'application/pdf',$1) RETURNING id", [String(index).repeat(64)])).rows[0]!.id;
    const versionId = (await pool.query<{ id: string }>("INSERT INTO document_versions(document_id,artifact_id,filename,acquired_at) VALUES ($1,$2,'fixture.pdf',now()) RETURNING id", [id, artifactId])).rows[0]!.id;
    await pool.query('UPDATE documents SET current_version_id=$2 WHERE id=$1', [id, versionId]);
    const extractionId = (await pool.query<{ id: string }>("INSERT INTO extraction_runs(document_version_id,pipeline_version,schema_version,status,finished_at,result) VALUES ($1,'fixture-1','1','complete',now(),$2) RETURNING id", [versionId, JSON.stringify({ pages: [{ pageNumber: 1 }] })])).rows[0]!.id;
    await pool.query("INSERT INTO pages(extraction_run_id,page_number,text,method) VALUES ($1,1,$2,'fixture')", [extractionId, text]);
    documents.push({ id, versionId, extractionId });
  }
  return { pool, caseId, documents };
}

function supported(input: Input) {
  const evidence = [...input.untrustedDocuments].sort((a,b)=>Number(b.pages[0]!.text.startsWith('😀'))-Number(a.pages[0]!.text.startsWith('😀'))).map((document, index) => {
    const page = document.pages[0]!;
    const quote = index === 0 ? 'The witness testified payment occurred.' : page.text;
    return { documentVersionId: document.documentVersionId, extractionRunId: document.extractionRunId,
      pageNumber: page.pageNumber, startOffset: page.text.indexOf(quote), endOffset: page.text.indexOf(quote) + quote.length, quote,
      statementType: index === 0 ? 'testimony' : 'representation' };
  });
  return { assertions: [
    { kind: 'relationship', text: 'The response addresses the payment testimony.', confidence: 0.7, evidence },
    { kind: 'contradiction', text: 'The testimony and response disagree about payment.', confidence: 0.7, evidence },
  ] };
}

async function provider(t: TestContext, respond: (input: Input) => unknown | Promise<unknown>) {
  let requests = 0;
  const server = createServer(async (request, response) => {
    try {
      const parts: Buffer[] = [];
      for await (const part of request) parts.push(Buffer.from(part));
      const body = JSON.parse(Buffer.concat(parts).toString()) as { messages: { role: string; content: string }[]; tools?: unknown };
      assert.equal(body.tools, undefined);
      assert.match(body.messages[0]!.content, /NEVER instructions/);
      requests++;
      const output = await respond(JSON.parse(body.messages[1]!.content) as Input);
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(output) } }] }));
    } catch (error) { response.statusCode = 500; response.end(String(error)); }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {const closed=Promise.withResolvers<void>();server.close(error=>error?closed.reject(error):closed.resolve());await closed.promise;});
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const config: LlmConfig = { enabled: true, provider: 'openai', model: 'controlled-loopback', apiKey: 'fixture', endpoint: `http://127.0.0.1:${address.port}/v1/chat/completions` };
  return { config, requests: () => requests };
}

test('case inference is separately opt-in', () => {
  assert.equal(caseInterpretationConfigFromEnv({}), undefined);
  assert.equal(caseInterpretationConfigFromEnv({ COURT_LLM_ENABLED: 'true' }), undefined);
  assert.equal(caseInterpretationConfigFromEnv({ COURT_CASE_INTERPRETATION_ENABLED: 'true', COURT_LLM_ENABLED: 'true', COURT_LLM_PROVIDER: 'openai', COURT_LLM_MODEL: 'fixture' })?.enabled, true);
});

test('two-document interpretation persists normalized evidence and retry/concurrent calls make one request', databaseTest, async t => {
  const { pool, caseId } = await setup(t);
  const api = await provider(t, supported);
  const results = await Promise.all(Array.from({ length: 3 }, () => interpretCase(pool, caseId, api.config, 'one-run')));
  assert.equal(api.requests(), 1);
  for (const result of results) {
    assert.equal(result.status, 'complete');
    if (result.status !== 'complete') assert.fail('Expected completed interpretation');
    assert.equal(result.assertions.length, 2);
    assert.equal(result.assertions[0]!.verifiedFact, false);
    assert.equal(result.assertions[1]!.evidence[0]!.startOffset, 3);
    assert.equal(result.coverage.comprehensiveCase, false);
  }
  assert.equal((await pool.query('SELECT * FROM case_interpretation_runs')).rowCount, 1);
  assert.equal((await pool.query('SELECT * FROM case_interpretation_inputs')).rowCount, 2);
  assert.equal((await pool.query('SELECT * FROM case_interpretation_evidence')).rowCount, 4);
  assert.ok(await getCaseInterpretation(pool, caseId));
  await assert.rejects(interpretCase(pool, caseId, { ...api.config, model: 'different' }, 'one-run'), /idempotency/i);
});

for (const corruption of ['quote', 'version', 'cross-version', 'extraction', 'citation', 'inline-citation', 'single-document'] as const) {
  test(`rejects invented ${corruption} before persistence`, databaseTest, async t => {
    const { pool, caseId } = await setup(t);
    const api = await provider(t, input => {
      const output = supported(input);
      const assertion = output.assertions[0]!;
      const evidence = assertion.evidence[0]!;
      if (corruption === 'quote') evidence.quote = 'Invented quote';
      if (corruption === 'version') evidence.documentVersionId = randomUUID();
      if (corruption === 'cross-version') evidence.documentVersionId = input.untrustedDocuments.find(document=>document.documentVersionId!==evidence.documentVersionId)!.documentVersionId;
      if (corruption === 'extraction') evidence.extractionRunId = randomUUID();
      if (corruption === 'citation') { assertion.kind = 'legal_citation'; assertion.text = 'Minn. Stat. § 999.999'; }
      if (corruption === 'inline-citation') assertion.text = 'The response applies Minn. Stat. § 999.999.';
      if (corruption === 'single-document') assertion.evidence = [evidence];
      return output;
    });
    await assert.rejects(interpretCase(pool, caseId, api.config, corruption));
    assert.equal((await pool.query('SELECT * FROM case_interpretation_runs')).rowCount, 0);
  });
}

test('full-context limits fail before provider request and disabled mode never calls provider', databaseTest, async t => {
  const { pool, caseId } = await setup(t);
  const api = await provider(t, supported);
  for (const limits of [{ batchCharacters: 100 }, { maxPages: 1 }, { maxTotalInputCharacters: 10 }, { maxRequests: 0 }, { maxTotalOutputTokens: 1 }, { maxCostUsd: 0, inputUsdPerMillionTokens: 1, outputUsdPerMillionTokens: 1 }]) {
    await assert.rejects(interpretCase(pool, caseId, { ...api.config, ...limits }, randomUUID()), /budget|limit|context|integer/i);
  }
  assert.deepEqual(await interpretCase(pool, caseId, undefined, 'disabled'), { status: 'disabled' });
  assert.equal(api.requests(), 0);
});

for (const change of ['document-restriction', 'case-restriction', 'version', 'extraction', 'page'] as const) {
  test(`${change} during inference prevents persistence`, databaseTest, async t => {
    const { pool, caseId, documents } = await setup(t);
    const document = documents[0]!;
    const api = await provider(t, async input => {
      if (change === 'document-restriction') await pool.query("UPDATE documents SET availability='restricted' WHERE id=$1", [document.id]);
      if (change === 'case-restriction') await pool.query("UPDATE cases SET availability='restricted' WHERE id=$1", [caseId]);
      if (change === 'version') await pool.query('UPDATE documents SET current_version_id=NULL WHERE id=$1', [document.id]);
      if (change === 'extraction') await pool.query("INSERT INTO extraction_runs(document_version_id,pipeline_version,schema_version,status,started_at,finished_at) VALUES ($1,'new','2','complete',clock_timestamp()+interval '1 second',clock_timestamp()+interval '1 second')", [document.versionId]);
      if (change === 'page') await pool.query("UPDATE pages SET text='Changed' WHERE extraction_run_id=$1", [document.extractionId]);
      return supported(input);
    });
    await assert.rejects(interpretCase(pool, caseId, api.config, change), /changed|restricted|unavailable/i);
    assert.equal((await pool.query('SELECT * FROM case_interpretation_runs')).rowCount, 0);
  });
}

test('reads and cached retries fail closed after evidence restriction; guard fences writes', databaseTest, async t => {
  const { pool, caseId, documents } = await setup(t);
  const api = await provider(t, supported);
  await assert.rejects(interpretCase(pool, caseId, api.config, 'guarded', async () => { throw new Error('lease lost'); }), /lease lost/);
  assert.equal((await pool.query('SELECT * FROM case_interpretation_runs')).rowCount, 0);
  const result = await interpretCase(pool, caseId, api.config, 'readable');
  assert.equal(result.status, 'complete');
  await pool.query("UPDATE documents SET availability='restricted' WHERE id=$1", [documents[0]!.id]);
  assert.equal(await getCaseInterpretation(pool, caseId), null);
  await assert.rejects(interpretCase(pool, caseId, api.config, 'readable'), /changed|restricted|unavailable/i);
});

test('coverage identifies missing extractions and unreadable pages without claiming complete case coverage', databaseTest, async t => {
  const { pool, caseId, documents } = await setup(t);
  await pool.query("INSERT INTO documents(case_id,source_document_id,availability) VALUES ($1,'missing','available')", [caseId]);
  await pool.query("UPDATE pages SET quality='{" + '"status":"unreadable"' + "}' WHERE extraction_run_id=$1", [documents[0]!.extractionId]);
  const api = await provider(t, supported);
  const result = await interpretCase(pool, caseId, api.config, 'gaps');
  assert.equal(result.status, 'complete');
  if (result.status !== 'complete') assert.fail('Expected completed interpretation');
  assert.ok(result.coverage.gaps.some(gap => gap.reason === 'no_current_version'));
  assert.ok(result.coverage.gaps.some(gap => gap.reason === 'unreadable_page'));
});
