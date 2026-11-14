#!/usr/bin/env node
import { createReadStream, existsSync, readFileSync, unlinkSync, statSync } from 'node:fs';
import path, { extname } from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { parse } from 'csv-parse/sync';
import { z } from 'zod';
import { createApplication } from './bootstrap.js';
import { createDatabase, migrate } from './database.js';
import { bulkSchema, invokeOperation, MAX_BODY_BYTES, type InterfaceService } from './interfaces.js';
import { CONFIG } from '../config.js';

export const HELP = `courtctl — local trusted court evidence interface (JSON output)
  sources list
  source caps --source SOURCE | --state MN
  source enable|disable|pause|resume --source SOURCE --reason TEXT [--minutes N]
  source search --query JSON --idempotency-key KEY [--source SOURCE | --state MN]
  acquire --query JSON --idempotency-key KEY [--source SOURCE | --state MN]
  bulk --file PATH [--format json|jsonl|csv] --idempotency-key KEY
  db search [--q TEXT] [structured filters] [--limit 50 --offset 0]
  db docket-search [filters] | db filing-search [filters]
  db migrate
  case get UUID | case docket UUID [--limit N --offset N]
  case refresh UUID --idempotency-key KEY | case restrict UUID --reason TEXT
  case watch UUID --enabled true|false
  refresh-policy get | refresh-policy set --policy JSON
  retention-policy get | retention-policy set --policy JSON
  retention request --query JSON --idempotency-key KEY | retention status UUID
  retention run UUID --idempotency-key KEY
  case interpretation UUID | case interpret UUID --idempotency-key KEY
  filing get UUID | document text UUID [--limit N --offset N]
  jobs status UUID | jobs retry UUID | jobs cancel UUID
  coverage [--source SOURCE] [--state STATE] [--court COURT] [--county COUNTY]
    [--category CATEGORY] [--filed-from DATE --filed-to DATE] [--limit N --offset N]
  discovery plan --query JSON | schedule due
  session status | session clear
  doctor | storage verify | metrics | import-legacy --directory PATH
Search query JSON supports case, party, business, attorney, hearing, judgment and
 document modes; source caps reports actual requirements and evidence levels.
Database filters: source,state,case-id,case-number,q,status,court,county,party,
 attorney,judge,category,filed-from,filed-to,document-type,citation,organization.
Database ordering: --sort-by observedAt|caseNumber|court|status|filedDate
 and --sort-order asc|desc.
Source search queues observation only; acquire queues acquisition. Neither implies
 exhaustive coverage. No arbitrary browser URLs or CAPTCHA bypass are supported.
`;

export function parseBatch(content: string, format: string): z.infer<typeof bulkSchema> {
  if (Buffer.byteLength(content) > MAX_BODY_BYTES) throw new Error('Batch exceeds 2 MiB');
  let input: unknown;
  if (format === 'json') {
    const value: unknown = JSON.parse(content);
    input = Array.isArray(value) ? { queries: value } : value;
  } else if (format === 'jsonl') {
    input = { queries: content.split(/\r?\n/).filter(line => line.trim()).map(line => JSON.parse(line) as unknown) };
  } else if (format === 'csv') {
    const rows: unknown = parse(content, { columns: true, bom: true, skip_empty_lines: true, trim: true,
      max_record_size: 65536, relax_column_count: false });
    const records = z.array(z.record(z.string(), z.string())).parse(rows);
    input = { queries: records.map(row => Object.fromEntries(Object.entries(row).filter(([, value]) => value !== '').map(([key, value]) => {
      if (key === 'soundex' || key === 'acquireResults') {
        return [key, value === 'true' ? true : value === 'false' ? false : value];
      }
      if (key === 'counties' || key === 'categories') {
        try { return [key, JSON.parse(value) as unknown]; }
        catch { return [key, value]; } // Preserve malformed cells for the service's per-item validation.
      }
      return [key, value];
    }))) };
  } else throw new Error('Batch format must be json, jsonl or csv');
  return bulkSchema.parse(input);
}

async function readBatchFile(path: string): Promise<string> {
  const stream = createReadStream(path, { highWaterMark: 65536 });
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of stream) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.length;
      if (size > MAX_BODY_BYTES) throw new Error('Batch exceeds 2 MiB');
      chunks.push(bytes);
    }
  } finally { stream.destroy(); }
  return Buffer.concat(chunks, size).toString('utf8');
}

const filterNames: Record<string, string> = {
  source: 'sourceId', state: 'state', 'case-id': 'caseId', 'case-number': 'caseNumber', q: 'q',
  status: 'status', court: 'court', county: 'county', party: 'party', attorney: 'attorney', judge: 'judge',
  category: 'category', 'filed-from': 'filedFrom', 'filed-to': 'filedTo', 'document-type': 'documentType',
  citation: 'citation', organization: 'organization', limit: 'limit', offset: 'offset',
  'sort-by': 'sortBy', 'sort-order': 'sortOrder',
};
const optionNames = [...Object.keys(filterNames), 'query', 'idempotency-key', 'file', 'format', 'directory', 'reason', 'enabled', 'policy','minutes'];

export async function migrateDatabase(): Promise<unknown> {
  const url = process.env.COURT_DATABASE_URL;
  if (!url) throw new Error('COURT_DATABASE_URL is required');
  const pool = createDatabase(url);
  try { await migrate(pool); return { migrated: true }; }
  finally { await pool.end(); }
}

export function handleSessionCommand(action: string): unknown {
  const sessionFile = process.env.COURT_SESSION_FILE || CONFIG.sessionFile || path.join(os.homedir(), '.mcro-puller', 'session.json');
  if (action === 'clear') {
    if (existsSync(sessionFile)) { unlinkSync(sessionFile); return { cleared: true, path: sessionFile }; }
    return { cleared: false, path: sessionFile, reason: 'File does not exist' };
  }
  if (!existsSync(sessionFile)) return { exists: false, path: sessionFile };
  const stat = statSync(sessionFile);
  const modeOctal = (stat.mode & 0o777).toString(8).padStart(4, '0');
  const content = JSON.parse(readFileSync(sessionFile, 'utf8'));
  const cookies = Array.isArray(content.cookies) ? content.cookies : [];
  return {
    exists: true,
    path: sessionFile,
    mode: modeOctal,
    sizeBytes: stat.size,
    updatedAt: stat.mtime.toISOString(),
    cookieCount: cookies.length,
    cookies: cookies.map((c: any) => ({ name: c.name, domain: c.domain, expires: c.expires > 0 ? new Date(c.expires * 1000).toISOString() : 'session' })),
  };
}

export async function runCli(args: string[], service: InterfaceService): Promise<unknown> {
  const options = Object.fromEntries(optionNames.map(name => [name, { type: 'string' as const }]));
  const { values, positionals } = parseArgs({ args, options, allowPositionals: true, strict: true });
  const remaining = new Map(Object.entries(values));
  const take = (key: string): string | undefined => {
    const value = remaining.get(key);
    remaining.delete(key);
    if (value === undefined) return undefined;
    if (typeof value !== 'string') throw new Error(`--${key} requires a string`);
    return value;
  };
  const required = (key: string): string => {
    const value = take(key);
    if (!value) throw new Error(`--${key} is required`);
    return value;
  };
  const selectedSource = (): string | undefined => {
    const source = take('source');
    const state = take('state');
    if (source && state) throw new Error('Use --source or --state, not both');
    if (state && state.toUpperCase() !== 'MN') throw new Error('Only --state MN is registered; select a supported --source explicitly');
    return source ?? (state ? 'mn-mcro' : undefined);
  };
  const query = (): Record<string, unknown> => {
    const parsed: unknown = JSON.parse(required('query'));
    const value = z.record(z.string(), z.unknown()).parse(parsed);
    const sourceId = selectedSource();
    if (sourceId && value.sourceId !== undefined && value.sourceId !== sourceId) throw new Error('Conflicting sourceId in query and CLI');
    return { ...value, ...(sourceId ? { sourceId } : {}) };
  };
  const filters = (): Record<string, unknown> => Object.fromEntries(Object.entries(filterNames).flatMap(([flag, field]) => {
    const value = take(flag);
    return value === undefined ? [] : [[field, field === 'limit' || field === 'offset' ? Number(value) : value]];
  }));
  const pagination = (): Record<string, unknown> => {
    const limit = take('limit'); const offset = take('offset');
    return { ...(limit === undefined ? {} : { limit: Number(limit) }), ...(offset === undefined ? {} : { offset: Number(offset) }) };
  };
  const [command, action, id] = positionals;
  let operation: string;
  let input: Record<string, unknown> = {};
  let expectedPositionals = 2;
  if (command === 'sources' && action === 'list') operation = 'list_sources';
  else if (command === 'source' && action === 'caps') { operation = 'get_source_capabilities'; input = { sourceId: selectedSource() ?? 'mn-mcro' }; }
  else if(command==='source'&&['enable','disable','pause','resume'].includes(action??'')){operation='control_source';const minutes=take('minutes');input={sourceId:selectedSource()??'mn-mcro',action,reason:required('reason'),...(minutes===undefined?{}:{minutes:Number(minutes)})};}
  else if (command === 'source' && action === 'search') {
    operation = 'request_acquisition'; input = { query: { ...query(), acquireResults: false }, idempotencyKey: required('idempotency-key') };
  } else if (command === 'acquire') {
    expectedPositionals = 1; operation = 'request_acquisition'; input = { query: query(), idempotencyKey: required('idempotency-key') };
  } else if (command === 'bulk') {
    expectedPositionals = 1; operation = 'request_bulk';
    const file = required('file'); const format = take('format') ?? extname(file).slice(1).toLowerCase();
    input = { input: parseBatch(await readBatchFile(file), format), idempotencyKey: required('idempotency-key') };
  } else if (command === 'db' && ['search', 'docket-search', 'filing-search'].includes(action ?? '')) {
    operation = action === 'search' ? 'search_cases' : action === 'docket-search' ? 'search_docket_entries' : 'search_filing_text'; input = filters();
  } else if (command === 'db' && action === 'migrate') {
    if (remaining.size || positionals.length !== 2) throw new Error('db migrate accepts no arguments');
    return migrateDatabase();
  } else if (command === 'case' && ['get', 'docket', 'refresh', 'restrict'].includes(action ?? '')) {
    expectedPositionals = 3;
    operation = action === 'get' ? 'get_case' : action === 'docket' ? 'get_case_docket' : action === 'refresh' ? 'request_refresh' : 'restrict_case';
    input = { id, ...(action === 'docket' ? pagination() : {}), ...(action === 'refresh' ? { idempotencyKey: required('idempotency-key') } : {}), ...(action === 'restrict' ? { reason: required('reason') } : {}) };
  } else if (command === 'filing' && action === 'get') { expectedPositionals = 3; operation = 'get_filing'; input = { id }; }
  else if (command === 'document' && action === 'text') { expectedPositionals = 3; operation = 'get_document_text'; input = { id, ...pagination() }; }
  else if (command === 'jobs' && ['status', 'retry', 'cancel'].includes(action ?? '')) {
    expectedPositionals = 3; operation = action === 'status' ? 'get_job_status' : action === 'retry' ? 'retry_job' : 'cancel_job'; input = { id };
  } else if (command === 'coverage') {
    expectedPositionals = 1; operation = 'get_coverage_report'; input = filters();
  } else if (command === 'discovery' && action === 'plan') { operation = 'plan_discovery'; input = { query: query() }; }
  else if (command === 'schedule' && action === 'due') operation = 'schedule_due';
  else if (command === 'case' && action === 'watch') {
    expectedPositionals = 3; operation = 'set_case_watch';
    const enabled = required('enabled');
    if (enabled !== 'true' && enabled !== 'false') throw new Error('--enabled must be true or false');
    input = { id, enabled: enabled === 'true' };
  } else if (command === 'refresh-policy' && action === 'get') operation = 'get_refresh_policy';
  else if (command === 'refresh-policy' && action === 'set') { operation = 'set_refresh_policy'; input = { policy: JSON.parse(required('policy')) as unknown }; }
  else if(command==='retention-policy'&&action==='get')operation='get_retention_policy';
  else if(command==='retention-policy'&&action==='set'){operation='set_retention_policy';input={policy:JSON.parse(required('policy')) as unknown};}
  else if(command==='retention'&&action==='request'){operation='request_retention';input={...z.record(z.string(),z.unknown()).parse(JSON.parse(required('query'))),idempotencyKey:required('idempotency-key')};}
  else if(command==='retention'&&['status','run'].includes(action??'')){expectedPositionals=3;operation=action==='status'?'get_retention_request':'run_retention';input={id,...(action==='run'?{idempotencyKey:required('idempotency-key')}:{})};}
  else if(command==='case'&&['interpretation','interpret'].includes(action??'')){expectedPositionals=3;operation=action==='interpretation'?'get_case_interpretation':'request_case_interpretation';input={id,...(action==='interpret'?{idempotencyKey:required('idempotency-key')}:{})};}
  else if (command === 'session' && ['status', 'clear'].includes(action ?? '')) {
    expectedPositionals = 2;
    return handleSessionCommand(action!);
  }
  else if (command === 'doctor') { expectedPositionals = 1; operation = 'health'; }
  else if (command === 'storage' && action === 'verify') operation = 'verify_storage';
  else if (command === 'metrics') { expectedPositionals = 1; operation = 'metrics'; }
  else if (command === 'import-legacy') { expectedPositionals = 1; operation = 'import_legacy'; input = { directory: required('directory') }; }
  else throw new Error(`Unknown command.\n${HELP}`);
  if (positionals.length !== expectedPositionals) throw new Error('Unexpected or missing command arguments');
  if (remaining.size) throw new Error(`Unsupported options: ${[...remaining.keys()].map(key => `--${key}`).join(', ')}`);
  return invokeOperation(service, operation, input, 'admin', 'local:cli');
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  if (!args.length || args.includes('--help') || args[0] === 'help') { process.stdout.write(HELP); return; }
  if (args.length === 2 && args[0] === 'db' && args[1] === 'migrate') {
    process.stdout.write(`${JSON.stringify(await migrateDatabase())}\n`); return;
  }
  const action = args[1];
  if (args.length === 2 && args[0] === 'session' && action && ['status', 'clear'].includes(action)) {
    process.stdout.write(`${JSON.stringify(handleSessionCommand(action))}\n`); return;
  }
  const application = await createApplication();
  try { process.stdout.write(`${JSON.stringify(await runCli(args, application.service))}\n`); }
  finally { await application.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
}
