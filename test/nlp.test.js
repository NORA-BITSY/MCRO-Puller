import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyDocumentType, classifyDocumentHeading, generateContextualChunks, processFilingToDossier, synthesizeCaseDossier } from '../src/nlp.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('classification does not call an answer a complaint merely because it references one', () => {
  const text = 'DEFENDANT ANSWER\nDefendant answers the allegations in the Complaint as follows.';
  assert.equal(classifyDocumentType(text, 'answer.pdf'), 'ANSWER');
});

test('oversized paragraphs are split within the configured chunk bound', () => {
  const text = `${'word '.repeat(300)}\n\n${'second '.repeat(180)}`;
  const chunks = generateContextualChunks(text, {
    caseNumber: '27-CV-24-1',
    documentId: 'document-a',
    filename: 'filing.pdf',
  }, 500, 50);

  assert.ok(chunks.length > 2);
  assert.ok(chunks.every((chunk) => chunk.charCount <= 500));
  assert.equal(new Set(chunks.map((chunk) => chunk.chunkId)).size, chunks.length);
});

test('chunk identifiers remain unique across filings in the same case', () => {
  const text = 'A sufficiently small filing paragraph.';
  const first = generateContextualChunks(text, { caseNumber: '27-CV-24-1', documentId: 'document-a' });
  const second = generateContextualChunks(text, { caseNumber: '27-CV-24-1', documentId: 'document-b' });

  assert.notEqual(first[0].chunkId, second[0].chunkId);
});

test('invalid chunk settings fail explicitly', () => {
  assert.throws(() => generateContextualChunks('text', {}, 100, 20), /at least 256/);
  assert.throws(() => generateContextualChunks('text', {}, 500, 500), /smaller than maxChunkSize/);
});

test('heading outranks procedural references and filename hints', () => {
  assert.equal(classifyDocumentType('COMPLAINT\nPlaintiff seeks an order and judgment; defendant must answer.', 'answer.pdf'), 'COMPLAINT');
  assert.equal(classifyDocumentType('ORDER\nThe motion and complaint are dismissed.'), 'ORDER');
  assert.equal(classifyDocumentType('The parties discussed a motion in their correspondence.'), 'OTHER');
});

test('wrapped caption references cannot outrank the actual summons heading', () => {
  const text = 'STATE OF EXAMPLE\nUnknown persons claiming an interest described in the\ncomplaint herein,\nDefendants.\n\nSUMMONS\nYou must serve an answer to the complaint.';
  const result = classifyDocumentHeading(text, 'answer.pdf');
  assert.equal(result.label, 'SUMMONS');
  assert.equal(result.family, 'NOTICE');
  assert.equal(result.evidence, 'SUMMONS');
  assert.equal(classifyDocumentType('order the relief requested below.\n\nCOMPLAINT\nThe plaintiff requests an order.'), 'COMPLAINT');
});

test('title-case headings and bounded source filename titles retain taxonomy and provenance', () => {
  const title = classifyDocumentHeading('Defendant Response to Motion\nThe motion should be denied.');
  assert.equal(title.label, 'RESPONSE');
  assert.equal(title.family, 'RESPONSE');
  assert.equal(title.evidence, 'Defendant Response to Motion');
  const filename = 'PORTAL_XX-CV-24-1_Civil Cover Sheet_2024-01-01.pdf';
  const hint = classifyDocumentHeading('INFORMATIONAL STATEMENT', filename);
  assert.equal(hint.label, 'CIVIL_COVER_SHEET');
  assert.equal(hint.family, 'ADMINISTRATIVE');
  assert.equal(hint.evidence, filename);
  assert.ok(hint.confidence < title.confidence);
  for (const label of ['DECLARATION', 'EXHIBIT', 'TRANSCRIPT', 'CORRESPONDENCE']) {
    assert.equal(classifyDocumentType(`${label}\nSupporting material.`), label);
  }
});

test('case synthesis ignores stale dossiers outside the current manifest', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'court-dossier-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.writeFileSync(path.join(directory, 'docket-export-index.json'), JSON.stringify({
    caseNumber: '27-CV-24-1', documents: [{ filename: 'current.pdf' }, { filename: 'removed.pdf', status: 'removed' }],
  }));
  for (const name of ['current', 'removed', 'stale']) {
    fs.writeFileSync(path.join(directory, `${name}.dossier.json`), JSON.stringify(
      processFilingToDossier('COMPLAINT\nAn allegation.', { documentId: name, filename: `${name}.pdf` }),
    ));
  }
  assert.deepEqual(synthesizeCaseDossier(directory).filings.map(filing => filing.documentId), ['current']);
});
