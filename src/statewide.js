import { CONFIG } from './config.js';
import { COUNTIES } from './counties.js';
import { executeSearch, validateSearchOptions } from './search.js';
import { crawlCase } from './crawler.js';
import { loadState } from './state.js';
import { sleepJitter } from './waf.js';

export const CASE_CATEGORIES = [
  { code: 'CV', name: 'Civil' },
  { code: 'CR', name: 'Criminal' },
  { code: 'FAM', name: 'Family' },
  { code: 'PR', name: 'Probate/Mental Health' },
];

export function validateDiscoveryQuery(query) {
  if (!query) throw Object.assign(new Error('Filter-only statewide discovery is unsupported: supply a documented, validated source query; no wildcard or name-free enumeration is assumed'), { code: 'unsupported' });
  const validated = validateSearchOptions(query);
  if (!['party', 'business', 'attorney'].includes(validated.searchType)) throw Object.assign(new Error('County/category/filing-date partitions require a person, business, or attorney query'), { code: 'unsupported' });
  for (const key of ['county', 'counties', 'categories', 'status', 'filedFrom', 'filedTo']) {
    if (validated[key] !== undefined) throw Object.assign(new Error(`Use partition options for ${key}; discovery will not silently replace a query filter`), { code: 'permanent' });
  }
  return validated;
}

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
      partitions.push({ county: cty, category: cat, dateFrom, dateTo, status });
    }
  }

  return partitions;
}

function parseDate(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isFinite(d.getTime()) ? d : null;
}

function formatDate(date) {
  return date.toISOString().slice(0, 10);
}

export async function discoverPartition(page, partition, maxCasesPerSlice = 200, search = executeSearch) {
  const { county, category, dateFrom, dateTo } = partition;
  return search(page, {
    searchType: 'party',
    county,
    categories: [category],
    filedFrom: dateFrom || undefined,
    filedTo: dateTo || undefined,
    pageSize: maxCasesPerSlice,
  });
}

/**
 * County-partitioned discovery for one validated source query.
 * Uncapped slices are not a claim of complete statewide public-record coverage.
 */
export async function crawlStatewideActiveCases(browserClient, options = {}) {
  validateDiscoveryQuery(options.query);
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
      `\n>>> [Partition ${pIdx + 1}/${partitions.length}] County: ${part.county} | Cat: ${part.category} | Status: ${part.status}`
    );

    let cases;
    try {
      cases = await discoverPartition(page, part, maxCasesPerSlice);
    } catch (err) {
      console.error(`  [Partition Error] Failed to search partition: ${err.message}`);
      partitionFailures.push({ partition: part, error: err.message });
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
