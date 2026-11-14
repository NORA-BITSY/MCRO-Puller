import fs from 'node:fs';
import path from 'node:path';
import { CONFIG } from './config.js';
import { searchByCaseNumber, searchByPartyName, searchByAttorney } from './search.js';
import { navigateToCaseDetails } from './roa.js';
import { downloadAllCaseDocuments } from './downloader.js';
import { sleepJitter, normalizeCaseNumber } from './waf.js';

/**
 * Load or initialize global state.json tracking all pulled cases.
 */
export function loadState(filePath = CONFIG.stateFile) {
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    }
  } catch (e) {
    // start fresh
  }
  return {
    version: '1.0.0',
    updatedAt: new Date().toISOString(),
    pulledCases: {},
  };
}

/**
 * Save global state.json atomically.
 */
export function saveState(state, filePath = CONFIG.stateFile) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  state.updatedAt = new Date().toISOString();
  fs.writeFileSync(filePath, JSON.stringify(state, null, 2), 'utf-8');
}

/**
 * Crawl a single case by case number.
 */
export async function crawlCase(browserClient, caseNumber, options = {}) {
  const normCase = normalizeCaseNumber(caseNumber);
  console.log(`\n======================================================`);
  console.log(`[Crawler] Starting crawl for case: ${normCase}`);
  console.log(`======================================================`);

  const page = browserClient.page;
  const searchResult = await searchByCaseNumber(page, normCase);

  if (!searchResult.cases || searchResult.cases.length === 0) {
    console.warn(`[Crawler] Case ${normCase} not found in MCRO search results.`);
    return { success: false, reason: 'Case not found' };
  }

  const caseItem = searchResult.cases[0];
  const roaData = await navigateToCaseDetails(page, caseItem);

  const downloadSummary = await downloadAllCaseDocuments(page, roaData, options);

  // Update state
  const state = loadState();
  state.pulledCases[normCase] = {
    status: downloadSummary.failures.length === 0 ? 'complete' : 'partial',
    caseTitle: roaData.caseInfo.caseTitle,
    caseType: roaData.caseInfo.caseType,
    dateFiled: roaData.caseInfo.dateFiled,
    totalDocuments: downloadSummary.totalDocuments,
    downloadedCount: downloadSummary.downloaded.length,
    skippedCount: downloadSummary.skipped.length,
    failureCount: downloadSummary.failures.length,
    lastRunAt: new Date().toISOString(),
  };
  saveState(state);

  return {
    success: true,
    caseNumber: normCase,
    summary: downloadSummary,
  };
}

/**
 * Autonomous crawl across a party name search.
 */
export async function crawlParty(browserClient, partyOptions, options = {}) {
  const page = browserClient.page;
  console.log(`\n[Crawler] Initiating party search crawl...`);
  const searchResult = await searchByPartyName(page, partyOptions);

  const cases = searchResult.cases || [];
  const limit = options.limit || cases.length;
  const targetCases = cases.slice(0, limit);

  console.log(`[Crawler] Found ${cases.length} cases; processing ${targetCases.length} (limit: ${limit})...`);

  const crawlResults = [];
  const state = loadState();

  for (let i = 0; i < targetCases.length; i++) {
    const c = targetCases[i];
    console.log(`\n------------------------------------------------------`);
    console.log(`[Crawler] Processing Case [${i + 1}/${targetCases.length}]: ${c.caseNumber} ("${c.caseTitle}")`);
    console.log(`------------------------------------------------------`);

    // Check if case is already fully pulled
    if (state.pulledCases[c.caseNumber] && state.pulledCases[c.caseNumber].status === 'complete' && !options.force) {
      console.log(`[Crawler] Case ${c.caseNumber} already completed in state.json; skipping...`);
      crawlResults.push({ caseNumber: c.caseNumber, skipped: true });
      continue;
    }

    try {
      // Re-enter search or direct navigate to ROA
      const roaData = await navigateToCaseDetails(page, c);
      const summary = await downloadAllCaseDocuments(page, roaData, options);

      state.pulledCases[c.caseNumber] = {
        status: summary.failures.length === 0 ? 'complete' : 'partial',
        caseTitle: roaData.caseInfo.caseTitle,
        caseType: roaData.caseInfo.caseType,
        dateFiled: roaData.caseInfo.dateFiled,
        totalDocuments: summary.totalDocuments,
        downloadedCount: summary.downloaded.length,
        skippedCount: summary.skipped.length,
        failureCount: summary.failures.length,
        lastRunAt: new Date().toISOString(),
      };
      saveState(state);

      crawlResults.push({ caseNumber: c.caseNumber, summary });
    } catch (err) {
      console.error(`[Crawler] Error processing case ${c.caseNumber}: ${err.message}`);
      crawlResults.push({ caseNumber: c.caseNumber, error: err.message });
    }

    // Humanized jitter pause before returning to search for the next case
    if (i < targetCases.length - 1) {
      const delay = await sleepJitter();
      console.log(`[WAF Safe] Pausing ${Math.round(delay / 1000)}s between cases...`);
    }
  }

  return crawlResults;
}

/**
 * Autonomous crawl across an attorney search.
 */
export async function crawlAttorney(browserClient, attorneyOptions, options = {}) {
  const page = browserClient.page;
  console.log(`\n[Crawler] Initiating attorney search crawl...`);
  const searchResult = await searchByAttorney(page, attorneyOptions);

  const cases = searchResult.cases || [];
  const limit = options.limit || cases.length;
  const targetCases = cases.slice(0, limit);

  console.log(`[Crawler] Found ${cases.length} cases; processing ${targetCases.length}...`);

  const crawlResults = [];
  const state = loadState();

  for (let i = 0; i < targetCases.length; i++) {
    const c = targetCases[i];
    console.log(`\n[Crawler Attorney] Case [${i + 1}/${targetCases.length}]: ${c.caseNumber}`);

    if (state.pulledCases[c.caseNumber] && state.pulledCases[c.caseNumber].status === 'complete' && !options.force) {
      console.log(`[Crawler] Case ${c.caseNumber} already completed; skipping...`);
      crawlResults.push({ caseNumber: c.caseNumber, skipped: true });
      continue;
    }

    try {
      const roaData = await navigateToCaseDetails(page, c);
      const summary = await downloadAllCaseDocuments(page, roaData, options);

      state.pulledCases[c.caseNumber] = {
        status: summary.failures.length === 0 ? 'complete' : 'partial',
        caseTitle: roaData.caseInfo.caseTitle,
        caseType: roaData.caseInfo.caseType,
        dateFiled: roaData.caseInfo.dateFiled,
        totalDocuments: summary.totalDocuments,
        downloadedCount: summary.downloaded.length,
        skippedCount: summary.skipped.length,
        failureCount: summary.failures.length,
        lastRunAt: new Date().toISOString(),
      };
      saveState(state);

      crawlResults.push({ caseNumber: c.caseNumber, summary });
    } catch (err) {
      console.error(`[Crawler] Error processing case ${c.caseNumber}: ${err.message}`);
      crawlResults.push({ caseNumber: c.caseNumber, error: err.message });
    }

    if (i < targetCases.length - 1) {
      const delay = await sleepJitter();
      console.log(`[WAF Safe] Pausing ${Math.round(delay / 1000)}s between cases...`);
    }
  }

  return crawlResults;
}
