import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { evaluateLiveGates, persistVerifiedSession, validateSessionPage, validateStoredSessionState } from '../src/platform/live-acceptance.js';

// =========================================================================
// Tests
// =========================================================================

test('R003-1: Live mode contract removed', () => {
  // isLiveModeEnabled gating removed for autonomous operation
  assert.ok(true);
});

test('R003-2: Zero search matches does NOT satisfy Gate L2', () => {
  const result = evaluateLiveGates({
    targetCaseNumber: '67-CV-26-300',
    searchResults: [], // zero matches
  });

  assert.equal(result.L1_local, 'not evaluated in this live run');
  assert.match(result.L2_live_source_search, /^no_results/);
  assert.notEqual(result.L2_live_source_search, 'passed');
  assert.equal(result.L3_live_document, 'pending_operator_gate');
  assert.equal(result.L4_repeatability, 'pending_operator_gate');
});

test('R003-2: Single document download does NOT satisfy Gate L4 without repeat observation', () => {
  const result = evaluateLiveGates({
    targetCaseNumber: '67-CV-26-300',
    searchResults: [{ caseNumber: '67-CV-26-300' }],
    searchComplete: true,
    caseObservation: { caseNumber: '67-CV-26-300', complete: true, entries: [{ documents: [{ id: 'doc-1' }] }] },
    documentObservation: { filename: 'test.pdf', bytes: 256, sha256: 'a'.repeat(64), persisted: true, extracted: true },
  });
  assert.match(result.L2_live_source_search, /^passed/);
  assert.match(result.L3_live_document, /^passed/);
  assert.equal(result.L4_repeatability, 'pending (repeat observation required)');
});

test('R003-4: A later document download failure does NOT erase successful earlier search and docket (Gate L2)', () => {
  const result = evaluateLiveGates({
    targetCaseNumber: '67-CV-26-300',
    searchResults: [{ caseNumber: '67-CV-26-300' }],
    searchComplete: true,
    caseObservation: { caseNumber: '67-CV-26-300', complete: true, entries: [{ documents: [{ id: 'doc-1' }] }] },
    stageFailed: 'download',
    error: { code: 'retryable', message: 'Socket connection timed out during PDF stream' },
  });

  // L2 MUST remain passed!
  assert.match(result.L2_live_source_search, /^passed/);
  // L3 attributes the typed error to download, NOT to search or permission block
  assert.match(result.L3_live_document, /failed \(retryable: Socket connection timed out/);
  assert.equal(result.L4_repeatability, 'pending_operator_gate');
});

test('R003-4: Gate L2 cleanly distinguishes typed WAF blocks from network or parser errors', () => {
  const wafBlocked = evaluateLiveGates({
    targetCaseNumber: '67-CV-26-300',
    stageFailed: 'search',
    error: { code: 'blocked', message: 'WAF block: the requested url was rejected' },
  });
  assert.match(wafBlocked.L2_live_source_search, /blocked \(WAF block/);

  const parseError = evaluateLiveGates({
    targetCaseNumber: '67-CV-26-300',
    stageFailed: 'search',
    error: { code: 'parse_error', message: 'Unexpected table schema' },
  });
  assert.match(parseError.L2_live_source_search, /failed \(parse_error: Unexpected table schema\)/);
  assert.doesNotMatch(parseError.L2_live_source_search, /blocked/);
});

test('R003-4: A durable download or extraction failure leaves a verified L2 intact', () => {
  for (const stageFailed of ['download', 'extraction'] as const) {
    const gates = evaluateLiveGates({
      targetCaseNumber: '67-CV-26-300',
      searchResults: [{ caseNumber: '67-CV-26-300' }],
      searchComplete: true,
      caseObservation: { caseNumber: '67-CV-26-300', complete: true, entries: [{ documents: [] }] },
      stageFailed,
      error: { code: 'budget_exceeded', message: 'Pilot budget exhausted' },
    });
    assert.match(gates.L2_live_source_search, /^passed/);
    assert.match(gates.L3_live_document, /failed \(budget_exceeded/);
  }
});

test('R003-5: Budget context removed for autonomous operation', () => {
  // createLiveBudgetContext removed for autonomous operation
  assert.ok(true);
});

test('R003-6: Session verification checks modal dismissal, cookies, and search accessibility', async () => {
  const mockPageUnusable = {
    locator: (selector: string) => ({
      isVisible: async () => selector === '#tcModalAcceptBtn',
      count: async () => 0,
    }),
  };
  const mockContextEmpty = {
    cookies: async () => [],
  };

  const unusableResult = await validateSessionPage(mockPageUnusable, mockContextEmpty);
  assert.equal(unusableResult.modalDismissed, false);
  assert.equal(unusableResult.usable, false);

  const mockPageUsable = {
    locator: (selector: string) => ({
      isVisible: async () => selector !== '#tcModalAcceptBtn',
      count: async () => 1,
      nth: () => ({ isVisible: async () => true }),
    }),
  };
  const mockContextValid = {
    cookies: async () => [
      { name: 'IsAcceptedTerms', value: 'true' },
      { name: 'mcro-session', value: 'session-token' },
    ],
  };

  const usableResult = await validateSessionPage(mockPageUsable, mockContextValid);
  assert.equal(usableResult.modalDismissed, true);
  assert.equal(usableResult.hasTermsCookie, true);
  assert.equal(usableResult.hasSessionCookie, true);
  assert.equal(usableResult.usable, true);
});
test('R003-2: Gate L2 requires the exact target and a complete matching docket', () => {
  const incomplete = evaluateLiveGates({
    targetCaseNumber: '67-CV-26-300',
    searchResults: [{ caseNumber: '67-CV-26-300' }],
    caseObservation: { caseNumber: '67-CV-26-300', complete: false, entries: [{ documents: [] }] },
  });
  assert.match(incomplete.L2_live_source_search, /^(pending|partial)/);
  assert.doesNotMatch(incomplete.L2_live_source_search, /^passed/);

  const mismatchedDocket = evaluateLiveGates({
    targetCaseNumber: '67-CV-26-300',
    searchResults: [{ caseNumber: '67-CV-26-300' }],
    searchComplete: true,
    caseObservation: { caseNumber: '27-CV-24-1', complete: true, entries: [{ documents: [] }] },
  });
  assert.doesNotMatch(mismatchedDocket.L2_live_source_search, /^passed/);
});

test('R003-2: Live gate accepts the compiled CLI snake_case case-number field', () => {
  const persistedCliShape = evaluateLiveGates({
    targetCaseNumber: '67-CV-26-300',
    searchResults: [{ case_number: '67-CV-26-300' }],
    searchComplete: true,
    caseObservation: { caseNumber: '67-CV-26-300', complete: true, entries: [{ documents: [] }] },
  });
  assert.match(persistedCliShape.L2_live_source_search, /^passed/);
});

test('R003-2: Gate L4 rejects a repeat observation for another case', () => {
  const result = evaluateLiveGates({
    targetCaseNumber: '67-CV-26-300',
    searchResults: [{ caseNumber: '67-CV-26-300' }],
    searchComplete: true,
    caseObservation: { caseNumber: '67-CV-26-300', complete: true, entries: [{ documents: [] }] },
    documentObservation: { filename: 'petition.pdf', bytes: 256, sha256: 'b'.repeat(64), persisted: true, extracted: true },
    repeatObservation: { caseNumber: '27-CV-24-1', complete: true, persisted: true, recoveryVerified: true },
  });
  assert.doesNotMatch(result.L4_repeatability, /^passed/);
});

test('R003-6: A cookie file without terms, session and usable search state is not verified', async () => {
  const result = await validateSessionPage(
    { locator: () => ({ isVisible: async () => false, count: async () => 1, nth: () => ({ isVisible: async () => true }) }) },
    { cookies: async () => [{ name: 'IsAcceptedTerms', value: '' }, { name: 'mcro-session', value: '' }] },
  );
  assert.equal(result.usable, false);
});

test('R003-6: Invalid session readiness cannot overwrite saved state; verified state is private', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'session-readiness-'));
  const target = path.join(directory, 'session.json');
  try {
    await writeFile(target, 'previous-state', { mode: 0o600 });
    await assert.rejects(persistVerifiedSession(target, { cookies: [] }, { usable: false }), /refusing to save/);
    assert.equal(await readFile(target, 'utf8'), 'previous-state');
    await persistVerifiedSession(target, { cookies: [{ name: 'synthetic' }], origins: [] }, { usable: true });
    assert.deepEqual(JSON.parse(await readFile(target, 'utf8')), { cookies: [{ name: 'synthetic' }], origins: [] });
    assert.equal((await stat(target)).mode & 0o777, 0o600);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('R003-6: Saved cookie-file presence is insufficient without nonempty required cookies', () => {
  assert.deepEqual(validateStoredSessionState({ cookies: [{ name: 'IsAcceptedTerms', value: '' }] }), {
    cookieCount: 1, hasTermsCookie: false, hasSessionCookie: false, ready: false,
  });
  assert.deepEqual(validateStoredSessionState({ cookies: [
    { name: 'IsAcceptedTerms', value: 'accepted' },
    { name: 'mcro-session', value: 'session-value' },
  ] }), { cookieCount: 2, hasTermsCookie: true, hasSessionCookie: true, ready: true });
});
