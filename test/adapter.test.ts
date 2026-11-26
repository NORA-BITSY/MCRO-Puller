import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createAdapters, IndependentFixtureAdapter } from '../src/platform/adapters.js';

const registry = createAdapters();
const mn = registry.get('mn-mcro')!;
const fixture = registry.get('independent-fixture')!;

test('registry distinguishes synthetic portability evidence from a real jurisdiction', () => {
  assert.deepEqual([...registry.keys()], ['mn-mcro', 'independent-fixture']);
  assert.equal(fixture.metadata().fixture, true);
  assert.equal(mn.metadata().fixture, false);
  for (const mode of Object.values(mn.capabilities().searchModes)) assert.equal(mode.verified, 'documented');
});

test('Minnesota validates all supported modes without ignoring incompatible fields', () => {
  for (const query of [
    { searchType: 'case', caseNumber: '27-CV-24-1' },
    { searchType: 'case', citationNumber: 'ABC123' },
    { searchType: 'party', firstName: 'Jane', lastName: 'Doe' },
    { searchType: 'business', businessName: 'Example LLC', soundex: true },
    { searchType: 'attorney', attorneyFirstName: 'Alex', attorneyLastName: 'Smith', attorneyMiddleName: 'B' },
    { searchType: 'attorney', barNumber: '0123456' },
    { searchType: 'document', caseNumber: '27-CV-24-1' },
    { searchType: 'hearing', judgeName: 'Example Judge', hearingFrom: '2025-01-01', hearingTo: '2025-01-02' },
    { searchType: 'hearing', caseNumber: '27-CV-24-1', hearingFrom: '2025-01-01' },
    { searchType: 'judgment', firstName: 'Jane', lastName: 'Doe', docketedFrom: '2024-01-01' },
  ]) assert.equal(mn.validateSearch(query).searchType, query.searchType);
  for (const query of [
    { searchType: 'party', lastName: 'Doe' },
    { searchType: 'case', caseNumber: '27-CV-24-1', lastName: 'Doe' },
    { searchType: 'document', caseNumber: '27-CV-24-1', county: 'Hennepin' },
    { searchType: 'attorney', barNumber: '123', attorneyLastName: 'Doe' },
    { searchType: 'party', firstName: 'Ja*', lastName: 'Doe', soundex: true },
    { searchType: 'judgment', caseNumber: '27-CV-24-1' },
    { searchType: 'hearing', judgeName: 'Example', hearingFrom: '2025-02-30' },
    { searchType: 'business', businessName: 'Example', filedFrom: '2025-01-02', filedTo: '2025-01-01' },
    { searchType: 'business', businessName: 'Example', county: 'Imaginary County' },
    { searchType: 'case', caseNumber: '27-CV-24-1', unexpected: true },
  ]) assert.throws(() => mn.validateSearch(query), JSON.stringify(query));
});

test('live acquisition proceeds without opt-in env gate', async () => {
  const previous = process.env.COURT_ALLOW_LIVE_MN;
  delete process.env.COURT_ALLOW_LIVE_MN;
  try {
    await assert.rejects(mn.fetchCase('27-CV-24-1', {}));
    await assert.rejects(mn.searchCases(mn.validateSearch({ searchType: 'case', caseNumber: '27-CV-24-1' }), {}));
  } finally {
    if (previous === undefined) delete process.env.COURT_ALLOW_LIVE_MN;
    else process.env.COURT_ALLOW_LIVE_MN = previous;
  }
});

test('independent source consumes pages and preserves non-Minnesota IDs and source order', async () => {
  const query = fixture.validateSearch({ sourceId: 'independent-fixture', searchType: 'business', businessName: 'Example*' });
  const result = await fixture.searchCases(query, {});
  assert.equal(result.complete, true);
  assert.equal(result.cases.length, 3);
  assert.equal(result.raw.pagesObserved, 2);
  assert.equal(result.cases[0]?.sourceCaseId, 'civil:alpha/2024');
  const docket = await fixture.fetchCase('civil:alpha/2024', {});
  assert.equal(docket.entries.length, 3);
  assert.equal(docket.entries[0]?.documents.length, 0);
  assert.equal(docket.entries[1]?.documents.length, 2);
  assert.deepEqual(docket.entries.map((entry) => entry.sourceOrder), [0, 1, 2]);
  assert.ok(docket.sections.hearings);
  assert.ok(docket.sections.judgments);
  assert.doesNotMatch(JSON.stringify(docket), /RequestVerificationToken|downloadToken|secret-cookie/);
  for (const ref of docket.entries[1]!.documents) {
    const artifact = await fixture.fetchDocument(ref, {});
    assert.equal(artifact.bytes.subarray(0, 5).toString(), '%PDF-');
    assert.match(artifact.bytes.toString(), /xref/);
    assert.equal(artifact.contentType, 'application/pdf');
  }
  await assert.rejects(fixture.fetchCase('missing', {}), { code: 'not_found' });
});

test('fixture cursor is explicit, query-bound, and malformed cursors fail', async () => {
  const adapter = new IndependentFixtureAdapter();
  const query = adapter.validateSearch({ sourceId: 'independent-fixture', searchType: 'business', businessName: 'Example*' });
  const first = await adapter.searchPage(query);
  assert.equal(first.cases.length, 2);
  assert.ok(first.nextCursor);
  const second = await adapter.searchPage(query, first.nextCursor);
  assert.equal(second.cases.length, 1);
  assert.equal(second.nextCursor, undefined);
  await assert.rejects(adapter.searchPage(query, 'invalid'), { code: 'permanent' });
  await assert.rejects(adapter.searchPage({ ...query, businessName: 'Other' }, first.nextCursor), { code: 'permanent' });
});

test('fixture restricted artifacts and cancellation remain observable', async () => {
  const docket = await fixture.fetchCase('appeal:gamma/2024', {});
  await assert.rejects(fixture.fetchDocument(docket.entries[0]!.documents[0]!, {}), { code: 'restricted' });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(fixture.fetchCase('civil:alpha/2024', { signal: controller.signal }), { name: 'AbortError' });
});

test('fixture evaluates every query mode and supported date/location/status filters', async () => {
  const scenarios = [
    { searchType: 'case', citationNumber: 'FIXTURE-101' },
    { searchType: 'party', lastName: 'Doe', firstName: 'Jane', middleName: 'A', dobFrom: '1980-04-01', county: 'North' },
    { searchType: 'attorney', attorneyFirstName: 'Alex', attorneyLastName: 'Smith', attorneyMiddleName: 'B', categories: ['CV'], status: 'Active' },
    { searchType: 'attorney', barNumber: '0123456' },
    { searchType: 'document', caseNumber: 'FX-2024-0001' },
    { searchType: 'hearing', judgeName: 'Example Judge', hearingFrom: '2025-01-02' },
    { searchType: 'judgment', firstName: 'Jane', lastName: 'Doe', docketedFrom: '2024-06-01', judgmentStatus: 'Unsatisfied' },
    { searchType: 'business', businessName: 'Example*', filedFrom: '2024-01-01', filedTo: '2024-01-31', counties: ['North'] },
  ];
  for (const scenario of scenarios) {
    const result = await fixture.searchCases(fixture.validateSearch({ sourceId: 'independent-fixture', ...scenario }), {});
    assert.deepEqual(result.cases.map((row) => row.sourceCaseId), ['civil:alpha/2024'], JSON.stringify(scenario));
  }
  const creditor = fixture.validateSearch({ sourceId: 'independent-fixture', searchType: 'judgment', businessName: 'Example*' });
  assert.equal((await fixture.searchCases(creditor, {})).cases.length, 0, 'judgment search matches debtor, not any party');
});

test('fixture parser rejects ambiguous source identities before exposing records', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'court-adapter-fixture-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const data: { records: unknown[] } = JSON.parse(await readFile(new URL('./fixtures/adapters/independent.json', import.meta.url), 'utf8'));
  data.records.push(data.records[0]);
  const filename = path.join(directory, 'duplicate.json');
  await writeFile(filename, JSON.stringify(data));
  const adapter = new IndependentFixtureAdapter(filename);
  await assert.rejects(adapter.fetchCase('civil:alpha/2024', {}), /duplicate.*record|duplicate.*case/i);
});
