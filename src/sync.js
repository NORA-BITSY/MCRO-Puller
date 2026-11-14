import fs from 'node:fs';
import path from 'node:path';
import { CONFIG } from './config.js';
import { loadState, saveState } from './crawler.js';
import { searchByCaseNumber } from './search.js';
import { navigateToCaseDetails } from './roa.js';
import { downloadAllCaseDocuments } from './downloader.js';
import { sleepJitter, normalizeCaseNumber } from './waf.js';

/**
 * Check and incrementally update a single case.
 * Only downloads newly filed documents since the last sync.
 */
export async function syncCase(browserClient, caseNumber, options = {}) {
  const normCase = normalizeCaseNumber(caseNumber);
  console.log(`\n[Sync] Checking case for updates: ${normCase}...`);

  const page = browserClient.page;
  const state = loadState();
  const existingRecord = state.pulledCases[normCase] || null;

  // Search case to get ROA
  const searchResult = await searchByCaseNumber(page, normCase);
  if (!searchResult.cases || searchResult.cases.length === 0) {
    console.warn(`[Sync] Case ${normCase} not found in search results.`);
    return { updated: false, reason: 'not_found' };
  }

  const caseItem = searchResult.cases[0];
  const roaData = await navigateToCaseDetails(page, caseItem);

  const availableDocCount = roaData.documentEventsCount;
  const prevDownloaded = existingRecord ? existingRecord.downloadedCount || 0 : 0;

  console.log(`[Sync] Case ${normCase}: ${availableDocCount} online docs vs ${prevDownloaded} previously downloaded.`);

  if (existingRecord && availableDocCount <= prevDownloaded && !options.force) {
    console.log(`  ✓ [Up to date] No new documents found for ${normCase}.`);
    // Touch timestamp
    existingRecord.lastCheckedAt = new Date().toISOString();
    saveState(state);
    return { updated: false, newDocs: 0 };
  }

  // New documents exist! Run delta download (already existing files are skipped automatically)
  console.log(`  ⚡ [Update Found] Downloading new documents for ${normCase}...`);
  const downloadSummary = await downloadAllCaseDocuments(page, roaData, {
    ...options,
    force: false, // ensures already downloaded files are skipped!
  });

  state.pulledCases[normCase] = {
    status: downloadSummary.failures.length === 0 ? 'complete' : 'partial',
    caseTitle: roaData.caseInfo.caseTitle,
    caseType: roaData.caseInfo.caseType,
    dateFiled: roaData.caseInfo.dateFiled,
    totalDocuments: downloadSummary.totalDocuments,
    downloadedCount: (existingRecord?.downloadedCount || 0) + downloadSummary.downloaded.length,
    skippedCount: downloadSummary.skipped.length,
    failureCount: downloadSummary.failures.length,
    lastRunAt: new Date().toISOString(),
    lastCheckedAt: new Date().toISOString(),
  };
  saveState(state);

  return {
    updated: downloadSummary.downloaded.length > 0,
    newDocs: downloadSummary.downloaded.length,
    summary: downloadSummary,
  };
}

/**
 * Sync all known active cases in state.json.
 */
export async function syncAllActiveCases(browserClient, options = {}) {
  const state = loadState();
  const caseNumbers = Object.keys(state.pulledCases || {});
  console.log(`\n======================================================`);
  console.log(`[Sync Manager] Starting daily sync of ${caseNumbers.length} tracked case(s)...`);
  console.log(`======================================================`);

  let updatedCount = 0;
  let upToDateCount = 0;
  let failedCount = 0;

  for (let i = 0; i < caseNumbers.length; i++) {
    const caseNo = caseNumbers[i];
    console.log(`\n--- Syncing [${i + 1}/${caseNumbers.length}]: ${caseNo} ---`);

    try {
      const res = await syncCase(browserClient, caseNo, options);
      if (res.updated) {
        updatedCount++;
        console.log(`  ✓ Case ${caseNo} updated with ${res.newDocs} new document(s).`);
      } else {
        upToDateCount++;
      }
    } catch (err) {
      failedCount++;
      console.error(`  ✗ Error syncing ${caseNo}: ${err.message}`);
    }

    if (i < caseNumbers.length - 1) {
      const jitter = await sleepJitter();
      console.log(`[WAF Safe] Pausing ${Math.round(jitter / 1000)}s before next case...`);
    }
  }

  console.log(`\n======================================================`);
  console.log(`[Sync Manager] Sync finished: ${updatedCount} updated, ${upToDateCount} unchanged, ${failedCount} errors.`);
  console.log(`======================================================`);
}
