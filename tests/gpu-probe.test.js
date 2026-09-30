import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { gpuProbe } from '../src/evolution/gpu-probe.js';

function fixture(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'lifewar-gpu-probe-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'gpu-probe.json');
  return { file, probe: gpuProbe(20, { file, enabled: true }) };
}

test('successful GPU probe releases marker without waiting for backend close', t => {
  const { file, probe } = fixture(t);
  probe.arm(); assert.equal(existsSync(file), true);
  probe.release(); assert.equal(existsSync(file), false);
  assert.equal(probe.crashed(), false);
  probe.release(); assert.equal(existsSync(file), false);
});

test('legacy stable residue is cleared while unfinished startup stays protected', t => {
  const { file, probe } = fixture(t);
  for (const phase of ['stable', 'armed']) {
    writeFileSync(file, JSON.stringify({ phase, owners: [{ id: 'old', pid: -1 }] }));
    assert.equal(probe.crashed(), phase === 'armed');
    assert.equal(existsSync(file), phase === 'armed');
  }
});

test('active owners are not mistaken for a failed startup or removed by another probe', t => {
  const { file, probe } = fixture(t);
  const other = gpuProbe(20, { file, enabled: true });
  probe.arm(); other.release(); assert.equal(existsSync(file), true);
  other.arm(); assert.equal(other.crashed(), false);
  probe.release(); assert.equal(JSON.parse(readFileSync(file)).owners.length, 1);
  other.release(); assert.equal(existsSync(file), false);
});

test('disabled GPU probe neither creates nor modifies a marker', t => {
  const { file } = fixture(t);
  const probe = gpuProbe(20, { file, enabled: false });
  probe.arm(); probe.release(); assert.equal(existsSync(file), false);
  const original = JSON.stringify({ phase: 'armed', owners: [] });
  writeFileSync(file, original);
  assert.equal(probe.crashed(), false); probe.arm(); probe.release();
  assert.equal(readFileSync(file, 'utf8'), original);
});

for (const phase of ['armed', 'success']) {
  test(`abrupt process termination after ${phase} preserves only unfinished startup protection`, async t => {
    const { file, probe } = fixture(t);
    const child = fork(new URL('./helpers/gpu-probe-session.js', import.meta.url), [file, phase], { execArgv: [], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
    await Promise.race([
      once(child, 'message'),
      once(child, 'exit').then(([code]) => { throw new Error(`Probe child exited early: ${code}`); }),
    ]);
    const exit = once(child, 'exit');
    child.kill('SIGKILL'); await exit;
    assert.equal(existsSync(file), phase === 'armed');
    assert.equal(probe.crashed(), phase === 'armed');
  });
}
