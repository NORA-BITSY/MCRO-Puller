import assert from 'node:assert/strict';
import test from 'node:test';
import { parseSearchResults, waitForSearchResults } from '../src/search.js';
import { caseNumbersEqual, checkWafBlock, normalizeCaseNumber } from '../src/waf.js';
import { validateSearchOptions, sanitizeSourceData } from '../src/search.js';
import { normalizeRoaSnapshot } from '../src/roa.js';
import { buildSearchQuery } from '../cli.js';
import { installSourceRequestGate, createIsolatedExtensionContext } from '../src/browser.js';

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

test('source query validation rejects silently ignored fields before navigation', () => {
  assert.throws(() => validateSearchOptions({ searchType: 'document', caseNumber: '27-CV-24-1', firstName: 'Jane' }), /firstName/);
  assert.throws(() => validateSearchOptions({ searchType: 'party', lastName: 'Doe', firstName: 'J*' }), /wildcard/i);
  assert.throws(() => validateSearchOptions({ searchType: 'business', businessName: 'Example', categories: ['INVALID'] }), /categor/i);
});

test('docket normalization retains every attachment, non-document event, and raw section label', () => {
  const result = normalizeRoaSnapshot({
    caseInfo: { caseNumberRaw: '27-CV-24-1', caseTitle: 'Example', caseStatus: 'Open' },
    parties: ['Jane Doe — Plaintiff'],
    events: [
      { index: 1, date: '01/02/2024', description: 'Hearing held', indexText: '', documents: [], rawText: 'Hearing held' },
      { index: 2, date: '01/01/2024', description: 'Complaint', indexText: '1', documents: [
        { sourceDocumentId: 'a', pages: '2', downloadToken: 'secret', requestVerificationToken: 'secret', formIndex: 0 },
        { sourceDocumentId: 'b', pages: '1', downloadToken: 'other', formIndex: 1 },
      ] },
    ],
    sections: [{ id: 'dispositions', label: 'Dispositions / Judgments', text: 'Judgment entered' }],
    rawText: 'Case Number: 27-CV-24-1',
  });
  assert.equal(result.events.length, 2);
  assert.equal(result.events[0].hasDocument, false);
  assert.equal(result.events[1].documents.length, 2);
  assert.equal(result.totalDocuments, 2);
  assert.equal(result.sections[0].label, 'Dispositions / Judgments');
  const persisted = sanitizeSourceData(result);
  assert.doesNotMatch(JSON.stringify(persisted), /secret|downloadToken|VerificationToken/);
});

test('sanitization removes credential fields and query secrets without dropping source text', () => {
  assert.deepEqual(sanitizeSourceData({ authorization: 'Bearer secret', text: 'Docket label', url: 'https://example.test/case?id=12&token=secret' }), {
    text: 'Docket label', url: 'https://example.test/case?id=12',
  });
});

test('legacy CLI constructs canonical query modes without implicit incompatible defaults', () => {
  assert.deepEqual(buildSearchQuery({ case: '27-CV-24-1', soundex: false, mode: 'extension' }), { searchType: 'case', caseNumber: '27-CV-24-1' });
  assert.deepEqual(buildSearchQuery({ attorney: 'Smith', attorneyFirst: 'Alex', attorneyMiddle: 'B' }), {
    searchType: 'attorney', attorneyLastName: 'Smith', attorneyFirstName: 'Alex', attorneyMiddleName: 'B',
  });
  assert.equal(buildSearchQuery({ searchType: 'judgment', name: 'Doe', first: 'Jane', docketedFrom: '2024-01-01' }).searchType, 'judgment');
  assert.equal(buildSearchQuery({ searchType: 'document', case: '27-CV-24-1' }).searchType, 'document');
  assert.throws(() => buildSearchQuery({ case: '27-CV-24-1', status: 'Active' }), /status/);
  assert.throws(() => buildSearchQuery({ attorney: 'Smith' }), /FirstName/);
});

test('every source document/XHR/fetch request reserves budget; static assets do not', async () => {
  let handler; let reservations = 0; let continued = 0;
  const page = { route: async (_pattern, callback) => { handler = callback; }, unroute: async () => {}, on() {}, off() {} };
  const gate = await installSourceRequestGate(page, { beforeRequest: async () => { reservations++; } });
  for (const type of ['document', 'xhr', 'fetch', 'stylesheet', 'font', 'image']) {
    await handler({ request: () => ({ url: () => 'https://publicaccess.courts.state.mn.us/CaseSearch', resourceType: () => type }), continue: async () => { continued++; }, abort: async () => { throw new Error('unexpected abort'); } });
  }
  assert.equal(reservations, 3);
  assert.equal(continued, 6);
  assert.equal(gate.error, undefined);
  await gate.close();
});

test('source network gate aborts and preserves budget or cancellation errors without bypass', async () => {
  let handler; let aborted = false;
  const blocked = Object.assign(new Error('source paused'), { code: 'blocked' });
  const gate = await installSourceRequestGate({
    route: async (_pattern, callback) => { handler = callback; }, unroute: async () => {}, on() {}, off() {},
  }, { beforeRequest: async () => { throw blocked; } });
  await handler({ request: () => ({ url: () => 'https://publicaccess.courts.state.mn.us/CaseSearch/DownloadDocument', resourceType: () => 'fetch' }), continue: async () => { throw new Error('must not send'); }, abort: async () => { aborted = true; } });
  assert.equal(aborted, true);
  assert.equal(gate.error, blocked);
  await assert.rejects(installSourceRequestGate({}, {}), { code: 'unsupported' });
});

test('source 429 responses preserve Retry-After and block further requests', async () => {
  let handler; let onResponse; let sent = false; let aborted = false;
  const gate = await installSourceRequestGate({
    route: async (_pattern, callback) => { handler = callback; }, unroute: async () => {},
    on: (_event, listener) => { onResponse = listener; }, off() {},
  }, { beforeRequest: async () => {} });
  onResponse({
    url: () => 'https://publicaccess.courts.state.mn.us/CaseSearch',
    request: () => ({ resourceType: () => 'xhr' }), status: () => 429, headers: () => ({ 'retry-after': '120' }),
  });
  assert.equal(gate.error.code, 'blocked');
  assert.equal(gate.error.retryAfterMs, 120000);
  await handler({ request: () => ({ url: () => 'https://publicaccess.courts.state.mn.us/CaseSearch', resourceType: () => 'xhr' }), continue: async () => { sent = true; }, abort: async () => { aborted = true; } });
  assert.equal(sent, false);
  assert.equal(aborted, true);
});

test('case-number validation rejects incomplete identifiers before live access', () => {
  assert.throws(() => validateSearchOptions({ searchType: 'case', caseNumber: '27-CV' }), /complete/i);
  assert.equal(validateSearchOptions({ searchType: 'case', caseNumber: '27CV241' }).caseNumber, '27CV241');
  assert.equal(validateSearchOptions({ searchType: 'case', caseNumber: '19HA-CR-24-1' }).caseNumber, '19HA-CR-24-1');
});

test('complete dashless case requests match the source number without weakening exact identity', () => {
  assert.equal(caseNumbersEqual('27CV240001', '27-CV-24-1'), true);
  assert.equal(caseNumbersEqual('19HACR241', '19HA-CR-24-0001'), true);
  assert.equal(caseNumbersEqual('27CV250001', '27-CV-24-1'), false);
  assert.equal(caseNumbersEqual('27CV240002', '27-CV-24-1'), false);
});

test('a response block arriving during budget wait prevents the reserved request from continuing', async () => {
  let handler; let onResponse; let continued = false; let aborted = false;
  const entered = Promise.withResolvers();
  const budget = Promise.withResolvers();
  const gate = await installSourceRequestGate({
    route: async (_pattern, callback) => { handler = callback; }, unroute: async () => {},
    on: (_event, listener) => { onResponse = listener; }, off() {},
  }, { beforeRequest: async () => { entered.resolve(); await budget.promise; } });
  const pending = handler({ request: () => ({ url: () => 'https://publicaccess.courts.state.mn.us/CaseSearch', resourceType: () => 'xhr' }), continue: async () => { continued = true; }, abort: async () => { aborted = true; } });
  await entered.promise;
  onResponse({ url: () => 'https://publicaccess.courts.state.mn.us/CaseSearch', request: () => ({ resourceType: () => 'document' }), status: () => 403, headers: () => ({}) });
  budget.resolve();
  await pending;
  assert.equal(continued, false);
  assert.equal(aborted, true);
  assert.equal(gate.error.code, 'blocked');
});

test('readiness timeouts inspect challenges and otherwise preserve the original timeout', async () => {
  const timeout = new Error('result timeout');
  const page = {
    waitForFunction: async () => { throw timeout; }, title: async () => 'MCRO', url: () => 'about:blank',
    content: async () => '<iframe title="reCAPTCHA"></iframe>',
    locator: () => ({ all: async () => [{ isVisible: async () => true }] }),
  };
  await assert.rejects(waitForSearchResults(page), { code: 'blocked' });
  page.content = async () => '<p>Still loading</p>';
  page.locator = () => ({ all: async () => [] });
  await assert.rejects(waitForSearchResults(page), (error) => error === timeout);
});

test('extension isolation attempts CDP newContext and never falls back to shared operator tabs', async () => {
  const isolated = {};
  let requested;
  const context = await createIsolatedExtensionContext({
    newContext: async (options) => { requested = options; return isolated; },
    contexts: () => { throw new Error('shared context must not be accessed'); },
  });
  assert.equal(context, isolated);
  assert.equal(requested.serviceWorkers, 'block');
  await assert.rejects(createIsolatedExtensionContext({
    newContext: async () => { throw new Error('Target.createBrowserContext is unsupported'); },
    contexts: () => { throw new Error('no shared-context fallback'); },
  }), { code: 'unsupported' });
});
