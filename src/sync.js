import { executeSearch } from './search.js';
import { navigateToCaseDetails } from './roa.js';
import { downloadAllCaseDocuments, safeCaseNumber } from './downloader.js';
import { assertExactCase, resolveCaseOutputDir } from './crawler.js';
import { buildCaseStateRecord, loadState, normalizeCaseStatus, updateState } from './state.js';
import { caseNumbersEqual, sleepJitter } from './waf.js';

/** Refresh every observed docket row, and acquire only missing or corrupt artifacts. */
export async function syncCase(browserClient, caseNumber, options = {}) {
  const normCase = safeCaseNumber(caseNumber);
  const searchResult = await executeSearch(browserClient.page, { searchType: 'case', caseNumber: normCase });
  if (!searchResult.cases?.length) {
    await updateState((state) => {
      state.pulledCases[normCase] = { ...state.pulledCases[normCase], status: 'not_found', lastRunAt: new Date().toISOString() };
    }, options.stateFile);
    return { success: false, updated: false, status: 'not_found', reason: 'not_found' };
  }
  const candidate = searchResult.cases.find((item) => caseNumbersEqual(item.caseNumber, normCase));
  if (!candidate) {
    const error = new Error(`Search returned results but no exact case-number match for ${normCase}`);
    error.code = 'parse_error';
    throw error;
  }
  const roaData = await navigateToCaseDetails(browserClient.page, candidate);
  const canonicalCase = assertExactCase(roaData, normCase);
  const record = async (summary) => updateState((state) => {
    const previous = state.pulledCases[canonicalCase] || state.pulledCases[normCase] || {};
    state.pulledCases[canonicalCase] = buildCaseStateRecord(roaData, summary, previous);
    if (canonicalCase !== normCase) delete state.pulledCases[normCase];
  }, options.stateFile);
  let summary;
  try {
    summary = await downloadAllCaseDocuments(browserClient.page, roaData, { ...options, outputDir: resolveCaseOutputDir(canonicalCase, options), force: false });
  } catch (error) {
    if (error.summary) await record(error.summary);
    throw error;
  }
  await record(summary);
  return { success: summary.status === 'complete', status: summary.status, updated: summary.downloaded.length > 0,
    newDocs: summary.downloaded.length, verifiedDocs: summary.documents.length, summary };
}

/** Unknown legacy statuses may refresh; Inactive/Closed never match Active by substring. */
export async function syncAllActiveCases(browserClient, options = {}) {
  const state = loadState(options.stateFile);
  const cases = Object.entries(state.pulledCases || {}).filter(([, record]) => ['active', 'unknown'].includes(normalizeCaseStatus(record.caseStatus))).map(([caseNumber]) => caseNumber);
  const summary = { total: cases.length, updatedCount: 0, upToDateCount: 0, failedCount: 0, status: 'complete', pending: [], results: [] };
  const synchronize = options.syncCase || syncCase;
  for (let index = 0; index < cases.length; index++) {
    const caseNumber = cases[index];
    try {
      const result = await synchronize(browserClient, caseNumber, options);
      summary.results.push({ caseNumber, ...result });
      const complete = result.status === 'complete' || (!result.status && !result.reason && result.success !== false);
      if (!complete) {
        summary.failedCount++;
        summary.pending = cases.slice(index);
        break;
      } else if (result.updated) summary.updatedCount++;
      else summary.upToDateCount++;
    } catch (error) {
      summary.failedCount++;
      summary.results.push({ caseNumber, status: 'error', error: error.message });
      summary.pending = cases.slice(index);
      break;
    }
    if (index < cases.length - 1) await sleepJitter();
  }
  if (summary.failedCount) {
    if (summary.status !== 'blocked') summary.status = 'partial';
    const error = new Error(`${summary.failedCount} case sync(s) failed; the run is ${summary.status}`);
    error.code = summary.status;
    error.summary = summary;
    throw error;
  }
  return summary;
}
