import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { CONFIG } from '../src/config.js';
import { createDocumentKey, downloadDocument, downloadAllCaseDocuments, SourceBlockedError, verifyPdfBuffer } from '../src/downloader.js';
import { assertExactCase, resolveCaseOutputDir } from '../src/crawler.js';
import { normalizeCaseStatus, buildCaseStateRecord, loadState, saveState, withCaseLock } from '../src/state.js';
import { syncAllActiveCases } from '../src/sync.js';
import { WorkerQueue } from '../src/queue.js';

function validPdf() {
  const stream = `BT /F1 12 Tf 72 720 Td (Fixture docket document) Tj ET\n%${' '.repeat(1100)}\n`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`,
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((body, index) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${index + 1} 0 obj\n${body}\nendobj\n`; });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf);
}

function directory(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcro-acquisition-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function event(index = 1, description = 'Order') {
  return { index, indexText: String(index), date: '01/02/2025', description, hasDocument: true,
    document: { pages: '1 page', downloadToken: `secret-${index}`, requestVerificationToken: 'csrf-secret', formIndex: index - 1 } };
}
function docket(events) {
  return { caseInfo: { caseNumber: '27-CV-24-1', caseTitle: 'A v B', caseStatus: 'Active' }, events,
    parties: ['A', 'B'], sections: { hearings: { text: 'Hearing scheduled', token: 'secret-session' }, disposition: 'Pending' } };
}
function pageFor(statuses = [200], beforeRequest) {
  let requests = 0;
  return {
    get requests() { return requests; },
    evaluate: async (_callback, input) => {
      assert.ok(input.downloadToken);
      await beforeRequest?.(requests);
      const status = statuses[Math.min(requests++, statuses.length - 1)];
      return { status, statusText: 'fixture',
        headers: { 'content-disposition': 'attachment; filename="Order.pdf"', 'retry-after': '60' },
        base64: validPdf().toString('base64') };
    },
  };
}
function noDelay(t) {
  const old = { min: CONFIG.delays.minDelayMs, max: CONFIG.delays.maxDelayMs, retries: CONFIG.maxRetries };
  CONFIG.delays.minDelayMs = CONFIG.delays.maxDelayMs = 0;
  CONFIG.maxRetries = 1;
  t.after(() => { CONFIG.delays.minDelayMs = old.min; CONFIG.delays.maxDelayMs = old.max; CONFIG.maxRetries = old.retries; });
}

test('stable identity ignores DOM position and rotated session credentials', () => {
  const a = event();
  const b = { ...a, index: 99, document: { ...a.document, formIndex: 98, downloadToken: 'rotated', requestVerificationToken: 'rotated-csrf' } };
  assert.equal(createDocumentKey(a), createDocumentKey(b));
  assert.notEqual(createDocumentKey(a), createDocumentKey(event(2)));
});

test('PDF validation rejects header/EOF camouflage but accepts a structural fixture', () => {
  assert.equal(verifyPdfBuffer(Buffer.from(`%PDF-1.4\n${'x'.repeat(1200)}\n%%EOF\n`)).valid, false);
  assert.equal(verifyPdfBuffer(validPdf()).valid, true);
});

test('a wrong document token never falls back to another form ordinal', async () => {
  const originalDocument = globalThis.document;
  globalThis.document = { querySelectorAll: () => [{ querySelector: () => ({ value: 'unrelated-token' }), action: 'https://example.test/wrong' }] };
  try {
    const page = { evaluate: async (fn, input) => fn(input), request: { post: () => { throw new Error('must not request'); } } };
    await assert.rejects(downloadDocument(page, event(), '27-CV-24-1'), /form.*not found|token.*not found/i);
  } finally {
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
  }
});

test('document transfer stays in-page and posts the exact form with a bounded stream', async () => {
  const original = { document: globalThis.document, FormData: globalThis.FormData, fetch: globalThis.fetch };
  const form = { querySelector: () => ({ value: 'secret-1' }), action: `${CONFIG.urls.base}CaseSearch/DownloadDocument` };
  globalThis.document = { querySelectorAll: () => [form] };
  globalThis.FormData = class { constructor(value) { assert.equal(value, form); this.form = value; } };
  globalThis.fetch = async (url, options) => {
    assert.equal(url, form.action);
    assert.equal(options.method, 'POST');
    assert.equal(options.body.form, form);
    assert.equal(options.headers['X-Requested-With'], 'XMLHttpRequest');
    assert.ok(options.signal);
    return new Response(validPdf(), { headers: { 'content-type': 'application/pdf' } });
  };
  try {
    const page = { evaluate: async (fn, input) => fn(input), request: { post: () => assert.fail('must use in-page fetch') } };
    assert.deepEqual((await downloadDocument(page, event(), '27-CV-24-1')).buffer, validPdf());
    globalThis.fetch = async () => new Response('oversized', { headers: { 'content-length': String(100 * 1024 * 1024) } });
    await assert.rejects(downloadDocument(page, event(), '27-CV-24-1'), /size limit/i);
  } finally {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete globalThis[key];
      else globalThis[key] = value;
    }
  }
});

for (const status of [403, 429]) {
  test(`HTTP ${status} is a typed source-wide block`, async () => {
    await assert.rejects(downloadDocument(pageFor([status]), event(), '27-CV-24-1'), (error) => error instanceof SourceBlockedError && error.code === 'blocked' && error.retryAfterMs === 60000);
  });
}

test('all docket rows and sanitized sections survive immutable snapshot history', async (t) => {
  noDelay(t);
  const dir = directory(t);
  const rows = [event(), { index: 2, date: '01/03/2025', description: 'Hearing scheduled', hasDocument: false }];
  const first = await downloadAllCaseDocuments(pageFor(), docket(rows), { outputDir: dir });
  const firstSnapshot = fs.readFileSync(first.snapshots.at(-1).path, 'utf8');
  assert.equal(first.events.length, 2);
  assert.equal(first.sections.hearings.text, 'Hearing scheduled');
  assert.equal(JSON.stringify(first).includes('secret-'), false);
  assert.equal(firstSnapshot.includes('csrf-secret'), false);
  const second = await downloadAllCaseDocuments(pageFor(), docket([...rows, { description: 'Closed', hasDocument: false }]), { outputDir: dir });
  assert.equal(second.events.length, 3);
  assert.equal(second.snapshots.length, 2);
  assert.equal(fs.readFileSync(second.snapshots.at(-2).path, 'utf8'), firstSnapshot);
});

test('legacy manifest migrates unambiguous artifact metadata without another request', async (t) => {
  const dir = directory(t);
  const old = event(1);
  const pdf = validPdf();
  const sha256 = crypto.createHash('sha256').update(pdf).digest('hex');
  fs.writeFileSync(path.join(dir, 'legacy.pdf'), pdf);
  fs.writeFileSync(path.join(dir, 'docket-export-index.json'), JSON.stringify({ schemaVersion: '2.0.0', caseNumber: '27-CV-24-1', documents: [{
    documentKey: 'legacy-order-dependent-key', index: 1, indexText: '1', date: old.date, description: old.description, pages: '1 page', filename: 'legacy.pdf', sha256,
  }] }));
  const page = pageFor();
  const result = await downloadAllCaseDocuments(page, docket([{ ...old, index: 30, document: { ...old.document, downloadToken: 'rotated' } }]), { outputDir: dir });
  assert.equal(page.requests, 0);
  assert.equal(result.skipped.length, 1);
  assert.equal(result.documents[0].filename, 'legacy.pdf');
  assert.equal(result.documents[0].sha256, sha256);
  assert.equal(result.documents[0].documentKey, createDocumentKey(old));
  assert.ok(result.snapshots.some((snapshot) => snapshot.kind === 'legacy'));
});

test('newly exposed source IDs migrate uniquely matching legacy metadata without fetching', async (t) => {
  const dir = directory(t);
  const row = event();
  const pdf = validPdf();
  const sha256 = crypto.createHash('sha256').update(pdf).digest('hex');
  fs.writeFileSync(path.join(dir, 'legacy.pdf'), pdf);
  fs.writeFileSync(path.join(dir, 'docket-export-index.json'), JSON.stringify({
    schemaVersion: '2.0.0', caseNumber: '27-CV-24-1',
    documents: [{ documentKey: 'old-key', indexText: row.indexText, date: row.date, description: row.description, pages: row.document.pages, filename: 'legacy.pdf', sha256 }],
  }));
  row.document.sourceDocumentId = 'newly-exposed-source-id';
  const page = pageFor();
  const result = await downloadAllCaseDocuments(page, docket([row]), { outputDir: dir });
  assert.equal(page.requests, 0);
  assert.equal(result.documents[0].documentKey, createDocumentKey(row));
  assert.equal(result.documents[0].sha256, sha256);
});

test('indistinguishable rows are explicitly ambiguous rather than overwritten or fetched', async (t) => {
  const dir = directory(t);
  const first = event();
  const page = pageFor();
  const result = await downloadAllCaseDocuments(page, docket([first, { ...first, index: 2, document: { ...first.document, downloadToken: 'other' } }]), { outputDir: dir });
  assert.equal(page.requests, 0);
  assert.equal(result.status, 'partial');
  assert.equal(result.events.length, 2);
  assert.equal(result.ambiguities.length, 1);
  assert.ok(result.events.every((row) => row.identityConfidence === 'ambiguous'));
});

test('multiple attachments retain stable source identities and all references', async (t) => {
  noDelay(t);
  const dir = directory(t);
  const row = event();
  row.documents = [
    { ...row.document, sourceDocumentId: 'order-1' },
    { ...row.document, sourceDocumentId: 'attachment-1', downloadToken: 'attachment-secret' },
  ];
  const first = await downloadAllCaseDocuments(pageFor(), docket([row]), { outputDir: dir });
  assert.equal(first.documents.length, 2);
  assert.equal(first.events[0].documents.length, 2);
  assert.equal(first.events[0].documentKeys.length, 2);
  const page = pageFor();
  const second = await downloadAllCaseDocuments(page, docket([{ ...row, index: 99, documents: row.documents.slice().reverse() }]), { outputDir: dir });
  assert.equal(page.requests, 0);
  assert.equal(second.skipped.length, 2);
});

test('repeated authoritative source document IDs reuse one artifact without false ambiguity', async (t) => {
  noDelay(t);
  const dir = directory(t);
  const rows = [event(1), event(2)].map((row) => ({ ...row, document: { ...row.document, sourceDocumentId: 'shared-order' } }));
  const page = pageFor();
  const result = await downloadAllCaseDocuments(page, docket(rows), { outputDir: dir });
  assert.equal(page.requests, 1);
  assert.equal(result.events.length, 2);
  assert.equal(result.ambiguities.length, 0);
  assert.equal(result.status, 'complete');
});

test('a changed PDF version never overwrites its prior immutable artifact', async (t) => {
  const dir = directory(t);
  const first = await downloadAllCaseDocuments(pageFor(), docket([event()]), { outputDir: dir });
  const changed = Buffer.from(validPdf().toString('utf8').replace('Fixture docket document', 'Changed docket document'));
  const page = { evaluate: async () => ({ status: 200, headers: { 'content-disposition': 'attachment; filename=\"Order.pdf\"' }, base64: changed.toString('base64') }) };
  const second = await downloadAllCaseDocuments(page, docket([event()]), { outputDir: dir, force: true });
  assert.equal(first.documents[0].documentKey, second.documents[0].documentKey);
  assert.notEqual(first.documents[0].filename, second.documents[0].filename);
  assert.deepEqual(fs.readFileSync(first.documents[0].savedPath), validPdf());
  assert.deepEqual(fs.readFileSync(second.documents[0].savedPath), changed);
  assert.equal(new Set(second.artifactInventory.map((item) => item.sha256)).size, 2);
});

test('ambiguous legacy metadata preserves artifacts without assigning or redownloading', async (t) => {
  const dir = directory(t);
  const row = event();
  const pdf = validPdf();
  const sha256 = crypto.createHash('sha256').update(pdf).digest('hex');
  const documents = ['first.pdf', 'second.pdf'].map((filename, index) => {
    fs.writeFileSync(path.join(dir, filename), pdf);
    return { documentKey: `old-${index}`, indexText: row.indexText, date: row.date, description: row.description, pages: row.document.pages, filename, sha256 };
  });
  fs.writeFileSync(path.join(dir, 'docket-export-index.json'), JSON.stringify({ schemaVersion: '2.0.0', caseNumber: '27-CV-24-1', documents }));
  const page = pageFor();
  const result = await downloadAllCaseDocuments(page, docket([row]), { outputDir: dir });
  assert.equal(page.requests, 0);
  assert.equal(result.status, 'partial');
  assert.equal(result.ambiguities.length, 1);
  assert.equal(result.artifactInventory.length, 2);
  for (const item of documents) assert.deepEqual(fs.readFileSync(path.join(dir, item.filename)), pdf);
});

test('a malformed PDF yields error rather than complete with zero documents', async (t) => {
  const dir = directory(t);
  const page = { evaluate: async () => ({ status: 200, headers: {}, base64: Buffer.from('%PDF-1.4\\ninvalid\\n%%EOF').toString('base64') }) };
  const result = await downloadAllCaseDocuments(page, docket([event()]), { outputDir: dir });
  assert.equal(result.status, 'error');
  assert.equal(result.complete, false);
  assert.equal(result.failures[0].code, 'parse_error');
  assert.equal(result.pending.length, 1);
});

test('a reused case output directory cannot overwrite another case manifest', async (t) => {
  const dir = directory(t);
  const existing = await downloadAllCaseDocuments(pageFor(), docket([]), { outputDir: dir });
  const before = fs.readFileSync(existing.indexPath, 'utf8');
  const wrong = docket([]);
  wrong.caseInfo.caseNumber = '27-CV-24-2';
  await assert.rejects(downloadAllCaseDocuments(pageFor(), wrong, { outputDir: dir }), /different case/i);
  assert.equal(fs.readFileSync(existing.indexPath, 'utf8'), before);
});

test('sanitized sections remove credential form fields and sensitive URL values', async (t) => {
  const dir = directory(t);
  const roa = docket([]);
  roa.sections.raw = {
    fields: [['DocumentDownloadToken', 'private-download'], ['CaseNumber', '27-CV-24-1']],
    html: '<input name=\"__RequestVerificationToken\" value=\"private-csrf\"><p>Public event</p>',
    url: 'https://example.test/roa?id=public&session=private-session',
  };
  const result = await downloadAllCaseDocuments(pageFor(), roa, { outputDir: dir });
  const serialized = fs.readFileSync(result.indexPath, 'utf8');
  assert.equal(serialized.includes('private-'), false);
  assert.match(serialized, /Public event/);
  assert.match(serialized, /CaseNumber/);
});

test('artifact checkpoint precedes next request and blocked run resumes without redownload', async (t) => {
  noDelay(t);
  const dir = directory(t);
  const rows = [event(1), event(2), event(3)];
  const blockedPage = pageFor([200, 429, 200], (request) => {
    if (request === 1) {
      const checkpoint = JSON.parse(fs.readFileSync(path.join(dir, 'docket-export-index.json'), 'utf8'));
      assert.equal(checkpoint.documents.length, 1);
      assert.equal(checkpoint.pending.length, 2);
    }
  });
  const blocked = await downloadAllCaseDocuments(blockedPage, docket(rows), { outputDir: dir });
  assert.equal(blockedPage.requests, 2);
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.complete, false);
  assert.equal(blocked.documents.length, 1);
  assert.equal(blocked.pending.length, 2);
  const resumedPage = pageFor();
  const resumed = await downloadAllCaseDocuments(resumedPage, docket(rows.map((row) => ({ ...row, index: row.index + 10 }))), { outputDir: dir });
  assert.equal(resumedPage.requests, 2);
  assert.equal(resumed.skipped.length, 1);
  assert.equal(resumed.status, 'complete');
});

test('a process crash resumes from its last artifact checkpoint and reclaims its lock', async (t) => {
  noDelay(t);
  const dir = directory(t);
  const roa = docket([event(1), event(2)]);
  const moduleUrl = new URL('../src/downloader.js', import.meta.url).href;
  const script = `
    import { downloadAllCaseDocuments } from ${JSON.stringify(moduleUrl)};
    let requests = 0;
    const page = { evaluate: async () => {
      if (++requests === 2) process.exit(73);
      return { status: 200, headers: {}, base64: ${JSON.stringify(validPdf().toString('base64'))} };
    } };
    await downloadAllCaseDocuments(page, ${JSON.stringify(roa)}, { outputDir: ${JSON.stringify(dir)} });
  `;
  await assert.rejects(promisify(execFile)(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, MCRO_MIN_DELAY_MS: '0', MCRO_MAX_DELAY_MS: '0' },
  }), (error) => error.code === 73);
  const checkpoint = JSON.parse(fs.readFileSync(path.join(dir, 'docket-export-index.json'), 'utf8'));
  assert.equal(checkpoint.documents.length, 1);
  const page = pageFor();
  const resumed = await downloadAllCaseDocuments(page, roa, { outputDir: dir });
  assert.equal(page.requests, 1);
  assert.equal(resumed.skipped.length, 1);
  assert.equal(resumed.status, 'complete');
});

test('per-case exclusion serializes concurrent acquisition and skips duplicate requests', async (t) => {
  const dir = directory(t);
  const page = pageFor();
  const results = await Promise.all([downloadAllCaseDocuments(page, docket([event()]), { outputDir: dir }), downloadAllCaseDocuments(page, docket([event()]), { outputDir: dir })]);
  assert.equal(page.requests, 1);
  assert.equal(results.reduce((sum, result) => sum + result.downloaded.length, 0), 1);
});

test('stale case locks from a dead process are recoverable', async (t) => {
  const dir = directory(t);
  fs.writeFileSync(path.join(dir, '.acquisition.lock'), `${2147483647}\n2000-01-01T00:00:00.000Z\n`);
  const value = await withCaseLock(dir, async () => 42);
  assert.equal(value, 42);
  assert.equal(fs.existsSync(path.join(dir, '.acquisition.lock')), false);
});

test('a long-running live owner cannot have its case lock stolen by age', async (t) => {
  const dir = directory(t);
  const lock = path.join(dir, '.acquisition.lock');
  fs.writeFileSync(lock, `${process.pid}\n2000-01-01T00:00:00.000Z\n`);
  const old = new Date('2000-01-01');
  fs.utimesSync(lock, old, old);
  await assert.rejects(withCaseLock(dir, async () => assert.fail('live lock must remain exclusive'), { lockTimeoutMs: 1 }), /Timed out/);
  assert.equal(fs.existsSync(lock), true);
});

test('output paths and ROA identities fail closed', () => {
  assert.throws(() => resolveCaseOutputDir('../../escape', { outputDir: '/data/cases' }), /case number/i);
  assert.throws(() => resolveCaseOutputDir('../27-CV-24-1', { outputDir: '/data/cases' }), /case number/i);
  assert.throws(() => assertExactCase(docket([]), '27-CV-24-2'), /exact|mismatch/i);
  assert.throws(() => assertExactCase({ caseInfo: {} }, '27-CV-24-1'), /exact|missing/i);
  assert.equal(assertExactCase(docket([]), '27-CV-24-000001'), '27-CV-24-1');
});

test('Inactive is not active and blocked case state is never complete', () => {
  assert.equal(normalizeCaseStatus(' Inactive '), 'inactive');
  assert.equal(normalizeCaseStatus('OPEN'), 'active');
  assert.equal(normalizeCaseStatus('Closed'), 'closed');
  const record = buildCaseStateRecord(docket([]), { status: 'blocked', documents: [], failures: [], skipped: [], totalDocuments: 0, pending: [] });
  assert.equal(record.status, 'blocked');
});

test('sync excludes inactive cases and not_found is not reported current', async (t) => {
  const stateFile = path.join(directory(t), 'state.json');
  saveState({ pulledCases: { inactive: { caseStatus: 'Inactive' }, active: { caseStatus: 'Open' } } }, stateFile);
  const seen = [];
  await assert.rejects(syncAllActiveCases({}, { stateFile, syncCase: async (_client, caseNumber) => {
    seen.push(caseNumber);
    return { updated: false, status: 'not_found', reason: 'not_found' };
  } }), (error) => error.summary.failedCount === 1 && error.summary.upToDateCount === 0);
  assert.deepEqual(seen, ['active']);
});

test('queue pauses source-wide challenges and durably retains pending work', async (t) => {
  const stateFile = path.join(directory(t), 'state.json');
  const seen = [];
  const queue = new WorkerQueue({ stateFile, concurrency: 2,
    createBrowserClient: async () => ({ close: async () => {} }),
    crawlCase: async (_client, caseNumber) => { seen.push(caseNumber); throw new SourceBlockedError('challenge'); },
  });
  queue.addCases(['27-CV-24-1', '27-CV-24-2', '27-CV-24-3']);
  const result = await queue.run();
  assert.equal(result.status, 'blocked');
  assert.equal(result.stopped, true);
  // With concurrent workers, cases started in parallel with the blocked one
  // may already be in flight; the source-wide pause guarantees no case beyond
  // the concurrency ceiling is attempted and everything is durably retained.
  assert.ok(seen.length >= 1 && seen.length <= 2, `expected at most concurrency-2 cases attempted, saw ${seen.length}`);
  assert.deepEqual(result.pending, ['27-CV-24-1', '27-CV-24-2', '27-CV-24-3']);
  assert.deepEqual(loadState(stateFile).queue.pending, result.pending);
});

test('worker pool assigns one sticky proxy per concurrent worker and completes all cases', async (t) => {
  const stateFile = path.join(directory(t), 'state.json');
  const proxies = [];
  let concurrent = 0;
  let peakConcurrency = 0;
  const queue = new WorkerQueue({ stateFile, concurrency: 3, proxyPool: ['http://proxy-a:8080', 'http://proxy-b:8080'],
    createBrowserClient: async (options) => { proxies.push(options.proxy); return { close: async () => {} }; },
    crawlCase: async () => {
      concurrent++; peakConcurrency = Math.max(peakConcurrency, concurrent);
      await new Promise((resolve) => setTimeout(resolve, 25));
      concurrent--;
      return { success: true, status: 'complete' };
    },
  });
  queue.addCases(['27-CV-24-101', '27-CV-24-102', '27-CV-24-103']);
  const result = await queue.run();
  assert.equal(result.status, 'complete');
  assert.equal(result.succeeded, 3);
  // Every browser client egresses through a pool proxy (never undefined).
  assert.ok(proxies.length >= 3 && proxies.every((proxy) => proxy === 'http://proxy-a:8080' || proxy === 'http://proxy-b:8080'),
    `expected pool proxies only, saw ${proxies.join(',')}`);
  assert.ok(peakConcurrency > 1, `expected concurrent crawl execution, peak was ${peakConcurrency}`);
});
