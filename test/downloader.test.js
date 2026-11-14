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
    evaluate: async (_callback, input) => ({
      action: 'https://publicaccess.courts.state.mn.us/CaseSearch/DownloadDocument',
      fields: [['DocumentDownloadToken', input.downloadToken], ['__RequestVerificationToken', 'csrf']],
    }),
    request: {
      post: async (_url, options) => {
        requests++;
        assert.match(options.data, /DocumentDownloadToken=token-1/);
        return {
          ok: () => true,
          status: () => 200,
          statusText: () => 'OK',
          headers: () => ({ 'content-disposition': 'attachment; filename="Order.pdf"' }),
          body: async () => pdfBuffer,
          dispose: async () => {},
        };
      },
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
  const pdf = Buffer.from(`%PDF-1.4\n${'x'.repeat(1200)}\n%%EOF\n`);
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
