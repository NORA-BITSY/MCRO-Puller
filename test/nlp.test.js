import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyDocumentType, generateContextualChunks } from '../src/nlp.js';

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
