import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { Pool, type PoolClient } from 'pg';

export function createDatabase(url: string): Pool {
  const pool = new Pool({ connectionString: url, connectionTimeoutMillis: 10_000 });
  pool.on('error', error => {
    console.error(JSON.stringify({ event: 'database_idle_connection_error', code: 'code' in error ? error.code : 'connection_error' }));
  });
  return pool;
}

/** The callback owns no connection lifetime; all writes commit or roll back together. */
export async function transaction<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  let discard: Error | undefined;
  // A terminated backend can emit a second client error after rejecting the
  // active query. Keep it owned until release; discard, never recycle, that socket.
  const connectionError = (error: Error): void => { discard = error; };
  client.on('error', connectionError);
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      // A failed rollback must never return an unknown transaction state to the pool.
      discard = rollbackError instanceof Error ? rollbackError : new Error(String(rollbackError));
      throw new AggregateError([error, rollbackError], 'Transaction failed and rollback failed');
    }
    throw error;
  } finally {
    client.release(discard);
    client.off('error', connectionError);
  }
}

interface Migration {
  version: string;
  sql: string;
  sha256: string;
}

async function migrationFiles(): Promise<Migration[]> {
  // Source: src/platform/database.ts; build: dist/src/platform/database.js.
  // Both deployments keep immutable SQL in the repository-root migrations folder.
  const candidates = [new URL('../../migrations/', import.meta.url), new URL('../../../migrations/', import.meta.url)];
  for (const directory of candidates) {
    let names: string[];
    try {
      names = await readdir(directory);
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') continue;
      throw error;
    }
    const versions = names.filter((name) => /^\d{4,}_[a-z0-9_]+\.sql$/.test(name)).sort();
    if (versions.length === 0) throw new Error(`No SQL migrations found at ${directory.pathname}`);
    const prefixes = new Set(versions.map((name) => name.split('_')[0]));
    if (prefixes.size !== versions.length) throw new Error('Duplicate migration sequence number');
    return Promise.all(versions.map(async (version) => {
      const sql = await readFile(new URL(version, directory), 'utf8');
      return { version, sql, sha256: createHash('sha256').update(sql).digest('hex') };
    }));
  }
  throw new Error('Repository migrations directory is missing; deploy migrations alongside dist');
}

/** Apply forward migrations atomically, refusing missing, reordered or changed history. */
export async function migrate(pool: Pool): Promise<void> {
  const migrations = await migrationFiles();
  await transaction(pool, async (client) => {
    // A transaction-scoped, database/schema-specific lock serializes both the ledger
    // creation and application. It releases even if the connection dies mid-migration.
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended(current_database() || ':' || current_schema() || ':court:migrations', 0))");
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version text PRIMARY KEY,
      sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const history = await client.query<{ version: string; sha256: string }>('SELECT version,sha256 FROM schema_migrations ORDER BY version');
    const available = new Map(migrations.map((migration) => [migration.version, migration]));
    const applied = new Set<string>();
    for (const row of history.rows) {
      const file = available.get(row.version);
      if (!file) throw new Error(`Applied migration is missing from this deployment: ${row.version}`);
      if (file.sha256 !== row.sha256) throw new Error(`Migration checksum mismatch: ${row.version}`);
      applied.add(row.version);
    }
    const latest = history.rows.at(-1)?.version;
    for (const migration of migrations) {
      if (applied.has(migration.version)) continue;
      if (latest && migration.version < latest) throw new Error(`Out-of-order migration refused: ${migration.version}`);
      await client.query(migration.sql);
      await client.query('INSERT INTO schema_migrations(version,sha256) VALUES ($1,$2)', [migration.version, migration.sha256]);
    }
  });
}
