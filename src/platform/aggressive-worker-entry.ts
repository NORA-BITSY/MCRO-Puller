#!/usr/bin/env node
import { runAggressiveWorker } from './aggressive-worker.js';
import { createProxyManagerFromEnv } from './proxy-manager.js';

async function main(): Promise<void> {
  console.log('[AggressiveWorker] Starting high-aggression extraction worker');

  const proxyManager = createProxyManagerFromEnv();

  await runAggressiveWorker({ proxyManager });
}

main().catch((error) => {
  console.error('[AggressiveWorker] Fatal error:', error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});