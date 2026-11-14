import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { test } from 'node:test';


async function probe(status, token = 'read-test-token') {
  let authorization;
  let path;
  const server = createServer((request, response) => {
    authorization = request.headers.authorization;
    path = request.url;
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ status: status === 200 ? 'ok' : 'unavailable' }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const child = spawn(process.execPath, [new URL('../healthcheck.mjs', import.meta.url).pathname], {
      env: { ...process.env, PORT: String(server.address().port), API_TOKEN_READ: token },
      stdio: 'ignore',
    });
    const code = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', resolve);
    });
    return { code, authorization, path };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('container readiness authenticates the actual HTTP health route', async () => {
  assert.deepEqual(await probe(200), {
    code: 0, authorization: 'Bearer read-test-token', path: '/api/v1/health',
  });
});

test('readiness fails closed for rejected credentials and database failures', async () => {
  assert.equal((await probe(401)).code, 1);
  assert.equal((await probe(503)).code, 1);
  const missing = await probe(200, '');
  assert.equal(missing.code, 1);
  assert.equal(missing.authorization, undefined);
});

