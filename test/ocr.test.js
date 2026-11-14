import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { getPdfPageCount, preprocessPdf } from '../src/ocr.js';

const hasPoppler = ['pdfinfo', 'pdftotext'].every((binary) => spawnSync(binary, ['-v']).status === 0);

function createPdf(text) {
  const escaped = text.replaceAll('\\', '\\\\').replaceAll('(', '\\(').replaceAll(')', '\\)');
  const stream = `BT /F1 10 Tf 40 720 Td (${escaped}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];

  let output = '%PDF-1.4\n';
  const offsets = [0];
  for (let index = 0; index < objects.length; index++) {
    offsets.push(Buffer.byteLength(output));
    output += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(output);
  output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  output += offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  output += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(output);
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
