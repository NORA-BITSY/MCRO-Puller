// This probe is local-only. Never print credentials or response bodies.
const token = process.env.API_TOKEN_READ;
if (!token) process.exit(1);
try {
  const response = await fetch(`http://127.0.0.1:${process.env.PORT || '3000'}/api/v1/health`, {
    headers: { authorization: `Bearer ${token}` },
    redirect: 'error',
    signal: AbortSignal.timeout(4000),
  });
  process.exitCode = response.status === 200 ? 0 : 1;
  await response.body?.cancel();
} catch {
  process.exitCode = 1;
}
