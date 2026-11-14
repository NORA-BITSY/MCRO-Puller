import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';

test('development database restart preserves committed records and existing credentials', { timeout: 60000 }, async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'court-dev-'));
  const children = new Set<ChildProcess>();
  const stop = async (child: ChildProcess) => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, 'exit');
    child.kill('SIGINT');
    const [code, signal] = await exited;
    assert.equal(code, 0, `Database process stopped by ${String(signal)}`);
  };
  t.after(async () => {
    for (const child of children) await stop(child);
    await rm(directory, { recursive: true, force: true });
  });
  const socket = createServer();
  socket.listen(0, '127.0.0.1'); await once(socket, 'listening');
  const address = socket.address(); assert.ok(address && typeof address !== 'string');
  const port = address.port;
  await new Promise<void>((resolve, reject) => socket.close(error => error ? reject(error) : resolve()));
  const script = fileURLToPath(new URL('../scripts/dev-database.ts', import.meta.url));
  const start = async () => {
    const child = spawn(process.execPath, ['--import', import.meta.resolve('tsx'), script], {
      cwd: directory, env: { ...process.env, COURT_DEV_DB_PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.add(child);
    let stdout = '', stderr = '';
    child.stderr.on('data', bytes => { stderr += String(bytes); });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Development database readiness deadline exceeded')), 30000);
      const failed = () => { clearTimeout(timer); reject(new Error(`Development database exited before readiness: ${stderr}`)); };
      child.once('exit', failed); child.once('error', reject);
      child.stdout.on('data', bytes => {
        stdout += String(bytes);
        if (stdout.includes('Court development PostgreSQL ready')) {
          clearTimeout(timer); child.removeListener('exit', failed); resolve();
        }
      });
    });
    return child;
  };
  const first = await start();
  const credentialsFile = path.join(directory, '.runtime', 'database.json');
  const credentialsBytes = await readFile(credentialsFile);
  const credentials = JSON.parse(credentialsBytes.toString()) as { password: string; port: number };
  const config = { host: '127.0.0.1', port: credentials.port, user: 'court', password: credentials.password, database: 'court_dev' };
  const before = new Pool(config);
  try {
    await before.query('CREATE TABLE restart_evidence (value text PRIMARY KEY)');
    await before.query("INSERT INTO restart_evidence VALUES ('committed before shutdown')");
  } finally { await before.end(); }
  await stop(first);
  const second = await start();
  assert.equal(createHash('sha256').update(await readFile(credentialsFile)).digest('hex'), createHash('sha256').update(credentialsBytes).digest('hex'));
  const after = new Pool(config);
  try { assert.deepEqual((await after.query('SELECT value FROM restart_evidence')).rows, [{ value: 'committed before shutdown' }]); }
  finally { await after.end(); }
  await stop(second);
});
