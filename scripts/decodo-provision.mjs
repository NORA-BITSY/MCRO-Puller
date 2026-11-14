#!/usr/bin/env node
/**
 * Decodo Residential proxy pool provisioner.
 *
 * Requires an active Decodo Residential subscription. Uses the account Public
 * API key to ensure a dedicated proxy sub-user exists, then materializes the
 * sticky per-worker proxy pool as COURT_PROXIES (written to the gitignored
 * .runtime/decodo.env) and verifies each session's egress.
 *
 *   node scripts/decodo-provision.mjs            # provision + verify egress
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
    throw new Error(`Decodo env file not found: ${envPath}. Expected DECODO_API_KEY, DECODO_SUB_USERNAME, DECODO_SUB_PASSWORD.`);
  }
  const env = {};
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (match) env[match[1]] = match[2];
  }
  return env;
}

const SESSIONS = Number.parseInt(process.env.DECODO_SESSIONS || '10', 10);
const COUNTRY = process.env.DECODO_COUNTRY || 'us';
const DURATION_MIN = Number.parseInt(process.env.DECODO_SESSION_DURATION || '120', 10);

function buildPool(env) {
  const username = env.DECODO_SUB_USERNAME;
  const password = env.DECODO_SUB_PASSWORD;
  if (!username || !password) throw new Error('DECODO_SUB_USERNAME and DECODO_SUB_PASSWORD are required');
  // One proxy user; each worker gets a distinct sticky session ID in the
  // username string (Decodo backconnect parameter model).
  return Array.from({ length: SESSIONS }, (_, i) => {
    const user = `user-${username}-country-${COUNTRY}-session-mcro-w${i + 1}-sessionduration-${DURATION_MIN}`;
    return `http://${encodeURIComponent(user)}:${encodeURIComponent(password)}@gate.decodo.com:7000`;
  });
}

async function api(key, pathname, init) {
  const response = await fetch(`https://api.decodo.com${pathname}`, {
    ...init,
    headers: { Authorization: key, 'Content-Type': 'application/json', ...(init?.headers || {}) },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok && body.error_code === 'unauthorized') {
    throw new Error('Decodo Public API rejected DECODO_API_KEY (unauthorized)');
  }
  return { ok: response.ok, status: response.status, body };
}

async function ensureSubUser(env) {
  const list = await api(env.DECODO_API_KEY, '/v2/sub-users?service_type=residential_proxies');
  if (!list.ok) throw new Error(`Cannot read Decodo sub-users (HTTP ${list.status}): ${JSON.stringify(list.body)}`);
  if (Array.isArray(list.body) && list.body.some((user) => user.username === env.DECODO_SUB_USERNAME)) {
    console.log(`[Decodo] Sub-user "${env.DECODO_SUB_USERNAME}" already exists.`);
    return;
  }
  const created = await api(env.DECODO_API_KEY, '/v2/sub-users', {
    method: 'POST',
    body: JSON.stringify({
      username: env.DECODO_SUB_USERNAME,
      password: env.DECODO_SUB_PASSWORD,
      service_type: 'residential_proxies',
    }),
  });
  if (!created.ok && created.status !== 201) {
    throw new Error(
      `Sub-user creation failed (HTTP ${created.status}): ${JSON.stringify(created.body)}. ` +
      'Most common cause: no active Residential subscription on the Decodo account (start the trial at dashboard.decodo.com → Residential).',
    );
  }
  console.log(`[Decodo] Sub-user "${env.DECODO_SUB_USERNAME}" created.`);
}

async function checkEgress(pool) {
  let failures = 0;
  for (const [index, proxy] of pool.entries()) {
    try {
      const { stdout } = await run('curl', ['-sS', '-m', '45', '-x', proxy, 'https://ip.decodo.com/json'], { maxBuffer: 1024 * 1024 });
      const ip = JSON.parse(stdout)?.proxy?.ip;
      if (!ip) throw new Error(`no IP in response: ${stdout.slice(0, 120)}`);
      console.log(`[Decodo] Session w${index + 1}: egress OK via ${ip}`);
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
  console.log(`[Decodo] ${pool.length} sticky sessions written to ${envPath} as COURT_PROXIES`);
  console.log('[Decodo] Run with: set -a && source .runtime/decodo.env && set +a && COURT_ALLOW_LIVE_MN=true pnpm live:mn');
}

const env = loadEnv();
const checkOnly = process.argv.includes('--check');
if (!env.DECODO_API_KEY || !env.DECODO_SUB_USERNAME || !env.DECODO_SUB_PASSWORD) {
  throw new Error('DECODO_API_KEY, DECODO_SUB_USERNAME and DECODO_SUB_PASSWORD are required in ' + envPath);
}

if (checkOnly) {
  const failures = await checkEgress(buildPool(env));
  process.exit(failures ? 1 : 0);
}

await ensureSubUser(env);
const pool = buildPool(env);
const failures = await checkEgress(pool);
if (failures) {
  console.error(`[Decodo] ${failures}/${pool.length} sessions failed egress verification; pool not persisted.`);
  process.exit(1);
}
persistPool(pool);
