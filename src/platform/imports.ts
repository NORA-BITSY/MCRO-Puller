import { isUtf8 } from 'node:buffer';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { parse } from 'csv-parse/sync';
import type { Pool } from 'pg';
import { transaction } from './database.js';
import { JobQueue } from './jobs.js';

export interface FeedImportOptions {
  sourceId: string;
  format: 'csv' | 'pipe' | 'jsonl';
  acquireResults?: boolean;
}
export interface FeedImportReport {
  importId: string;
  sourceId: string;
  sha256: string;
  status: 'complete' | 'partial';
  acceptedRows: number;
  rejectedRows: number;
  resumedRows: number;
  checkpoint: number;
  refreshJobs: number;
  coverage: 'metadata-only';
}
interface InputRow { text: string; bytes: Buffer; line: number }
interface NormalizedRow {
  sourceId: 'mn-mcro';
  sourceCaseId: string;
  caseNumber: string;
  feedCaseId: string | null;
  sourceRecordId: string | null;
  title: string;
  court: string;
  status: string;
  county: string | null;
  caseType: string | null;
  filedDate: string | null;
  complete: false;
}
interface PreparedRow {
  raw: Record<string, unknown> | null;
  normalized: NormalizedRow | null;
  error: { code: string; message: string } | null;
}
const MAPPING_VERSION = 'mn-bulk-1';
const CASE_NUMBER_FIELDS = ['casenumber', 'courtcasenumber', 'courtfilenumber', 'mncourtcasenumber'];
const headerKey = (value: string) => value.toLowerCase().replace(/[\s_-]/g, '');

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function validateText(value: unknown): void {
  if (typeof value === 'string' && (value.includes('\0') || /[\uD800-\uDFFF]/u.test(value))) throw new Error('Text contains NUL or invalid Unicode');
  if (Array.isArray(value)) for (const item of value) validateText(item);
  else if (object(value)) for (const [key, item] of Object.entries(value)) { validateText(key); validateText(item); }
}
function normalizedDate(value: string | null): string | null {
  if (!value) return null;
  const match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(value);
  const iso = match ? `${match[3]}-${match[1]!.padStart(2, '0')}-${match[2]!.padStart(2, '0')}` : value;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) throw new Error('Filed date must be YYYY-MM-DD or MM/DD/YYYY');
  const date = new Date(`${iso}T00:00:00Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== iso) throw new Error('Invalid filed date');
  return iso;
}
function normalize(raw: Record<string, unknown>): NormalizedRow {
  const fields = new Map<string, unknown>();
  for (const [name, value] of Object.entries(raw)) {
    const key = headerKey(name);
    if (fields.has(key)) throw new Error(`Ambiguous duplicate header: ${name}`);
    fields.set(key, value);
  }
  function field(names: string[]): string | null {
    const present = names.flatMap(name => {
      const value = fields.get(name);
      if (value === null || value === undefined || value === '') return [];
      if (typeof value !== 'string' && typeof value !== 'number') throw new Error(`Field ${name} must be text or a number`);
      return String(value).trim() ? [String(value).trim()] : [];
    });
    if (new Set(present).size > 1) throw new Error(`Conflicting fields: ${names.join(', ')}`);
    return present[0] ?? null;
  }
  const caseNumber = field(CASE_NUMBER_FIELDS)?.toUpperCase();
  if (!caseNumber) throw new Error('Explicit known case number field is required; ID and CaseID are not case numbers');
  if (caseNumber.length > 100 || /[\r\n\t]/.test(caseNumber) || !/\d/.test(caseNumber)) throw new Error('Invalid case number');
  return {
    sourceId: 'mn-mcro', sourceCaseId: caseNumber, caseNumber,
    feedCaseId: field(['caseid', 'sourcecaseid']), sourceRecordId: field(['recordid', 'sourcerecordid']),
    title: field(['casetitle', 'casename', 'casecaption', 'title']) ?? '',
    court: field(['court', 'courtname', 'caselocation']) ?? '',
    status: field(['casestatus', 'status']) ?? 'unknown',
    county: field(['county', 'countyname']), caseType: field(['casetype', 'casecategory', 'category']),
    filedDate: normalizedDate(field(['fileddate', 'datefiled', 'filingdate', 'casefileddate'])), complete: false,
  };
}

/** Physical lines retain original bytes, including CRLF and malformed UTF-8. */
async function* lines(filename: string): AsyncGenerator<{ bytes: Buffer; line: number }> {
  let parts: Buffer[] = [];
  let line = 1;
  for await (const value of createReadStream(filename)) {
    const chunk: Buffer = value;
    let start = 0;
    for (let index = 0; index < chunk.length; index++) {
      if (chunk[index] === 10) {
        const segment = chunk.subarray(start, index + 1);
        const bytes = parts.length ? Buffer.concat([...parts, segment]) : segment;
        yield { bytes, line: line++ };
        parts = [];
        start = index + 1;
      }
    }
    if (start < chunk.length) parts.push(chunk.subarray(start));
  }
  if (parts.length) yield { bytes: Buffer.concat(parts), line };
}

/** CSV permits quoted multiline fields; malformed closed records remain isolated. */
async function* records(filename: string, format: FeedImportOptions['format']): AsyncGenerator<InputRow> {
  let parts: Buffer[] = [];
  let firstLine = 1;
  let quoted = false;
  let fieldStart = true;
  const delimiter = format === 'pipe' ? 124 : 44;
  for await (const line of lines(filename)) {
    if (!parts.length) firstLine = line.line;
    parts.push(line.bytes);
    if (format !== 'jsonl') {
      const start = line.line === 1 && line.bytes[0] === 0xef && line.bytes[1] === 0xbb && line.bytes[2] === 0xbf ? 3 : 0;
      for (let i = start; i < line.bytes.length; i++) {
        const byte = line.bytes[i];
        if (quoted) {
          if (byte === 34) {
            if (line.bytes[i + 1] === 34) i++;
            else quoted = false;
          }
        } else if (byte === 34 && fieldStart) { quoted = true; fieldStart = false; }
        else if (byte === delimiter || byte === 10 || byte === 13) fieldStart = true;
        else fieldStart = false;
      }
    }
    if (!quoted) {
      const bytes = parts.length === 1 ? parts[0]! : Buffer.concat(parts);
      yield { bytes, text: bytes.toString('utf8'), line: firstLine };
      parts = [];
      fieldStart = true;
    }
  }
  if (parts.length) {
    const bytes = Buffer.concat(parts);
    yield { bytes, text: bytes.toString('utf8'), line: firstLine };
  }
}
function csvFields(text: string, format: 'csv' | 'pipe'): string[] {
  const parsed: unknown = parse(text, { delimiter: format === 'pipe' ? '|' : ',', bom: true, skip_empty_lines: false });
  if (!Array.isArray(parsed) || parsed.length !== 1 || !Array.isArray(parsed[0]) || !parsed[0].every((value: unknown) => typeof value === 'string')) throw new Error('Expected one delimited record');
  // The runtime check above validates csv-parse's untyped output before use.
  return parsed[0] as string[];
}
function prepare(row: InputRow, format: FeedImportOptions['format'], headers: string[] | null, headerError: string | null): PreparedRow {
  let raw: Record<string, unknown> | null = null;
  try {
    // Never silently replace invalid source bytes in normalized data.
    if (!isUtf8(row.bytes)) throw new Error('Input record is not valid UTF-8');
    validateText(row.text);
    if (format === 'jsonl') {
      const parsed: unknown = JSON.parse(row.text.replace(/^\uFEFF/, ''));
      if (!object(parsed)) throw new Error('JSONL row must be an object');
      validateText(parsed);
      raw = parsed;
    } else {
      if (headerError || !headers) throw new Error(headerError ?? 'Missing header record');
      const values = csvFields(row.text, format);
      if (values.length !== headers.length) throw new Error(`Column count ${values.length} does not match header count ${headers.length}`);
      validateText(values);
      raw = Object.fromEntries(headers.map((name, index) => [name, values[index]]));
    }
    return { raw, normalized: normalize(raw), error: null };
  } catch (error) {
    return { raw, normalized: null, error: { code: 'invalid_feed_row', message: error instanceof Error ? error.message : String(error) } };
  }
}

/** Import an operator-supplied local extract, never fetching or enabling its source. */
export async function importFeed(pool: Pool, filePath: string, options: FeedImportOptions): Promise<FeedImportReport> {
  if (options.sourceId !== 'mn-mcro') throw new Error('Minnesota bulk imports require sourceId mn-mcro');
  if (!['csv', 'pipe', 'jsonl'].includes(options.format)) throw new Error('Format must be csv, pipe or jsonl');
  if (options.acquireResults !== undefined && typeof options.acquireResults !== 'boolean') throw new Error('acquireResults must be boolean');
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(filePath)) throw new Error('Feed import accepts a local file only; subscription fetching is not supported');
  const sourcePath = path.resolve(filePath);
  if (!(await stat(sourcePath)).isFile()) throw new Error('Feed input must be a regular local file');
  const temporary = await mkdtemp(path.join(tmpdir(), 'court-feed-'));
  let importId: string | undefined;
  try {
    // A private streaming snapshot prevents path replacement or edits between hash
    // and parse from assigning rows to the wrong checksum. Memory is row-bounded.
    const snapshot = path.join(temporary, 'input');
    const digest = createHash('sha256');
    let size = 0;
    await pipeline(createReadStream(sourcePath), new Transform({
      transform(chunk: Buffer, _encoding, callback) { digest.update(chunk); size += chunk.length; callback(null, chunk); },
    }), createWriteStream(snapshot, { flags: 'wx', mode: 0o600 }));
    const sha256 = digest.digest('hex');
    const ledger = await transaction(pool, async client => {
      await client.query("INSERT INTO sources(id,state,name) VALUES('mn-mcro','MN','Minnesota Court Records Online') ON CONFLICT(id) DO NOTHING");
      return (await client.query<{ id: string; checkpoint: string }>(`INSERT INTO feed_imports(source_id,sha256,format,mapping_version,file_path,size_bytes)
        VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(source_id,sha256,format,mapping_version)
        DO UPDATE SET updated_at=now() RETURNING id,checkpoint`, [options.sourceId, sha256, options.format, MAPPING_VERSION, sourcePath, size])).rows[0]!;
    });
    importId = ledger.id;
    const resumedRows = Number(ledger.checkpoint);
    let headers: string[] | null = null;
    let headerError: string | null = null;
    let headerSeen = options.format === 'jsonl';
    let rowNumber = 0;
    for await (const row of records(snapshot, options.format)) {
      if (!headerSeen) {
        headerSeen = true;
        try {
          if (!isUtf8(row.bytes)) throw new Error('Input header is not valid UTF-8');
          validateText(row.text);
          headers = csvFields(row.text, options.format === 'pipe' ? 'pipe' : 'csv');
          validateText(headers);
          const keys = headers.map(headerKey);
          if (new Set(keys).size !== keys.length || keys.some(key => !key)) throw new Error('Duplicate or empty header names');
          if (!keys.some(key => CASE_NUMBER_FIELDS.includes(key))) throw new Error('Explicit known case number header is required');
        } catch (error) { headerError = error instanceof Error ? error.message : String(error); }
        await pool.query('UPDATE feed_imports SET headers=$2 WHERE id=$1', [importId, JSON.stringify({ fields: headerError ? null : headers, raw: row.text.replaceAll('\0', '\\u0000'), rawBase64: row.bytes.toString('base64'), error: headerError })]);
        continue;
      }
      rowNumber++;
      if (rowNumber <= resumedRows) continue;
      const prepared = prepare(row, options.format, headers, headerError);
      await transaction(pool, async client => {
        const checkpoint = (await client.query<{ checkpoint: string }>('SELECT checkpoint FROM feed_imports WHERE id=$1 FOR UPDATE', [importId])).rows[0]!;
        if (Number(checkpoint.checkpoint) >= rowNumber) return;
        if (Number(checkpoint.checkpoint) !== rowNumber - 1) throw new Error('Non-contiguous import checkpoint');
        const item = prepared.normalized;
        let caseId: string | null = null;
        if (item) {
          const metadata = { ...(item.filedDate ? { filedDate: item.filedDate } : {}), raw: { county: item.county, caseType: item.caseType }, feedImport: { importId, rowNumber, mappingVersion: MAPPING_VERSION, complete: false } };
          const saved = (await client.query<{ id: string; availability: string }>(`INSERT INTO cases(source_id,source_case_id,case_number,title,court,status,metadata,last_observed_at,next_refresh_at)
            VALUES($1,$2,$3,$4,$5,$6,$7,now(),NULL)
            ON CONFLICT(source_id,source_case_id) DO UPDATE SET
              title=CASE WHEN cases.title='' THEN EXCLUDED.title ELSE cases.title END,
              court=CASE WHEN cases.court='' THEN EXCLUDED.court ELSE cases.court END,
              status=CASE WHEN cases.status IN ('','unknown') THEN EXCLUDED.status ELSE cases.status END,
              metadata=EXCLUDED.metadata || cases.metadata,updated_at=now()
            RETURNING id,availability`, [item.sourceId, item.sourceCaseId, item.caseNumber, item.title, item.court, item.status, JSON.stringify(metadata)])).rows[0]!;
          caseId = saved.id;
          if (item.feedCaseId) await client.query("INSERT INTO case_identifiers(case_id,kind,value,provenance) VALUES($1,'feed_case_id',$2,'mn-bulk-1') ON CONFLICT(case_id,kind,value) DO NOTHING", [caseId, item.feedCaseId]);
          if (options.acquireResults === true && saved.availability === 'public') await client.query('INSERT INTO feed_import_refreshes(import_id,case_id) VALUES($1,$2) ON CONFLICT DO NOTHING', [importId, caseId]);
        }
        await client.query(`INSERT INTO feed_import_rows(import_id,row_number,source_line,sha256,raw_text,raw_bytes,raw,normalized,case_id,error)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [importId, rowNumber, row.line, createHash('sha256').update(row.bytes).digest('hex'), row.text.replaceAll('\0', '\\u0000'), row.bytes, prepared.raw === null ? null : JSON.stringify(prepared.raw), item === null ? null : JSON.stringify(item), caseId, prepared.error === null ? null : JSON.stringify(prepared.error)]);
        await client.query(`UPDATE feed_imports SET checkpoint=$2,accepted_rows=accepted_rows+$3,rejected_rows=rejected_rows+$4,
          status='running',error=NULL,finished_at=NULL,updated_at=now() WHERE id=$1`, [importId, rowNumber, item ? 1 : 0, item ? 0 : 1]);
      });
    }
    if (!headerSeen || (headerError && rowNumber === 0)) throw new Error(headerError ?? 'Missing header record');
    if (options.acquireResults === true) {
      // Also permits explicit acquisition on a later invocation of an already
      // imported file without replaying or mutating its source observations.
      await pool.query(`INSERT INTO feed_import_refreshes(import_id,case_id)
        SELECT DISTINCT r.import_id,r.case_id FROM feed_import_rows r JOIN cases c ON c.id=r.case_id
        WHERE r.import_id=$1 AND c.availability='public' ON CONFLICT DO NOTHING`, [importId]);
    }
    // Even recovery of a durable intent requires explicit opt-in on this call.
    const queue = new JobQueue(pool);
    while (options.acquireResults === true) {
      const pending = await pool.query<{ case_id: string; source_case_id: string }>(`SELECT f.case_id,c.source_case_id
        FROM feed_import_refreshes f JOIN cases c ON c.id=f.case_id
        WHERE f.import_id=$1 AND f.job_id IS NULL AND c.availability='public' ORDER BY f.case_id LIMIT 100`, [importId]);
      if (!pending.rows.length) break;
      for (const item of pending.rows) {
        const job = await queue.enqueue({ type: 'refresh_case', sourceId: options.sourceId,
          payload: { caseId: item.case_id, sourceCaseId: item.source_case_id }, idempotencyKey: `feed:${importId}:${item.case_id}` });
        await pool.query('UPDATE feed_import_refreshes SET job_id=$3 WHERE import_id=$1 AND case_id=$2', [importId, item.case_id, job.id]);
      }
    }
    const result = (await pool.query<{ status: 'complete' | 'partial'; accepted_rows: string; rejected_rows: string; checkpoint: string }>(`UPDATE feed_imports
      SET status=CASE WHEN rejected_rows>0 THEN 'partial' ELSE 'complete' END,error=NULL,finished_at=now(),updated_at=now()
      WHERE id=$1 RETURNING status,accepted_rows,rejected_rows,checkpoint`, [importId])).rows[0]!;
    const refreshJobs = Number((await pool.query<{ count: string }>('SELECT count(*) FROM feed_import_refreshes WHERE import_id=$1 AND job_id IS NOT NULL', [importId])).rows[0]!.count);
    return { importId, sourceId: options.sourceId, sha256, status: result.status, acceptedRows: Number(result.accepted_rows), rejectedRows: Number(result.rejected_rows), checkpoint: Number(result.checkpoint), resumedRows, refreshJobs, coverage: 'metadata-only' };
  } catch (error) {
    if (importId) {
      try { await pool.query("UPDATE feed_imports SET status='failed',error=$2,updated_at=now() WHERE id=$1", [importId, JSON.stringify({ message: error instanceof Error ? error.message : String(error) })]); }
      catch { /* A lost database connection cannot record its own failure; committed checkpoints remain restartable. */ }
    }
    throw error;
  } finally { await rm(temporary, { recursive: true, force: true }); }
}
