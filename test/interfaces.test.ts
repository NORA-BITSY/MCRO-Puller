import assert from 'node:assert/strict';
import test from 'node:test';
import { createApi } from '../src/platform/api.js';
import { authenticate, authorize, invokeOperation, loadApiTokens, resolveMcpRole, type InterfaceService } from '../src/platform/interfaces.js';
import { parseBatch, runCli } from '../src/platform/courtctl.js';

const env = { API_TOKEN_READ: 'read-secret', API_TOKEN_WRITE: 'write-secret', API_TOKEN_ADMIN: 'admin-secret' };
const tokens = loadApiTokens(env);
function serviceDouble() {
  const calls: { method: string; args: unknown[] }[] = [];
  const audits: unknown[][] = [];
  const admissions: string[] = [];
  const methods = ['listSources', 'getCapabilities', 'searchCases', 'searchDocketEntries', 'searchFilingText', 'getCase', 'getCaseDocket', 'getFiling', 'getDocumentText', 'requestAcquisition', 'requestBulk', 'requestRefresh', 'getJobStatus', 'getCoverageReport', 'health', 'retryJob', 'cancelJob', 'restrictCase', 'planDiscovery', 'scheduleDue', 'setCaseWatch', 'getRefreshPolicy', 'setRefreshPolicy', 'importLegacy', 'verifyStorage', 'metrics'];
  methods.push('getRetentionPolicy','setRetentionPolicy','requestRetention','getRetentionRequest','runRetention','getCaseInterpretation','requestCaseInterpretation');
  methods.push('controlSource');
  // Every public method is represented; only the external service is replaced in boundary tests.
  const service = Object.fromEntries(methods.map(method => [method, async (...args: unknown[]) => {
    calls.push({ method, args });
    return { method, id: '11111111-1111-4111-8111-111111111111', data: [], meta: { limit: 50, offset: 0, hasMore: false } };
  }])) as unknown as InterfaceService;
  service.recordAudit = async (...args) => { audits.push(args); };
  service.admitRequest = async principal => { admissions.push(principal); return true; };
  service.getDocumentArtifact = async () => ({ bytes: Buffer.from('%PDF-test'), filename: '../../unsafe"\\name\r\n.pdf', contentType: 'application/pdf' });
  return { service, calls, audits, admissions };
}

test('API credentials fail closed and roles cannot be confused', () => {
  assert.throws(() => loadApiTokens({}), /API_TOKEN/);
  assert.throws(() => loadApiTokens({ ...env, API_TOKEN_ADMIN: env.API_TOKEN_READ }), /distinct/);
  assert.equal(authenticate('Bearer write-secret', tokens), 'acquire');
  assert.throws(() => authenticate('Bearer wrong', tokens), /authentication/i);
  assert.throws(() => authorize('read', 'acquire'), /permission/i);
  assert.doesNotThrow(() => authorize('admin', 'read'));
});

test('MCP defaults read-only and elevated roles require their configured credential', () => {
  assert.equal(resolveMcpRole({}), 'read');
  assert.throws(() => resolveMcpRole({ ...env, MCP_ROLE: 'acquire' }), /token/i);
  assert.throws(() => resolveMcpRole({ ...env, MCP_ROLE: 'admin', MCP_TOKEN: env.API_TOKEN_READ }), /token/i);
  assert.equal(resolveMcpRole({ ...env, MCP_ROLE: 'acquire', MCP_TOKEN: env.API_TOKEN_WRITE }), 'acquire');
  assert.throws(() => resolveMcpRole({ MCP_ROLE: 'root' }), /role/i);
});

test('shared dispatch enforces authorization, bounded input, and explicit idempotency', async () => {
  const { service, calls } = serviceDouble();
  const input = { query: { searchType: 'case', caseNumber: '27-CV-24-1' }, idempotencyKey: 'submission-1' };
  await assert.rejects(invokeOperation(service, 'request_acquisition', input, 'read'), /permission/i);
  await assert.rejects(invokeOperation(service, 'request_acquisition', { query: input.query }, 'acquire'));
  await assert.rejects(invokeOperation(service, 'request_acquisition', { ...input, query: { ...input.query, url: 'http://169.254.169.254/' } }, 'acquire'));
  await assert.rejects(invokeOperation(service, 'search_cases', { limit: 101 }, 'read'));
  await assert.rejects(invokeOperation(service, 'search_cases', { unknown: true }, 'read'));
  assert.equal(calls.length, 0);
  await invokeOperation(service, 'request_acquisition', input, 'acquire');
  assert.equal(calls[0]?.method, 'requestAcquisition');
  assert.equal(calls[0]?.args[1], 'submission-1');
});

test('REST rejects unauthorized requests before service work and preserves idempotency keys', async t => {
  const { service, calls } = serviceDouble();
  const app = await createApi(service, { env });
  t.after(() => app.close());
  assert.equal((await app.inject({ method: 'GET', url: '/api/v1/cases' })).statusCode, 401);
  assert.equal((await app.inject({ method: 'POST', url: '/api/v1/acquisitions', headers: { authorization: 'Bearer read-secret' }, payload: { query: { searchType: 'case', caseNumber: '27-CV-24-1' } } })).statusCode, 403);
  assert.equal((await app.inject({ method: 'GET', url: '/api/v1/cases?limit=101', headers: { authorization: 'Bearer read-secret' } })).statusCode, 400);
  assert.equal((await app.inject({ method: 'GET', url: '/api/v1/cases?url=https://example.org', headers: { authorization: 'Bearer read-secret' } })).statusCode, 400);
  assert.equal(calls.length, 0);
  const response = await app.inject({ method: 'POST', url: '/api/v1/acquisitions', headers: { authorization: 'Bearer write-secret', 'idempotency-key': 'request-123' }, payload: { query: { searchType: 'case', caseNumber: '27-CV-24-1' } } });
  assert.equal(response.statusCode, 202);
  assert.equal(calls[0]?.args[1], 'request-123');
  const page = await app.inject({ method: 'GET', url: '/api/v1/cases?limit=20&offset=40', headers: { authorization: 'Bearer read-secret' } });
  assert.equal(page.statusCode, 200);
  assert.deepEqual(calls[1]?.args, [{ limit: 20, offset: 40 }]);
  const schema = await app.inject({ method: 'GET', url: '/api/v1/openapi.json', headers: { authorization: 'Bearer read-secret' } });
  assert.equal(schema.statusCode, 200);
  assert.ok(schema.json().paths['/api/v1/acquisitions'].post.requestBody);
});

test('REST hides internal error details', async t => {
  const { service } = serviceDouble();
  service.health = async () => { throw new Error('postgres://secret@internal'); };
  const app = await createApi(service, { env });
  t.after(() => app.close());
  const response = await app.inject({ method: 'GET', url: '/api/v1/health', headers: { authorization: 'Bearer read-secret' } });
  assert.equal(response.statusCode, 500);
  assert.doesNotMatch(response.body, /postgres|secret|internal\//);
});

test('JSON, JSONL and CSV preserve heterogeneous and invalid queries for per-item service results', () => {
  const queries = [{ searchType: 'case', caseNumber: '27-CV-24-1' }, { searchType: 'party', lastName: 'Smith' }];
  assert.equal(parseBatch(JSON.stringify(queries), 'json').queries.length, 2);
  assert.deepEqual(parseBatch(queries.map(x => JSON.stringify(x)).join('\n'), 'jsonl').queries[1], queries[1]);
  const csv = 'searchType,caseNumber,lastName,acquireResults\ncase,27-CV-24-1,,false\nparty,,Smith,true\n';
  assert.deepEqual(parseBatch(csv, 'csv').queries[0], { searchType: 'case', caseNumber: '27-CV-24-1', acquireResults: false });
  assert.deepEqual(parseBatch('searchType,url\ncase,https://example.org\n', 'csv').queries, [{ searchType: 'case', url: 'https://example.org' }]);
  assert.throws(() => parseBatch(JSON.stringify(Array.from({ length: 1001 }, () => queries[0])), 'json'));
});

test('CLI distinguishes database reads from queued source access', async () => {
  const { service, calls } = serviceDouble();
  await runCli(['db', 'search', '--q', 'housing', '--limit', '10'], service);
  await runCli(['source', 'search', '--state', 'MN', '--query', '{"searchType":"party","lastName":"Smith"}', '--idempotency-key', 'search-1'], service);
  assert.equal(calls[0]?.method, 'searchCases');
  assert.deepEqual(calls[0]?.args, [{ q: 'housing', limit: 10, offset: 0 }]);
  assert.equal(calls[1]?.method, 'requestAcquisition');
  assert.equal((calls[1]?.args[0] as Record<string, unknown>).acquireResults, false);
  assert.equal((calls[1]?.args[0] as Record<string, unknown>).sourceId, 'mn-mcro');
  await assert.rejects(runCli(['source', 'search', '--state', 'WI', '--query', '{}', '--idempotency-key', 'x'], service), /source|state/i);
});

test('acquire cannot administer jobs and invalid identifiers do not reach storage', async t => {
  const { service, calls } = serviceDouble();
  const app = await createApi(service, { env });
  t.after(() => app.close());
  const id = '11111111-1111-4111-8111-111111111111';
  const denied = await app.inject({ method: 'POST', url: `/api/v1/jobs/${id}/retry`, headers: { authorization: 'Bearer write-secret' } });
  assert.equal(denied.statusCode, 403);
  const invalid = await app.inject({ method: 'GET', url: '/api/v1/documents/not-a-uuid/text', headers: { authorization: 'Bearer read-secret' } });
  assert.equal(invalid.statusCode, 400);
  assert.equal(calls.length, 0);
  const accepted = await app.inject({ method: 'POST', url: `/api/v1/jobs/${id}/retry`, headers: { authorization: 'Bearer admin-secret' } });
  assert.equal(accepted.statusCode, 200);
  assert.deepEqual(calls, [{ method: 'retryJob', args: [id] }]);
});

test('bounded batches and strict CLI options fail before submission', async () => {
  assert.throws(() => parseBatch(' '.repeat(2 * 1024 * 1024 + 1), 'json'), /2 MiB/);
  assert.deepEqual(parseBatch('searchType,caseNumber,acquireResults\ncase,27-CV-24-1,yes\n', 'csv').queries, [{ searchType: 'case', caseNumber: '27-CV-24-1', acquireResults: 'yes' }]);
  assert.equal(parseBatch('[{"searchType":"case","caseNumber":"27-CV-24-1","filedFrom":"2025-02-30"}]', 'json').queries.length, 1);
  const { service, calls } = serviceDouble();
  await assert.rejects(runCli(['doctor', '--q', 'ignored'], service), /Unsupported options/);
  await assert.rejects(runCli(['case', 'get', 'not-a-uuid'], service));
  assert.equal(calls.length, 0);
});

test('bulk dispatch preserves valid neighbors of invalid items and audits successful mutation', async () => {
  const { service, calls, audits } = serviceDouble();
  const queries = [{ searchType: 'case', caseNumber: '27-CV-24-1' }, { url: 'https://example.org' }, null];
  await invokeOperation(service, 'request_bulk', { input: { queries }, idempotencyKey: 'batch-mixed-1' }, 'acquire', 'api:hashed-principal');
  assert.deepEqual(calls, [{ method: 'requestBulk', args: [{ queries }, 'batch-mixed-1'] }]);
  assert.equal(audits.length, 1);
  assert.equal(audits[0]?.[0], 'api:hashed-principal');
  assert.equal(audits[0]?.[1], 'request_bulk');
});

test('document download requires auth and sanitizes attachment headers', async t => {
  const { service } = serviceDouble();
  const app = await createApi(service, { env });
  t.after(() => app.close());
  const url = '/api/v1/documents/11111111-1111-4111-8111-111111111111/content';
  assert.equal((await app.inject({ method: 'GET', url })).statusCode, 401);
  const response = await app.inject({ method: 'GET', url, headers: { authorization: 'Bearer read-secret' } });
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers['content-type'], 'application/pdf');
  assert.match(String(response.headers['content-disposition']), /^attachment; filename="[A-Za-z0-9._-]+"$/);
  assert.doesNotMatch(String(response.headers['content-disposition']), /\.\.|\r|\n|\/|\\/);
  assert.equal(response.body, '%PDF-test');
});

test('distributed request admission receives only token digests and blocks work', async t => {
  const { service, calls, admissions } = serviceDouble();
  const app = await createApi(service, { env });
  t.after(() => app.close());
  const request = { method: 'GET' as const, url: '/api/v1/cases', headers: { authorization: 'Bearer read-secret' } };
  assert.equal((await app.inject(request)).statusCode, 200);
  assert.match(admissions[0] ?? '', /^api:[a-f0-9]{64}$/);
  assert.ok(!admissions[0]?.includes(env.API_TOKEN_READ));
  service.admitRequest = async () => false;
  const rejected = await app.inject(request);
  assert.equal(rejected.statusCode, 429);
  assert.equal(rejected.headers['retry-after'], '60');
  assert.equal(calls.length, 1);
});

test('coverage CLI preserves structured dimensions and rejects unrelated search filters', async () => {
  const { service, calls } = serviceDouble();
  await runCli(['coverage', '--source', 'mn-mcro', '--state', 'MN', '--court', 'District', '--county', 'Hennepin',
    '--category', 'Civil', '--filed-from', '2024-01-01', '--filed-to', '2024-12-31', '--limit', '10'], service);
  assert.deepEqual(calls[0], { method: 'getCoverageReport', args: [{
    sourceId: 'mn-mcro', state: 'MN', court: 'District', county: 'Hennepin', category: 'Civil',
    filedFrom: '2024-01-01', filedTo: '2024-12-31', limit: 10, offset: 0,
  }] });
  await assert.rejects(runCli(['coverage', '--party', 'Smith'], service));
  assert.equal(calls.length, 1);
});

test('database CLI forwards validated ordering and rejects arbitrary sort expressions', async () => {
  const { service, calls } = serviceDouble();
  await runCli(['db', 'search', '--sort-by', 'filedDate', '--sort-order', 'asc'], service);
  assert.deepEqual(calls[0], { method: 'searchCases', args: [{ sortBy: 'filedDate', sortOrder: 'asc', limit: 50, offset: 0 }] });
  await assert.rejects(runCli(['db', 'search', '--sort-by', 'DROP TABLE cases'], service));
  assert.equal(calls.length, 1);
});
