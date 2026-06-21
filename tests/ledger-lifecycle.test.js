import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { getSlotLedger } from '../src/runner/slot-ledger.js';
import { createTask, setTaskPid, completeTask, failTask, cancelTask } from '../src/tools/results.js';

// AGENT_POOL_LEDGER_DIR is isolated by tests/_ledger-setup.js (--import).

const DEAD_PID = 2147483646;

async function waitFor(fn, timeoutMs = 1000) {
  let deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await fn()) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('ledger task lifecycle wiring', () => {
  let cwd;
  let n = 0;

  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-life-cwd-'));
  });

  afterEach(() => {
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  function uniq(p) { return `${p}-${process.pid}-${++n}`; }

  it('admissionId flows to the task; setTaskPid redeems; completeTask releases', async () => {
    let ledger = getSlotLedger();
    let admissionId = uniq('adm');
    let group = uniq('lg');
    let taskId = uniq('task');

    await ledger.acquire({ admissionId, groupKey: group, limit: 2 });
    assert.equal(await ledger.activeCount({ groupKey: group }), 1);

    createTask(taskId, 'p', null, 'plan', cwd, 'test', null, null, null, null, group, { admissionId });
    setTaskPid(taskId, process.pid); // redeem -> running, liveness pid = alive

    assert.ok(await waitFor(async () => (await ledger.lookup({ admissionId })).status === 'running'));
    let look = await ledger.lookup({ admissionId });
    assert.equal(look.taskId, taskId);
    assert.equal(look.alive, true);

    completeTask(taskId, { exitCode: 0, response: '' });
    assert.ok(await waitFor(async () => (await ledger.activeCount({ groupKey: group })) === 0),
      'slot should be released on completion');
  });

  it('failTask releases the slot', async () => {
    let ledger = getSlotLedger();
    let admissionId = uniq('adm');
    let group = uniq('lg');
    let taskId = uniq('task');
    await ledger.acquire({ admissionId, groupKey: group, limit: 1 });
    createTask(taskId, 'p', null, 'plan', cwd, 'test', null, null, null, null, group, { admissionId });
    failTask(taskId, 'boom');
    assert.ok(await waitFor(async () => (await ledger.activeCount({ groupKey: group })) === 0));
  });

  it('cancelTask releases the slot', async () => {
    let ledger = getSlotLedger();
    let admissionId = uniq('adm');
    let group = uniq('lg');
    let taskId = uniq('task');
    await ledger.acquire({ admissionId, groupKey: group, limit: 1 });
    createTask(taskId, 'p', null, 'plan', cwd, 'test', null, null, null, null, group, { admissionId });
    cancelTask(taskId);
    assert.ok(await waitFor(async () => (await ledger.activeCount({ groupKey: group })) === 0));
  });

  it('a task created without an admissionId never touches the ledger', async () => {
    let ledger = getSlotLedger();
    let group = uniq('lg');
    let taskId = uniq('task');
    createTask(taskId, 'p', null, 'plan', cwd, 'test', null, null, null, null, group, {}); // no admissionId
    setTaskPid(taskId, process.pid);
    completeTask(taskId, { exitCode: 0 });
    // No reservation was ever made.
    assert.equal(await ledger.activeCount({ groupKey: group }), 0);
  });

  it('a redeemed slot whose task pid dies is reclaimed by the sweep', async () => {
    let ledger = getSlotLedger();
    let admissionId = uniq('adm');
    let group = uniq('lg');
    let taskId = uniq('task');
    await ledger.acquire({ admissionId, groupKey: group, limit: 1 });
    createTask(taskId, 'p', null, 'plan', cwd, 'test', null, null, null, null, group, { admissionId });
    setTaskPid(taskId, DEAD_PID); // redeem with a dead liveness pid
    assert.ok(await waitFor(async () => (await ledger.lookup({ admissionId })).status === 'running'));
    // Sweep reclaims a running slot whose holder pid is dead.
    assert.equal(await ledger.activeCount({ groupKey: group }), 0);
  });
});
