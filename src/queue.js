import { CONFIG } from './config.js';
import { createBrowserClient } from './browser.js';
import { crawlCase } from './crawler.js';
import { sleepJitter } from './waf.js';

export class WorkerQueue {
  constructor(options = {}) {
    this.concurrency = Number.isInteger(options.concurrency) && options.concurrency > 0 ? options.concurrency : 1;
    this.proxyManager = options.proxyManager || null;
    this.mode = options.mode || (this.proxyManager && this.proxyManager.proxies.length > 0 ? 'standalone' : 'extension');
    this.headed = options.headed || false;
    this.outputDir = options.outputDir || CONFIG.outputDir;
    this.force = options.force || false;

    this.queue = [];
    this.activeWorkers = 0;
    this.isStopping = false;
    this.completedCount = 0;
    this.failedCount = 0;

    this.registerSignalHandlers();
  }

  registerSignalHandlers() {
    const handleExit = async (signal) => {
      if (this.isStopping) return;
      console.log(`\n[Queue] Received ${signal}. Initiating graceful shutdown...`);
      this.isStopping = true;
      this.queue = []; // clear remaining jobs
    };

    process.once('SIGINT', () => handleExit('SIGINT'));
    process.once('SIGTERM', () => handleExit('SIGTERM'));
  }

  addCase(caseNumber) {
    this.queue.push(caseNumber);
  }

  addCases(caseNumbers) {
    this.queue.push(...caseNumbers);
  }

  async run() {
    console.log(
      `[Queue] Starting processing with ${this.concurrency} worker(s) across ${this.queue.length} case(s) (mode: ${this.mode})...`
    );

    const workers = [];
    for (let i = 0; i < this.concurrency; i++) {
      workers.push(this.spawnWorker(i + 1));
    }

    await Promise.all(workers);
    const summary = {
      succeeded: this.completedCount,
      failed: this.failedCount,
      stopped: this.isStopping,
    };
    console.log(`[Queue] All workers completed: ${summary.succeeded} succeeded, ${summary.failed} failed.`);
    return summary;
  }

  async spawnWorker(workerId) {
    while (this.queue.length > 0 && !this.isStopping) {
      const caseNumber = this.queue.shift();
      if (!caseNumber) break;

      let proxy = null;
      if (this.proxyManager && this.proxyManager.proxies.length > 0) {
        proxy = this.proxyManager.getNextAvailableProxy();
        if (!proxy) {
          this.failedCount++;
          console.error(`[Worker ${workerId}] No healthy proxy is available; stopping rather than falling back to the direct IP.`);
          this.isStopping = true;
          break;
        }
      }

      console.log(`[Worker ${workerId}] Processing case: ${caseNumber} (proxy: ${proxy ? proxy.server : 'direct'})`);

      let client;
      try {
        client = await createBrowserClient({
          mode: this.mode,
          headed: this.headed,
          proxy: this.proxyManager ? this.proxyManager.toPlaywrightProxy(proxy) : undefined,
        });

        const res = await crawlCase(client, caseNumber, {
          outputDir: this.outputDir,
          force: this.force,
        });

        if (res.success) {
          this.completedCount++;
          if (this.proxyManager && proxy) {
            this.proxyManager.reportSuccess(proxy);
          }
        } else {
          this.failedCount++;
        }
      } catch (err) {
        this.failedCount++;
        console.error(`[Worker ${workerId}] Error processing case ${caseNumber}: ${err.message}`);
        if (this.proxyManager && proxy) {
          this.proxyManager.reportFailure(proxy, err.message);
        }
      } finally {
        if (client) {
          await client.close().catch(() => {});
        }
      }

      if (!this.isStopping && this.queue.length > 0) {
        const jitter = await sleepJitter();
        console.log(`[Worker ${workerId}] Pausing ${Math.round(jitter / 1000)}s before next job...`);
      }
    }
  }
}
