import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { LocalArtifactStore, validatePdf } from '../src/platform/storage.js';

test('immutable storage survives retries and detects corrupt bytes', async t => {
  const dir=await mkdtemp(path.join(os.tmpdir(),'court-store-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const store=new LocalArtifactStore(dir);
  const bytes=Buffer.from('original source bytes');
  const first=await store.put(bytes);
  assert.deepEqual(await store.put(bytes),first);
  assert.deepEqual(await store.get(first.storageKey),bytes);
  await writeFile(path.join(dir,first.storageKey),'corrupt');
  await assert.rejects(store.get(first.storageKey),/checksum/);
  await assert.rejects(store.put(bytes),/checksum/);
});
test('artifact keys cannot escape the storage root',async t=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'court-store-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  await assert.rejects(new LocalArtifactStore(dir).get('../session.json'),/key/);
});
test('header-only PDF is rejected by structural parser',async()=>{
  await assert.rejects(validatePdf(Buffer.from('%PDF-1.7\n'+'x'.repeat(1200)+'\n%%EOF'),'application/pdf'),/PDF/);
});
