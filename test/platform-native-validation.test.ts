import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { verifyPdfBuffer } from '../src/downloader.js';
import { validatePdf } from '../src/platform/storage.js';

test('both pre-storage PDF validators establish native limits before parsing', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'court-limited-pdfinfo-'));
  const originalPath = process.env.PATH;
  t.after(async () => {
    if (originalPath === undefined) delete process.env.PATH; else process.env.PATH = originalPath;
    await rm(directory, { recursive: true, force: true });
  });
  // Controlled executable fixture verifies launch policy, not PDF validity.
  const script = '#!/bin/sh\n[ "$(ulimit -t)" = 60 ] || exit 86\n[ "$(ulimit -f)" = 131072 ] || exit 87\nif [ "$(uname -s)" = Linux ]; then [ "$(ulimit -v)" = 1048576 ] || exit 88; fi\nprintf "Pages: 1\\n"\n';
  await writeFile(path.join(directory, 'pdfinfo'), script, { mode: 0o700 });
  process.env.PATH = `${directory}${path.delimiter}${originalPath ?? ''}`;
  const bytes = Buffer.from('%PDF-1.4\ncontrolled executable fixture\n%%EOF\n');
  assert.equal(verifyPdfBuffer(bytes).valid, true);
  assert.deepEqual(await validatePdf(bytes, 'application/pdf'), { pages: 1 });
  await writeFile(path.join(directory, 'pdfinfo'), '#!/bin/sh\nprintf "Syntax Error: fixture parser failure\\n" >&2\nexit 1\n', { mode: 0o700 });
  assert.equal(verifyPdfBuffer(bytes).valid, false);
  await assert.rejects(validatePdf(bytes, 'application/pdf'), /fixture parser failure/);
});
