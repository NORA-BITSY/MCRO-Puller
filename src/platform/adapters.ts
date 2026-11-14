import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { CourtSearchQuerySchema, SourceError } from './contracts.js';
import type { CourtSourceAdapter, CourtSearchQuery, SourceMetadata, SourceCapabilities, SearchObservation, CaseObservation, CaseCandidate, DocketEntry, DocumentReference, AcquisitionContext, ArtifactObservation } from './contracts.js';
import { createBrowserClient, installSourceRequestGate } from '../browser.js';
import type { BrowserClient, SourceRequestGate } from '../browser.js';
import type { Page } from 'playwright';
import { executeSearch, validateSearchOptions, SEARCH_MODES, sanitizeSourceData } from '../search.js';
import { navigateToCaseDetails } from '../roa.js';
import { createDocumentKey, downloadDocument } from '../downloader.js';
import { requireLiveMn, caseNumbersEqual, normalizeCaseNumber } from '../waf.js';
import { eventIdentity } from './identity.js';

const version = '1.0.0';
const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const now = (): string => new Date().toISOString();
const record = z.record(z.string(), z.unknown());
function sanitized(value: unknown): Record<string, unknown> { return record.parse(sanitizeSourceData(value)); }
function validate(input: unknown, sourceId: string): CourtSearchQuery {
  const parsed = CourtSearchQuerySchema.parse(input);
  if (parsed.sourceId !== sourceId) throw new SourceError('permanent', `Expected sourceId ${sourceId}`);
  try { validateSearchOptions(parsed); } catch (error) { throw new SourceError('permanent', error instanceof Error ? error.message : String(error), { cause: error }); }
  return parsed;
}
function capabilities(fixture: boolean): SourceCapabilities {
  return {
    searchModes: Object.fromEntries(Object.entries(SEARCH_MODES).map(([mode, shape]) => [mode, { required: shape.required, optional: shape.optional, verified: fixture ? 'fixture' : 'documented', limitations: fixture ? ['Synthetic records only; not a second real jurisdiction.'] : ['Documented in Minnesota SCAO 2022-08-05 guides; current live execution has not been verified.', ...(mode === 'party' || mode === 'business' || mode === 'hearing' ? ['Name searches omit pending criminal matters; absent results do not establish absence of a case.'] : [])] }])),
    resultLimit: fixture ? null : 200,
    exhaustiveDiscovery: fixture,
    notes: fixture ? ['Independent synthetic IDs, record format, cursor pagination, source ordering, multiple attachments and restricted-artifact scenario.'] : ['COURT_ALLOW_LIVE_MN=true required before browser or portal access.', 'No CAPTCHA bypass, stealth, proxy rotation, or claim of statewide exhaustive discovery.', 'Raw source section labels and non-document events are preserved; unavailable public records remain outside coverage.'],
  };
}

const legacyCase = z.object({ caseNumber: z.string(), caseTitle: z.string().default(''), caseLocation: z.string().default(''), caseStatus: z.string().default(''), detailsHref: z.string().nullable().optional() }).passthrough();
const legacyDocument = z.object({ sourceDocumentId: z.string().optional(), pages: z.string().default(''), title: z.string().optional(), downloadToken: z.string().default(''), requestVerificationToken: z.string().default(''), formAction: z.string().optional(), formIndex: z.number().optional() }).passthrough();
const legacyEvent = z.object({ index: z.number(), sourceId: z.string().optional(), date: z.string(), description: z.string(), indexText: z.string(), documents: z.array(legacyDocument) }).passthrough();
const legacyRoa = z.object({ caseInfo: legacyCase, parties: z.array(z.string()), events: z.array(legacyEvent), sections: z.array(record), rawText: z.string() }).passthrough();
type LegacyRoa = z.infer<typeof legacyRoa>;
function candidate(value: z.infer<typeof legacyCase>): CaseCandidate {
  return { sourceCaseId: value.caseNumber, caseNumber: value.caseNumber, title: value.caseTitle, court: value.caseLocation, status: value.caseStatus, raw: sanitized(value) };
}
function documentEvent(event: z.infer<typeof legacyEvent>, document: z.infer<typeof legacyDocument>) { return { ...event, document, hasDocument: true }; }
export function mapRoa(roa: LegacyRoa): CaseObservation {
  const counts = new Map<string, number>();
  const entries: DocketEntry[] = roa.events.map((event, sourceOrder) => {
    const identity = eventIdentity(event);
    counts.set(identity, (counts.get(identity) || 0) + 1);
    const occurrence = counts.get(identity)!;
    const identityKey = occurrence > 1 ? `${identity}:ambiguous:${occurrence}` : identity;
    const documents = event.documents.map((document): DocumentReference => ({
      sourceDocumentId: createDocumentKey(documentEvent(event, document)), entryKey: identityKey, caseNumber: roa.caseInfo.caseNumber, title: document.title || event.description,
      availability: document.downloadToken ? 'available' : 'unknown', raw: sanitized({ ...document, eventIndexText: event.indexText, eventDate: event.date, eventDescription: event.description }),
    }));
    return { identityKey, ...(event.sourceId ? { sourceId: event.sourceId } : {}), sourceOrder, date: event.date || null, title: event.description, documents, raw: sanitized(event), identityConfidence: event.sourceId ? 'source' : 'derived' };
  });
  const allDocuments = entries.flatMap((entry) => entry.documents);
  if (new Set(allDocuments.map((doc) => doc.sourceDocumentId)).size !== allDocuments.length) throw new SourceError('parse_error', 'Docket has ambiguous document identities; refusing ordinal attachment matching');
  for (const entry of entries) if ((counts.get(entry.sourceId || entry.identityKey.split(':ambiguous:')[0]!) || 0) > 1) entry.identityConfidence = 'ambiguous';
  const participants=roa.parties.map(rawLabel=>{
    const rolePattern='Attorney|Judge|Judicial Officer|Plaintiff|Defendant|Petitioner|Respondent|Organization|Business';
    const suffix=new RegExp(`^([\\s\\S]+?)\\s*(?:—|–|\\n|:)\\s*(${rolePattern})\\s*$`,'i').exec(rawLabel);
    const prefix=new RegExp(`^(${rolePattern})\\s*:\\s*([\\s\\S]+)$`,'i').exec(rawLabel);
    const name=(suffix?.[1]??prefix?.[2]??rawLabel).trim();
    const role=(suffix?.[2]??prefix?.[1]??'').toLowerCase();
    const kind=/attorney/.test(role)?'attorney':/judge|judicial officer/.test(role)?'judge':/organization|business/.test(role)?'organization':'unknown';
    return {name,role,kind,rawLabel};
  });
  if(typeof roa.caseInfo['judicialOfficer']==='string'&&roa.caseInfo['judicialOfficer'].trim())participants.push({name:roa.caseInfo['judicialOfficer'].trim(),role:'judicial officer',kind:'judge',rawLabel:`Judicial Officer: ${roa.caseInfo['judicialOfficer']}`});
  return { sourceId: 'mn-mcro', sourceCaseId: roa.caseInfo.caseNumber, caseNumber: roa.caseInfo.caseNumber, title: roa.caseInfo.caseTitle, court: roa.caseInfo.caseLocation, status: roa.caseInfo.caseStatus, observedAt: now(), complete: entries.every((entry) => entry.identityConfidence !== 'ambiguous'), entries, participants, sections: Object.fromEntries(roa.sections.map((section, index) => [typeof section.id === 'string' ? section.id : `section-${index}`, sanitized(section)])), raw: sanitized({ caseInfo: roa.caseInfo, rawText: roa.rawText }) };
}

export class MinnesotaAdapter implements CourtSourceAdapter {
  private client: BrowserClient | undefined;
  private pending: Promise<void> = Promise.resolve();
  constructor(private readonly mode: 'extension' | 'standalone' = 'standalone') {}
  metadata(): SourceMetadata { return { id: 'mn-mcro', state: 'MN', name: 'Minnesota Court Records Online', baseUrl: 'https://publicaccess.courts.state.mn.us/', adapterVersion: version, fixture: false,processOptInEnvironment:'COURT_ALLOW_LIVE_MN' }; }
  capabilities(): SourceCapabilities { return capabilities(false); }
  validateSearch(query: unknown): CourtSearchQuery { return validate(query, 'mn-mcro'); }
  private async exclusive<T>(context: AcquisitionContext, operation: (client: BrowserClient) => Promise<T>): Promise<T> {
    requireLiveMn(); context.signal?.throwIfAborted();
    const result = this.pending.then(async () => {
      let gate: SourceRequestGate | undefined;
      try {
        context.signal?.throwIfAborted();
        this.client ||= await createBrowserClient({ mode: this.mode });
        if (context.beforeRequest || context.signal) gate = await installSourceRequestGate(this.client.context, context);
        let value: T;
        try { value = await operation(this.client); }
        catch (error) { throw gate?.error || error; }
        if (gate?.error) throw gate.error;
        context.signal?.throwIfAborted();
        return value;
      } catch (error) {
        if (error instanceof SourceError) throw error;
        if (error instanceof Error && 'code' in error) {
          const code = z.enum(['blocked', 'restricted', 'not_found', 'retryable', 'permanent', 'parse_error', 'unsupported']).safeParse(error.code);
          if (code.success) throw new SourceError(code.data, error.message, {
            cause: error,
            ...('retryAfterMs' in error && typeof error.retryAfterMs === 'number' ? { retryAfterMs: error.retryAfterMs } : {}),
          });
        }
        throw error;
      }
      finally { await gate?.close(); }
    });
    this.pending = result.then(() => undefined, () => undefined);
    return result;
  }
  async searchCases(query: CourtSearchQuery, context: AcquisitionContext): Promise<SearchObservation> {
    const validated = this.validateSearch(query);
    return this.exclusive(context, async ({ page }) => {
      const raw: unknown = await executeSearch(page, validated);
      if (validated.searchType === 'document') {
        const result = z.object({ caseNumberRaw: z.string(), caseTitle: z.string(), noResults: z.boolean() }).passthrough().parse(raw);
        if (!result.noResults && !caseNumbersEqual(result.caseNumberRaw, validated.caseNumber)) throw new SourceError('parse_error', 'Document search returned the wrong case');
        const caseNumber = normalizeCaseNumber(result.caseNumberRaw);
        return { sourceId: 'mn-mcro', query: validated, observedAt: now(), cases: result.noResults ? [] : [{ sourceCaseId: caseNumber, caseNumber, title: result.caseTitle, court: '', status: '', raw: sanitized(result) }], truncated: false, complete: true, limitations: ['Document availability is limited to public online filings.'], raw: sanitized(result) };
      }
      const result = z.object({ cases: z.array(legacyCase), truncated: z.boolean().optional() }).passthrough().parse(raw);
      return { sourceId: 'mn-mcro', query: validated, observedAt: now(), cases: result.cases.map(candidate), truncated: !!result.truncated, complete: !result.truncated, limitations: result.truncated ? ['Source result limit or unconsumed next page observed; discovery is incomplete.'] : [], raw: sanitized(result) };
    });
  }
  private async docket(page: Page, identifier: string): Promise<LegacyRoa> {
    const query = this.validateSearch({ sourceId: 'mn-mcro', searchType: 'case', caseNumber: identifier });
    const result = z.object({ cases: z.array(legacyCase) }).parse(await executeSearch(page, query));
    const matches = result.cases.filter((item) => item.caseNumber && caseNumbersEqual(item.caseNumber, identifier));
    if (!matches.length) throw new SourceError('not_found', 'Case was not returned by the source');
    if (matches.length !== 1) throw new SourceError('parse_error', 'Case search returned ambiguous matches');
    const roa = legacyRoa.parse(await navigateToCaseDetails(page, matches[0]));
    if (!roa.caseInfo.caseNumber || !caseNumbersEqual(roa.caseInfo.caseNumber, identifier)) throw new SourceError('parse_error', 'Observed docket identity differs from requested case');
    return roa;
  }
  async fetchCase(identifier: string, context: AcquisitionContext): Promise<CaseObservation> { return this.exclusive(context, async ({ page }) => mapRoa(await this.docket(page, identifier))); }
  async fetchDocument(reference: DocumentReference, context: AcquisitionContext): Promise<ArtifactObservation> {
    return this.exclusive(context, async ({ page }) => {
      if (reference.availability === 'restricted') throw new SourceError('restricted', 'Document is restricted');
      const roa = await this.docket(page, reference.caseNumber);
      const matches = roa.events.flatMap((event) => event.documents.map((document) => documentEvent(event, document))).filter((event) => createDocumentKey(event) === reference.sourceDocumentId);
      if (matches.length !== 1) throw new SourceError(matches.length ? 'parse_error' : 'not_found', 'Document identity could not be uniquely reacquired; refusing ordinal fallback');
      const acquired = await downloadDocument(page, matches[0], reference.caseNumber);
      if (!acquired) throw new SourceError('retryable', 'Document acquisition returned no artifact');
      return { bytes: acquired.buffer, filename: acquired.filename, contentType: 'application/pdf', acquiredAt: now() };
    });
  }
  async close(): Promise<void> { await this.pending; if (this.client) { await this.client.close(); this.client = undefined; } }
}

const assetSchema = z.object({ assetId: z.string().min(1), title: z.string(), file: z.string().optional(), access: z.enum(['available', 'restricted', 'unavailable', 'unknown']) });
const fixtureRecord = z.object({
  recordId: z.string(), displayNumber: z.string(), caption: z.string(), tribunal: z.string(), region: z.string(), lifeCycle: z.string(), category: z.string(), filedOn: z.string(), citation: z.string(),
  people: z.array(z.object({ name: z.string(), given: z.string(), family: z.string(), middle: z.string().optional(), born: z.string(), role: z.string() })),
  organizations: z.array(z.string()), lawyers: z.array(z.object({ given: z.string(), family: z.string(), middle: z.string().optional(), bar: z.string() })),
  hearings: z.array(z.object({ date: z.string(), judge: z.string(), label: z.string(), outcome: z.string() })),
  judgments: z.array(z.object({ docketed: z.string(), status: z.string(), debtor: z.string(), amount: z.string() })),
  ledger: z.array(z.object({ eventId: z.string(), when: z.string().nullable(), label: z.string(), rawLabel: z.string(), attachments: z.array(assetSchema) })),
});
const fixtureSchema = z.object({ format: z.literal('independent-fixture/1'), description: z.string(), pageSize: z.number().int().min(1).max(100), records: z.array(fixtureRecord) }).superRefine((data, context) => {
  const records = new Set<string>(); const numbers = new Set<string>();
  for (const item of data.records) {
    if (records.has(item.recordId) || numbers.has(item.displayNumber)) context.addIssue({ code: 'custom', message: `Duplicate fixture case/record identity: ${item.recordId}` });
    records.add(item.recordId); numbers.add(item.displayNumber);
    const events = new Set<string>(); const documents = new Set<string>();
    for (const event of item.ledger) {
      if (events.has(event.eventId)) context.addIssue({ code: 'custom', message: `Duplicate fixture event identity: ${event.eventId}` });
      events.add(event.eventId);
      for (const document of event.attachments) {
        if (documents.has(document.assetId)) context.addIssue({ code: 'custom', message: `Duplicate fixture document identity: ${document.assetId}` });
        documents.add(document.assetId);
        if (document.access === 'available' && !document.file) context.addIssue({ code: 'custom', message: `Available fixture artifact lacks file: ${document.assetId}` });
        if (document.file && path.basename(document.file) !== document.file) context.addIssue({ code: 'custom', message: 'Fixture artifact must be a sibling filename' });
      }
    }
  }
});
type FixtureRecord = z.infer<typeof fixtureRecord>;
function fixturePath(): string {
  const local = fileURLToPath(new URL('../../test/fixtures/adapters/independent.json', import.meta.url));
  return existsSync(local) ? local : fileURLToPath(new URL('../../../test/fixtures/adapters/independent.json', import.meta.url));
}
function soundex(value: string): string {
  const letters = value.toUpperCase().replace(/[^A-Z]/g, '');
  const code = (letter: string): string => 'BFPV'.includes(letter) ? '1' : 'CGJKQSXZ'.includes(letter) ? '2' : 'DT'.includes(letter) ? '3' : letter === 'L' ? '4' : 'MN'.includes(letter) ? '5' : letter === 'R' ? '6' : '0';
  let result = letters[0] || ''; let last = result ? code(result) : '0';
  for (const letter of letters.slice(1)) { const next = code(letter); if (next !== '0' && next !== last) result += next; last = next; }
  return result.padEnd(4, '0').slice(0, 4);
}
function matches(value: string | undefined, expected: string | undefined, approximate = false): boolean {
  if (expected === undefined) return true;
  if (value === undefined) return false;
  if (approximate) return soundex(value) === soundex(expected);
  return expected.endsWith('*') ? value.toLowerCase().startsWith(expected.slice(0, -1).toLowerCase()) : value.toLowerCase() === expected.toLowerCase();
}
function between(value: string, from?: string, to?: string): boolean {
  if (!from) return !to || value <= to;
  return value >= from && value <= (to || from);
}
function fixtureMatches(item: FixtureRecord, query: CourtSearchQuery): boolean {
  if (query.caseNumber && !matches(item.displayNumber, query.caseNumber)) return false;
  if (!matches(item.citation, query.citationNumber)) return false;
  if (query.businessName && !item.organizations.some((value) => matches(value, query.businessName, query.soundex))) return false;
  if (query.lastName && !item.people.some((person) => matches(person.family, query.lastName, query.soundex) && matches(person.given, query.firstName, query.soundex) && matches(person.middle, query.middleName, query.soundex) && between(person.born, query.dobFrom, query.dobTo))) return false;
  if ((query.barNumber || query.attorneyLastName) && !item.lawyers.some((lawyer) => matches(lawyer.bar, query.barNumber) && matches(lawyer.family, query.attorneyLastName, query.soundex) && matches(lawyer.given, query.attorneyFirstName, query.soundex) && matches(lawyer.middle, query.attorneyMiddleName, query.soundex))) return false;
  const regions = query.counties || (query.county ? [query.county] : []);
  if (regions.length && !regions.some((region) => matches(item.region, region))) return false;
  if (query.categories && !query.categories.includes(item.category)) return false;
  const status = query.status?.toLowerCase();
  const desiredStatus = status === '1' ? 'active' : status === '2' ? 'inactive' : status;
  if (desiredStatus && !['0', 'all'].includes(desiredStatus) && !matches(item.lifeCycle, desiredStatus)) return false;
  if (!between(item.filedOn, query.filedFrom, query.filedTo)) return false;
  if (query.searchType === 'hearing' && !item.hearings.some((hearing) => matches(hearing.judge, query.judgeName) && between(hearing.date, query.hearingFrom, query.hearingTo || query.hearingFrom))) return false;
  if (query.searchType === 'judgment' && !item.judgments.some((judgment) => {
    const debtorMatches = query.businessName
      ? matches(judgment.debtor, query.businessName, query.soundex)
      : item.people.some((person) => person.name === judgment.debtor && matches(person.family, query.lastName, query.soundex) && matches(person.given, query.firstName, query.soundex) && matches(person.middle, query.middleName, query.soundex));
    return debtorMatches && matches(judgment.status, query.judgmentStatus) && between(judgment.docketed, query.docketedFrom, query.docketedTo);
  })) return false;
  return true;
}
function fixtureCandidate(item: FixtureRecord): CaseCandidate { return { sourceCaseId: item.recordId, caseNumber: item.displayNumber, title: item.caption, court: item.tribunal, status: item.lifeCycle, raw: { fixture: true, region: item.region, category: item.category, filedOn: item.filedOn } }; }

export class IndependentFixtureAdapter implements CourtSourceAdapter {
  private readonly filename: string;
  private data: Promise<z.infer<typeof fixtureSchema>> | undefined;
  constructor(filename?: string) { this.filename = path.resolve(filename || fixturePath()); }
  metadata(): SourceMetadata { return { id: 'independent-fixture', state: 'ZZ', name: 'Independent synthetic court fixture (not a jurisdiction)', baseUrl: 'fixture://independent', adapterVersion: version, fixture: true }; }
  capabilities(): SourceCapabilities { const result = capabilities(true); result.notes.push('Sounds Like uses fixture-only Soundex; it does not reproduce the proprietary Minnesota matching algorithm.'); return result; }
  validateSearch(query: unknown): CourtSearchQuery { return validate(query, 'independent-fixture'); }
  private async load() {
    this.data ||= readFile(this.filename, 'utf8').then((text) => fixtureSchema.parse(JSON.parse(text)));
    return this.data;
  }
  async searchPage(query: CourtSearchQuery, cursor?: string, context: AcquisitionContext = {}): Promise<SearchObservation> {
    context.signal?.throwIfAborted(); const validated = this.validateSearch(query); const data = await this.load();
    const fingerprint = hash(validated); let offset = 0;
    if (cursor) {
      try { const decoded = z.object({ fingerprint: z.string(), offset: z.number().int().nonnegative() }).parse(JSON.parse(Buffer.from(cursor, 'base64url').toString())); if (decoded.fingerprint !== fingerprint || decoded.offset % data.pageSize !== 0) throw new Error('Cursor does not match query'); offset = decoded.offset; }
      catch (error) { throw new SourceError('permanent', 'Invalid fixture cursor', { cause: error }); }
    }
    const matching = data.records.filter((item) => fixtureMatches(item, validated));
    if (offset > matching.length) throw new SourceError('permanent', 'Cursor is beyond the result set');
    const cases = matching.slice(offset, offset + data.pageSize).map(fixtureCandidate);
    const hasNext = offset + data.pageSize < matching.length;
    context.signal?.throwIfAborted();
    return { sourceId: 'independent-fixture', query: validated, observedAt: now(), cases, truncated: hasNext, complete: !hasNext, ...(hasNext ? { nextCursor: Buffer.from(JSON.stringify({ fingerprint, offset: offset + data.pageSize })).toString('base64url') } : {}), limitations: ['Synthetic fixture data only.'], raw: { fixture: true, offset, pageSize: data.pageSize, denominator: matching.length } };
  }
  async searchCases(query: CourtSearchQuery, context: AcquisitionContext): Promise<SearchObservation> {
    const cases: CaseCandidate[] = []; let cursor: string | undefined; let pagesObserved = 0;
    do { const page = await this.searchPage(query, cursor, context); cases.push(...page.cases); cursor = page.nextCursor; pagesObserved++; } while (cursor);
    return { sourceId: 'independent-fixture', query: this.validateSearch(query), observedAt: now(), cases, truncated: false, complete: true, limitations: ['Synthetic fixture data only; completeness covers this dataset, not any state.'], raw: { fixture: true, pagesObserved, denominator: cases.length } };
  }
  async fetchCase(identifier: string, context: AcquisitionContext): Promise<CaseObservation> {
    context.signal?.throwIfAborted(); const data = await this.load();
    const item = data.records.find((row) => row.recordId === identifier || row.displayNumber === identifier);
    if (!item) throw new SourceError('not_found', `Fixture case not found: ${identifier}`);
    const entries: DocketEntry[] = item.ledger.map((event, sourceOrder) => ({ identityKey: event.eventId, sourceId: event.eventId, sourceOrder, date: event.when, title: event.label, identityConfidence: 'source', raw: { rawLabel: event.rawLabel }, documents: event.attachments.map((asset) => ({ sourceDocumentId: asset.assetId, entryKey: event.eventId, caseNumber: item.displayNumber, title: asset.title, ...(asset.file ? { filename: asset.file } : {}), availability: asset.access, raw: { fixture: true, recordId: item.recordId } })) }));
    context.signal?.throwIfAborted();
    return { sourceId: 'independent-fixture', sourceCaseId: item.recordId, caseNumber: item.displayNumber, title: item.caption, court: item.tribunal, status: item.lifeCycle, observedAt: now(), complete: true, entries, participants: item.people.map((person) => ({ ...person })), sections: { hearings: item.hearings, judgments: item.judgments, organizations: item.organizations, representations: item.lawyers }, raw: { fixture: true, sourceFormat: data.format, description: data.description, region: item.region, category: item.category, filedOn: item.filedOn, citationNumber: item.citation } };
  }
  async fetchDocument(reference: DocumentReference, context: AcquisitionContext): Promise<ArtifactObservation> {
    context.signal?.throwIfAborted(); const data = await this.load();
    const item = data.records.find((row) => row.displayNumber === reference.caseNumber);
    const asset = item?.ledger.find((event) => event.eventId === reference.entryKey)?.attachments.find((entry) => entry.assetId === reference.sourceDocumentId);
    if (!asset) throw new SourceError('not_found', 'Fixture attachment does not exist');
    if (asset.access === 'restricted') throw new SourceError('restricted', 'Fixture scenario: restricted document');
    if (asset.access !== 'available' || !asset.file) throw new SourceError('not_found', 'Fixture document is unavailable');
    if (path.basename(asset.file) !== asset.file) throw new SourceError('permanent', 'Fixture artifact must be a sibling filename');
    const bytes = await readFile(path.join(path.dirname(this.filename), asset.file)); context.signal?.throwIfAborted();
    return { bytes, filename: asset.file, contentType: 'application/pdf', sourceUrl: `fixture://independent/${encodeURIComponent(asset.assetId)}`, acquiredAt: now() };
  }
  async close(): Promise<void> { this.data = undefined; }
}

export function createAdapters(options: { mode?: 'extension' | 'standalone'; fixturePath?: string } = {}): Map<string, CourtSourceAdapter> {
  const adapters: CourtSourceAdapter[] = [new MinnesotaAdapter(options.mode), new IndependentFixtureAdapter(options.fixturePath)];
  return new Map(adapters.map((adapter) => [adapter.metadata().id, adapter]));
}
