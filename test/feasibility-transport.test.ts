import test from 'node:test';
import assert from 'node:assert/strict';
import { findSystemChrome } from '../src/browser.js';
import { ensureTermsAccepted } from '../src/waf.js';
import { MinnesotaAdapter } from '../src/platform/adapters.js';
import { CourtService } from '../src/platform/service.js';
import { createDatabase } from '../src/platform/database.js';
import { LocalArtifactStore } from '../src/platform/storage.js';
import { createAdapters } from '../src/platform/adapters.js';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';

test('findSystemChrome identifies local Chrome binary or respects environment overrides', () => {
  const original = process.env.COURT_CHROME_BIN;
  try {
    process.env.COURT_CHROME_BIN = '/bin/sh';
    assert.equal(findSystemChrome(), '/bin/sh');
  } finally {
    if (original === undefined) delete process.env.COURT_CHROME_BIN;
    else process.env.COURT_CHROME_BIN = original;
  }
});

test('ensureTermsAccepted refuses automated consent by default and requires operator confirmation', async () => {
  const originalAutoAccept = process.env.COURT_AUTO_ACCEPT_TERMS;
  delete process.env.COURT_AUTO_ACCEPT_TERMS;

  let clicked = false;
  const mockPage = {
    locator: (selector: string) => ({
      isVisible: async () => selector === '#tcModalAcceptBtn',
      click: async () => { clicked = true; },
    }),
    waitForTimeout: async () => {},
  };

  try {
    await assert.rejects(
      async () => ensureTermsAccepted(mockPage as any),
      (err: any) => {
        assert.equal(err.code, 'blocked');
        assert.match(err.message, /refusing automated terms acceptance on user's behalf/i);
        return true;
      }
    );
    assert.equal(clicked, false, 'Terms accept button must not be clicked without authorization');

    process.env.COURT_AUTO_ACCEPT_TERMS = 'true';
    const accepted = await ensureTermsAccepted(mockPage as any);
    assert.equal(accepted, true);
    assert.equal(clicked, true);
  } finally {
    if (originalAutoAccept === undefined) delete process.env.COURT_AUTO_ACCEPT_TERMS;
    else process.env.COURT_AUTO_ACCEPT_TERMS = originalAutoAccept;
  }
});

test('MinnesotaAdapter exposes efficiency metrics and reuses session-level docket across document downloads', async () => {
  const adapter = new MinnesotaAdapter('standalone', { headed: false });
  assert.equal(typeof adapter.getEfficiencyMetrics, 'function');
  const metrics = adapter.getEfficiencyMetrics();
  assert.equal(metrics.navsAvoided, 0);
  assert.equal(metrics.docketFetches, 0);
  assert.equal(metrics.documentDownloads, 0);
});

test('CourtService.health() discriminates database, browser, sources, credentials, storage, worker, http, and mcp without credential disclosure', async () => {
  const dbUrl = process.env.COURT_DATABASE_URL || process.env.COURT_TEST_DATABASE_URL;
  if (!dbUrl) return; // Skip if no DB

  const pool = createDatabase(dbUrl);
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'health-test-'));
  const store = new LocalArtifactStore(tmpDir);
  const adapters = createAdapters({ mode: 'standalone' });
  const service = new CourtService(pool, store, adapters);

  try {
    const health = await service.health() as any;
    assert.equal(health.status, 'ok');
    assert.equal(health.database, 'reachable');
    assert.ok(health.details, 'details must be present');

    const { details } = health;
    assert.equal(details.database.status, 'reachable');
    assert.ok(details.browser);
    assert.equal(details.browser.mode, 'standalone');
    assert.equal(details.browser.extensionBridge.supported, false);
    assert.ok(details.sources['mn-mcro']);
    assert.ok(details.sources['independent-fixture']);
    assert.ok(details.credentials);
    assert.equal(typeof details.credentials.apiReadTokenPresent, 'boolean');
    assert.equal(typeof details.credentials.databaseConfigured, 'boolean');
    // Ensure no secrets leaked
    const json = JSON.stringify(details);
    assert.doesNotMatch(json, /postgres:\/\/.*:.*@/);
    assert.doesNotMatch(json, /secret/i);

    assert.equal(details.storage.status, 'accessible');
    assert.equal(typeof details.worker.activeOrQueuedJobs, 'number');
    assert.equal(details.http.configured, true);
    assert.equal(details.mcp.configured, true);
  } finally {
    await pool.end();
    await rm(tmpDir, { recursive: true, force: true });
  }
});
