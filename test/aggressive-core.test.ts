import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { LocalArtifactStore } from '../src/platform/storage.js';
import { HighAggressionProxyManager } from '../src/platform/proxy-manager.js';
import { validatePdf } from '../src/platform/storage.js';
import path from 'node:path';
import fs from 'node:fs';

const FIXTURE_DIR = path.join(process.cwd(), 'test', 'fixtures', 'aggressive-core');

describe('AggressiveWorker core logic', () => {
  let artifactStore: LocalArtifactStore;
  let proxyManager: HighAggressionProxyManager;

  before(() => {
    if (!fs.existsSync(FIXTURE_DIR)) {
      fs.mkdirSync(FIXTURE_DIR, { recursive: true });
    }
    artifactStore = new LocalArtifactStore(path.join(FIXTURE_DIR, 'artifacts'));
    proxyManager = new HighAggressionProxyManager({ pool: [] });
  });

  after(() => {
    try {
      fs.rmSync(FIXTURE_DIR, { recursive: true, force: true });
    } catch {}
    proxyManager.shutdown();
  });

  it('validatePdf async returns pages for valid PDF', async () => {
    const pdfBytes = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\nxref\n0 2\n0000000000 65535 f \n0000000010 00000 n \ntrailer\n<< /Size 2 /Root 1 0 R >>\nstartxref\n61\n%%EOF');
    const result = await validatePdf(pdfBytes, 'application/pdf');
    assert.ok(result);
    assert.ok(typeof result.pages === 'number');
    assert.ok(result.pages > 0);
  });

  it('validatePdf throws for invalid PDF', async () => {
    const invalidBytes = Buffer.from('not a pdf');
    try {
      await validatePdf(invalidBytes, 'application/pdf');
      assert.fail('Should have thrown');
    } catch (e) {
      assert.ok(e instanceof Error);
      assert.ok(e.message.includes('Invalid PDF'));
    }
  });

  it('artifact store put/get/remove roundtrip', async () => {
    const testBytes = Buffer.from('test artifact content');
    const artifact = await artifactStore.put(testBytes);
    assert.ok(artifact.sha256);
    assert.ok(artifact.storageKey);
    assert.strictEqual(artifact.sizeBytes, testBytes.length);
    
    const retrieved = await artifactStore.get(artifact.storageKey);
    assert.ok(retrieved.equals(testBytes));
    
    await artifactStore.remove(artifact.storageKey);
    try {
      await artifactStore.get(artifact.storageKey);
      assert.fail('Should have thrown');
    } catch {}
  });

  it('identity expiration detects 403/429/blocked/rate-limit', async () => {
    const { AggressiveWorker } = await import('../src/platform/aggressive-worker.js');
    const testWorker = new AggressiveWorker(
      {} as any, {} as any, { proxyManager, maxConcurrency: 1 }
    );
    
    const err403 = new Error('403 Forbidden');
    (err403 as any).code = 'blocked';
    assert.ok(testWorker['isIdentityExpirationError'](err403));
    
    const err429 = new Error('429 Too Many Requests');
    assert.ok(testWorker['isIdentityExpirationError'](err429));
    
    const errRate = new Error('Rate limit exceeded');
    assert.ok(testWorker['isIdentityExpirationError'](errRate));
    
    const errBlock = new Error('Blocked by WAF');
    assert.ok(testWorker['isIdentityExpirationError'](errBlock));
    
    const errOther = new Error('Network error');
    assert.strictEqual(testWorker['isIdentityExpirationError'](errOther), false);
    
    await testWorker.shutdown();
  });

  it('semaphore acquires/releases correctly', async () => {
    const { AggressiveWorker } = await import('../src/platform/aggressive-worker.js');
    const testWorker = new AggressiveWorker(
      {} as any, {} as any, { proxyManager, maxConcurrency: 2, semaphoreLimit: 2 }
    );
    
    await testWorker['globalSemaphore'].acquire();
    await testWorker['globalSemaphore'].acquire();
    
    const start = Date.now();
    const acquirePromise = testWorker['globalSemaphore'].acquire();
    
    setTimeout(() => testWorker['globalSemaphore'].release(), 50);
    
    await acquirePromise;
    const elapsed = Date.now() - start;
    assert.ok(elapsed >= 40);
    
    testWorker['globalSemaphore'].release();
    testWorker['globalSemaphore'].release();
    
    await testWorker.shutdown();
  });

  it('graceful shutdown sets aborted signal', async () => {
    const { AggressiveWorker } = await import('../src/platform/aggressive-worker.js');
    const testWorker = new AggressiveWorker(
      {} as any, {} as any, { proxyManager, maxConcurrency: 1 }
    );
    
    await testWorker.shutdown();
    assert.ok(testWorker['controller'].signal.aborted);
  });

  it('proxy manager empty pool', () => {
    const pm = new HighAggressionProxyManager({ pool: [] });
    assert.strictEqual(pm.getPoolStatus().total, 0);
    assert.strictEqual(pm.getPoolStatus().healthy, 0);
  });
});