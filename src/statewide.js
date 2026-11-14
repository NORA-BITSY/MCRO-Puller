import { CONFIG } from './config.js';
import { COUNTIES } from './counties.js';
import { searchCases } from './search.js';
import { crawlCase } from './crawler.js';
import { loadState } from './state.js';
import { sleepJitter } from './waf.js';

export const CASE_CATEGORIES = [
  { code: 'CV', name: 'Civil' },
  { code: 'CR', name: 'Criminal' },
  { code: 'FAM', name: 'Family' },
  { code: 'PR', name: 'Probate/Mental Health' },
];

/**
 * Generate county/category/date slices. Capped slices are bisected later.
 */
export function generatePartitions(options = {}) {
  const {
    counties = COUNTIES.map((c) => c.name),
    categories = ['CV', 'CR', 'FAM', 'PR'],
    dateFrom = '',
    dateTo = '',
    status = '1', // 1 = Active
  } = options;

  const partitions = [];
  const targetCounties = Array.isArray(counties) ? counties : [counties];
  const targetCategories = Array.isArray(categories) ? categories : [categories];

  for (const cty of targetCounties) {
    for (const cat of targetCategories) {
      partitions.push({
        county: cty,
        category: cat,
        filedDateFrom: dateFrom,
        filedDateTo: dateTo,
        caseStatus: status,
      });
    }
  }

  return partitions;
}
function parseDate(value) {
  if (!value) return null;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatDate(date) {
  return date.toISOString().slice(0, 10);
}

export async function discoverPartition(page, partition, maxCasesPerSlice = 200, search = searchCases) {
  const result = await search(page, {
    counties: [partition.county],
    categories: [partition.category],
    caseStatus: partition.caseStatus,
    filedDateFrom: partition.filedDateFrom,
    filedDateTo: partition.filedDateTo,
    filedDateExact: false,
  });

  if (!result.truncated && result.cases.length < maxCasesPerSlice) return result.cases;

  const start = parseDate(partition.filedDateFrom);
  const end = parseDate(partition.filedDateTo);
  if (!start || !end || start >= end) {
    throw new Error(
      `Partition remains capped at ${result.cases.length} results and cannot be split further: ` +
      `${partition.county}/${partition.category}/${partition.filedDateFrom || 'open'}-${partition.filedDateTo || 'open'}`
    );
  }

  const midpoint = new Date(start.getTime() + Math.floor((end.getTime() - start.getTime()) / 2));
  const rightStart = new Date(midpoint.getTime() + 24 * 60 * 60 * 1000);
  const left = await discoverPartition(page, {
    ...partition,
    filedDateTo: formatDate(midpoint),
  }, maxCasesPerSlice, search);
  const right = await discoverPartition(page, {
    ...partition,
    filedDateFrom: formatDate(rightStart),
  }, maxCasesPerSlice, search);

  return [...new Map([...left, ...right].map((item) => [item.caseNumber, item])).values()];
}


/**
 * Autonomous Statewide Discovery & Crawler.
 * Iterates through partitioned slices, discovers all active cases, and downloads documents.
 */
export async function crawlStatewideActiveCases(browserClient, options = {}) {
  const partitions = generatePartitions(options);
  console.log(`\n======================================================`);
  console.log(`[Statewide Crawler] Generated ${partitions.length} partition slices.`);
  console.log(`======================================================`);

  const page = browserClient.page;
  const state = loadState(options.stateFile);
  const maxCasesPerSlice = options.maxCasesPerSlice || 200;
  let totalDiscovered = 0;
  let totalProcessed = 0;
  const partitionFailures = [];
  const caseFailures = [];

  for (let pIdx = 0; pIdx < partitions.length; pIdx++) {
    const part = partitions[pIdx];
    console.log(
      `\n>>> [Partition ${pIdx + 1}/${partitions.length}] County: ${part.county} | Cat: ${part.category} | Status: ${part.caseStatus}`
    );

    let cases;
    try {
      cases = await discoverPartition(page, part, maxCasesPerSlice);
    } catch (err) {
      console.error(`  [Partition Error] Failed to search partition: ${err.message}`);
      partitionFailures.push({ partition: part, error: err.message });
      if (err.message.includes('[WAF BLOCKED]')) throw err;
      await sleepJitter();
      continue;
    }

    console.log(`  [Partition] Discovered ${cases.length} uncapped case(s).`);
    totalDiscovered += cases.length;

    // Process each case in this partition
    for (let cIdx = 0; cIdx < cases.length; cIdx++) {
      const c = cases[cIdx];
      const caseNo = c.caseNumber;

      // Skip already complete cases unless force
      if (state.pulledCases[caseNo] && state.pulledCases[caseNo].status === 'complete' && !options.force) {
        console.log(`  [Skip] Case ${caseNo} already complete in state.json.`);
        continue;
      }

      console.log(`  -> Pulling Case [${cIdx + 1}/${cases.length}]: ${caseNo} (${c.caseTitle || ''})`);
      try {
        const result = await crawlCase(browserClient, caseNo, options);
        if (result.success) {
          totalProcessed++;
        } else {
          caseFailures.push({ caseNumber: caseNo, error: result.reason || 'Unknown crawl failure' });
        }
      } catch (err) {
        console.error(`  [Case Error] Failed pulling ${caseNo}: ${err.message}`);
        caseFailures.push({ caseNumber: caseNo, error: err.message });
        if (err.message.includes('[WAF BLOCKED]')) throw err;
      }

      // Jitter pause between cases
      const jitter = await sleepJitter();
      console.log(`  [Rate Limit] Pausing ${Math.round(jitter / 1000)}s...`);
    }

    // Jitter pause between partitions
    if (pIdx < partitions.length - 1) {
      const pDelay = await sleepJitter(CONFIG.delays.minDelayMs * 1.5, CONFIG.delays.maxDelayMs * 1.5);
      console.log(`[Rate Limit] Partition complete. Pausing ${Math.round(pDelay / 1000)}s before next slice...`);
    }
  }

  console.log(`\n======================================================`);
  console.log(`[Statewide Crawler] Finished: ${totalDiscovered} cases discovered, ${totalProcessed} processed, ${partitionFailures.length} failed partition(s), ${caseFailures.length} failed case(s).`);
  console.log(`======================================================`);

  const failures = [
    ...partitionFailures.map((failure) => ({ type: 'partition', ...failure })),
    ...caseFailures.map((failure) => ({ type: 'case', ...failure })),
  ];
  if (failures.length > 0) {
    const error = new AggregateError(
      failures.map((failure) => new Error(failure.error)),
      `${failures.length} statewide operation(s) failed; the run is incomplete`
    );
    error.failures = failures;
    throw error;
  }

  return { totalDiscovered, totalProcessed, partitionFailures, caseFailures };
}
