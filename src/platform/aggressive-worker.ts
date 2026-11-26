import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createApplication } from './bootstrap.js';
import type { CourtService } from './service.js';
import { errorInfo } from './contracts.js';
import { transaction } from './database.js';
import { settleDiscoveryFailures } from './discovery.js';
import { HighAggressionProxyManager, type ProxyEndpoint } from './proxy-manager.js';
import { createStealthBrowserClientWithRetry, type StealthBrowserClient } from './stealth-browser.js';
import { AggressiveMinnesotaAdapter } from './aggressive-adapter.js';
import { CONFIG } from '../config.js';
import type { Job } from './jobs.js';
import { sha256, validatePdf } from './storage.js';

export interface AggressiveWorkerConfig {
  maxConcurrency: number;
  workerId: string;
  proxyManager: HighAggressionProxyManager;
  semaphoreLimit: number;
  requestTimeoutMs: number;
  maxRetriesPerRequest: number;
  retryBaseDelayMs: number;
}

export interface WorkerContext {
  proxy: ProxyEndpoint;
  browser: StealthBrowserClient;
  semaphore: Semaphore;
  attemptCount: number;
}

export class Semaphore {
  private permits: number;
  private waiters: Array<{ resolve: () => void; reject: (error: Error) => void }> = [];

  constructor(permits: number) {
    this.permits = permits;
  }

  async acquire(signal?: AbortSignal): Promise<void> {
    if (this.permits > 0) {
      this.permits--;
      return;
    }

    const { promise, resolve, reject } = Promise.withResolvers<void>();
    const abortHandler = () => {
      const idx = this.waiters.findIndex(w => w.resolve === resolve);
      if (idx !== -1) {
        this.waiters.splice(idx, 1);
        reject(new Error('Aborted'));
      }
    };

    this.waiters.push({ resolve, reject });
    signal?.addEventListener('abort', abortHandler, { once: true });
    await promise;
  }

  release(): void {
    this.permits++;
    if (this.waiters.length > 0) {
      const next = this.waiters.shift()!;
      this.permits--;
      next.resolve();
    }
  }

  get available(): number {
    return this.permits;
  }

  get waiting(): number {
    return this.waiters.length;
  }
}

async function fence(pool: import('pg').Pool, job: Job): Promise<void> {
  const lease = await pool.query("SELECT 1 FROM jobs WHERE id=$1 AND lease_token=$2 AND status='running' AND lease_expires_at>clock_timestamp() FOR UPDATE", [job.id, job.leaseToken]);
  if (!lease.rowCount) throw new Error('Job lease lost or cancelled before persistence');
}

async function enqueueCaseRefresh(service: CourtService, client: import('pg').PoolClient, caseId: string, key: string, policy: import('./refresh.js').RefreshPolicy, parentId?: string): Promise<import('./jobs.js').Job> {
  const row = await client.query<{ source_id: string; source_case_id: string }>("SELECT source_id,source_case_id FROM cases WHERE id=$1 AND availability='public' FOR UPDATE", [caseId]);
  if (!row.rows[0]) throw new Error('Case not found or restricted');
  if (parentId) {
    const linked = await client.query<import('./jobs.js').Job>(`SELECT j.id,j.status,j.source_id,j.type,j.payload,j.idempotency_key,j.priority,j.max_attempts,j.attempts,j.status,j.created_at,j.updated_at,j.lease_token,j.lease_owner,j.lease_expires_at,j.retry_generation FROM job_links l JOIN jobs j ON j.id=l.child_id
      WHERE l.parent_id=$1 AND j.type='refresh_case' AND j.payload->>'caseId'=$2 ORDER BY j.created_at,j.id LIMIT 1`, [parentId, caseId]);
    if (linked.rows[0]) return linked.rows[0];
  }
  const keyed = await client.query<import('./jobs.js').Job>(`SELECT id,status,source_id,type,payload,idempotency_key,priority,max_attempts,attempts,created_at,updated_at,lease_token,lease_owner,lease_expires_at,retry_generation
    FROM jobs WHERE idempotency_key=$1`, [key]);
  if (keyed.rows[0]) return keyed.rows[0];
  const active = await client.query<import('./jobs.js').Job>(`SELECT id,status,source_id,type,payload,idempotency_key,priority,max_attempts,attempts,created_at,updated_at,lease_token,lease_owner,lease_expires_at,retry_generation FROM jobs WHERE type='refresh_case' AND payload->>'caseId'=$1
    AND status IN ('queued','running','retry_wait','blocked') ORDER BY created_at,id LIMIT 1`, [caseId]);
  if (active.rows[0]) return active.rows[0];
  const { scheduleNextRefresh } = await import('./refresh.js');
  const decision = await scheduleNextRefresh(client, caseId, policy);
  return service.jobs.enqueue({ type: 'refresh_case', sourceId: row.rows[0].source_id, payload: { caseId, sourceCaseId: row.rows[0].source_case_id }, idempotencyKey: key, priority: decision.priority }, client);
}

async function enqueueChild(service: CourtService, job: Job, input: import('./jobs.js').EnqueueInput): Promise<import('./jobs.js').Job> {
  return service.jobs.enqueue(input);
}

export class AggressiveWorker {
  private service: CourtService;
  private adapter: AggressiveMinnesotaAdapter;
  private config: AggressiveWorkerConfig;
  private controller = new AbortController();
  private activeContexts: Map<string, WorkerContext> = new Map();
  private globalSemaphore: Semaphore;
  private shutdownPromise: Promise<void> | null = null;

  constructor(service: CourtService, adapter: AggressiveMinnesotaAdapter, config: Partial<AggressiveWorkerConfig> = {}) {
    this.service = service;
    this.adapter = adapter;
    this.config = {
      maxConcurrency: config.maxConcurrency ?? CONFIG.concurrency,
      workerId: config.workerId ?? `worker-${randomUUID()}`,
      proxyManager: config.proxyManager!,
      semaphoreLimit: config.semaphoreLimit ?? Math.max(CONFIG.concurrency * 2, 20),
      requestTimeoutMs: config.requestTimeoutMs ?? 60000,
      maxRetriesPerRequest: config.maxRetriesPerRequest ?? 3,
      retryBaseDelayMs: config.retryBaseDelayMs ?? 1000,
    };
    this.globalSemaphore = new Semaphore(this.config.semaphoreLimit);
  }

  async start(): Promise<void> {
    console.log(`[AggressiveWorker] Starting worker ${this.config.workerId} with concurrency=${this.config.maxConcurrency}, semaphore=${this.config.semaphoreLimit}`);

    const shutdown = () => this.shutdown();
    process.once('SIGTERM', shutdown);
    process.once('SIGINT', shutdown);

    this.shutdownPromise = this.runLoop();
    await this.shutdownPromise;
  }

  private async runLoop(): Promise<void> {
    let nextSchedule = 0;

    try {
      while (!this.controller.signal.aborted) {
        if (Date.now() >= nextSchedule) {
          await this.service.scheduleDue();
          nextSchedule = Date.now() + 60000;
        }

        const worked = await this.runOne();
        if (!worked) {
          await delay(500, undefined, { signal: this.controller.signal }).catch(() => {});
        }
      }
    } finally {
      await this.shutdown();
    }
  }

  private async runOne(): Promise<boolean> {
    await this.globalSemaphore.acquire(this.controller.signal);

    const leaseMs = 120000;
    let job: Job | null;
    try {
      job = await this.service.jobs.claim(this.config.workerId, leaseMs);
      if (!job || !job.leaseToken) return false;
    } catch {
      this.globalSemaphore.release();
      return false;
    }

    const token = job.leaseToken;
    const jobController = new AbortController();
    const cancel = () => jobController.abort();
    this.controller.signal.addEventListener('abort', cancel, { once: true });
    if (this.controller.signal.aborted) cancel();

    let renewing = false;
    const heartbeat = setInterval(() => {
      if (renewing) return;
      renewing = true;
      void this.service.jobs.heartbeat(job.id, token, leaseMs).then(alive => {
        if (!alive) jobController.abort();
      }).catch(() => jobController.abort()).finally(() => { renewing = false; });
    }, 20000);

    let context: WorkerContext | undefined;

    try {
      context = await this.acquireContext(job);
      this.activeContexts.set(job.id, context);

      const result = await this.executeJobWithRetries(job, context, jobController.signal);
      jobController.signal.throwIfAborted();

      const committed = await this.service.jobs.complete(job.id, token, result.result, result.status);
      if (!committed) throw new Error('Lease lost before completion');

      console.log(JSON.stringify({ event: 'job_completed', jobId: job.id, type: job.type, status: result.status, at: new Date().toISOString() }));
    } catch (error) {
      const info = errorInfo(error);
      if (jobController.signal.aborted) info.code = 'retryable';

      await transaction(this.service.pool, async client => {
        const committed = await this.service.jobs.fail(job.id, token, info, client);
        if (!committed) return;
        if (job.type === 'source_search') await settleDiscoveryFailures(client, job.id);
        if (job.type === 'download_artifact' && typeof job.payload['documentId'] === 'string') {
          await client.query(`UPDATE documents SET
            acquisition_status=CASE WHEN $4='restricted' THEN 'restricted' ELSE 'partial' END,
            availability=CASE WHEN $4='restricted' THEN 'restricted' WHEN $4='not_found' THEN 'unavailable' ELSE availability END
            WHERE id=$1 AND availability='available'
            AND EXISTS(SELECT 1 FROM jobs WHERE id=$2 AND attempts=$3 AND status<>'running')`,
          [job.payload['documentId'], job.id, job.attempts, info.code]);
          await client.query("INSERT INTO artifact_acquisition_attempts(document_id,outcome,observed_at,details) VALUES($1,$2,now(),$3)",
            [job.payload['documentId'], info.code, JSON.stringify({ jobId: job.id, error: info.message })]);
          if (typeof job.payload['caseId'] === 'string') await client.query("UPDATE cases SET acquisition_status='partial' WHERE id=$1", [job.payload['caseId']]);
        }
        if (job.type === 'refresh_case' && typeof job.payload['caseId'] === 'string') {
          if (info.code === 'restricted') {
            await client.query("UPDATE cases SET availability='restricted',acquisition_status='restricted' WHERE id=$1", [job.payload['caseId']]);
            await client.query("UPDATE documents SET availability='restricted' WHERE case_id=$1", [job.payload['caseId']]);
          } else {
            await client.query(`UPDATE cases SET next_refresh_at=CASE WHEN $3 IN ('retryable','lease_expired') THEN now()+interval '6 hours' ELSE NULL END,acquisition_status='partial'
              WHERE id=$1 AND availability='public' AND EXISTS(SELECT 1 FROM jobs WHERE id=$2 AND status='dead_letter')`,
            [job.payload['caseId'], job.id, info.code]);
          }
        }
      });
      console.error(JSON.stringify({ event: 'job_failed', jobId: job.id, type: job.type, ...info, at: new Date().toISOString() }));
    } finally {
      clearInterval(heartbeat);
      this.controller.signal.removeEventListener('abort', cancel);
      if (context) {
        this.activeContexts.delete(job.id);
        await this.releaseContext(context);
      }
      this.globalSemaphore.release();
    }

    return true;
  }

  private async acquireContext(job: Job): Promise<WorkerContext> {
    const proxy = await this.config.proxyManager.getNextProxy();

    const browser = await createStealthBrowserClientWithRetry({
      headed: process.env.COURT_BROWSER_HEADED === 'true',
      proxy,
      sessionPath: process.env.COURT_SESSION_FILE ?? undefined,
    }, 3, 2000);

    const semaphore = new Semaphore(1);

    return { proxy, browser, semaphore, attemptCount: 0 };
  }

  private async releaseContext(context: WorkerContext): Promise<void> {
    await context.browser.close().catch(() => {});
    await this.config.proxyManager.reportSuccess(context.proxy);
  }

  private async executeJobWithRetries(
    job: Job,
    context: WorkerContext,
    signal: AbortSignal
  ): Promise<{ status: 'complete' | 'partial'; result: Record<string, unknown> }> {
    let lastError: Error | undefined;
    const maxRetries = this.config.maxRetriesPerRequest;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      context.attemptCount = attempt;
      signal.throwIfAborted();

      try {
        const result = await this.executeJobCore(job, context, signal);
        return result;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        const isIdentityExpiration = this.isIdentityExpirationError(error);
        if (isIdentityExpiration) {
          console.log(`[AggressiveWorker] Identity expiration detected for job ${job.id}, attempt ${attempt + 1}/${maxRetries + 1} — cycling proxy`);
          await this.cycleIdentity(context);
          continue;
        }

        if (attempt < maxRetries) {
          const retryDelay = this.config.retryBaseDelayMs * Math.pow(2, attempt) + Math.floor(Math.random() * 1000);
          console.log(`[AggressiveWorker] Job ${job.id} attempt ${attempt + 1} failed: ${lastError.message}. Retrying in ${retryDelay}ms`);
          await delay(retryDelay, undefined, { signal });
          continue;
        }

        throw lastError;
      }
    }

    throw lastError ?? new Error('Max retries exceeded');
  }

  private isIdentityExpirationError(error: unknown): boolean {
    if (error instanceof Error) {
      const code = (error as { code?: string }).code;
      if (code === 'blocked' || code === 'retryable') return true;
      const message = error.message.toLowerCase();
      if (message.includes('403') || message.includes('429') || message.includes('rate limit') || message.includes('blocked')) return true;
    }
    return false;
  }

  private async cycleIdentity(context: WorkerContext): Promise<void> {
    const oldProxy = context.proxy;
    await context.browser.close().catch(() => {});

    const newProxy = await this.config.proxyManager.cycleIdentity(oldProxy);

    context.proxy = newProxy;
    context.browser = await createStealthBrowserClientWithRetry({
      headed: process.env.COURT_BROWSER_HEADED === 'true',
      proxy: newProxy,
      sessionPath: process.env.COURT_SESSION_FILE ?? undefined,
    }, 3, 2000);

    console.log(`[AggressiveWorker] Identity cycled from ${oldProxy.sessionId} to ${newProxy.sessionId} (egress: ${newProxy.egressIp})`);
  }

  private async executeJobCore(
    job: Job,
    context: WorkerContext,
    signal: AbortSignal
  ): Promise<{ status: 'complete' | 'partial'; result: Record<string, unknown> }> {
    const acquisitionContext = { signal };

    if (job.type === 'source_search') {
      const query = this.adapter.validateSearch(job.payload['query']);
      const partitionId = typeof job.payload['partitionId'] === 'string' ? job.payload['partitionId'] : null;

      const observation = await this.adapter.searchCases(query, acquisitionContext);
      if (observation.sourceId !== query.sourceId) throw new Error('Search source identity mismatch');

      const children: string[] = [];
      const limitations = [...observation.limitations, ...(observation.truncated ? ['Result limit reached'] : [])];

      await transaction(this.service.pool, async client => {
        await fence(this.service.pool, job);
        if (partitionId && !(await client.query('SELECT 1 FROM discovery_partitions WHERE id=$1 AND last_job_id=$2 FOR UPDATE', [partitionId, job.id])).rowCount)
          throw new Error('Discovery partition changed before checkpoint');

        const { readRefreshPolicy } = await import('./refresh.js');
        const refreshPolicy = query.acquireResults === false ? undefined : await readRefreshPolicy(client);
        for (const candidate of observation.cases) {
          const row = (await client.query<{ id: string; availability: string }>(`INSERT INTO cases(source_id,source_case_id,case_number,title,court,status,metadata)
            VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(source_id,source_case_id) DO UPDATE SET updated_at=now() RETURNING id,availability`,
          [query.sourceId, candidate.sourceCaseId, candidate.caseNumber, candidate.title, candidate.court, candidate.status, JSON.stringify({ raw: candidate.raw })])).rows[0]!;
          if (refreshPolicy && row.availability === 'public') {
            const child = await enqueueCaseRefresh(this.service, client, row.id, `search:${job.id}:${row.id}`, refreshPolicy, job.id);
            await client.query('INSERT INTO job_links(parent_id,child_id) VALUES($1,$2) ON CONFLICT DO NOTHING', [job.id, child.id]);
            children.push(child.id);
          }
        }
        await client.query(`INSERT INTO coverage_observations(source_id,partition_id,dimension,scope,observed_count,denominator,status,limitations,observed_at,job_id)
          VALUES($1,$2,'discovery',$3,$4,NULL,$5,$6,$7,$8) ON CONFLICT(job_id,dimension) DO UPDATE SET observed_count=EXCLUDED.observed_count,status=EXCLUDED.status,limitations=EXCLUDED.limitations,observed_at=EXCLUDED.observed_at`,
        [query.sourceId, partitionId, JSON.stringify(query), observation.cases.length, observation.truncated ? 'truncated' : !observation.complete ? 'partial' : 'observed', JSON.stringify(limitations), observation.observedAt, job.id]);
        let split = false;
        if (partitionId && observation.truncated && query.filedFrom && query.filedTo && query.filedFrom < query.filedTo) {
          const start = Date.parse(query.filedFrom), end = Date.parse(query.filedTo), day = 86400000;
          const middle = start + Math.floor((end - start) / day / 2) * day;
          for (const range of [{ filedFrom: query.filedFrom, filedTo: new Date(middle).toISOString().slice(0, 10) }, { filedFrom: new Date(middle + day).toISOString().slice(0, 10), filedTo: query.filedTo }]) {
            const childQuery = this.adapter.validateSearch({ ...query, ...range });
            const childHash = sha256(JSON.stringify(childQuery));
            await client.query("INSERT INTO discovery_partitions(source_id,query,query_hash,status,parent_id,limitations,next_run_at) VALUES($1,$2,$3,'pending',$4,'[]',now()) ON CONFLICT(source_id,query_hash) DO NOTHING", [query.sourceId, JSON.stringify(childQuery), childHash, partitionId]);
          }
          split = true;
        }
        if (partitionId) await client.query("UPDATE discovery_partitions SET status=$2,observed_count=$3,limitations=$4,recovery_count=0,last_error_code=NULL,next_run_at=CASE WHEN $2 IN ('split','saturated') THEN NULL ELSE now()+interval '1 day' END,updated_at=now() WHERE id=$1",
          [partitionId, split ? 'split' : observation.truncated ? 'saturated' : !observation.complete ? 'partial' : 'complete', observation.cases.length, JSON.stringify(limitations)]);
      });

      return { status: observation.truncated || !observation.complete ? 'partial' : 'complete', result: { observed: observation.cases.length, truncated: observation.truncated, coverage: 'unknown', childJobIds: children, completionScope: 'source observation only', limitations } };
    }

    if (job.type === 'refresh_case') {
      if (!job.sourceId) throw new Error('Refresh has no source');
      const observation = await this.adapter.fetchCase(String(job.payload['sourceCaseId']), acquisitionContext);
      if (observation.sourceId !== job.sourceId) throw new Error('Docket source identity mismatch');
      const { reconcileObservation } = await import('./reconcile.js');
      const saved = await reconcileObservation(this.service.pool, observation, client => fence(this.service.pool, job));
      const children: string[] = [];
      for (const documentId of saved.documents) {
        const child = await enqueueChild(this.service, job, { type: 'download_artifact', sourceId: job.sourceId, payload: { documentId, caseId: saved.caseId }, idempotencyKey: `snapshot:${saved.snapshotId}:${documentId}` });
        children.push(child.id);
      }
      await transaction(this.service.pool, async client => {
        await fence(this.service.pool, job);
        await (await import('./refresh.js')).scheduleNextRefresh(client, saved.caseId);
      });
      return { status: saved.complete ? 'complete' : 'partial', result: { caseId: saved.caseId, snapshotId: saved.snapshotId, acquisitionStatus: children.length ? 'partial' : saved.complete ? 'complete' : 'partial', childJobIds: children } };
    }

    if (job.type === 'download_artifact') {
      const z = (await import('zod')).default;
      const documentId = z.string().uuid().parse(job.payload['documentId']);
      const row = (await this.service.pool.query<{ source_id: string; reference: unknown; case_id: string }>(
        `SELECT d.source_id,d.reference,c.id AS case_id FROM documents d JOIN cases c ON c.id=d.case_id WHERE d.id=$1`, [documentId])).rows[0];
      if (!row) throw new Error('Document not found');
      const artifact = await this.adapter.fetchDocument(row.reference as { sourceDocumentId: string; caseNumber: string; availability: 'available' | 'restricted' | 'unavailable' | 'unknown'; entryKey: string; title: string; raw: Record<string, unknown> }, acquisitionContext);
      const pdfValidation = await validatePdf(artifact.bytes, artifact.contentType);
      if (!pdfValidation) throw new Error('Downloaded content is not a valid PDF');
      const artifactRecord = await this.service.store.put(artifact.bytes);
      const versionResult = await this.service.pool.query<{ id: string }>(
        `INSERT INTO document_versions(document_id,filename,source_url,acquired_at,artifact_id) VALUES($1,$2,$3,$4,$5) RETURNING id`,
        [documentId, artifact.filename, artifact.sourceUrl, artifact.acquiredAt, artifactRecord.storageKey]
      );
      const versionId = versionResult.rows[0]!.id;
      await this.service.pool.query(`UPDATE documents SET current_version_id=$1,availability='available',acquisition_status='complete',updated_at=now() WHERE id=$2`, [versionId, documentId]);
      return { status: 'complete', result: { documentId, artifactId: artifactRecord.storageKey, bytes: artifact.bytes.length, versionId } };
    }
    throw new Error(`Unknown job type: ${job.type}`);
  }

  async shutdown(): Promise<void> {
    if (this.controller.signal.aborted) return;
    console.log(`[AggressiveWorker] Shutting down worker ${this.config.workerId}`);
    this.controller.abort();

    for (const [jobId, context] of this.activeContexts) {
      await this.releaseContext(context);
    }
    this.activeContexts.clear();

    await this.config.proxyManager.shutdown();
    await this.adapter.close();
  }

  getStats(): { workerId: string; activeJobs: number; semaphoreAvailable: number; semaphoreWaiting: number; proxyPool: ReturnType<HighAggressionProxyManager['getPoolStatus']> } {
    return {
      workerId: this.config.workerId,
      activeJobs: this.activeContexts.size,
      semaphoreAvailable: this.globalSemaphore.available,
      semaphoreWaiting: this.globalSemaphore.waiting,
      proxyPool: this.config.proxyManager.getPoolStatus(),
    };
  }
}

export async function runAggressiveWorker(config?: Partial<AggressiveWorkerConfig> & { adapter?: AggressiveMinnesotaAdapter }): Promise<void> {
  const app = await createApplication();
  const proxyManager = config?.proxyManager ?? (await import('./proxy-manager.js')).createProxyManagerFromEnv();
  const adapter = config?.adapter ?? new (await import('./aggressive-adapter.js')).AggressiveMinnesotaAdapter({ proxyManager });
  const worker = new AggressiveWorker(app.service, adapter, { ...config, proxyManager });
  await worker.start();
  await app.close();
}