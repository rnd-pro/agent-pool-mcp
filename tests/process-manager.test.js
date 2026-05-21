import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

import { killGroup } from '../src/runner/process-manager.js';

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('process manager', () => {
  it('escalates cleanup for a process group that ignores SIGTERM', async () => {
    let child = spawn(process.execPath, ['-e', `
      process.on('SIGTERM', () => {});
      setInterval(() => {}, 1000);
    `], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();

    try {
      assert.equal(isAlive(child.pid), true);
      assert.equal(killGroup(child.pid), true);
      await delay(900);
      assert.equal(isAlive(child.pid), false);
    } finally {
      try { process.kill(-child.pid, 'SIGKILL'); } catch {}
      try { process.kill(child.pid, 'SIGKILL'); } catch {}
    }
  });
});
