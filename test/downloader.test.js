import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createDocumentKey, downloadAllCaseDocuments, verifyPdfBuffer } from '../src/downloader.js';
import { resolveCaseOutputDir } from '../src/crawler.js';

function tempDirectory(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mcro-download-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function validPdf() {
  const stream = `BT /F1 12 Tf 72 720 Td (Valid fixture) Tj ET\n%${' '.repeat(1100)}\n`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`,
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((body, index) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}`;
  pdf += `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf);
}

function documentEvent(index, description = 'Order') {
  return {
    index,
    indexText: String(index),
    date: '01/02/2025',
    description,
    hasDocument: true,
    document: {
      downloadToken: `token-${index}`,
      formIndex: index - 1,
      pages: '1 page',
    },
  };
}

function roaData(events) {
  return {
    caseInfo: {
      caseNumber: '27-CV-24-1',
      caseTitle: 'Alpha v. Beta',
      caseType: 'Civil',
      caseStatus: 'Active',
      dateFiled: '01/01/2024',
      caseLocation: 'Hennepin',
      judicialOfficer: 'Example, Judge',
    },
    parties: ['Alpha', 'Beta'],
    events,
  };
}

function fakePage(pdfBuffer) {
  let requests = 0;
  return {
    get requestCount() { return requests; },
    evaluate: async (_callback, input) => {
      requests++;
      assert.equal(input.downloadToken, 'token-1');
      return {
        status: 200,
        statusText: 'OK',
        headers: { 'content-disposition': 'attachment; filename="Order.pdf"' },
        base64: pdfBuffer.toString('base64'),
      };
    },
  };
}

test('document identities distinguish same-description docket rows', () => {
  assert.notEqual(createDocumentKey(documentEvent(1)), createDocumentKey(documentEvent(2)));
});

test('PDF verification rejects truncated files with a valid header', () => {
  const truncated = Buffer.from(`%PDF-1.4\n${'x'.repeat(1200)}`);
  assert.deepEqual(verifyPdfBuffer(truncated), {
    valid: false,
    reason: 'Missing PDF end-of-file marker (%%EOF)',
  });
});

test('case output directories isolate each case', () => {
  assert.equal(resolveCaseOutputDir('27-CV-24-1', { outputDir: '/data/cases' }), '/data/cases/27-CV-24-1');
});

test('download manifest verifies and skips an unchanged document on the next run', async (t) => {
  const directory = tempDirectory(t);
  const pdf = validPdf();
  const page = fakePage(pdf);
  const event = documentEvent(1);

  const first = await downloadAllCaseDocuments(page, roaData([event]), { outputDir: directory });
  assert.equal(first.downloaded.length, 1);
  assert.equal(first.documents.length, 1);
  assert.equal(page.requestCount, 1);
  assert.equal(verifyPdfBuffer(fs.readFileSync(path.join(directory, first.documents[0].filename))).valid, true);

  const second = await downloadAllCaseDocuments(page, roaData([event]), { outputDir: directory });
  assert.equal(second.downloaded.length, 0);
  assert.equal(second.skipped.length, 1);
  assert.equal(second.documents.length, 1);
  assert.equal(page.requestCount, 1);
});

test('invalid existing manifest stops rather than overwriting provenance', async (t) => {
  const directory = tempDirectory(t);
  fs.writeFileSync(path.join(directory, 'docket-export-index.json'), '{broken', 'utf-8');

  await assert.rejects(
    downloadAllCaseDocuments(fakePage(Buffer.alloc(2000)), roaData([]), { outputDir: directory }),
    /Existing manifest is invalid/
  );
});
