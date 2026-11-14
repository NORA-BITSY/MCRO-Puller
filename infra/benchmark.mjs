import { pathToFileURL } from 'node:url';

export function summarize(samples, elapsedMs, failures) {
  if (samples.length === 0 || elapsedMs <= 0) throw new Error('nonempty samples and elapsed time required');
  const sorted = [...samples].sort((a, b) => a - b);
  const quantile = (p) => sorted[Math.ceil(sorted.length * p) - 1];
  return {
    requests: samples.length,
    failures,
    elapsedMs,
    requestsPerSecond: samples.length / (elapsedMs / 1000),
    latencyMs: { p50: quantile(0.5), p95: quantile(0.95), p99: quantile(0.99), max: sorted.at(-1) },
  };
}

async function main() {
  const target = new URL(process.env.BENCH_URL || 'http://127.0.0.1:3000/api/v1/health');
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname)) {
    throw new Error('This harness targets local/staging tunnels only, never live court portals');
  }
  const count = Number(process.env.BENCH_REQUESTS || 1000);
  const concurrency = Number(process.env.BENCH_CONCURRENCY || 4);
  if (!Number.isSafeInteger(count) || count < 1 || !Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 100) {
    throw new Error('Positive integer request count and concurrency 1..100 required');
  }
  const token = process.env.API_TOKEN_READ;
  if (!token) throw new Error('API_TOKEN_READ required');
  const samples = [];
  let failures = 0;
  let issued = 0;
  const started = performance.now();
  await Promise.all(Array.from({ length: Math.min(count, concurrency) }, async () => {
    while (issued < count) {
      issued += 1;
      const start = performance.now();
      try {
        const response = await fetch(target, {
          headers: { authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(30000),
          redirect: 'error',
        });
        await response.arrayBuffer();
        if (!response.ok) failures += 1;
      } catch {
        failures += 1;
      }
      samples.push(performance.now() - start);
    }
  }));
  console.log(JSON.stringify({
    kind: 'local-http-observation',
    observedAt: new Date().toISOString(),
    endpoint: target.pathname,
    concurrency,
    node: process.version,
    ...summarize(samples, performance.now() - started, failures),
  }, null, 2));
  if (failures > 0) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
