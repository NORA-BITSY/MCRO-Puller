import assert from 'node:assert/strict';
import { test } from 'node:test';
import { summarize } from '../benchmark.mjs';

test('measurement summary reports observed samples without inventing missing results', () => {
  assert.deepEqual(summarize([10, 20, 30, 40], 1000, 1), {
    requests: 4, failures: 1, elapsedMs: 1000, requestsPerSecond: 4,
    latencyMs: { p50: 20, p95: 40, p99: 40, max: 40 },
  });
  assert.throws(() => summarize([], 1000, 0), /samples/);
});
