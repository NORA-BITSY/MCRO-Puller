import { CONFIG, MAX_PULL_CONCURRENCY } from './config.js';
import { createBrowserClient } from './browser.js';
import { crawlCase } from './crawler.js';
import { safeCaseNumber } from './downloader.js';
import { loadState, updateState } from './state.js';
import { sleepJitter } from './waf.js';

export class WorkerQueue {
  constructor(options = {}) {
    // Operator-approved concurrency: up to 10 concurrent pull jobs (hard
    // ceiling). Each worker is sticky-assigned one proxy from the pool by
    // index; an empty pool means direct connections.
    this.concurrency = Math.max(1, Math.min(options.concurrency ?? CONFIG.concurrency, MAX_PULL_CONCURRENCY));
    this.proxyPool = options.proxyPool || CONFIG.proxyPool;
    this.mode = options.mode || 'extension';
    this.headed = options.headed || false;
    this.outputDir = options.outputDir || CONFIG.outputDir;
    this.stateFile = options.stateFile || CONFIG.stateFile;
    this.force = options.force || false;
    this.createClient = options.createBrowserClient || createBrowserClient;
    this.crawl = options.crawlCase || crawlCase;
    const previous = loadState(this.stateFile).queue;
    this.queue = options.resume !== false && previous?.outputDir === this.outputDir ? [...new Set(previous.pending || [])] : [];
    this.activeWorkers = 0;
    this.isStopping = false;
    this.completedCount = 0;
    this.failedCount = 0;
    this.retryCases = [];
    this.inFlight = [];
    this.status = 'pending';
    this.results = [];
    this.signalHandlers = new Map();
    this.registerSignalHandlers();
  }

  registerSignalHandlers() {
    for (const signal of ['SIGINT', 'SIGTERM']) {
      const handler = () => {
        this.isStopping = true;
        if (this.status !== 'blocked') this.status = 'stopped';
        this.persist().catch((error) => { console.error(`[Queue] Could not persist shutdown state: ${error.message}`); process.exitCode = 1; });
      };
      this.signalHandlers.set(signal, handler);
      process.once(signal, handler);
    }
  }

  addCase(caseNumber) {
    const normalized = safeCaseNumber(caseNumber);
    if (!this.queue.includes(normalized) && !this.inFlight.includes(normalized)) this.queue.push(normalized);
  }

  addCases(caseNumbers) {
    for (const caseNumber of caseNumbers) this.addCase(caseNumber);
  }

  pending() { return [...new Set([...this.retryCases, ...this.inFlight, ...this.queue])]; }

  async persist() {
    const queue = { sourceId: 'mn-mcro', outputDir: this.outputDir, status: this.status,
      pending: this.pending(), inFlight: [...this.inFlight], succeeded: this.completedCount,
      failed: this.failedCount, updatedAt: new Date().toISOString() };
    await updateState((state) => { state.queue = queue; }, this.stateFile);
  }

  async run() {
    this.status = this.isStopping ? this.status : 'running';
    try {
      await this.persist();
      await Promise.all(Array.from({ length: this.concurrency }, (_, index) => this.spawnWorker(index + 1)));
      if (!this.isStopping) this.status = this.failedCount ? 'partial' : 'complete';
      await this.persist();
      return { succeeded: this.completedCount, failed: this.failedCount, stopped: this.isStopping,
        status: this.status, pending: this.pending(), results: this.results, concurrency: this.concurrency };
    } finally {
      for (const [signal, handler] of this.signalHandlers) process.removeListener(signal, handler);
      this.signalHandlers.clear();
    }
  }

  async spawnWorker(workerId) {
    // Sticky proxy: worker N always egresses through pool[N-1] (mod pool
    // size) so F5/session cookies stay bound to one exit IP per worker.
    const proxy = this.proxyPool.length ? this.proxyPool[(workerId - 1) % this.proxyPool.length] : undefined;
    while (this.queue.length && !this.isStopping) {
      const caseNumber = this.queue.shift();
      this.inFlight.push(caseNumber);
      this.activeWorkers++;
      await this.persist();
      let client;
      try {
        client = await this.createClient({ mode: this.mode, headed: this.headed, proxy });
        if (this.isStopping) {
          this.retryCases.push(caseNumber);
          continue;
        }
        const result = await this.crawl(client, caseNumber, { outputDir: this.outputDir, stateFile: this.stateFile, force: this.force });
        this.results.push({ caseNumber, ...result });
        if (result.success && (!result.status || result.status === 'complete')) this.completedCount++;
        else {
          this.failedCount++;
          this.retryCases.push(caseNumber);
          // Retryable failures (rate limits, challenges) are re-queued; nothing
          // auto-stops the queue for source signals.
        }
      } catch (error) {
        this.failedCount++;
        this.retryCases.push(caseNumber);
        this.results.push({ caseNumber, success: false, status: 'error', error: error.message });
      } finally {
        if (client) {
          try { await client.close(); } catch (error) { console.error(`[Worker ${workerId}] Browser cleanup failed: ${error.message}`); }
        }
        this.inFlight = this.inFlight.filter((value) => value !== caseNumber);
        this.activeWorkers--;
        await this.persist();
      }
      if (!this.isStopping && this.queue.length) await sleepJitter();
    }
  }
}
