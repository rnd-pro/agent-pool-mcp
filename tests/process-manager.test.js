import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

import {
  calculateCapacity,
  killGroup,
  parseDarwinVmStatAvailableBytes,
} from '../src/runner/process-manager.js';

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('process manager', () => {
  it('parses reclaimable macOS memory from vm_stat', () => {
    const available = parseDarwinVmStatAvailableBytes(`
Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                                     4.
Pages active:                                  10.
Pages inactive:                                5.
Pages speculative:                              3.
Pages wired down:                              20.
`);

    assert.equal(available, (4 + 5 + 3) * 16384);
  });

  it('counts already running children as already allocated memory capacity', () => {
    const capacity = calculateCapacity({
      cpuCount: 8,
      loadRatio1m: 0.2,
      availableMemoryBytes: 512 * 1024 * 1024,
      external: 0,
      trackedChildren: 1,
      runningTaskCount: 1,
      estimatedNewTaskBytes: 512 * 1024 * 1024,
      memoryReserveBytes: 512 * 1024 * 1024,
    });

    assert.equal(capacity.estimatedAdditionalTaskSlots, 0);
    assert.equal(capacity.recommendedMaxParallelTasks, 1);
    assert.equal(capacity.state, 'constrained');
    assert.equal(capacity.reason, 'memory');
  });

  it('reports no new task capacity when memory is below the per-task estimate', () => {
    const capacity = calculateCapacity({
      cpuCount: 8,
      loadRatio1m: 0.2,
      availableMemoryBytes: 512 * 1024 * 1024,
      external: 0,
      trackedChildren: 0,
      runningTaskCount: 0,
      estimatedNewTaskBytes: 512 * 1024 * 1024,
      memoryReserveBytes: 512 * 1024 * 1024,
    });

    assert.equal(capacity.estimatedAdditionalTaskSlots, 0);
    assert.equal(capacity.recommendedMaxParallelTasks, 0);
    assert.equal(capacity.deficitForNextTaskBytes, 512 * 1024 * 1024);
  });

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
