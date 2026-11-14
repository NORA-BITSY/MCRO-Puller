import assert from 'node:assert/strict';
import test from 'node:test';
import { parseSearchResults } from '../src/search.js';
import { caseNumbersEqual, checkWafBlock, normalizeCaseNumber } from '../src/waf.js';

test('unrecognized search pages fail instead of becoming false no-result responses', async () => {
  const page = {
    evaluate: async () => ({ totalFound: 0, noResults: false, unexpected: true, cases: [] }),
    url: () => 'https://publicaccess.courts.state.mn.us/CaseSearch',
  };

  await assert.rejects(parseSearchResults(page), /could not be recognized/);
});

test('search parsing preserves cap evidence and normalizes case numbers', async () => {
  const page = {
    evaluate: async () => ({
      totalFound: 200,
      noResults: false,
      truncated: true,
      unexpected: false,
      cases: [{ caseNumberRaw: '27 dash CV dash 24 dash 1' }],
    }),
    url: () => 'https://publicaccess.courts.state.mn.us/CaseSearch',
  };

  const result = await parseSearchResults(page);
  assert.equal(result.truncated, true);
  assert.equal(result.cases[0].caseNumber, '27-CV-24-1');
});
test('case-number normalization stops at duplicated accessible heading text', () => {
  assert.equal(
    normalizeCaseNumber('27-CV-02-00004127-CV-02-000041'),
    '27-CV-02-000041'
  );
  assert.equal(caseNumbersEqual('27-CV-02-41', '27-CV-02-000041'), true);
  assert.equal(caseNumbersEqual('27-CV-24-1', '27-CV-02-000041'), false);
});


test('WAF indicators are surfaced as a hard block', async () => {
  const result = await checkWafBlock({
    title: async () => 'Access Denied',
    url: () => 'https://publicaccess.courts.state.mn.us/CaseSearch',
    content: async () => '<html>request blocked</html>',
  });

  assert.equal(result.blocked, true);
  assert.match(result.reason, /access denied/);
});
