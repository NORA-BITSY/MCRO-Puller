import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { loadState, saveState, updateState } from '../src/state.js';

const execFileAsync = promisify(execFile);

function tempDirectory(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mcro-state-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test('loadState fails closed on corrupt state instead of silently resetting', (t) => {
  const statePath = path.join(tempDirectory(t), 'state.json');
  fs.writeFileSync(statePath, '{not json', 'utf-8');

  assert.throws(() => loadState(statePath), /invalid JSON/);
});

test('saveState writes a valid restrictive state file', (t) => {
  const statePath = path.join(tempDirectory(t), 'state.json');
  const state = { pulledCases: { '27-CV-24-1': { status: 'complete' } } };

  saveState(state, statePath);

  assert.equal(loadState(statePath).pulledCases['27-CV-24-1'].status, 'complete');
  assert.equal(fs.statSync(statePath).mode & 0o777, 0o600);
  assert.equal(fs.readdirSync(path.dirname(statePath)).some((name) => name.endsWith('.tmp')), false);
});

test('updateState serializes concurrent worker updates without losing cases', async (t) => {
  const statePath = path.join(tempDirectory(t), 'state.json');
  await Promise.all(Array.from({ length: 25 }, (_, index) => updateState((state) => {
    state.pulledCases[`case-${index}`] = { status: 'complete' };
  }, statePath)));

  assert.equal(Object.keys(loadState(statePath).pulledCases).length, 25);
});

test('updateState coordinates concurrent writer processes', async (t) => {
  const statePath = path.join(tempDirectory(t), 'state.json');
  const stateModule = new URL('../src/state.js', import.meta.url).href;
  await Promise.all(Array.from({ length: 8 }, (_, index) => {
    const code =
      `import { updateState } from ${JSON.stringify(stateModule)};` +
      `await updateState((state) => { state.pulledCases[${JSON.stringify(`child-${index}`)}] = { status: 'complete' }; }, ${JSON.stringify(statePath)});`;
    return execFileAsync(process.execPath, ['--input-type=module', '-e', code]);
  }));

  assert.equal(Object.keys(loadState(statePath).pulledCases).length, 8);
  assert.equal(fs.existsSync(`${statePath}.lock`), false);
});
