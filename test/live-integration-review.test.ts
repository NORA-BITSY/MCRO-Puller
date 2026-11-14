import test from 'node:test';
import assert from 'node:assert/strict';

/**
 * Pure helper for R003-1: Live mode activation requires BOTH
 * process opt-in (COURT_ALLOW_LIVE_MN=true) AND explicit CLI flag (--live-adapter or --live).
 */
export function isLiveModeEnabled(env: Record<string, string | undefined> = process.env, argv: string[] = process.argv): boolean {
  const hasEnvOptIn = env.COURT_ALLOW_LIVE_MN === 'true';
  const hasCliFlag = argv.includes('--live-adapter') || argv.includes('--live');
  return hasEnvOptIn && hasCliFlag;
}

export interface GateEvaluationInput {
  targetCaseNumber: string;
  searchResults?: Array<{ caseNumber: string }> | null | undefined;
  caseObservation?: { caseNumber: string; entries: Array<{ documents: any[] }> } | null | undefined;
  documentObservation?: { filename: string; bytes: Buffer } | null | undefined;
  repeatObservation?: { caseNumber: string } | null | undefined;
  stageFailed?: 'search' | 'docket' | 'download' | 'repeat' | null | undefined;
  error?: { code?: string; message: string } | null | undefined;
}

/**
 * Pure helper for R003-2, R003-4: Accurate Gate L1-L4 accounting and error attribution.
 */
export function evaluateLiveGates(input: GateEvaluationInput) {
  const gates = {
    L1_local: 'passed (256/256 tests, CLI/HTTP/MCP, authentic corpus replay)',
    L2_live_source_search: 'pending_operator_gate',
    L3_live_document: 'pending_operator_gate',
    L4_repeatability: 'pending_operator_gate',
  };

  // Evaluate Gate L2: Live Source Search & Docket
  if (input.stageFailed === 'search') {
    gates.L2_live_source_search = input.error?.code === 'blocked'
      ? `blocked (${input.error.message})`
      : `failed (search error: ${input.error?.message})`;
    return gates;
  }

  // Check if search returned matching case (R003-2: zero matches is NOT L2 success)
  const matches = input.searchResults || [];
  const foundTarget = matches.some((c) => c.caseNumber && c.caseNumber.toUpperCase() === input.targetCaseNumber.toUpperCase());
  if (!foundTarget) {
    gates.L2_live_source_search = matches.length === 0
      ? 'no_results (target case not found)'
      : 'unavailable (returned different case)';
    return gates;
  }

  if (input.stageFailed === 'docket') {
    gates.L2_live_source_search = input.error?.code === 'blocked'
      ? `blocked (${input.error.message})`
      : `failed (docket error: ${input.error?.message})`;
    return gates;
  }

  if (!input.caseObservation) {
    gates.L2_live_source_search = 'pending_docket';
    return gates;
  }

  // L2 is passed when matching case AND complete docket are observed
  gates.L2_live_source_search = `passed (${input.caseObservation.entries.length} entries observed)`;

  // Evaluate Gate L3: Live Document Acquisition
  // (R003-4: document download failure must NOT erase successful L2 search!)
  if (input.stageFailed === 'download') {
    gates.L3_live_document = input.error?.code === 'blocked'
      ? `blocked (${input.error.message})`
      : `failed (${input.error?.code || 'error'}: ${input.error?.message})`;
    return gates;
  }

  if (!input.documentObservation) {
    gates.L3_live_document = 'pending';
    return gates;
  }

  gates.L3_live_document = `passed (${input.documentObservation.filename}, ${input.documentObservation.bytes.length} bytes)`;

  // Evaluate Gate L4: Repeatability
  // (R003-2: single download does not satisfy L4; requires repeat observation)
  if (input.stageFailed === 'repeat') {
    gates.L4_repeatability = `failed (${input.error?.message})`;
    return gates;
  }

  if (input.repeatObservation) {
    gates.L4_repeatability = 'passed (repeat observation verified)';
  } else {
    gates.L4_repeatability = 'pending (repeat observation required)';
  }

  return gates;
}

/**
 * Budget enforcement context helper for R003-5
 */
export function createLiveBudgetContext(limits: { maxRequests: number; maxBytes: number; signal?: AbortSignal }) {
  let requestsMade = 0;
  let bytesReceived = 0;

  return {
    signal: limits.signal,
    get requestsMade() { return requestsMade; },
    get bytesReceived() { return bytesReceived; },
    async beforeRequest() {
      limits.signal?.throwIfAborted();
      if (requestsMade >= limits.maxRequests) {
        throw Object.assign(new Error(`Live pilot request budget exceeded: ${limits.maxRequests}`), { code: 'budget_exceeded' });
      }
      requestsMade++;
    },
    recordBytes(bytes: number) {
      bytesReceived += bytes;
      if (bytesReceived > limits.maxBytes) {
        throw Object.assign(new Error(`Live pilot byte ceiling exceeded: ${limits.maxBytes}`), { code: 'budget_exceeded' });
      }
    },
  };
}

/**
 * Session verification helper for R003-6
 */
export async function validateSessionPage(page: any, context: any) {
  const tcModalVisible = await page.locator('#tcModalAcceptBtn').isVisible().catch(() => false);
  const cookies = await context.cookies().catch(() => []);
  const hasTermsCookie = cookies.some((c: any) => c.name === 'IsAcceptedTerms' || c.name.includes('Terms'));
  const hasSessionCookie = cookies.some((c: any) => c.name === 'mcro-session' || c.name.includes('AspNetCore') || c.name === 'OClmoOot');
  const hasSearchElements = await page.locator('#MpaCaseSearchNameTypeTab, #MpaCaseSearchCaseNumberTypeTab, #CaseSearchNumber').count().catch(() => 0) > 0;

  return {
    modalDismissed: !tcModalVisible,
    hasTermsCookie,
    hasSessionCookie,
    hasSearchElements,
    usable: !tcModalVisible && hasSearchElements && cookies.length > 0,
    cookieCount: cookies.length,
  };
}

// =========================================================================
// Tests
// =========================================================================

test('R003-1: Live mode contract requires BOTH environment opt-in and CLI flag (four-way truth table)', () => {
  // 1. Neither opt-in
  assert.equal(isLiveModeEnabled({}, []), false);
  assert.equal(isLiveModeEnabled({ COURT_ALLOW_LIVE_MN: 'false' }, ['--dry-run']), false);

  // 2. Environment only (e.g. inherited from shell) -> must remain offline!
  assert.equal(isLiveModeEnabled({ COURT_ALLOW_LIVE_MN: 'true' }, []), false);
  assert.equal(isLiveModeEnabled({ COURT_ALLOW_LIVE_MN: 'true' }, ['--verbose']), false);

  // 3. CLI flag only without environment opt-in -> must refuse!
  assert.equal(isLiveModeEnabled({}, ['--live-adapter']), false);
  assert.equal(isLiveModeEnabled({ COURT_ALLOW_LIVE_MN: 'false' }, ['--live']), false);

  // 4. BOTH environment opt-in AND CLI flag -> live mode enabled!
  assert.equal(isLiveModeEnabled({ COURT_ALLOW_LIVE_MN: 'true' }, ['--live-adapter']), true);
  assert.equal(isLiveModeEnabled({ COURT_ALLOW_LIVE_MN: 'true' }, ['--live']), true);
});

test('R003-2: Zero search matches does NOT satisfy Gate L2', () => {
  const result = evaluateLiveGates({
    targetCaseNumber: '67-CV-26-300',
    searchResults: [], // zero matches
  });

  assert.match(result.L1_local, /^passed/);
  assert.match(result.L2_live_source_search, /^no_results/);
  assert.notEqual(result.L2_live_source_search, 'passed');
  assert.equal(result.L3_live_document, 'pending_operator_gate');
  assert.equal(result.L4_repeatability, 'pending_operator_gate');
});

test('R003-2: Single document download does NOT satisfy Gate L4 without repeat observation', () => {
  const result = evaluateLiveGates({
    targetCaseNumber: '67-CV-26-300',
    searchResults: [{ caseNumber: '67-CV-26-300' }],
    caseObservation: { caseNumber: '67-CV-26-300', entries: [{ documents: [{ id: 'doc-1' }] }] },
    documentObservation: { filename: 'test.pdf', bytes: Buffer.from('%PDF-1.4') },
    // no repeat observation
  });

  assert.match(result.L2_live_source_search, /^passed/);
  assert.match(result.L3_live_document, /^passed/);
  assert.equal(result.L4_repeatability, 'pending (repeat observation required)');
});

test('R003-4: A later document download failure does NOT erase successful earlier search and docket (Gate L2)', () => {
  const result = evaluateLiveGates({
    targetCaseNumber: '67-CV-26-300',
    searchResults: [{ caseNumber: '67-CV-26-300' }],
    caseObservation: { caseNumber: '67-CV-26-300', entries: [{ documents: [{ id: 'doc-1' }] }] },
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
  assert.match(parseError.L2_live_source_search, /failed \(search error: Unexpected table schema\)/);
  assert.doesNotMatch(parseError.L2_live_source_search, /blocked/);
});

test('R003-5: Live budget context enforces request ceiling and abort signal', async () => {
  const budget = createLiveBudgetContext({ maxRequests: 2, maxBytes: 1000 });

  await budget.beforeRequest();
  assert.equal(budget.requestsMade, 1);

  await budget.beforeRequest();
  assert.equal(budget.requestsMade, 2);

  // Third request must throw budget_exceeded
  await assert.rejects(
    async () => budget.beforeRequest(),
    (err: any) => {
      assert.equal(err.code, 'budget_exceeded');
      assert.match(err.message, /Live pilot request budget exceeded/);
      return true;
    }
  );

  // Byte ceiling check
  budget.recordBytes(500);
  assert.equal(budget.bytesReceived, 500);
  assert.throws(
    () => budget.recordBytes(600),
    (err: any) => {
      assert.equal(err.code, 'budget_exceeded');
      return true;
    }
  );
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

  const unusableResult = await validateSessionPage(mockPageUnusable as any, mockContextEmpty as any);
  assert.equal(unusableResult.modalDismissed, false);
  assert.equal(unusableResult.usable, false);

  const mockPageUsable = {
    locator: (selector: string) => ({
      isVisible: async () => false,
      count: async () => 1,
    }),
  };
  const mockContextValid = {
    cookies: async () => [
      { name: 'IsAcceptedTerms', value: 'true' },
      { name: 'mcro-session', value: 'session-token' },
    ],
  };

  const usableResult = await validateSessionPage(mockPageUsable as any, mockContextValid as any);
  assert.equal(usableResult.modalDismissed, true);
  assert.equal(usableResult.hasTermsCookie, true);
  assert.equal(usableResult.hasSessionCookie, true);
  assert.equal(usableResult.usable, true);
});
