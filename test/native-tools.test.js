import assert from 'node:assert/strict';
import test from 'node:test';
import { runNativeSync, runNative } from '../src/native-tools.js';

const limitsCommand = 'printf "%s\\n" "$(ulimit -t)" "$(ulimit -f)"; if [ "$(uname -s)" = Linux ]; then ulimit -v; fi';

test('sync and async native execution establish CPU file and Linux address-space bounds', async () => {
  for (const result of [runNativeSync('/bin/sh', ['-c', limitsCommand]), await runNative('/bin/sh', ['-c', limitsCommand])]) {
    const limits = result.stdout.trim().split('\n').map(Number);
    assert.equal(limits[0], 60);
    assert.equal(limits[1], 131072);
    if (process.platform === 'linux') assert.equal(limits[2], 1048576);
  }
});

test('argument strings are not shell-interpolated and sync stdin remains supported', () => {
  const value = '$(printf injected); " quoted & literal';
  assert.equal(runNativeSync('/bin/echo', [value]).stdout.trim(), value);
  assert.equal(runNativeSync('/bin/cat', [], { input: Buffer.from('PDF input') }).stdout, 'PDF input');
});

test('native errors and stderr are explicit in both execution modes', async () => {
  const args = ['-c', 'printf decoder-error >&2; exit 9'];
  assert.throws(() => runNativeSync('/bin/sh', args), /decoder-error/);
  await assert.rejects(runNative('/bin/sh', args), /decoder-error/);
  assert.throws(() => runNativeSync('/no-such-court-decoder', []), /no-such-court-decoder/);
  await assert.rejects(runNative('/no-such-court-decoder', []), /no-such-court-decoder/);
});

test('native commands have enforced wall deadlines and captured-output bounds', async () => {
  assert.throws(() => runNativeSync('/bin/sleep', ['5'], { timeout: 20 }));
  await assert.rejects(runNative('/bin/sleep', ['5'], { timeout: 20 }));
  const args = ['-c', 'printf %010000d 0'];
  assert.throws(() => runNativeSync('/bin/sh', args, { maxBuffer: 100 }));
  await assert.rejects(runNative('/bin/sh', args, { maxBuffer: 100 }));
});

test('callers cannot disable or increase execution ceilings', async () => {
  assert.throws(() => runNativeSync('/bin/echo', [], { timeout: 0 }), /timeout/);
  assert.throws(() => runNativeSync('/bin/echo', [], { maxBuffer: 100 * 1024 * 1024 }), /maxBuffer/);
  await assert.rejects(runNative('/bin/echo', [], { timeout: 60001 }), /timeout/);
});
