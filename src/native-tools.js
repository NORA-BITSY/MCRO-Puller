import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const MAX_CAPTURE_BYTES = 16 * 1024 * 1024;
const MAX_WALL_MS = 60000;

/** @typedef {{timeout?: number, maxBuffer?: number}} NativeOptions */

/**
 * Establish limits before exec, never after the decoder begins parsing.
 * Linux: 1 GiB address space. Darwin: no RAM claim (finite RLIMIT_DATA fails).
 * Both: 60 CPU seconds and at most 128 MiB per output file. Shells whose
 * ulimit -f unit is 512 bytes apply the stricter 64 MiB ceiling.
 * Container limits remain necessary for aggregate process-tree resources.
 * @param {string} binary
 * @param {string[]} args
 * @param {NativeOptions} options
 */
function invocation(binary, args, options) {
  const timeout = options.timeout ?? MAX_WALL_MS;
  const maxBuffer = options.maxBuffer ?? MAX_CAPTURE_BYTES;
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > MAX_WALL_MS) throw new Error(`Native timeout must be 1–${MAX_WALL_MS} milliseconds`);
  if (!Number.isInteger(maxBuffer) || maxBuffer < 1 || maxBuffer > MAX_CAPTURE_BYTES) throw new Error(`Native maxBuffer must be 1–${MAX_CAPTURE_BYTES} bytes`);
  const limits = process.platform === 'linux'
    ? 'ulimit -v 1048576 && ulimit -t 60 && ulimit -f 131072'
    : 'ulimit -t 60 && ulimit -f 131072';
  return {
    args: ['-c', `${limits} || exit 125; exec "$@"`, 'court-native', binary, ...args],
    options: { timeout, maxBuffer, killSignal: /** @type {const} */ ('SIGKILL'), env: { ...process.env, OMP_THREAD_LIMIT: '1' } },
  };
}

/**
 * @param {string} binary
 * @param {string[]} args
 * @param {NativeOptions & {input?: Buffer | string}} options
 * @returns {{stdout: string, stderr: string}}
 */
export function runNativeSync(binary, args, options = {}) {
  const command = invocation(binary, args, options);
  const result = spawnSync('/bin/sh', command.args, { ...command.options, encoding: 'utf8', ...(options.input === undefined ? {} : { input: options.input }) });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw Object.assign(new Error(`Native command ${binary} failed (${result.signal ?? result.status}): ${result.stderr || 'no stderr'}`), {
      code: result.status === 127 ? 'ENOENT' : 'NATIVE_PROCESS_FAILED', status: result.status, signal: result.signal, stderr: result.stderr,
    });
  }
  return { stdout: result.stdout, stderr: result.stderr };
}

/**
 * @param {string} binary
 * @param {string[]} args
 * @param {NativeOptions} options
 * @returns {Promise<{stdout: string, stderr: string}>}
 */
export async function runNative(binary, args, options = {}) {
  const command = invocation(binary, args, options);
  return execFileAsync('/bin/sh', command.args, { ...command.options, encoding: 'utf8' });
}
