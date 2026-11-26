import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { runNativeSync } from './native-tools.js';
import { CONFIG } from './config.js';
import { caseNumbersEqual, normalizeCaseNumber, sleepJitter } from './waf.js';
export { caseNumbersEqual, normalizeCaseNumber, sleepJitter } from './waf.js';
import { withCaseLock } from './state.js';

function sourceError(code, message, options = {}) {
  const error = new Error(message);
  error.code = code;
  if (options.retryAfterMs !== undefined) error.retryAfterMs = options.retryAfterMs;
  return error;
}

/** Bounded Poppler structural parsing, not just a header/EOF test. */
export function verifyPdfBuffer(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 8) return { valid: false, reason: 'PDF buffer is empty or too small' };
  if (!buffer.subarray(0, 5).equals(Buffer.from('%PDF-'))) return { valid: false, reason: 'Missing %PDF magic bytes' };
  if (!buffer.subarray(Math.max(0, buffer.length - 4096)).includes(Buffer.from('%%EOF'))) {
    return { valid: false, reason: 'Missing PDF end-of-file marker (%%EOF)' };
  }
  try {
    const result = runNativeSync('pdfinfo', ['-'], { input: buffer, timeout: 10000, maxBuffer: 1024 * 1024 });
    if (/Syntax Error/i.test(result.stderr) || !/^Pages:\s*[1-9]\d*\s*$/m.test(result.stdout)) {
      return { valid: false, reason: 'PDF structure check failed' };
    }
    return { valid: true, pages: Number(result.stdout.match(/^Pages:\s*(\d+)\s*$/m)[1]) };
  } catch (error) {
    return { valid: false, reason: `pdfinfo failed: ${error.message}` };
  }
}

function sanitizeFilenamePart(value, fallback = 'document', maxLength = 120) {
  return String(value || '').normalize('NFKC').replace(/[^a-zA-Z0-9_.-]+/g, '_').replace(/^[_ .-]+|[_ .-]+$/g, '').slice(0, maxLength) || fallback;
}

export function safeCaseNumber(value) {
  const raw = String(value || '');
  if (raw === '..' || raw === '.' || raw.startsWith('/') || raw.startsWith('\\') || raw.includes('/../') || raw.includes('\\..\\') || raw.startsWith('../') || raw.startsWith('..\\')) throw new Error(`case number must not attempt path traversal: ${raw}`);
  const safe = raw.replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 80);
  if (!safe) throw new Error('case number is required');
  return safe;
}

function ensureDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true });
}

function assertRegularFile(filePath) {
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Unsafe output file: ${filePath}`);
}

function writeFileAtomic(filePath, contents) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tempPath, contents);
    fs.renameSync(tempPath, filePath);
  } finally {
    if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
  }
}

const secretKey = /token|cookie|authorization|password|secret|session/i;
function sanitizeObservation(value) {
  const secrets = new Set();
  function collect(item) {
    if (!item || typeof item !== 'object') return;
    if (Array.isArray(item) && typeof item[0] === 'string' && secretKey.test(item[0]) && typeof item[1] === 'string') {
      if (item[1].length > 2) secrets.add(item[1]);
      return;
    }
    for (const [key, child] of Object.entries(item)) {
      if (secretKey.test(key) && typeof child === 'string' && child.length > 2) secrets.add(child);
      else collect(child);
    }
  }
  collect(value);
  function clean(item) {
    if (Array.isArray(item)) return item.filter((child) => !(Array.isArray(child) && typeof child[0] === 'string' && secretKey.test(child[0]))).map(clean);
    if (item && typeof item === 'object') {
      return Object.fromEntries(Object.entries(item).filter(([key]) => !secretKey.test(key)).map(([key, child]) => [key, clean(child)]));
    }
    if (typeof item !== 'string') return item;
    let text = item.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<input\b[^>]*>/gi, '')
      .replace(/([?&](?:[^=&#]*(?:token|session|auth|cookie)[^=&#]*)=)[^&#\s"']*/gi, '$1[REDACTED]');
    for (const secret of secrets) text = text.split(secret).join('[REDACTED]');
    return text;
  }
}
function metadataIdentity(event) {
  return JSON.stringify([event.indexText, event.date, event.description || event.title,
    event.document?.pages ?? event.pages, event.document?.title ?? event.documentTitle].map(identityText));
}

function identityText(value) { return String(value ?? '').normalize('NFKC').trim().replace(/\s+/g, ' '); }
function sourceDocumentId(event) {
  return event.document?.sourceDocumentId || event.document?.documentId || event.sourceDocumentId || '';
}

/** Identity never includes DOM order, download tokens, selectors, or session URLs. */
export function createDocumentKey(docEvent) {
  const parts = [
    docEvent.indexText ?? '',
    docEvent.date ?? '',
    docEvent.description ?? '',
    sourceDocumentId(docEvent) ?? '',
  ];
  return crypto.createHash('sha256').update(parts.join('|')).digest('hex');
}


function loadExistingManifest(targetDir) {
  const indexPath = path.join(targetDir, 'docket-export-index.json');
  if (!fs.existsSync(indexPath)) return null;
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(indexPath, 'utf8')); } catch (error) { throw new Error(`Existing manifest is invalid: ${indexPath}: ${error.message}`); }
  return parsed;
}

function verifyExistingDocument(targetDir, record) {
  const filePath = path.join(targetDir, record.filename);
  if (!fs.existsSync(filePath)) return null;
  assertRegularFile(filePath);
  const bytes = fs.readFileSync(filePath);
  if (record.sha256 && crypto.createHash('sha256').update(bytes).digest('hex') !== record.sha256) return null;
  if (!verifyPdfBuffer(bytes).valid) return null;
  return { ...record, savedPath: filePath, sizeBytes: bytes.length };
}

function filenameFromDisposition(disposition, fallback) {
  const match = disposition.match(/filename\*?=(?:UTF-8'')?["']?([^"';]+)["']?/i);
  return match ? decodeURIComponent(match[1].replace(/\\(.)/g, '$1')) : fallback;
}

function retryAfter(headers) {
  const raw = headers['retry-after'];
  if (!raw) return undefined;
  if (/^\d+$/.test(raw)) return Number(raw) * 1000;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? Math.max(0, parsed - Date.now()) : undefined;
}

const MAX_DOCUMENT_RESPONSE_BYTES = 50 * 1024 * 1024;

/** Preserve the demonstrated in-page FormData transport, with bounded body/time. */
export async function downloadDocument(page, docEvent, caseNumber) {
  const documentKey = createDocumentKey(docEvent);
  const safeCase = safeCaseNumber(caseNumber);
  const maxBytes = MAX_DOCUMENT_RESPONSE_BYTES;
  const response = await page.evaluate(async ({ downloadToken, sourceOrigin, timeoutMs, maxBytes }) => {
    const fail = (code, message) => ({ error: { code, message } });
    const sizeError = (bytesReceived = 0) => ({
      ...fail('permanent', 'Document exceeds the 50 MiB response size limit'),
      bytesReceived,
    });
    if (!downloadToken) return fail('parse_error', 'Document token was not found');
    const forms = Array.from(document.querySelectorAll('#mpa-roa-case-events-content form[action*="DownloadDocument"]'));
    const matches = forms.filter((candidate) => candidate.querySelector('input[name="DocumentDownloadToken"]')?.value === downloadToken);
    if (matches.length !== 1) return fail('parse_error', 'Document download form for the exact token was not found uniquely in the current docket');
    const form = matches[0];
    const action = new URL(form.action);
    if (action.origin !== sourceOrigin || !action.pathname.endsWith('/DownloadDocument')) return fail('parse_error', 'Document form action does not belong to the court source');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let length = 0;
    try {
      const fetched = await fetch(form.action, {
        method: 'POST', body: new FormData(form), credentials: 'same-origin',
        headers: { 'X-Requested-With': 'XMLHttpRequest' }, signal: controller.signal,
      });
      const headers = Object.fromEntries(['content-disposition', 'content-type', 'retry-after'].map((key) => [key, fetched.headers.get(key) || '']));
      const metadata = { status: fetched.status, statusText: fetched.statusText, headers };
      if (!fetched.ok) {
        await fetched.body?.cancel();
        return metadata;
      }
      if (Number(fetched.headers.get('content-length')) > maxBytes) {
        await fetched.body?.cancel();
        return sizeError();
      }
      if (!fetched.body) return fail('parse_error', 'Document response body is missing');
      const reader = fetched.body.getReader();
      const chunks = [];
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        length += value.byteLength;
        if (length > maxBytes) {
          await reader.cancel();
          return sizeError(length);
        }
        chunks.push(value);
      }
      const bytes = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      const encoded = [];
      for (let start = 0; start < bytes.length; start += 24576) {
        encoded.push(btoa(String.fromCharCode(...bytes.subarray(start, start + 24576))));
      }
      return { ...metadata, base64: encoded.join('') };
    } catch (error) {
      return { ...fail('retryable', error.name === 'AbortError' ? 'Document transfer timed out' : 'In-page document transfer failed'), bytesReceived: length };
    } finally {
      clearTimeout(timer);
    }
  }, { downloadToken: docEvent.document?.downloadToken, sourceOrigin: new URL(CONFIG.urls.base).origin,
    timeoutMs: CONFIG.delays.downloadTimeoutMs, maxBytes });
  if (response.error) {
    const error = sourceError(response.error.code, response.error.message);
    if (Number.isSafeInteger(response.bytesReceived) && response.bytesReceived > 0) error.bytesReceived = response.bytesReceived;
    throw error;
  }
  const { status, headers } = response;
  if (status === 403 || status === 429) { const error = sourceError('retryable', `Court source rate-limited document access (HTTP ${status})`); const retryAfterMs = retryAfter(headers); if (Number.isFinite(retryAfterMs)) error.retryAfterMs = retryAfterMs; throw error; }
  if (status < 200 || status >= 300) throw sourceError(status >= 500 ? 'retryable' : 'permanent', `HTTP ${status} ${response.statusText}`);
  const buffer = Buffer.from(response.base64 || '', 'base64');
  const verification = verifyPdfBuffer(buffer);
  if (!verification.valid) {
    const text = buffer.subarray(0, 65536).toString('utf8');
    if (/captcha|access denied|request blocked|verify (?:you are|that you are)|incapsula|imperva|too many requests/i.test(text)) throw sourceError('retryable', 'Court source returned an access challenge instead of a document');
    throw sourceError('parse_error', `Downloaded file failed PDF verification: ${verification.reason}`);
  }
  const fallback = sanitizeFilenamePart(docEvent.description, 'document');
  const sourceFilename = filenameFromDisposition(headers['content-disposition'] || '', fallback);
  const sourceStem = sanitizeFilenamePart(path.basename(sourceFilename).replace(/\.pdf$/i, ''), fallback);
  const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
  const filename = `MCRO_${safeCase}_${documentKey.slice(0, 16)}_${sha256.slice(0, 16)}_${sourceStem}.pdf`;
  return { documentKey, filename, buffer, sizeBytes: buffer.length, sha256 };
}

function writeSnapshot(targetDir, observation, kind) {
  const directory = path.join(targetDir, 'snapshots');
  ensureDirectory(directory);
  const contents = `${JSON.stringify(sanitizeObservation(observation), null, 2)}\n`;
  const sha256 = crypto.createHash('sha256').update(contents).digest('hex');
  const snapshotPath = path.join(directory, `${sha256}.json`);
  writeFileAtomic(snapshotPath, contents);
  return { path: snapshotPath, kind, sha256 };
}

function documentEvents(events) {
  return events.flatMap((event) => {
    const docs = event.documents || (event.document ? [event.document] : []);
    return docs.map((document) => ({ ...event, document, hasDocument: true }));
  });
}

function priorRecords(manifest) {
  const records = [...(manifest?.artifactInventory || []), ...(manifest?.documents || []), ...(manifest?.downloaded || [])];
  return [...new Map(records.filter((record) => record && record.filename).map((record) => [`${record.documentKey || ''}\u001f${record.filename}\u001f${record.sha256 || ''}`, record])).values()];
}

async function acquireDocuments(page, roaData, targetDir, options) {
  const caseNumber = safeCaseNumber(roaData.caseInfo.caseNumber);
  const prior = loadExistingManifest(targetDir);
  if (prior?.caseNumber && !caseNumbersEqual(prior.caseNumber, caseNumber)) throw sourceError('permanent', 'Output manifest belongs to a different case');
  const observedAt = new Date().toISOString();
  const observation = sanitizeObservation({ ...roaData, observedAt, observationId: crypto.randomUUID() });
  const snapshots = [...(prior?.snapshots || [])];
  if (prior && prior.schemaVersion !== '3.0.0') snapshots.push(writeSnapshot(targetDir, prior, 'legacy'));
  snapshots.push(writeSnapshot(targetDir, observation, 'docket'));
  const docs = documentEvents(roaData.events || []);
  const grouped = new Map();
  const metadataKeys = new Map();
  docs.forEach((event) => {
    const key = createDocumentKey(event);
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(event);
    const metadata = metadataIdentity(event);
    if (!metadataKeys.has(metadata)) metadataKeys.set(metadata, new Set());
    metadataKeys.get(metadata).add(key);
  });
  const ambiguities = [...grouped].filter(([, events]) => events.length > 1 && !events.every(sourceDocumentId)).map(([documentKey, events]) => ({ documentKey, count: events.length, reason: 'Indistinguishable document references; no ordinal or session-token identity is permitted' }));
  const ambiguousKeys = new Set(ambiguities.map((item) => item.documentKey));
  const inventory = priorRecords(prior).map((record) => sanitizeObservation(record));
  const results = {
    schemaVersion: '3.0.0', ...observation.caseInfo, caseNumber,
    caseTitle: observation.caseInfo.caseTitle, parties: observation.parties || [], sections: observation.sections || {},
    events: (observation.events || []).map((event) => {
      const refs = documentEvents([event]);
      const keys = refs.map(createDocumentKey);
      return { ...event, documentKeys: keys, identityConfidence: keys.some((key) => ambiguousKeys.has(key)) ? 'ambiguous' : refs.length && refs.every(sourceDocumentId) ? 'source' : 'derived' };
    }),
    observation, snapshots, totalDocuments: docs.length, totalEvents: (roaData.events || []).length,
    documents: [], artifactInventory: inventory, downloaded: [], skipped: [], failures: [], ambiguities,
    pending: docs.map((event) => ({ documentKey: createDocumentKey(event), index: event.index, description: event.description })),
    status: 'partial', complete: false, startedAt: observedAt, indexPath: path.join(targetDir, 'docket-export-index.json'),
  };
  const checkpoint = () => {
    results.checkpointAt = new Date().toISOString();
    writeFileAtomic(results.indexPath, `${JSON.stringify(sanitizeObservation(results), null, 2)}\n`);
  };
  checkpoint();
  try {
    for (let i = 0; i < docs.length; i++) {
      const event = docs[i];
      const documentKey = createDocumentKey(event);
      const base = { documentKey, sourceDocumentId: sourceDocumentId(event) || undefined, index: event.index, indexText: event.indexText, date: event.date, description: event.description, pages: event.document?.pages, documentTitle: event.document?.title };
      if (ambiguousKeys.has(documentKey)) {
        results.failures.push({ ...base, code: 'ambiguous', error: 'Document identity is ambiguous' });
        checkpoint();
        continue;
      }
      const direct = inventory.filter((record) => record.documentKey === documentKey);
      const candidates = direct.length ? direct : inventory.filter((record) =>
        record.sourceDocumentId
          ? record.sourceDocumentId === sourceDocumentId(event)
          : metadataIdentity(record) === metadataIdentity(event));
      const matches = direct.length ? direct.slice(-1) : candidates;
      const metadataAmbiguous = !direct.length && matches.length > 0 && metadataKeys.get(metadataIdentity(event)).size > 1;
      if (matches.length > 1 || metadataAmbiguous) {
        results.ambiguities.push({ documentKey, count: metadataAmbiguous ? metadataKeys.get(metadataIdentity(event)).size : matches.length, reason: 'Legacy artifacts have indistinguishable metadata' });
        results.failures.push({ ...base, code: 'ambiguous', error: 'Legacy migration requires an unambiguous artifact match' });
        checkpoint();
        continue;
      }
      const previous = matches[0];
      const verified = previous && !options.force ? verifyExistingDocument(targetDir, previous) : null;
      if (verified) {
        const record = { ...previous, ...base, ...verified };
        results.documents.push(record);
        results.skipped.push(record);
        results.artifactInventory.push(record);
        results.pending = results.pending.filter((item) => item.documentKey !== documentKey);
        checkpoint();
        continue;
      }
      let downloaded;
      let failure;
      for (let attempt = 1; attempt <= CONFIG.maxRetries; attempt++) {
        try {
          downloaded = await downloadDocument(page, event, caseNumber);
          break;
        } catch (error) {
          failure = error;
          if ((error.code && error.code !== 'retryable') || attempt === CONFIG.maxRetries) break;
          await new Promise((resolve) => setTimeout(resolve, 2000 * (2 ** (attempt - 1))));
        }
      }
      if (!downloaded) {
        results.failures.push({ ...base, code: failure?.code || 'error', error: failure?.message || 'Unknown download error' });
        checkpoint();
        continue;
      }
      const savedPath = path.join(targetDir, downloaded.filename);
      writeFileAtomic(savedPath, downloaded.buffer);
      const record = { ...base, filename: downloaded.filename, sizeBytes: downloaded.sizeBytes, sha256: downloaded.sha256, savedPath, acquiredAt: new Date().toISOString() };
      results.documents.push(record);
      results.downloaded.push(record);
      results.artifactInventory.push(record);
      results.pending = results.pending.filter((item) => item.documentKey !== documentKey);
      checkpoint();
      if (i < docs.length - 1) await sleepJitter();
    }
    results.complete = results.pending.length === 0 && results.failures.length === 0 && roaData.complete !== false;
    results.status = results.complete ? 'complete' : results.documents.length || results.ambiguities.length || roaData.complete === false ? 'partial' : 'error';
  } catch (error) {
    results.status = results.documents.length ? 'partial' : 'error';
    results.error = { code: error.code || 'error', message: error.message };
    results.finishedAt = new Date().toISOString();
    checkpoint();
    error.summary = results;
    throw error;
  }
  results.finishedAt = new Date().toISOString();
  checkpoint();
  writeFileAtomic(path.join(targetDir, 'README.txt'), [
    'MCRO Case Docket Export', `Case Number: ${caseNumber}`, `Acquisition Status: ${results.status}`,
    `Observed Events: ${results.totalEvents}`, `Verified Documents: ${results.documents.length}/${results.totalDocuments}`,
    `Pending: ${results.pending.length}`, `Immutable Snapshots: ${snapshots.length}`,
    'docket-export-index.json retains all observed events, sanitized sections, artifact hashes and checkpoint state.',
    'snapshots/ contains immutable docket observations and migrated legacy manifests.',
    ...results.documents.map((document) => `${document.date || ''} ${document.description || ''} -> ${document.filename}`), '',
  ].join('\n'));
  return results;
}

/** Serialized per output case; each verified artifact is checkpointed before the next request. */
export async function downloadAllCaseDocuments(page, roaData, options = {}) {
  const caseNumber = safeCaseNumber(roaData.caseInfo?.caseNumber);
  const targetDir = path.resolve(options.outputDir || path.join(CONFIG.outputDir, caseNumber));
  ensureDirectory(targetDir);
  return withCaseLock(targetDir, () => acquireDocuments(page, roaData, targetDir, options), options);
}
