#!/usr/bin/env node

import { Command } from 'commander';
import fs from 'node:fs';
import path from 'node:path';
import { CONFIG } from './src/config.js';
import { createBrowserClient } from './src/browser.js';
import { searchCases, searchHearings, searchDocumentDirect } from './src/search.js';
import { crawlCase, crawlParty, crawlAttorney, loadState } from './src/crawler.js';
import { verifyPdfBuffer } from './src/downloader.js';
import { ProxyManager } from './src/proxy.js';
import { WorkerQueue } from './src/queue.js';
import { syncCase, syncAllActiveCases } from './src/sync.js';
import { preprocessPdf } from './src/ocr.js';
import { synthesizeCaseDossier } from './src/nlp.js';
import { COUNTIES, getAllCountyNames } from './src/counties.js';

const program = new Command();

program
  .name('mcro')
  .description('Autonomous Minnesota Court Records Online (MCRO) WAF-Safe Document Engine & Crawler')
  .version('1.1.0');

// 1. SEARCH COMMAND (Covering all MCRO UI fields)
program
  .command('search')
  .description('Search MCRO cases using any or all search UI fields')
  .option('-c, --case <caseNumber>', 'Search by Case Number (e.g., 67-CV-26-300)')
  .option('--citation <citationNumber>', 'Search by Citation Number')
  .option('-n, --name <lastName>', 'Party Last Name')
  .option('-f, --first <firstName>', 'Party First Name')
  .option('--middle <middleName>', 'Party Middle Name')
  .option('-b, --business <businessName>', 'Search as Business Name')
  .option('--soundex', 'Enable Sounds Like search', false)
  .option('-a, --attorney <lastName>', 'Attorney Last Name')
  .option('--bar <barNumber>', 'Attorney MN Bar/License Number')
  .option('--judge <judgeName>', 'Judicial Officer Name (via Hearing Search)')
  .option('--hearing-from <date>', 'Hearing Date From (YYYY-MM-DD)')
  .option('--hearing-to <date>', 'Hearing Date To (YYYY-MM-DD)')
  .option('--dob-from <date>', 'Date of Birth From (YYYY-MM-DD)')
  .option('--dob-to <date>', 'Date of Birth To (YYYY-MM-DD)')
  .option('--filed-from <date>', 'Date Filed From (YYYY-MM-DD)')
  .option('--filed-to <date>', 'Date Filed To (YYYY-MM-DD)')
  .option('--category <categories>', 'Case Categories (comma-separated: CV, CR, FAM, PR)')
  .option('--status <status>', 'Case Status: Active, Inactive, All', 'All')
  .option('--county <counties>', 'County name(s) (comma-separated, e.g. Hennepin,Ramsey)')
  .option('-m, --mode <mode>', 'Browser mode: "extension" or "standalone"', 'extension')
  .option('--headed', 'Run browser in headed mode', false)
  .option('--proxy <proxy>', 'Proxy URL (http://user:pass@host:port)')
  .action(async (opts) => {
    let client;
    try {
      const proxyObj = opts.proxy ? new ProxyManager().parseProxy(opts.proxy) : null;
      client = await createBrowserClient({
        mode: opts.mode,
        headed: opts.headed,
        proxy: proxyObj ? new ProxyManager().toPlaywrightProxy(proxyObj) : undefined,
      });

      const categories = opts.category ? opts.category.split(',').map((c) => c.trim().toUpperCase()) : [];
      const counties = opts.county ? opts.county.split(',').map((c) => c.trim()) : [];

      if (opts.judge) {
        const result = await searchHearings(client.page, {
          judgeName: opts.judge,
          hearingDateFrom: opts.hearingFrom || '',
          hearingDateTo: opts.hearingTo || '',
          categories,
          counties,
        });
        printSearchResults(result);
      } else {
        const result = await searchCases(client.page, {
          caseNumber: opts.case || '',
          citationNumber: opts.citation || '',
          lastName: opts.name || '',
          firstName: opts.first || '',
          middleName: opts.middle || '',
          businessName: opts.business || '',
          soundex: opts.soundex,
          attorneyLastName: opts.attorney || '',
          barNumber: opts.bar || '',
          dobFrom: opts.dobFrom || '',
          dobTo: opts.dobTo || '',
          filedDateFrom: opts.filedFrom || '',
          filedDateTo: opts.filedTo || '',
          categories,
          caseStatus: opts.status,
          counties,
        });
        printSearchResults(result);
      }
    } catch (err) {
      console.error(`\n[Search Error] ${err.message}`);
      process.exitCode = 1;
    } finally {
      if (client) await client.close();
    }
  });

// 2. DOWNLOAD-CASE COMMAND
program
  .command('download-case')
  .description('Download all publicly available PDFs from a specific case')
  .argument('<caseNumber>', 'Case number (e.g., 67-CV-26-300)')
  .option('-o, --out <dir>', 'Output directory', CONFIG.outputDir)
  .option('--force', 'Re-download already existing files', false)
  .option('-m, --mode <mode>', 'Browser mode: "extension" or "standalone"', 'extension')
  .option('--headed', 'Run browser headed', false)
  .option('--proxy <proxy>', 'Proxy URL (http://user:pass@host:port)')
  .action(async (caseNumber, opts) => {
    let client;
    try {
      const proxyObj = opts.proxy ? new ProxyManager().parseProxy(opts.proxy) : null;
      client = await createBrowserClient({
        mode: opts.mode,
        headed: opts.headed,
        proxy: proxyObj ? new ProxyManager().toPlaywrightProxy(proxyObj) : undefined,
      });

      const res = await crawlCase(client, caseNumber, {
        outputDir: opts.out ? path.join(opts.out, caseNumber) : undefined,
        force: opts.force,
      });

      if (!res.success) {
        console.error(`\n[Download Error] ${res.reason}`);
        process.exitCode = 1;
      }
    } catch (err) {
      console.error(`\n[Download Error] ${err.message}`);
      process.exitCode = 1;
    } finally {
      if (client) await client.close();
    }
  });

// 3. BULK-DOWNLOAD COMMAND
program
  .command('bulk-download')
  .description('Bulk download multiple cases from a text file or comma-separated list')
  .option('-f, --file <path>', 'Text file containing case numbers (one per line) or JSON array')
  .option('-c, --cases <list>', 'Comma-separated list of case numbers')
  .option('-w, --workers <count>', 'Number of concurrent workers (default: 1)', (v) => parseInt(v, 10), 1)
  .option('-p, --proxies <path>', 'Path to proxies list file')
  .option('-o, --out <dir>', 'Output directory', CONFIG.outputDir)
  .option('--force', 'Force re-download existing files', false)
  .option('-m, --mode <mode>', 'Browser mode: "extension" or "standalone"')
  .option('--headed', 'Run browser headed', false)
  .action(async (opts) => {
    const caseList = [];
    if (opts.file) {
      const content = fs.readFileSync(opts.file, 'utf-8').trim();
      if (opts.file.endsWith('.json')) {
        caseList.push(...JSON.parse(content));
      } else {
        caseList.push(
          ...content
            .split('\n')
            .map((l) => l.trim())
            .filter((l) => l && !l.startsWith('#'))
        );
      }
    } else if (opts.cases) {
      caseList.push(...opts.cases.split(',').map((c) => c.trim()).filter(Boolean));
    } else {
      console.error('Please specify a case list with --file <path> or --cases <list>');
      process.exitCode = 1;
      return;
    }

    console.log(`[Bulk Download] Queuing ${caseList.length} cases across ${opts.workers} worker(s)...`);

    const proxyManager = opts.proxies ? new ProxyManager({ proxyFile: opts.proxies }) : null;
    const queue = new WorkerQueue({
      concurrency: opts.workers,
      proxyManager,
      mode: opts.mode,
      headed: opts.headed,
      outputDir: opts.out,
      force: opts.force,
    });

    queue.addCases(caseList);
    await queue.run();
  });

// 4. SYNC COMMAND (Incremental daily updates)
program
  .command('sync')
  .description('Incrementally update tracked cases (only downloads new filings)')
  .option('-c, --case <caseNumber>', 'Sync a specific case number only')
  .option('-o, --out <dir>', 'Output directory', CONFIG.outputDir)
  .option('-m, --mode <mode>', 'Browser mode: "extension" or "standalone"', 'extension')
  .option('--headed', 'Run browser headed', false)
  .action(async (opts) => {
    let client;
    try {
      client = await createBrowserClient({ mode: opts.mode, headed: opts.headed });
      if (opts.case) {
        await syncCase(client, opts.case, { outputDir: opts.out });
      } else {
        await syncAllActiveCases(client, { outputDir: opts.out });
      }
    } catch (err) {
      console.error(`\n[Sync Error] ${err.message}`);
      process.exitCode = 1;
    } finally {
      if (client) await client.close();
    }
  });

// 5. STATEWIDE COMMAND (County-partitioned discovery)
program
  .command('statewide')
  .description('Statewide partitioned crawl of active cases without hitting the 200-result cap')
  .option('--county <counties>', 'Specific counties (comma-separated, default: all 87 counties)')
  .option('--category <categories>', 'Specific categories: CV,CR,FAM,PR (default: all)')
  .option('--days <number>', 'Only pull cases filed within past N days (default: 1)', (v) => parseInt(v, 10), 1)
  .option('-o, --out <dir>', 'Output directory', CONFIG.outputDir)
  .option('-m, --mode <mode>', 'Browser mode: "extension" or "standalone"', 'extension')
  .action(async (opts) => {
    let client;
    try {
      client = await createBrowserClient({ mode: opts.mode });

      const counties = opts.county ? opts.county.split(',').map((c) => c.trim()) : undefined;
      const categories = opts.category ? opts.category.split(',').map((c) => c.trim().toUpperCase()) : undefined;

      // Compute dateFrom
      const now = new Date();
      const fromDate = new Date(now.getTime() - opts.days * 24 * 60 * 60 * 1000);
      const dateFrom = fromDate.toISOString().split('T')[0];
      const dateTo = now.toISOString().split('T')[0];

      await crawlStatewideActiveCases(client, {
        counties,
        categories,
        dateFrom,
        dateTo,
        outputDir: opts.out,
      });
    } catch (err) {
      console.error(`\n[Statewide Error] ${err.message}`);
      process.exitCode = 1;
    } finally {
      if (client) await client.close();
    }
  });

// 6. DAEMON COMMAND (Continuous 24/7 runner)
program
  .command('daemon')
  .description('Run continuously as a 24/7 background service, syncing active cases daily')
  .option('-i, --interval <hours>', 'Sync interval in hours', (v) => parseFloat(v), 24)
  .option('-p, --proxies <path>', 'Path to proxies list file')
  .option('-w, --workers <count>', 'Concurrency', (v) => parseInt(v, 10), 1)
  .option('-o, --out <dir>', 'Output directory', CONFIG.outputDir)
  .action(async (opts) => {
    console.log(`\n======================================================`);
    console.log(`[MCRO Daemon] Starting continuous puller service`);
    console.log(`[MCRO Daemon] Sync Interval: every ${opts.interval} hour(s)`);
    console.log(`[MCRO Daemon] Output directory: ${opts.out}`);
    console.log(`======================================================\n`);

    let running = true;
    const shutdown = () => {
      console.log('\n[MCRO Daemon] Shutting down daemon...');
      running = false;
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);

    while (running) {
      console.log(`\n[MCRO Daemon] Initiating sync run at ${new Date().toISOString()}...`);
      let client;
      try {
        client = await createBrowserClient({ mode: 'extension' });
        await syncAllActiveCases(client, { outputDir: opts.out });
      } catch (err) {
        console.error(`[MCRO Daemon] Sync iteration error: ${err.message}`);
      } finally {
        if (client) await client.close().catch(() => {});
      }

      if (!running) break;
      const sleepMs = opts.interval * 60 * 60 * 1000;
      console.log(`[MCRO Daemon] Sleeping for ${opts.interval} hour(s) until next sync run...`);
      await new Promise((resolve) => setTimeout(resolve, Math.min(sleepMs, 10000)));
    }
  });

// 7. PROXY-TEST COMMAND
program
  .command('proxy-test')
  .description('Benchmark and verify a list of proxies against MCRO and Volterra WAF')
  .argument('<proxyFile>', 'Path to proxies list file')
  .action(async (proxyFile) => {
    console.log(`[Proxy Test] Testing proxies from ${proxyFile}...`);
    const pm = new ProxyManager({ proxyFile });
    const { chromium } = await import('playwright-extra');
    const stealthPlugin = (await import('puppeteer-extra-plugin-stealth')).default;
    chromium.use(stealthPlugin());

    for (const p of pm.proxies) {
      process.stdout.write(`Testing proxy ${p.server}... `);
      const startTime = Date.now();
      try {
        const browser = await chromium.launch({
          headless: true,
          proxy: pm.toPlaywrightProxy(p),
          args: ['--no-sandbox', '--disable-setuid-sandbox'],
        });
        const ctx = await browser.newContext();
        const page = await ctx.newPage();
        const resp = await page.goto(CONFIG.urls.base, { timeout: 15000 });
        const latency = Date.now() - startTime;
        const status = resp ? resp.status() : 0;
        await browser.close();

        if (status === 200) {
          console.log(`✓ PASS (Status 200, ${latency}ms)`);
          pm.reportSuccess(p);
        } else {
          console.log(`✗ FAIL (Status ${status}, ${latency}ms)`);
          pm.reportFailure(p, `HTTP ${status}`);
        }
      } catch (err) {
        console.log(`✗ ERROR: ${err.message.slice(0, 50)}`);
        pm.reportFailure(p, err.message);
      }
    }
  });

// 8. VERIFY COMMAND
program
  .command('verify')
  .description('Audit downloaded PDFs to ensure 100% genuine %PDF magic bytes and >= 1KB size')
  .argument('[directory]', 'Cases directory to verify', CONFIG.outputDir)
  .action(async (dir) => {
    const targetDir = path.resolve(dir);
    console.log(`[Verify] Auditing PDF files in: ${targetDir}`);

    if (!fs.existsSync(targetDir)) {
      console.error(`Directory not found: ${targetDir}`);
      return;
    }

    const files = [];
    function scanDir(d) {
      for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, entry.name);
        if (entry.isDirectory()) scanDir(full);
        else if (entry.isFile() && entry.name.endsWith('.pdf')) files.push(full);
      }
    }
    scanDir(targetDir);

    console.log(`Found ${files.length} PDF file(s). Inspecting bytes...`);
    let validCount = 0;
    let corruptedCount = 0;

    for (const f of files) {
      const buf = fs.readFileSync(f);
      const res = verifyPdfBuffer(buf);
      const rel = path.relative(targetDir, f);
      if (res.valid) {
        validCount++;
        console.log(`  ✓ [PASS] ${rel} (${buf.length} bytes)`);
      } else {
        corruptedCount++;
        console.error(`  ✗ [FAIL] ${rel}: ${res.reason}`);
      }
    }

    console.log(`\nAudit Complete: ${validCount} valid %PDF files, ${corruptedCount} corrupted stubs.`);
    if (corruptedCount > 0) process.exitCode = 1;
  });

// OCR & PREPROCESSING COMMAND
program
  .command('ocr')
  .description('Run hybrid vector extraction + Tesseract OCR and structured entity parsing on PDFs')
  .argument('[target]', 'PDF file or directory of cases to process', './downloads')
  .action(async (target) => {
    const resolvedTarget = path.resolve(target);
    console.log(`[OCR Pipeline] Processing target: ${resolvedTarget}`);

    const pdfFiles = [];
    if (fs.statSync(resolvedTarget).isDirectory()) {
      function scan(d) {
        for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
          const full = path.join(d, entry.name);
          if (entry.isDirectory()) scan(full);
          else if (entry.isFile() && entry.name.endsWith('.pdf')) pdfFiles.push(full);
        }
      }
      scan(resolvedTarget);
    } else {
      pdfFiles.push(resolvedTarget);
    }

    console.log(`Found ${pdfFiles.length} PDF(s) to process.`);
    for (let i = 0; i < pdfFiles.length; i++) {
      const f = pdfFiles[i];
      console.log(`\n[${i + 1}/${pdfFiles.length}] Preprocessing: ${path.basename(f)}...`);
      try {
        const res = preprocessPdf(f);
        console.log(`  Case: ${res.structured.caseNumber || 'N/A'} | Title: ${res.structured.documentTitle || 'N/A'}`);
        console.log(`  Pages: ${res.totalPages} (Vector: ${res.pages.filter(p => p.source === 'vector_text').length}, OCR: ${res.pages.filter(p => p.source === 'tesseract_ocr').length})`);
      } catch (err) {
        console.error(`  Error processing ${path.basename(f)}: ${err.message}`);
      }
    }
    if (fs.statSync(resolvedTarget).isDirectory()) {
      // Check if current directory has a docket-export-index.json or subdirectories
      if (fs.existsSync(path.join(resolvedTarget, 'docket-export-index.json'))) {
        synthesizeCaseDossier(resolvedTarget);
      } else {
        for (const sub of fs.readdirSync(resolvedTarget, { withFileTypes: true })) {
          if (sub.isDirectory()) {
            const subPath = path.join(resolvedTarget, sub.name);
            if (fs.existsSync(path.join(subPath, 'docket-export-index.json'))) {
              synthesizeCaseDossier(subPath);
            }
          }
        }
      }
    }
    console.log(`\n[OCR Pipeline] Finished processing and generated comprehensive dossiers.`);
  });

// 9. STATUS COMMAND
program
  .command('status')
  .description('Display status and summary of all recorded case pulls')
  .action(() => {
    const state = loadState();
    const cases = Object.entries(state.pulledCases || {});
    console.log(`\nMCRO Pulled Cases Summary (${cases.length} recorded):`);
    console.log(`--------------------------------------------------------------------------------`);
    if (cases.length === 0) {
      console.log('No cases recorded yet.');
      return;
    }

    for (const [caseNo, info] of cases) {
      console.log(`Case: ${caseNo} [${(info.status || 'UNKNOWN').toUpperCase()}]`);
      console.log(`  Title:        ${info.caseTitle || 'N/A'}`);
      console.log(`  Type:         ${info.caseType || 'N/A'} (Filed: ${info.dateFiled || 'N/A'})`);
      console.log(
        `  Documents:    ${info.downloadedCount || 0} saved, ${info.skippedCount || 0} skipped, ${info.failureCount || 0} failed`
      );
      console.log(`  Last Run:     ${info.lastRunAt || 'N/A'}`);
      console.log(`  Last Checked: ${info.lastCheckedAt || 'N/A'}`);
      console.log(`--------------------------------------------------------------------------------`);
    }
  });

// 10. LIST-COUNTIES COMMAND
program
  .command('counties')
  .description('List all 87 Minnesota county names and codes')
  .action(() => {
    console.log(`\nMinnesota 87 Counties List:`);
    console.log(`--------------------------------------------------------------------------------`);
    COUNTIES.forEach((c) => {
      console.log(`  - ${c.name.padEnd(20)} (Code: ${c.code}, ID: ${c.id})`);
    });
  });

function printSearchResults(result) {
  console.log(`\nFound ${result.cases.length} result(s):`);
  console.log('--------------------------------------------------------------------------------');
  result.cases.forEach((c) => {
    console.log(`[#${c.index}] Case Number: ${c.caseNumber}`);
    console.log(`     Title:     ${c.caseTitle}`);
    console.log(`     Type:      ${c.caseType} | Status: ${c.caseStatus}`);
    console.log(`     Location:  ${c.caseLocation} | Officer: ${c.judicialOfficer || 'N/A'}`);
    console.log(`     Date Filed: ${c.dateFiled}`);
    console.log('--------------------------------------------------------------------------------');
  });
}

program.parse();
