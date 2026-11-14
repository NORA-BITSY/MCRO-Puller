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

async function acquireFileLock(lockPath, timeoutMs = 30000, staleMs = 5 * 60 * 1000) {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const startedAt = Date.now();
  while (true) {
    try {
      const handle = await fs.promises.open(lockPath, 'wx', 0o600);
      try {
        await handle.writeFile(`${process.pid}\n${new Date().toISOString()}\n`, 'utf-8');
        await handle.sync();
      } catch (error) {
        await handle.close();
        await fs.promises.unlink(lockPath);
        throw error;
      }
      return async () => {
        await handle.close();
        await fs.promises.unlink(lockPath).catch((error) => {
          if (error.code !== 'ENOENT') throw error;
        });
      };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try {
        const stat = await fs.promises.lstat(lockPath);
        if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Unsafe lock file: ${lockPath}`);
        const owner = Number.parseInt(await fs.promises.readFile(lockPath, 'utf8'), 10);
        let dead = false;
        if (Number.isSafeInteger(owner) && owner > 0) {
          try {
            process.kill(owner, 0);
          } catch (ownerError) {
            if (ownerError.code === 'ESRCH') dead = true;
            else if (ownerError.code !== 'EPERM') throw ownerError;
          }
        } else {
          dead = Date.now() - stat.mtimeMs > staleMs;
        }
        if (dead) {
          // Recheck the inode before reclaiming; never remove a replacement lock.
          const current = await fs.promises.lstat(lockPath);
          if (current.ino === stat.ino) await fs.promises.unlink(lockPath);
          continue;
        }
      } catch (lockError) {
        if (lockError.code === 'ENOENT') continue;
        throw lockError;
      }
      if (Date.now() - startedAt >= timeoutMs) {
        const error = new Error(`Timed out waiting for acquisition/state lock: ${lockPath}`);
        error.code = 'retryable';
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}

export async function withCaseLock(directory, operation, options = {}) {
  const release = await acquireFileLock(path.join(directory, '.acquisition.lock'), options.lockTimeoutMs ?? 30 * 60 * 1000);
  try {
    return await operation();
  } finally {
    await release();
  }
}

export function normalizeCaseStatus(status) {
  const normalized = String(status || '').trim().toLowerCase().replace(/\s+/g, ' ');
  if (['active', 'open', 'reopened', 'pending'].includes(normalized)) return 'active';
  if (['inactive', 'closed', 'disposed', 'dismissed', 'terminated'].includes(normalized)) return normalized;
  return 'unknown';
}

export function updateState(mutator, filePath = CONFIG.stateFile) {
  const update = updateTail.then(async () => {
    const release = await acquireFileLock(`${filePath}.lock`);
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
    status: downloadSummary.status || (downloadSummary.failures.length === 0 && documents.length === downloadSummary.totalDocuments
      ? 'complete'
      : 'partial'),
    caseTitle: roaData.caseInfo.caseTitle,
    caseType: roaData.caseInfo.caseType,
    caseStatus: roaData.caseInfo.caseStatus,
    normalizedCaseStatus: normalizeCaseStatus(roaData.caseInfo.caseStatus),
    dateFiled: roaData.caseInfo.dateFiled,
    totalDocuments: downloadSummary.totalDocuments,
    downloadedCount: documents.length,
    skippedCount: downloadSummary.skipped.length,
    failureCount: downloadSummary.failures.length,
    manifestPath: downloadSummary.indexPath,
    pendingCount: downloadSummary.pending?.length || 0,
    error: downloadSummary.error || null,
    lastRunAt: now,
    lastCheckedAt: now,
  };
}
