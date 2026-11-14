import assert from 'node:assert/strict';
import test from 'node:test';
import { analyzePages, validateInterpretation, processDocument } from '../src/platform/processing.js';

test('entities and chunks retain exact page-local UTF-16 offsets', () => {
  const text = 'COMPLAINT\n😀 Minn. Stat. § 504B.321 demands $1,250.00 on 01/02/2025.';
  const result = analyzePages([{ pageNumber: 1, text, method: 'vector_text', quality: {} }]);
  assert.equal(result.classification.label, 'COMPLAINT');
  assert.ok(result.entities.some(e => e.kind === 'statute'));
  for (const entity of result.entities) assert.equal(text.slice(entity.startOffset, entity.endOffset), entity.value);
  for (const chunk of result.chunks) assert.equal(text.slice(chunk.startOffset, chunk.endOffset), chunk.text);
});

test('interpretation rejects invented evidence, unknown fields, and citation promotion', () => {
  const pages = [{ pageNumber: 1, text: 'An allegation only.', method: 'vector_text', quality: {} }];
  const assertion = { kind: 'allegation', text: 'An allegation only.', evidence: [{ pageNumber: 1, startOffset: 0, endOffset: 20, quote: 'An allegation only.' }], confidence: 0.7 };
  assert.throws(() => validateInterpretation({ assertions: [assertion] }, pages), /evidence/i);
  assertion.evidence[0]!.endOffset = 19;
  assert.equal(validateInterpretation({ assertions: [assertion] }, pages).assertions.length, 1);
  assert.throws(() => validateInterpretation({ assertions: [assertion], citations: ['invented'] }, pages));
  assert.throws(() => validateInterpretation({ assertions: [{ ...assertion, kind: 'citation' }] }, pages));
});

test('processing rejects non-PDF input before tools or inference', async () => {
  await assert.rejects(processDocument(Buffer.from('not pdf'), { documentVersionId: 'v', filename: 'x.pdf' }), /PDF/);
});

test('page failures are partial while genuine blanks are successful', () => {
  assert.equal(analyzePages([{ pageNumber: 1, text: '', method: 'blank', quality: { status: 'blank' } }]).status, 'complete');
  const failed = analyzePages([{ pageNumber: 1, text: 'retained', method: 'vector_text_sparse', quality: { status: 'failed', error: 'timeout' } }]);
  assert.equal(failed.status, 'partial');
  assert.match(failed.warnings.join(' '), /failed/);
});
