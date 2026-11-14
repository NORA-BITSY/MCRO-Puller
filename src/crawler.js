import path from 'node:path';
import { CONFIG } from './config.js';
import { executeSearch } from './search.js';
import { navigateToCaseDetails } from './roa.js';
import { downloadAllCaseDocuments, safeCaseNumber } from './downloader.js';
import { buildCaseStateRecord, loadState, updateState } from './state.js';
import { caseNumbersEqual, sleepJitter, normalizeCaseNumber } from './waf.js';

export function resolveCaseOutputDir(caseNumber, options = {}) {
  const safeCase = safeCaseNumber(caseNumber);
  if (options.caseOutputDir) return path.resolve(options.caseOutputDir);
  return path.resolve(options.outputDir || CONFIG.outputDir, safeCase);
}

export function assertExactCase(roaData, requestedCase) {
  const actual = roaData.caseInfo?.caseNumber;
  if (!actual || !caseNumbersEqual(actual, requestedCase)) {
    const error = new Error(`ROA case-number mismatch: expected exact ${requestedCase}; received ${actual || 'missing case number'}`);
    error.code = 'parse_error';
    throw error;
  }
  return safeCaseNumber(actual);
}

async function recordCaseResult(caseNumber, roaData, summary, stateFile) {
  await updateState((state) => {
    const previous = state.pulledCases[caseNumber] || {};
    state.pulledCases[caseNumber] = buildCaseStateRecord(roaData, summary, previous);
  }, stateFile);
}

async function acquireCase(page, caseItem, options) {
  const roaData = await navigateToCaseDetails(page, caseItem);
  const caseNumber = assertExactCase(roaData, caseItem.caseNumber);
  try {
    const summary = await downloadAllCaseDocuments(page, roaData, { ...options, outputDir: resolveCaseOutputDir(caseNumber, options) });
    await recordCaseResult(caseNumber, roaData, summary, options.stateFile);
    return {
      success: summary.status === 'complete', status: summary.status, caseNumber, summary,
      ...(summary.status !== 'complete' ? { reason: summary.error?.message || `Acquisition ${summary.status}`, code: summary.status } : {}),
    };
  } catch (error) {
    if (error.summary) await recordCaseResult(caseNumber, roaData, error.summary, options.stateFile);
    throw error;
  }
}

/** Crawl exactly the requested case; partial acquisition is never a success. */
export async function crawlCase(browserClient, caseNumber, options = {}) {
  const normCase = safeCaseNumber(caseNumber);
  const searchResult = await executeSearch(browserClient.page, { searchType: 'case', caseNumber: normCase });
  if (!searchResult.cases?.length) {
    await updateState((state) => {
      state.pulledCases[normCase] = { ...state.pulledCases[normCase], status: 'not_found', lastRunAt: new Date().toISOString() };
    }, options.stateFile);
    return { success: false, status: 'not_found', reason: 'Case not found', caseNumber: normCase };
  }
  const caseItem = searchResult.cases.find((item) => caseNumbersEqual(item.caseNumber, normCase));
  if (!caseItem) return { success: false, status: 'error', code: 'parse_error', reason: `No exact case-number match for ${normCase}` };
  return acquireCase(browserClient.page, caseItem, options);
}

async function crawlSearchResults(page, searchResult, options) {
  const cases = searchResult.cases || [];
  const targetCases = cases.slice(0, options.limit ?? cases.length);
  const state = loadState(options.stateFile);
  const results = [];
  for (let index = 0; index < targetCases.length; index++) {
    const candidate = targetCases[index];
    const caseNumber = normalizeCaseNumber(candidate.caseNumber);
    if (state.pulledCases[caseNumber]?.status === 'complete' && !options.force) {
      results.push({ caseNumber, success: true, status: 'complete', skipped: true });
      continue;
    }
    try {
      const result = await acquireCase(page, candidate, options);
      results.push(result);
      if (result.status === 'blocked') {
        results.push(...targetCases.slice(index + 1).map((pending) => ({ caseNumber: pending.caseNumber, success: false, status: 'pending', reason: 'Source blocked; not attempted' })));
        break;
      }
    } catch (error) {
      results.push({ caseNumber, success: false, status: error.code === 'blocked' ? 'blocked' : 'error', code: error.code || 'error', error: error.message });
      if (error.code === 'blocked') {
        results.push(...targetCases.slice(index + 1).map((pending) => ({ caseNumber: pending.caseNumber, success: false, status: 'pending', reason: 'Source blocked; not attempted' })));
        break;
      }
    }
    if (index < targetCases.length - 1) await sleepJitter();
  }
  return results;
}

export async function crawlParty(browserClient, partyOptions, options = {}) {
  return crawlSearchResults(browserClient.page, await executeSearch(browserClient.page, { ...partyOptions, searchType: 'party' }), options);
}

export async function crawlAttorney(browserClient, attorneyOptions, options = {}) {
  return crawlSearchResults(browserClient.page, await executeSearch(browserClient.page, { ...attorneyOptions, searchType: 'attorney' }), options);
}
