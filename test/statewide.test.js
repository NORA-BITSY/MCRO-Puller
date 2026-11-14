import assert from 'node:assert/strict';
import test from 'node:test';
import { discoverPartition, generatePartitions, validateDiscoveryQuery } from '../src/statewide.js';

test('partition generation covers each county/category combination', () => {
  const partitions = generatePartitions({
    counties: ['Hennepin', 'Ramsey'],
    categories: ['CV', 'CR'],
    dateFrom: '2025-01-01',
    dateTo: '2025-01-02',
  });

  assert.equal(partitions.length, 4);
  assert.deepEqual(new Set(partitions.map((item) => item.county)), new Set(['Hennepin', 'Ramsey']));
});

test('capped date ranges are bisected until each search is uncapped', async () => {
  const search = async (_page, options) => {
    if (options.filedFrom !== options.filedTo) {
      return { truncated: true, cases: [{ caseNumber: 'cap-a' }, { caseNumber: 'cap-b' }] };
    }
    return {
      truncated: false,
      cases: [{ caseNumber: `case-${options.filedFrom}` }],
    };
  };

  const cases = await discoverPartition(null, {
    query: { searchType: 'party', lastName: 'Doe', firstName: 'Jane' },
    county: 'Hennepin',
    category: 'CV',
    caseStatus: '1',
    filedDateFrom: '2025-01-01',
    filedDateTo: '2025-01-04',
  }, 2, search);

  assert.deepEqual(cases.map((item) => item.caseNumber), [
    'case-2025-01-01',
    'case-2025-01-02',
    'case-2025-01-03',
    'case-2025-01-04',
  ]);
});

test('a saturated one-day partition fails instead of claiming completeness', async () => {
  const search = async () => ({
    truncated: true,
    cases: [{ caseNumber: 'cap-a' }, { caseNumber: 'cap-b' }],
  });

  await assert.rejects(
    discoverPartition(null, {
      query: { searchType: 'party', lastName: 'Doe', firstName: 'Jane' },
      county: 'Hennepin',
      category: 'CV',
      caseStatus: '1',
      filedDateFrom: '2025-01-01',
      filedDateTo: '2025-01-01',
    }, 2, search),
    /cannot be split further/
  );
});

test('filter-only statewide discovery fails before searching and does not invent a wildcard', async () => {
  let searched = false;
  await assert.rejects(discoverPartition(null, {
    county: 'Hennepin', category: 'CV', caseStatus: '1', filedDateFrom: '2025-01-01', filedDateTo: '2025-01-02',
  }, 200, async () => { searched = true; return { cases: [] }; }), { code: 'unsupported' });
  assert.equal(searched, false);
});

test('discovery never overwrites user filters or applies date partitions to an incompatible mode', () => {
  assert.throws(() => validateDiscoveryQuery({ searchType: 'case', caseNumber: '27-CV-24-1' }), { code: 'unsupported' });
  assert.throws(() => validateDiscoveryQuery({ searchType: 'party', firstName: 'Jane', lastName: 'Doe', counties: ['Hennepin'] }), /counties/);
  assert.throws(() => validateDiscoveryQuery({ searchType: 'business', businessName: 'Example', filedFrom: '2025-01-01' }), /filedFrom/);
});
