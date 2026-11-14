import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { deflateSync } from 'node:zlib';
import { processDocument } from '../src/platform/processing.js';
import { getPdfPageCount, preprocessPdf } from '../src/ocr.js';

const hasPoppler = ['pdfinfo', 'pdftotext'].every((binary) => spawnSync(binary, ['-v']).status === 0);

function createPdf(text, scan) {
  const lines = text.split('\n').map(line => line.replaceAll('\\', '\\\\').replaceAll('(', '\\(').replaceAll(')', '\\)'));
  const stream = `BT /F1 10 Tf 40 720 Td ${lines.map((line, i) => `${i ? '0 -18 Td ' : ''}(${line}) Tj`).join('\n')} ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [3 0 R${scan ? ' 6 0 R' : ''}] /Count ${scan ? 2 : 1} >>`,
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  if (scan) {
    const imageStream = 'q 612 0 0 792 0 0 cm /Image0 Do Q';
    const pixels = deflateSync(scan.pixels);
    objects.push(
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Image0 8 0 R >> >> /Contents 7 0 R >>',
      `<< /Length ${imageStream.length} >>\nstream\n${imageStream}\nendstream`,
      Buffer.concat([Buffer.from(`<< /Type /XObject /Subtype /Image /Width ${scan.width} /Height ${scan.height} /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode /Length ${pixels.length} >>\nstream\n`), pixels, Buffer.from('\nendstream')]),
    );
  }
  const chunks = [Buffer.from('%PDF-1.4\n')];
  const offsets = [0];
  let length = chunks[0].length;
  for (let index = 0; index < objects.length; index++) {
    offsets.push(length);
    const object = Buffer.concat([Buffer.from(`${index + 1} 0 obj\n`), Buffer.from(objects[index]), Buffer.from('\nendobj\n')]);
    chunks.push(object); length += object.length;
  }
  chunks.push(Buffer.from(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${length}\n%%EOF\n`));
  return Buffer.concat(chunks);
}

test('OCR preprocessing uses the PDF page count and emits provenance metadata', { skip: !hasPoppler }, (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mcro-ocr-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const pdfPath = path.join(directory, 'filing.pdf');
  const words = Array.from({ length: 60 }, (_, index) => `word${index}`).join(' ');
  fs.writeFileSync(pdfPath, createPdf(`27-CV-24-1 ANSWER ${words}`));

  assert.equal(getPdfPageCount(pdfPath), 1);
  const result = preprocessPdf(pdfPath, {
    caseNumber: '27-CV-24-1',
    documentId: 'document-key',
    filedDate: '01/02/2025',
    index: 4,
  });

  assert.equal(result.totalPages, 1);
  assert.equal(result.dossier.filingMeta.documentId, 'document-key');
  assert.equal(result.dossier.filingMeta.caseNumber, '27-CV-24-1');
  assert.equal(result.dossier.filingMeta.filedDate, '01/02/2025');
  assert.match(result.dossier.filingMeta.sha256, /^[a-f0-9]{64}$/);
  assert.equal(fs.existsSync(path.join(directory, 'filing.txt')), true);
  assert.equal(fs.existsSync(path.join(directory, 'filing.dossier.json')), true);
});

test('malformed PDF fails explicitly rather than becoming a blank document', { skip: !hasPoppler }, (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mcro-invalid-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filename = path.join(directory, 'bad.pdf');
  fs.writeFileSync(filename, '%PDF-1.4\nnot a PDF');
  assert.throws(() => preprocessPdf(filename), /PDF|pdfinfo|page count/);
});

test('successful empty OCR is distinguished from extraction failure', {
  skip: !hasPoppler || !['pdftoppm', 'tesseract'].every((binary) => spawnSync(binary, ['-v']).status === 0),
}, (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mcro-blank-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filename = path.join(directory, 'blank.pdf');
  fs.writeFileSync(filename, createPdf(''));
  const result = preprocessPdf(filename);
  assert.equal(result.pages[0].source, 'blank');
  assert.equal(result.pages[0].quality.status, 'blank');
});

test('one mixed PDF keeps embedded text and selectively OCRs its scanned page with exact provenance', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mcro-mixed-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const scanPdf = path.join(directory, 'scan-source.pdf');
  fs.writeFileSync(scanPdf, createPdf('SCANNED EXHIBIT\nImage only evidence on the second page.'));
  const prefix = path.join(directory, 'scan');
  const rendered = spawnSync('pdftoppm', ['-gray', '-r', '150', '-singlefile', scanPdf, prefix]);
  assert.equal(rendered.status, 0, rendered.stderr.toString());
  const image = fs.readFileSync(`${prefix}.pgm`);
  const header = image.toString('ascii', 0, 200).match(/^P5\s+(?:#[^\n]*\n\s*)*(\d+)\s+(\d+)\s+255\s/);
  assert.ok(header);
  const scan = { width: Number(header[1]), height: Number(header[2]), pixels: image.subarray(header[0].length) };
  assert.equal(scan.pixels.length, scan.width * scan.height);
  const native = 'NATIVE NOTICE\n' + Array.from({ length: 8 }, () => 'Native selectable text remains on the first page.').join('\n');
  const result = await processDocument(createPdf(native, scan), { documentVersionId: 'synthetic-mixed', filename: 'mixed.pdf' });
  assert.equal(result.status, 'complete');
  assert.deepEqual(result.pages.map(page => [page.pageNumber, page.method]), [[1, 'vector_text'], [2, 'tesseract_ocr']]);
  assert.match(result.pages[0].text, /NATIVE NOTICE/);
  assert.match(result.pages[1].text, /SCANNED EXHIBIT/);
  assert.doesNotMatch(result.pages[0].text, /SCANNED EXHIBIT/);
  assert.doesNotMatch(result.pages[1].text, /NATIVE NOTICE/);
  assert.deepEqual([...new Set(result.chunks.map(chunk => chunk.pageNumber))], [1, 2]);
  for (const chunk of result.chunks) assert.equal(result.pages[chunk.pageNumber - 1].text.slice(chunk.startOffset, chunk.endOffset), chunk.text);
});
