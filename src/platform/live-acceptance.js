import { randomUUID } from 'node:crypto';
import { mkdir, open, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { caseNumbersEqual } from '../waf.js';

export function evaluateLiveGates(input) {
  const gates = {
    L1_local: 'not evaluated in this live run',
    L2_live_source_search: 'pending_operator_gate',
    L3_live_document: 'pending_operator_gate',
    L4_repeatability: 'pending_operator_gate',
  };
  const failure = (stage) => input.error?.code === 'blocked'
    ? `blocked (${input.error.message})`
    : `failed (${input.error?.code || 'error'}: ${input.error?.message || `${stage} failed`})`;

  if (input.stageFailed === 'search') {
    gates.L2_live_source_search = failure('search');
    return gates;
  }

  const matches = input.searchResults || [];
  const foundTarget = matches.some((candidate) => caseNumbersEqual(candidate.caseNumber ?? candidate.case_number, input.targetCaseNumber));
  if (!foundTarget) {
    gates.L2_live_source_search = matches.length === 0
      ? 'no_results (target case not found)'
      : 'unavailable (returned different case)';
    return gates;
  }
  if (input.searchComplete !== true) {
    gates.L2_live_source_search = 'partial (search observation incomplete or truncated)';
    return gates;
  }
  if (input.stageFailed === 'docket') {
    gates.L2_live_source_search = failure('docket');
    return gates;
  }
  const observation = input.caseObservation;
  if (!observation) {
    gates.L2_live_source_search = 'pending_docket';
    return gates;
  }
  if (!caseNumbersEqual(observation.caseNumber, input.targetCaseNumber)) {
    gates.L2_live_source_search = 'unavailable (docket identity does not match target)';
    return gates;
  }
  if (observation.complete !== true) {
    gates.L2_live_source_search = `partial (${observation.entries?.length || 0} entries; docket not complete)`;
    return gates;
  }
  gates.L2_live_source_search = `passed (${observation.entries.length} complete docket entries observed)`;

  if (input.stageFailed === 'download' || input.stageFailed === 'extraction') {
    gates.L3_live_document = failure(input.stageFailed);
    return gates;
  }
  const document = input.documentObservation;
  if (!document) {
    gates.L3_live_document = 'pending (durable acquisition and extraction required)';
    return gates;
  }
  if (document.persisted !== true || document.extracted !== true || document.bytes <= 0 || !document.sha256) {
    gates.L3_live_document = 'partial (artifact persistence, integrity, or extraction not verified)';
    return gates;
  }
  gates.L3_live_document = `passed (${document.filename}, ${document.bytes} bytes, persisted and extracted)`;

  if (input.stageFailed === 'repeat') {
    gates.L4_repeatability = failure('repeat');
    return gates;
  }
  const repeat = input.repeatObservation;
  if (!repeat) {
    gates.L4_repeatability = 'pending (repeat observation required)';
  } else if (!caseNumbersEqual(repeat.caseNumber, input.targetCaseNumber) || repeat.complete !== true || repeat.persisted !== true || repeat.recoveryVerified !== true) {
    gates.L4_repeatability = 'partial (matching persisted repeat observation and recovery proof required)';
  } else {
    gates.L4_repeatability = 'passed (matching repeat observation persisted and recovery verified)';
  }
  return gates;
}

export async function validateSessionPage(page, context) {
  let modalVisible = true;
  let cookies = [];
  let searchElementsVisible = false;
  try { modalVisible = await page.locator('#tcModalAcceptBtn').isVisible(); } catch {}
  try { cookies = await context.cookies(); } catch {}
  try {
    const searchElements = page.locator('#MpaCaseSearchNameTypeTab, #MpaCaseSearchCaseNumberTypeTab, #CaseSearchNumber');
    const count = await searchElements.count();
    for (let index = 0; index < count; index++) {
      if (await searchElements.nth(index).isVisible()) {
        searchElementsVisible = true;
        break;
      }
    }
  } catch {}
  const hasTermsCookie = cookies.some((cookie) => (cookie.name === 'IsAcceptedTerms' || cookie.name.includes('Terms')) && typeof cookie.value === 'string' && cookie.value.length > 0);
  const hasSessionCookie = cookies.some((cookie) => (cookie.name === 'mcro-session' || cookie.name.includes('AspNetCore') || cookie.name === 'OClmoOot') && typeof cookie.value === 'string' && cookie.value.length > 0);
  return {
    modalDismissed: !modalVisible,
    hasTermsCookie,
    hasSessionCookie,
    hasSearchElements: searchElementsVisible,
    usable: !modalVisible && hasTermsCookie && hasSessionCookie && searchElementsVisible,
    cookieCount: cookies.length,
  };
}

export function validateStoredSessionState(state) {
  const cookies = state && typeof state === 'object' && Array.isArray(state.cookies) ? state.cookies : [];
  const hasTermsCookie = cookies.some((cookie) => cookie && (cookie.name === 'IsAcceptedTerms' || typeof cookie.name === 'string' && cookie.name.includes('Terms')) && typeof cookie.value === 'string' && cookie.value.length > 0);
  const hasSessionCookie = cookies.some((cookie) => cookie && (cookie.name === 'mcro-session' || typeof cookie.name === 'string' && cookie.name.includes('AspNetCore') || cookie.name === 'OClmoOot') && typeof cookie.value === 'string' && cookie.value.length > 0);
  return { cookieCount: cookies.length, hasTermsCookie, hasSessionCookie, ready: hasTermsCookie && hasSessionCookie };
}

export async function persistVerifiedSession(targetPath, storageState, validation) {
  if (validation?.usable !== true) throw new Error('Session is not verified usable; refusing to save browser state');
  const directory = path.dirname(targetPath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporaryPath = path.join(directory, `.${path.basename(targetPath)}.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temporaryPath, 'wx', 0o600);
    await handle.writeFile(JSON.stringify(storageState, null, 2), 'utf8');
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, targetPath);
  } catch (error) {
    await handle?.close().catch(() => {});
    await unlink(temporaryPath).catch(() => {});
    throw error;
  }
}
