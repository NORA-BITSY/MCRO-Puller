import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import Fastify, { type FastifyInstance, type FastifySchema } from 'fastify';
import swagger from '@fastify/swagger';
import { z } from 'zod';
import { createApplication } from './bootstrap.js';
import { authenticate, authorize, BoundaryError, idempotencyKeySchema, invokeOperation, loadApiTokens, MAX_BODY_BYTES, operations, publicError, type Environment, type InterfaceService } from './interfaces.js';

interface Route {
  method: 'GET' | 'POST'; path: string; operation: string;
  params?: string[]; idempotent?: boolean; accepted?: boolean;
}
const routes: Route[] = [
  { method: 'GET', path: '/sources', operation: 'list_sources' },
  { method: 'GET', path: '/sources/:sourceId/capabilities', operation: 'get_source_capabilities', params: ['sourceId'] },
  { method:'POST',path:'/sources/:sourceId/control',operation:'control_source',params:['sourceId'] },
  { method: 'GET', path: '/cases', operation: 'search_cases' },
  { method: 'GET', path: '/docket-entries', operation: 'search_docket_entries' },
  { method: 'GET', path: '/filing-text', operation: 'search_filing_text' },
  { method: 'GET', path: '/cases/:id', operation: 'get_case', params: ['id'] },
  { method: 'GET', path: '/cases/:id/docket', operation: 'get_case_docket', params: ['id'] },
  { method: 'GET', path: '/filings/:id', operation: 'get_filing', params: ['id'] },
  { method: 'GET', path: '/documents/:id/text', operation: 'get_document_text', params: ['id'] },
  { method: 'GET', path: '/jobs/:id', operation: 'get_job_status', params: ['id'] },
  { method: 'GET', path: '/coverage', operation: 'get_coverage_report' },
  { method: 'GET', path: '/health', operation: 'health' },
  { method: 'GET', path: '/metrics', operation: 'metrics' },
  { method: 'POST', path: '/acquisitions', operation: 'request_acquisition', idempotent: true, accepted: true },
  { method: 'POST', path: '/acquisitions/bulk', operation: 'request_bulk', idempotent: true, accepted: true },
  { method: 'POST', path: '/cases/:id/refresh', operation: 'request_refresh', params: ['id'], idempotent: true, accepted: true },
  { method: 'POST', path: '/cases/:id/watch', operation: 'set_case_watch', params: ['id'] },
  { method: 'GET', path: '/refresh-policy', operation: 'get_refresh_policy' },
  { method: 'POST', path: '/refresh-policy', operation: 'set_refresh_policy' },
  { method:'GET',path:'/retention-policy',operation:'get_retention_policy' },
  { method:'POST',path:'/retention-policy',operation:'set_retention_policy' },
  { method:'POST',path:'/retention',operation:'request_retention',idempotent:true },
  { method:'GET',path:'/retention/:id',operation:'get_retention_request',params:['id'] },
  { method:'POST',path:'/retention/:id/run',operation:'run_retention',params:['id'],idempotent:true,accepted:true },
  { method:'GET',path:'/cases/:id/interpretation',operation:'get_case_interpretation',params:['id'] },
  { method:'POST',path:'/cases/:id/interpretation',operation:'request_case_interpretation',params:['id'],idempotent:true,accepted:true },
  { method: 'POST', path: '/jobs/:id/retry', operation: 'retry_job', params: ['id'] },
  { method: 'POST', path: '/jobs/:id/cancel', operation: 'cancel_job', params: ['id'] },
  { method: 'POST', path: '/cases/:id/restrictions', operation: 'restrict_case', params: ['id'] },
  { method: 'POST', path: '/discovery/plans', operation: 'plan_discovery' },
  { method: 'POST', path: '/schedules/due', operation: 'schedule_due' },
  { method: 'POST', path: '/imports/legacy', operation: 'import_legacy' },
  { method: 'POST', path: '/storage/verify', operation: 'verify_storage' },
];

function objectSchema(properties: Record<string, unknown>, required: string[] = []) {
  return { type: 'object', properties, required, additionalProperties: false };
}
function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function requestPrincipal(header: string | undefined): string {
  return `api:${createHash('sha256').update((header ?? '').replace(/^Bearer /i, '')).digest('hex')}`;
}

function attachmentFilename(filename: string): string {
  return (filename.split(/[\\/]/).pop() ?? '').replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '').slice(0, 180) || 'document';
}

export interface ApiOptions { env?: Environment; logger?: boolean; }
export async function createApi(service: InterfaceService, options: ApiOptions = {}): Promise<FastifyInstance> {
  const tokens = loadApiTokens(options.env ?? process.env);
  const app = Fastify({ bodyLimit: MAX_BODY_BYTES, logger: options.logger ?? false,
    ajv: { customOptions: { removeAdditional: false, coerceTypes: true, useDefaults: true } } });
  await app.register(swagger, { openapi: { info: { title: 'Court acquisition and evidence API', version: '1.0.0' },
    components: { securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } } }, security: [{ bearerAuth: [] }] } });
  app.addHook('onRequest', async (request, reply) => {
    authenticate(request.headers.authorization, tokens);
    const admitted = await service.admitRequest(requestPrincipal(request.headers.authorization), 120, 60000);
    if (!admitted) {
      reply.header('Retry-After', '60');
      throw new BoundaryError(429, 'rate_limit_exceeded', 'Rate limit exceeded');
    }
  });
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof Error && 'validation' in error && error.validation) return reply.code(400).send({ error: { code: 'validation_error', message: 'Invalid request input' } });
    const statusCode = error instanceof Error && 'statusCode' in error ? error.statusCode : undefined;
    if (statusCode === 413 || statusCode === 429 || statusCode === 400) {
      return reply.code(statusCode).send({ error: { code: statusCode === 429 ? 'rate_limit_exceeded' : 'invalid_request', message: statusCode === 429 ? 'Rate limit exceeded' : 'Invalid request' } });
    }
    const failure = publicError(error);
    if (failure.statusCode >= 500) request.log.error({ err: error }, 'Request failed');
    if (failure.statusCode === 401) reply.header('WWW-Authenticate', 'Bearer');
    return reply.code(failure.statusCode).send({ error: failure.error });
  });
  for (const route of routes) {
    const definition = operations[route.operation];
    if (!definition) throw new Error(`Missing operation ${route.operation}`);
    const json = z.toJSONSchema(definition.schema, { target: 'draft-7' });
    const properties = record(json.properties);
    const required = Array.isArray(json.required) ? json.required.filter((x): x is string => typeof x === 'string') : [];
    const pathKeys = route.params ?? [];
    const bodyKeys = Object.keys(properties).filter(key => !pathKeys.includes(key) && key !== 'idempotencyKey');
    const schema: FastifySchema = { operationId: route.operation, description: `${definition.description} Required role: ${definition.role}.`, security: [{ bearerAuth: [] }] };
    if (pathKeys.length) schema.params = objectSchema(Object.fromEntries(pathKeys.map(key => [key, properties[key]])), pathKeys);
    const inputSchema = objectSchema(Object.fromEntries(bodyKeys.map(key => [key, properties[key]])), required.filter(key => bodyKeys.includes(key)));
    if (route.method === 'GET') schema.querystring = inputSchema;
    else if (bodyKeys.length) schema.body = inputSchema;
    else schema.querystring = objectSchema({});
    if (route.idempotent) schema.headers = { type: 'object', properties: { 'idempotency-key': z.toJSONSchema(idempotencyKeySchema, { target: 'draft-7' }) }, required: ['idempotency-key'] };
    app.route({ method: route.method, url: `/api/v1${route.path}`, schema,
      onRequest: async request => { authorize(authenticate(request.headers.authorization, tokens), definition.role); },
      handler: async (request, reply) => {
        const input = { ...record(request.query), ...record(request.body), ...record(request.params),
          ...(route.idempotent ? { idempotencyKey: request.headers['idempotency-key'] } : {}) };
        const result = await invokeOperation(service, route.operation, input, authenticate(request.headers.authorization, tokens), requestPrincipal(request.headers.authorization));
        if (route.accepted) reply.code(202);
        return result ?? null;
      },
    });
  }
  app.get('/api/v1/documents/:id/content', {
    schema: {
      operationId: 'get_document_content',
      description: 'Download an authorized stored artifact. Storage paths are never returned.',
      security: [{ bearerAuth: [] }],
      params: objectSchema({ id: { type: 'string', format: 'uuid' } }, ['id']),
      querystring: objectSchema({}),
      response: { 200: { type: 'string', format: 'binary' } },
    },
  }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const artifact = await service.getDocumentArtifact(id);
    const contentType = /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/.test(artifact.contentType)
      ? artifact.contentType : 'application/octet-stream';
    return reply.type(contentType)
      .header('Content-Disposition', `attachment; filename="${attachmentFilename(artifact.filename)}"`)
      .header('Cache-Control', 'private, no-store')
      .header('X-Content-Type-Options', 'nosniff')
      .send(artifact.bytes);
  });
  app.get('/api/v1/openapi.json', { schema: { hide: true } }, async () => app.swagger());
  return app;
}

export async function main(): Promise<void> {
  // Reject missing credentials before opening database or storage connections.
  loadApiTokens();
  const application = await createApplication();
  let app: FastifyInstance;
  try { app = await createApi(application.service, { logger: true }); }
  catch (error) { await application.close(); throw error; }
  app.addHook('onClose', () => application.close());
  const close = () => { void app.close().catch(error => { console.error(error); process.exitCode = 1; }); };
  process.once('SIGINT', close);
  process.once('SIGTERM', close);
  try {
    const port = z.coerce.number().int().min(1).max(65535).parse(process.env.PORT ?? '3000');
    await app.listen({ port, host: process.env.HOST ?? '0.0.0.0' });
  } catch (error) { await app.close(); throw error; }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
}
