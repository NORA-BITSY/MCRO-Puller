import { COUNTIES } from './counties.js';
import { searchCases } from './search.js';
import { crawlCase, loadState } from './crawler.js';
import { sleepJitter } from './waf.js';

export const CASE_CATEGORIES = [
  { code: 'CV', name: 'Civil' },
  { code: 'CR', name: 'Criminal' },
  { code: 'FAM', name: 'Family' },
  { code: 'PR', name: 'Probate/Mental Health' },
];

/**
 * Generate slice partitions for discovery without hitting the 200-result cap.
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
  const state = loadState();
  const maxCasesPerSlice = options.maxCasesPerSlice || 200;
  let totalDiscovered = 0;
  let totalProcessed = 0;

  for (let pIdx = 0; pIdx < partitions.length; pIdx++) {
    const part = partitions[pIdx];
    console.log(
      `\n>>> [Partition ${pIdx + 1}/${partitions.length}] County: ${part.county} | Cat: ${part.category} | Status: ${part.caseStatus}`
    );

    let searchResult;
    try {
      searchResult = await searchCases(page, {
        counties: [part.county],
        categories: [part.category],
        caseStatus: part.caseStatus,
        filedDateFrom: part.filedDateFrom,
        filedDateTo: part.filedDateTo,
        filedDateExact: false,
      });
    } catch (err) {
      console.error(`  [Partition Error] Failed to search partition: ${err.message}`);
      await sleepJitter();
      continue;
    }

    const cases = searchResult.cases || [];
    console.log(`  [Partition] Discovered ${cases.length} cases.`);
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
        await crawlCase(browserClient, caseNo, options);
        totalProcessed++;
      } catch (err) {
        console.error(`  [Case Error] Failed pulling ${caseNo}: ${err.message}`);
      }

      // Jitter pause between cases
      const jitter = await sleepJitter();
      console.log(`  [WAF Safe] Pausing ${Math.round(jitter / 1000)}s...`);
    }

    // Jitter pause between partitions
    if (pIdx < partitions.length - 1) {
      const pDelay = await sleepJitter(CONFIG.delays.minDelayMs * 1.5, CONFIG.delays.maxDelayMs * 1.5);
      console.log(`[WAF Safe] Partition complete. Pausing ${Math.round(pDelay / 1000)}s before next slice...`);
    }
  }

  console.log(`\n======================================================`);
  console.log(`[Statewide Crawler] Finished: ${totalDiscovered} cases discovered, ${totalProcessed} processed.`);
  console.log(`======================================================`);
}
