import { searchByCaseNumber } from './search.js';
import { navigateToCaseDetails } from './roa.js';
import { downloadAllCaseDocuments } from './downloader.js';
import { resolveCaseOutputDir } from './crawler.js';
import { buildCaseStateRecord, loadState, updateState } from './state.js';
import { caseNumbersEqual, sleepJitter, normalizeCaseNumber } from './waf.js';

/**
 * Check and incrementally update a single case.
 * Only downloads newly filed documents since the last sync.
 */
export async function syncCase(browserClient, caseNumber, options = {}) {
  const normCase = normalizeCaseNumber(caseNumber);
  console.log(`\n[Sync] Checking case for updates: ${normCase}...`);

  const page = browserClient.page;
  const searchResult = await searchByCaseNumber(page, normCase);
  if (!searchResult.cases || searchResult.cases.length === 0) {
    console.warn(`[Sync] Case ${normCase} not found in search results.`);
    return { updated: false, reason: 'not_found' };
  }

  const caseItem = searchResult.cases.find((item) => caseNumbersEqual(item.caseNumber, normCase));
  if (!caseItem) {
    throw new Error(`Search returned results but no exact case-number match for ${normCase}`);
  }

  const roaData = await navigateToCaseDetails(page, caseItem);
  const canonicalCase = roaData.caseInfo.caseNumber || caseItem.caseNumber;
  console.log(`[Sync] Verifying ${roaData.documentEventsCount} public document(s) for ${canonicalCase}.`);

  const downloadSummary = await downloadAllCaseDocuments(page, roaData, {
    ...options,
    outputDir: resolveCaseOutputDir(canonicalCase, options),
    force: false,
  });

  await updateState((state) => {
    const previous = state.pulledCases[canonicalCase] || state.pulledCases[normCase] || {};
    state.pulledCases[canonicalCase] = buildCaseStateRecord(roaData, downloadSummary, previous);
    if (canonicalCase !== normCase) delete state.pulledCases[normCase];
  }, options.stateFile);

  return {
    updated: downloadSummary.downloaded.length > 0,
    newDocs: downloadSummary.downloaded.length,
    verifiedDocs: downloadSummary.documents.length,
    summary: downloadSummary,
  };
}

/**
 * Sync all known active cases in state.json.
 */
export async function syncAllActiveCases(browserClient, options = {}) {
  const state = loadState(options.stateFile);
  const entries = Object.entries(state.pulledCases || {});
  const activeEntries = entries.filter(([, record]) => {
    if (!record.caseStatus) return true;
    return /active|open/i.test(record.caseStatus);
  });
  const caseNumbers = activeEntries.map(([caseNumber]) => caseNumber);

  console.log(`\n======================================================`);
  console.log(`[Sync Manager] Starting sync of ${caseNumbers.length} active or legacy-unclassified case(s)...`);
  console.log(`======================================================`);

  let updatedCount = 0;
  let upToDateCount = 0;
  let failedCount = 0;

  for (let i = 0; i < caseNumbers.length; i++) {
    const caseNo = caseNumbers[i];
    console.log(`\n--- Syncing [${i + 1}/${caseNumbers.length}]: ${caseNo} ---`);

    try {
      const result = await syncCase(browserClient, caseNo, options);
      if (result.updated) {
        updatedCount++;
        console.log(`  ✓ Case ${caseNo} updated with ${result.newDocs} new or repaired document(s).`);
      } else {
        upToDateCount++;
      }
    } catch (error) {
      failedCount++;
      console.error(`  ✗ Error syncing ${caseNo}: ${error.message}`);
      if (error.message.includes('[WAF BLOCKED]')) throw error;
    }

    if (i < caseNumbers.length - 1) {
      const jitter = await sleepJitter();
      console.log(`[Rate Limit] Pausing ${Math.round(jitter / 1000)}s before next case...`);
    }
  }

  const summary = { total: caseNumbers.length, updatedCount, upToDateCount, failedCount };
  console.log(`\n======================================================`);
  console.log(`[Sync Manager] Sync finished: ${updatedCount} updated, ${upToDateCount} unchanged, ${failedCount} errors.`);
  console.log(`======================================================`);

  if (failedCount > 0) {
    const error = new Error(`${failedCount} case sync(s) failed; the run is incomplete`);
    error.summary = summary;
    throw error;
  }
  return summary;
}
