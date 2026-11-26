import { createDatabase } from './database.js';
import { LocalArtifactStore, GcsArtifactStore } from './storage.js';
import { CourtService } from './service.js';
import { HighAggressionProxyManager, createProxyManagerFromEnv } from './proxy-manager.js';
import { createAggressiveAdapter, type AggressiveAdapterOptions } from './aggressive-adapter.js';
export interface AggressiveApplication {
  service: CourtService;
  proxyManager: HighAggressionProxyManager;
  close: () => Promise<void>;
}

export async function createAggressiveApplication(): Promise<AggressiveApplication> {
  const url = process.env.COURT_DATABASE_URL;
  if (!url) throw new Error('COURT_DATABASE_URL is required; run courtctl db migrate before starting services');
  const pool = createDatabase(url);

  const proxyManager = createProxyManagerFromEnv();

  const adapterOptions: AggressiveAdapterOptions = {
    proxyManager,
    headed: process.env.COURT_BROWSER_HEADED === 'true',
    executablePath: process.env.COURT_CHROME_BIN,
    sessionPath: process.env.COURT_SESSION_FILE,
    maxBrowserRetries: 3,
    browserRetryDelayMs: 2000,
  };

  const aggressiveAdapter = createAggressiveAdapter(adapterOptions);
  const adapters = new Map([[aggressiveAdapter.metadata().id, aggressiveAdapter]]);

  const store = process.env.COURT_GCS_BUCKET
    ? new GcsArtifactStore(process.env.COURT_GCS_BUCKET)
    : new LocalArtifactStore(process.env.COURT_STORAGE_DIR ?? '.runtime/artifacts');

  const service = new CourtService(pool, store, adapters);

  try {
    await service.registerSources();
  } catch (error) {
    await pool.end();
    await proxyManager.shutdown();
    throw error;
  }

  return {
    service,
    proxyManager,
    close: async () => {
      await Promise.allSettled([...adapters.values()].map(adapter => adapter.close()));
      await proxyManager.shutdown();
      await pool.end();
    },
  };
}