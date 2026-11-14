import assert from 'node:assert/strict';
import test from 'node:test';
import { discoverPartition, generatePartitions } from '../src/statewide.js';

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
    if (options.filedDateFrom !== options.filedDateTo) {
      return { truncated: true, cases: [{ caseNumber: 'cap-a' }, { caseNumber: 'cap-b' }] };
    }
    return {
      truncated: false,
      cases: [{ caseNumber: `case-${options.filedDateFrom}` }],
    };
  };

  const cases = await discoverPartition(null, {
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
      county: 'Hennepin',
      category: 'CV',
      caseStatus: '1',
      filedDateFrom: '2025-01-01',
      filedDateTo: '2025-01-01',
    }, 2, search),
    /cannot be split further/
  );
});
