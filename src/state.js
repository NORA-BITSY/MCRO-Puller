import fs from 'node:fs';
import path from 'node:path';
import { CONFIG } from './config.js';

let updateTail = Promise.resolve();

export function createEmptyState() {
  return {
    version: '2.0.0',
    updatedAt: new Date().toISOString(),
    pulledCases: {},
  };
}

export function loadState(filePath = CONFIG.stateFile) {
  if (!fs.existsSync(filePath)) return createEmptyState();

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch (error) {
    throw new Error(`State file is unreadable or invalid JSON: ${filePath}: ${error.message}`);
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !parsed.pulledCases || typeof parsed.pulledCases !== 'object' || Array.isArray(parsed.pulledCases)) {
    throw new Error(`State file has an invalid schema: ${filePath}`);
  }

  return parsed;
}

export function saveState(state, filePath = CONFIG.stateFile) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });

  state.version = '2.0.0';
  state.updatedAt = new Date().toISOString();
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;

  try {
    fs.writeFileSync(tempPath, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf-8', mode: 0o600 });
    fs.renameSync(tempPath, filePath);
  } finally {
    if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
  }
}

async function acquireStateLock(filePath, timeoutMs = 30000, staleMs = 5 * 60 * 1000) {
  const directory = path.dirname(filePath);
  const lockPath = `${filePath}.lock`;
  fs.mkdirSync(directory, { recursive: true });
  const startedAt = Date.now();

  while (true) {
    try {
      const handle = await fs.promises.open(lockPath, 'wx', 0o600);
      await handle.writeFile(`${process.pid}\n${new Date().toISOString()}\n`, 'utf-8');
      return async () => {
        await handle.close().catch(() => {});
        await fs.promises.unlink(lockPath).catch((error) => {
          if (error.code !== 'ENOENT') throw error;
        });
      };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;

      const stats = await fs.promises.stat(lockPath).catch(() => null);
      if (stats && Date.now() - stats.mtimeMs > staleMs) {
        await fs.promises.unlink(lockPath).catch(() => {});
        continue;
      }
      if (Date.now() - startedAt >= timeoutMs) {
        throw new Error(`Timed out waiting for state lock: ${lockPath}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}

export function updateState(mutator, filePath = CONFIG.stateFile) {
  const update = updateTail.then(async () => {
    const release = await acquireStateLock(filePath);
    try {
      const state = loadState(filePath);
      const result = await mutator(state);
      saveState(state, filePath);
      return result;
    } finally {
      await release();
    }
  });

  updateTail = update.catch(() => {});
  return update;
}

export function buildCaseStateRecord(roaData, downloadSummary, previous = {}) {
  const documents = downloadSummary.documents || [];
  const now = new Date().toISOString();

  return {
    ...previous,
    status: downloadSummary.failures.length === 0 && documents.length === downloadSummary.totalDocuments
      ? 'complete'
      : 'partial',
    caseTitle: roaData.caseInfo.caseTitle,
    caseType: roaData.caseInfo.caseType,
    caseStatus: roaData.caseInfo.caseStatus,
    dateFiled: roaData.caseInfo.dateFiled,
    totalDocuments: downloadSummary.totalDocuments,
    downloadedCount: documents.length,
    skippedCount: downloadSummary.skipped.length,
    failureCount: downloadSummary.failures.length,
    manifestPath: downloadSummary.indexPath,
    lastRunAt: now,
    lastCheckedAt: now,
  };
}
