import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { CourtService } from './service.js';
import { CourtSearchQuerySchema, QueryFiltersSchema } from './contracts.js';
import { RefreshPolicyPatchSchema } from './refresh.js';
import { RetentionPolicySchema } from './retention.js';

export type InterfaceService = Pick<CourtService,
  'listSources' | 'getCapabilities' | 'searchCases' | 'searchDocketEntries' | 'searchFilingText' |
  'getCase' | 'getCaseDocket' | 'getFiling' | 'getDocumentText' | 'requestAcquisition' |
  'requestBulk' | 'requestRefresh' | 'getJobStatus' | 'getCoverageReport' | 'health' |
  'retryJob' | 'cancelJob' | 'restrictCase' | 'planDiscovery' | 'scheduleDue' | 'setCaseWatch' | 'getRefreshPolicy' | 'setRefreshPolicy' |
  'getRetentionPolicy'|'setRetentionPolicy'|'requestRetention'|'getRetentionRequest'|'runRetention'|'getCaseInterpretation'|'requestCaseInterpretation'|
  'controlSource'|
  'importLegacy' | 'verifyStorage' | 'metrics' | 'getDocumentArtifact' | 'admitRequest' | 'recordAudit'>;
export type Role = 'read' | 'acquire' | 'admin';
export type Environment = Record<string, string | undefined>;
export type ApiTokens = Record<Role, string>;
export const MAX_BODY_BYTES = 2 * 1024 * 1024;
export const MAX_BATCH_QUERIES = 1000;

export class BoundaryError extends Error {
  constructor(public readonly statusCode: number, public readonly code: string, message: string) {
    super(message);
    this.name = 'BoundaryError';
  }
}

function tokenEquals(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function loadApiTokens(env: Environment = process.env): ApiTokens {
  const read = env.API_TOKEN_READ;
  const acquire = env.API_TOKEN_WRITE;
  const admin = env.API_TOKEN_ADMIN;
  if (!read?.trim() || !acquire?.trim() || !admin?.trim()) {
    throw new Error('API_TOKEN_READ, API_TOKEN_WRITE and API_TOKEN_ADMIN are mandatory');
  }
  if (new Set([read, acquire, admin]).size !== 3) throw new Error('API tokens must be distinct for each role');
  return { read, acquire, admin };
}

export function authenticate(header: string | undefined, tokens: ApiTokens): Role {
  const match = /^Bearer ([^\s]+)$/i.exec(header ?? '');
  const supplied = match?.[1];
  if (supplied) {
    for (const role of ['read', 'acquire', 'admin'] as const) {
      if (tokenEquals(supplied, tokens[role])) return role;
    }
  }
  throw new BoundaryError(401, 'unauthorized', 'Bearer authentication required');
}

export function authorize(actual: Role, required: Role): void {
  const rank = { read: 0, acquire: 1, admin: 2 };
  if (rank[actual] < rank[required]) throw new BoundaryError(403, 'forbidden', 'Insufficient permission');
}

export function resolveMcpRole(env: Environment = process.env): Role {
  const role = env.MCP_ROLE ?? 'read';
  if (role !== 'read' && role !== 'acquire' && role !== 'admin') throw new Error('MCP_ROLE must be read, acquire or admin');
  if (role === 'read') return role;
  const tokens = loadApiTokens(env);
  if (!env.MCP_TOKEN || !tokenEquals(env.MCP_TOKEN, tokens[role])) {
    throw new Error(`MCP_TOKEN must match the configured ${role} token`);
  }
  return role;
}

const text = z.string().trim().min(1).max(512);
const sourceId = z.string().min(1).max(80).regex(/^[a-z0-9][a-z0-9-]*$/);
const uuid = z.string().uuid();
export const idempotencyKeySchema = z.string().min(1).max(200).regex(/^[A-Za-z0-9._:-]+$/);
export const querySchema = CourtSearchQuerySchema;
export const filtersSchema = QueryFiltersSchema;
export const paginationShape = {
  limit: QueryFiltersSchema.shape.limit,
  offset: QueryFiltersSchema.shape.offset,
};
export const bulkSchema = z.object({
  queries: z.array(z.unknown()).min(1).max(MAX_BATCH_QUERIES),
  acquireResults: z.boolean().optional(),
}).strict();
const empty = z.object({}).strict();
const identifier = z.object({ id: uuid }).strict();
const pagedIdentifier = z.object({ id: uuid, ...paginationShape }).strict();
const coverage = QueryFiltersSchema.pick({
  sourceId: true, state: true, court: true, county: true, category: true,
  filedFrom: true, filedTo: true, limit: true, offset: true,
});

export interface Operation {
  role: Role;
  description: string;
  schema: z.ZodType<Record<string, unknown>>;
  invoke(service: InterfaceService, input: unknown): Promise<unknown>;
}
function operation<S extends z.ZodType<Record<string, unknown>>>(role: Role, description: string, schema: S,
  invoke: (service: InterfaceService, input: z.output<S>) => Promise<unknown>): Operation {
  return { role, description, schema, invoke: (service, input) => invoke(service, schema.parse(input)) };
}

export const operations: Record<string, Operation> = {
  list_sources: operation('read', 'List registered source metadata; registration does not prove live availability.', empty, s => s.listSources()),
  get_source_capabilities: operation('read', 'Inspect documented, fixture or live capability evidence and source caps.', z.object({ sourceId }).strict(), (s, x) => s.getCapabilities(x.sourceId)),
  control_source:operation('admin','Explicit source enable/disable/pause/resume; does not confer access permission or reset job retry deadlines.',z.object({sourceId,action:z.enum(['enable','disable','pause','resume']),reason:text,minutes:z.number().int().min(1).max(10080).optional()}).strict(),(s,x)=>s.controlSource(x.sourceId,x.action,x.reason,x.minutes)),
  search_cases: operation('read', 'Search locally acquired cases, never the live source.', filtersSchema, (s, x) => s.searchCases(x)),
  search_docket_entries: operation('read', 'Search locally acquired docket entries.', filtersSchema, (s, x) => s.searchDocketEntries(x)),
  search_filing_text: operation('read', 'Search stored extracted filing text with provenance.', filtersSchema, (s, x) => s.searchFilingText(x)),
  get_case: operation('read', 'Read an acquired case by internal UUID.', identifier, (s, x) => s.getCase(x.id)),
  get_case_docket: operation('read', 'Read acquired docket entries with bounded pagination.', pagedIdentifier, (s, x) => s.getCaseDocket(x.id, { limit: x.limit, offset: x.offset })),
  get_filing: operation('read', 'Read filing metadata and artifact provenance.', identifier, (s, x) => s.getFiling(x.id)),
  get_document_text: operation('read', 'Read stored extracted document pages with bounded pagination.', pagedIdentifier, (s, x) => s.getDocumentText(x.id, { limit: x.limit, offset: x.offset })),
  request_acquisition: operation('acquire', 'Queue source search or case acquisition. No synchronous browser action or arbitrary URL.', z.object({ query: querySchema, idempotencyKey: idempotencyKeySchema }).strict(), (s, x) => s.requestAcquisition(x.query, x.idempotencyKey)),
  request_bulk: operation('acquire', 'Queue a heterogeneous bounded batch of source queries.', z.object({ input: bulkSchema, idempotencyKey: idempotencyKeySchema }).strict(), (s, x) => s.requestBulk(x.input, x.idempotencyKey)),
  request_refresh: operation('acquire', 'Queue refresh of an already acquired case.', z.object({ id: uuid, idempotencyKey: idempotencyKeySchema }).strict(), (s, x) => s.requestRefresh(x.id, x.idempotencyKey)),
  get_job_status: operation('read', 'Read durable job state and explicit partial/failure evidence.', identifier, (s, x) => s.getJobStatus(x.id)),
  get_coverage_report: operation('read', 'Read observed coverage; unknown denominators are not completeness claims.', coverage, (s, x) => s.getCoverageReport(x)),
  health: operation('read', 'Read application dependency health.', empty, s => s.health()),
  retry_job: operation('admin', 'Retry a failed durable job within source budget controls.', identifier, (s, x) => s.retryJob(x.id)),
  cancel_job: operation('admin', 'Cancel a durable job.', identifier, (s, x) => s.cancelJob(x.id)),
  restrict_case: operation('admin', 'Restrict local case visibility with an audit reason.', z.object({ id: uuid, reason: text }).strict(), (s, x) => s.restrictCase(x.id, x.reason)),
  plan_discovery: operation('admin', 'Persist a source discovery plan without claiming exhaustive discovery.', z.object({ query: querySchema }).strict(), (s, x) => s.planDiscovery(x.query)),
  schedule_due: operation('admin', 'Enqueue due refresh and discovery work.', empty, s => s.scheduleDue()),
  set_case_watch: operation('acquire', 'Enable prioritized recurring acquisition or remove watch priority. Enabling explicitly opts a metadata-only case into acquisition; disabling retains normal tracking.', z.object({ id: uuid, enabled: z.boolean() }).strict(), (s, x) => s.setCaseWatch(x.id, x.enabled)),
  get_refresh_policy: operation('read', 'Read the persisted adaptive refresh intervals and observed-activity windows.', empty, s => s.getRefreshPolicy()),
  set_refresh_policy: operation('admin', 'Update validated refresh intervals in minutes and observation windows in days; active intervals cannot exceed 24 hours.', z.object({ policy: RefreshPolicyPatchSchema }).strict(), (s, x) => s.setRefreshPolicy(x.policy)),
  get_retention_policy:operation('admin','Inspect opt-in local retention policy.',empty,s=>s.getRetentionPolicy()),
  set_retention_policy:operation('admin','Enable or disable explicit retention and physical artifact deletion.',z.object({policy:RetentionPolicySchema}).strict(),(s,x)=>s.setRetentionPolicy(x.policy)),
  request_retention:operation('admin','Schedule irreversible local withdrawal or purge; never deletes original downloads.',z.object({caseId:uuid,documentId:uuid.optional(),action:z.enum(['restrict','purge']),dueAt:z.iso.datetime(),reason:text,idempotencyKey:idempotencyKeySchema}).strict(),(s,x)=>s.requestRetention(x)),
  get_retention_request:operation('admin','Read withdrawal and artifact cleanup checkpoints.',identifier,(s,x)=>s.getRetentionRequest(x.id)),
  run_retention:operation('admin','Queue a scheduled retention request; disabled policy remains partial and requires explicit retry.',z.object({id:uuid,idempotencyKey:idempotencyKeySchema}).strict(),(s,x)=>s.runRetention(x.id,x.idempotencyKey)),
  get_case_interpretation:operation('read','Read source-grounded interpretation only while its complete input set remains current and available.',identifier,(s,x)=>s.getCaseInterpretation(x.id)),
  request_case_interpretation:operation('admin','Queue bounded case inference; requires separate paid-inference opt-ins.',z.object({id:uuid,idempotencyKey:idempotencyKeySchema}).strict(),(s,x)=>s.requestCaseInterpretation(x.id,x.idempotencyKey)),
  import_legacy: operation('admin', 'Import existing local evidence from a server filesystem directory.', z.object({ directory: z.string().min(1).max(4096).refine(x => !x.includes('\0'), 'NUL is not allowed') }).strict(), (s, x) => s.importLegacy(x.directory)),
  verify_storage: operation('admin', 'Verify persisted artifact integrity.', empty, s => s.verifyStorage()),
  metrics: operation('admin', 'Read operational metrics.', empty, s => s.metrics()),
};

const auditedOperations: Record<string, true> = {
  request_acquisition: true, request_bulk: true, request_refresh: true, retry_job: true,
  cancel_job: true, restrict_case: true, plan_discovery: true, schedule_due: true, import_legacy: true,
  set_case_watch: true, set_refresh_policy: true,
  set_retention_policy:true,request_retention:true,run_retention:true,request_case_interpretation:true,
  control_source:true,
};

export async function invokeOperation(service: InterfaceService, name: string, input: unknown, role: Role, actor = `local:${role}`): Promise<unknown> {
  const definition = operations[name];
  if (!definition) throw new BoundaryError(404, 'not_found', 'Unknown operation');
  authorize(role, definition.role);
  if (Buffer.byteLength(JSON.stringify(input) ?? '') > MAX_BODY_BYTES) {
    throw new BoundaryError(413, 'input_too_large', 'Input exceeds 2 MiB');
  }
  const result = await definition.invoke(service, input);
  if (auditedOperations[name]) {
    const resourceId = typeof result === 'object' && result !== null && 'id' in result && typeof result.id === 'string'
      ? result.id : typeof input === 'object' && input !== null && 'id' in input && typeof input.id === 'string' ? input.id : null;
    await service.recordAudit(actor, name, 'operation', resourceId, { role });
  }
  return result;
}

export function publicError(error: unknown): { statusCode: number; error: { code: string; message: string } } {
  if (error instanceof BoundaryError) return { statusCode: error.statusCode, error: { code: error.code, message: error.message } };
  if (error instanceof z.ZodError) return { statusCode: 400, error: { code: 'validation_error', message: 'Invalid request input' } };
  if (error instanceof Error && 'code' in error && typeof error.code === 'string') {
    const statuses: Record<string, number> = { not_found: 404, restricted: 403, unsupported: 422, permanent: 422, blocked: 503, retryable: 503, parse_error: 502, conflict: 409 };
    const statusCode = statuses[error.code];
    if (statusCode) return { statusCode, error: { code: error.code, message: `Operation failed: ${error.code}` } };
  }
  return { statusCode: 500, error: { code: 'internal_error', message: 'Internal server error' } };
}
