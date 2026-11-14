#!/usr/bin/env node
/**
 * Decodo Residential proxy pool provisioner.
 *
 * Uses the operator's dashboard proxy user (DECODO_SUB_USERNAME/DECODO_SUB_PASSWORD)
 * to materialize 10 sticky US sessions as COURT_PROXIES (written to the
 * gitignored .runtime/decodo.env, mode 0600) and verifies each session's
 * egress. Sessions are port-based sticky endpoints on us.decodo.com
 * (10001-29999): one port per worker, US exit IPs, never rotated mid-session.
 *
 * Usage:
 *   node scripts/decodo-provision.mjs            # verify egress + persist pool
 *   node scripts/decodo-provision.mjs --check    # verify egress only
 */
import { readFileSync, writeFileSync, chmodSync, existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';

const run = promisify(execFile);
const envPath = process.env.DECODO_ENV_FILE || path.join(process.cwd(), '.runtime', 'decodo.env');

function loadEnv() {
  if (!existsSync(envPath)) {
    throw new Error(`Decodo env file not found: ${envPath}. Expected DECODO_SUB_USERNAME, DECODO_SUB_PASSWORD.`);
  }
  const env = {};
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (match) env[match[1]] = match[2];
  }
  return env;
}

const SESSIONS = Number.parseInt(process.env.DECODO_SESSIONS || '10', 10);
const STICKY_HOST = process.env.DECODO_STICKY_HOST || 'us.decodo.com';
const STICKY_PORT_BASE = Number.parseInt(process.env.DECODO_STICKY_PORT_BASE || '10000', 10);

function buildPool(env) {
  const username = env.DECODO_SUB_USERNAME;
  const password = env.DECODO_SUB_PASSWORD;
  if (!username || !password) throw new Error('DECODO_SUB_USERNAME and DECODO_SUB_PASSWORD are required');
  // Port-based sticky: each port is its own session with a stable US exit IP.
  return Array.from({ length: SESSIONS }, (_, i) => {
    const port = STICKY_PORT_BASE + i + 1;
    return `http://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${STICKY_HOST}:${port}`;
  });
}

async function checkEgress(pool) {
  let failures = 0;
  for (const [index, proxy] of pool.entries()) {
    try {
      const { stdout } = await run('curl', ['-sS', '-m', '45', '-x', proxy, 'https://ip.decodo.com/json'], { maxBuffer: 1024 * 1024 });
      const parsed = JSON.parse(stdout);
      const ip = parsed?.proxy?.ip;
      const country = parsed?.country?.code;
      if (!ip) throw new Error(`no IP in response: ${stdout.slice(0, 120)}`);
      if (country !== 'US') throw new Error(`non-US egress (${country})`);
      console.log(`[Decodo] Session w${index + 1}: egress OK via ${ip} (${country})`);
    } catch (error) {
      failures++;
      console.error(`[Decodo] Session w${index + 1}: FAILED (${error.message})`);
    }
  }
  return failures;
}

function persistPool(pool) {
  const existing = readFileSync(envPath, 'utf8');
  const stripped = existing.replace(/^COURT_PROXIES=.*$/m, '').replace(/\n{3,}/g, '\n\n').trimEnd();
  writeFileSync(envPath, `${stripped}\nCOURT_PROXIES=${pool.join(',')}\n`);
  chmodSync(envPath, 0o600);
  console.log(`[Decodo] ${pool.length} sticky US sessions written to ${envPath} as COURT_PROXIES`);
  console.log('[Decodo] Run with: set -a && source .runtime/decodo.env && set +a && COURT_ALLOW_LIVE_MN=true pnpm live:mn');
}

const env = loadEnv();
const checkOnly = process.argv.includes('--check');
const pool = buildPool(env);
const failures = await checkEgress(pool);
if (failures === pool.length) {
  console.error('[Decodo] All sessions failed — check DECODO_SUB_USERNAME/DECODO_SUB_PASSWORD and the Residential subscription.');
  process.exit(3);
}
if (checkOnly) process.exit(failures ? 1 : 0);
if (failures) {
  console.error(`[Decodo] ${failures}/${pool.length} sessions failed egress verification; pool not persisted.`);
  process.exit(1);
}
persistPool(pool);
