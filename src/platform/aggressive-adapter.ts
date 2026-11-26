import { createHash } from 'crypto';
import { z } from 'zod';
import { setTimeout as delay } from 'timers/promises';
import type { CourtSourceAdapter, CourtSearchQuery, SourceMetadata, SourceCapabilities, SearchObservation, CaseObservation, DocumentReference, ArtifactObservation, AcquisitionContext, CaseCandidate } from './contracts.js';
import { executeSearch } from '../search.js';
import { navigateToCaseDetails } from '../roa.js';
import { downloadDocument, createDocumentKey, safeCaseNumber, caseNumbersEqual, normalizeCaseNumber } from '../downloader.js';
import { mapRoa, type LegacyRoa, legacyCase, legacyRoa, legacyDocument, legacyEvent, sanitizeSourceDataAdapter, validateAdapter } from './adapters.js';
import type { StealthBrowserClient } from './stealth-browser.js';
import { HighAggressionProxyManager, type ProxyEndpoint } from './proxy-manager.js';
import { createStealthBrowserClientWithRetry } from './stealth-browser.js';

const version = '1.0.0';
const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const now = (): string => new Date().toISOString();
const record = z.record(z.string(), z.unknown());
function sanitized(value: unknown): Record<string, unknown> { return record.parse(sanitizeSourceDataAdapter(value)); }
function candidate(value: z.infer<typeof legacyCase>): CaseCandidate {
  return { sourceCaseId: value.caseNumber, caseNumber: value.caseNumber, title: value.caseTitle, court: value.caseLocation, status: value.caseStatus, raw: sanitized(value) };
}
function documentEvent(event: z.infer<typeof legacyEvent>, document: z.infer<typeof legacyDocument>) { return { ...event, document, hasDocument: true }; }
function createDocumentKeyLocal(event: { document?: { sourceDocumentId?: string; documentId?: string }; sourceDocumentId?: string }): string {
  return event.document?.sourceDocumentId || event.document?.documentId || event.sourceDocumentId || '';
}

export interface AggressiveAdapterOptions {
  proxyManager: HighAggressionProxyManager;
  headed?: boolean | undefined;
  executablePath?: string | undefined;
  sessionPath?: string | undefined;
  maxBrowserRetries?: number;
  browserRetryDelayMs?: number;
}

export class AggressiveMinnesotaAdapter implements CourtSourceAdapter {
  private proxyManager: HighAggressionProxyManager;
  private browserOptions: {
    headed?: boolean | undefined;
    executablePath?: string | undefined;
    sessionPath?: string | undefined;
  };
  private maxBrowserRetries: number;
  private browserRetryDelayMs: number;
  private client: StealthBrowserClient | undefined;
  private pending: Promise<void> = Promise.resolve();
  private cachedRoa: { caseNumber: string; roa: LegacyRoa; observedAt: number } | undefined;
  private currentProxy: ProxyEndpoint | undefined;

  constructor(options: AggressiveAdapterOptions) {
    this.proxyManager = options.proxyManager;
    this.browserOptions = {
      headed: options.headed ?? undefined,
      executablePath: options.executablePath ?? undefined,
      sessionPath: options.sessionPath ?? undefined,
    };
    this.maxBrowserRetries = options.maxBrowserRetries ?? 3;
    this.browserRetryDelayMs = options.browserRetryDelayMs ?? 2000;
  }

  metadata(): SourceMetadata { return { id: 'mn-mcro', state: 'MN', name: 'Minnesota Court Records Online', baseUrl: 'https://publicaccess.courts.state.mn.us/', adapterVersion: version, fixture: false }; }
  capabilities(): SourceCapabilities { return { searchModes: { case: { required: ['caseNumber OR citationNumber'], optional: ['caseNumber', 'citationNumber'], verified: 'documented', limitations: [] }, party: { required: ['lastName', 'firstName'], optional: ['lastName', 'firstName', 'middleName', 'dobFrom', 'dobTo', 'soundex', 'county', 'counties', 'categories', 'status', 'filedFrom', 'filedTo'], verified: 'documented', limitations: ['Name searches omit pending criminal matters; absent results do not establish absence of a case.'] } }, resultLimit: 200, exhaustiveDiscovery: false, notes: ['High-aggression stealth extraction with rotating residential proxies', 'COURT_ALLOW_LIVE_MN=true required before browser or portal access.'] }; }
  validateSearch(query: unknown): CourtSearchQuery { return validateAdapter(query, 'mn-mcro'); }

  private async ensureBrowser(proxy: ProxyEndpoint): Promise<StealthBrowserClient> {
    if (this.client && this.currentProxy?.sessionId === proxy.sessionId && !this.client.page.isClosed()) {
      return this.client;
    }

    if (this.client) {
      await this.client.close().catch(() => {});
      this.client = undefined;
    }

    this.client = await createStealthBrowserClientWithRetry({
      headed: this.browserOptions.headed,
      executablePath: this.browserOptions.executablePath,
      sessionPath: this.browserOptions.sessionPath,
      proxy,
    }, this.maxBrowserRetries, this.browserRetryDelayMs);

    this.currentProxy = proxy;
    return this.client;
  }

  private async executeWithIdentityRotation<T>(
    context: AcquisitionContext,
    operation: (client: StealthBrowserClient, proxy: ProxyEndpoint) => Promise<T>
  ): Promise<T> {
    context.signal?.throwIfAborted();

    let proxy = await this.proxyManager.getNextProxy();
    let browser = await this.ensureBrowser(proxy);

    for (let attempt = 0; attempt < 5; attempt++) {
      context.signal?.throwIfAborted();

      try {
        const result = await operation(browser, proxy);
        await this.proxyManager.reportSuccess(proxy);
        return result;
      } catch (error) {
        const isIdentityExpiration = this.isIdentityExpirationError(error);
        if (isIdentityExpiration) {
          console.log(`[AggressiveAdapter] Identity expiration detected — cycling proxy ${proxy.sessionId}`);
          proxy = await this.proxyManager.cycleIdentity(proxy);
          browser = await this.ensureBrowser(proxy);
          continue;
        }

        if (attempt < 4) {
          const retryDelay = Math.min(1000 * Math.pow(2, attempt) + Math.floor(Math.random() * 1000), 10000);
          console.log(`[AggressiveAdapter] Attempt ${attempt + 1} failed: ${error instanceof Error ? error.message : String(error)}. Retrying in ${retryDelay}ms`);
          await delay(retryDelay, undefined, { signal: context.signal });
          continue;
        }

        throw error;
      }
    }

    throw new Error('Max retries exceeded in executeWithIdentityRotation');
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

  async searchCases(query: CourtSearchQuery, context: AcquisitionContext): Promise<SearchObservation> {
    const validated = this.validateSearch(query);

    return this.executeWithIdentityRotation(context, async ({ page }) => {
      const raw: unknown = await executeSearch(page, validated);
      if (validated.searchType === 'document') {
        const result = z.object({ caseNumberRaw: z.string(), caseTitle: z.string(), noResults: z.boolean() }).passthrough().parse(raw);
        if (!result.noResults && !caseNumbersEqual(result.caseNumberRaw, validated.caseNumber)) throw new Error('Document search returned the wrong case');
        const caseNumber = normalizeCaseNumber(result.caseNumberRaw);
        return { sourceId: 'mn-mcro', query: validated, observedAt: now(), cases: result.noResults ? [] : [{ sourceCaseId: caseNumber, caseNumber, title: result.caseTitle, court: '', status: '', raw: sanitized(result) }], truncated: false, complete: true, limitations: ['Document availability is limited to public online filings.'], raw: sanitized(result) };
      }
      const result = z.object({ cases: z.array(legacyCase), truncated: z.boolean().optional() }).passthrough().parse(raw);
      return { sourceId: 'mn-mcro', query: validated, observedAt: now(), cases: result.cases.map(candidate), truncated: !!result.truncated, complete: !result.truncated, limitations: result.truncated ? ['Source result limit or unconsumed next page observed; discovery is incomplete.'] : [], raw: sanitized(result) };
    });
  }

  private async docket(page: import('playwright').Page, identifier: string): Promise<LegacyRoa> {
    const query = this.validateSearch({ sourceId: 'mn-mcro', searchType: 'case', caseNumber: identifier });
    const result = z.object({ cases: z.array(legacyCase) }).parse(await executeSearch(page, query));
    const matches = result.cases.filter((item: z.infer<typeof legacyCase>) => item.caseNumber && caseNumbersEqual(item.caseNumber, identifier));
    if (!matches.length) throw new Error('Case was not returned by the source');
    if (matches.length !== 1) throw new Error('Case search returned ambiguous matches');
    const roa = legacyRoa.parse(await navigateToCaseDetails(page, matches[0]));
    if (!roa.caseInfo.caseNumber || !caseNumbersEqual(roa.caseInfo.caseNumber, identifier)) throw new Error('Observed docket identity differs from requested case');
    this.cachedRoa = { caseNumber: identifier, roa, observedAt: Date.now() };
    return roa;
  }

  async fetchCase(identifier: string, context: AcquisitionContext): Promise<CaseObservation> {
    return this.executeWithIdentityRotation(context, async ({ page }) => {
      const roa = await this.docket(page, identifier);
      return mapRoa(roa);
    });
  }

  async fetchDocument(reference: DocumentReference, context: AcquisitionContext): Promise<ArtifactObservation> {
    return this.executeWithIdentityRotation(context, async ({ page }) => {
      if (reference.availability === 'restricted') throw new Error('Document is restricted');

      let roa: LegacyRoa;
      let reused = false;
      if (
        this.cachedRoa &&
        caseNumbersEqual(this.cachedRoa.caseNumber, reference.caseNumber) &&
        Date.now() - this.cachedRoa.observedAt < 300000 &&
        !page.isClosed() &&
        page.url().includes('ViewCaseDetails')
      ) {
        roa = this.cachedRoa.roa;
        reused = true;
      } else {
        roa = await this.docket(page, reference.caseNumber);
      }

      type DocEvent = { document: z.infer<typeof legacyDocument> & { sourceDocumentId: string }; sourceDocumentId?: string; indexText?: string; date?: string; description?: string; index?: number };
      let matches = roa.events.flatMap((event: z.infer<typeof legacyEvent>) => event.documents.map((document: z.infer<typeof legacyDocument>) => ({ ...event, document: { ...document, sourceDocumentId: document.sourceDocumentId || '' }, hasDocument: true } as DocEvent))).filter((event) => createDocumentKeyLocal(event) === reference.sourceDocumentId);
      if (matches.length !== 1 && reused) {
        this.cachedRoa = undefined;
        roa = await this.docket(page, reference.caseNumber);
        matches = roa.events.flatMap((event: z.infer<typeof legacyEvent>) => event.documents.map((document: z.infer<typeof legacyDocument>) => ({ ...event, document: { ...document, sourceDocumentId: document.sourceDocumentId || '' }, hasDocument: true } as DocEvent))).filter((event) => createDocumentKeyLocal(event) === reference.sourceDocumentId);
      }
      if (matches.length !== 1) throw new Error(matches.length ? 'parse_error' : 'not_found', { cause: new Error('Document identity could not be uniquely reacquired; refusing ordinal fallback') });

      let acquired: Awaited<ReturnType<typeof downloadDocument>> | null = null;
      try {
        acquired = await downloadDocument(page, matches[0], reference.caseNumber);
      } catch (error) {
        if (!reused) throw error;
        this.cachedRoa = undefined;
        roa = await this.docket(page, reference.caseNumber);
        const freshMatches = roa.events.flatMap((event: z.infer<typeof legacyEvent>) => event.documents.map((document: z.infer<typeof legacyDocument>) => ({ ...event, document: { ...document, sourceDocumentId: document.sourceDocumentId || '' }, hasDocument: true } as DocEvent))).filter((event) => createDocumentKeyLocal(event) === reference.sourceDocumentId);
        if (freshMatches.length !== 1) throw error;
        acquired = await downloadDocument(page, freshMatches[0], reference.caseNumber);
      }
      if (!acquired) throw new Error('Document acquisition returned no artifact');

      return { bytes: acquired.buffer, filename: acquired.filename, contentType: 'application/pdf', acquiredAt: now() };
    });
  }

  async close(): Promise<void> {
    await this.pending;
    this.cachedRoa = undefined;
    if (this.client) {
      await this.client.close();
      this.client = undefined;
    }
  }
}

export function createAggressiveAdapter(options: AggressiveAdapterOptions): CourtSourceAdapter {
  return new AggressiveMinnesotaAdapter(options);
}