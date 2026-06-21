import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

import { SlotLedger, LedgerLockTimeoutError } from '../src/runner/slot-ledger.js';

const MODULE_PATH = fileURLToPath(new URL('../src/runner/slot-ledger.js', import.meta.url));
const DEAD_PID = 2147483646; // guaranteed not a live process

describe('SlotLedger (WS-LEDGER)', () => {
  let dir;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slot-ledger-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('acquires, redeems, looks up, and releases a slot', async () => {
    let ledger = new SlotLedger({ dir });
    let a = await ledger.acquire({ admissionId: 'a1', groupKey: 'g', limit: 2 });
    assert.equal(a.granted, true);
    assert.equal(a.token, 'a1');
    assert.equal(a.slot.status, 'reserved');

    let r = await ledger.redeem({ admissionId: 'a1', taskId: 't1', pid: process.pid });
    assert.equal(r.ok, true);
    assert.equal(r.slot.status, 'running');

    let look = await ledger.lookup({ admissionId: 'a1' });
    assert.equal(look.found, true);
    assert.equal(look.status, 'running');
    assert.equal(look.taskId, 't1');
    assert.equal(look.alive, true);

    let rel = await ledger.release({ admissionId: 'a1' });
    assert.equal(rel.released, true);
    assert.equal((await ledger.lookup({ admissionId: 'a1' })).found, false);
  });

  it('acquire is idempotent on admissionId (no double count)', async () => {
    let ledger = new SlotLedger({ dir });
    let a1 = await ledger.acquire({ admissionId: 'x', groupKey: 'g', limit: 1 });
    let a2 = await ledger.acquire({ admissionId: 'x', groupKey: 'g', limit: 1 });
    assert.equal(a1.granted, true);
    assert.equal(a2.granted, true); // same slot returned, not a second reservation
    assert.equal(await ledger.activeCount({ groupKey: 'g' }), 1);
  });

  it('enforces the group capacity limit', async () => {
    let ledger = new SlotLedger({ dir });
    assert.equal((await ledger.acquire({ admissionId: 'a', groupKey: 'g', limit: 2 })).granted, true);
    assert.equal((await ledger.acquire({ admissionId: 'b', groupKey: 'g', limit: 2 })).granted, true);
    let c = await ledger.acquire({ admissionId: 'c', groupKey: 'g', limit: 2 });
    assert.equal(c.granted, false);
    assert.equal(c.reason, 'group_at_capacity');
    // A different group is independent.
    assert.equal((await ledger.acquire({ admissionId: 'd', groupKey: 'other', limit: 2 })).granted, true);
  });

  it('release is idempotent (unknown/double release is a no-op)', async () => {
    let ledger = new SlotLedger({ dir });
    assert.deepEqual(await ledger.release({ admissionId: 'nope' }), { released: false, alreadyReleased: true });
    await ledger.acquire({ admissionId: 'a', groupKey: 'g', limit: 1 });
    assert.equal((await ledger.release({ admissionId: 'a' })).released, true);
    assert.deepEqual(await ledger.release({ admissionId: 'a' }), { released: false, alreadyReleased: true });
  });

  it('durably persists the dedup map across ledger instances (survives a crash)', async () => {
    let l1 = new SlotLedger({ dir });
    await l1.acquire({ admissionId: 'adm', groupKey: 'g', limit: 4 });
    await l1.redeem({ admissionId: 'adm', taskId: 'task-9', pid: process.pid });

    // Fresh instance over the same dir — only what reached disk survives.
    let l2 = new SlotLedger({ dir });
    let look = await l2.lookup({ admissionId: 'adm' });
    assert.equal(look.found, true);
    assert.equal(look.status, 'running');
    assert.equal(look.taskId, 'task-9');
  });

  it('sweeps a running slot whose holder pid is dead', async () => {
    let ledger = new SlotLedger({ dir });
    await ledger.acquire({ admissionId: 'a', groupKey: 'g', limit: 4 });
    await ledger.redeem({ admissionId: 'a', taskId: 't', pid: DEAD_PID });
    assert.equal(await ledger.activeCount({ groupKey: 'g' }), 0); // swept on count
    assert.equal((await ledger.lookup({ admissionId: 'a' })).found, false);
  });

  it('sweeps an unredeemed reservation after its TTL', async () => {
    let clock = 1000;
    let ledger = new SlotLedger({ dir, now: () => clock, reservationTtlMs: 5000 });
    await ledger.acquire({ admissionId: 'a', groupKey: 'g', limit: 4 });
    assert.equal(await ledger.activeCount({ groupKey: 'g' }), 1);
    clock += 6000; // past TTL
    assert.equal(await ledger.activeCount({ groupKey: 'g' }), 0);
  });

  it('reclaims a stale-epoch reservation when given the current epoch', async () => {
    let ledger = new SlotLedger({ dir });
    await ledger.acquire({ admissionId: 'a', groupKey: 'g', limit: 4, leaseEpoch: 1 });
    let res = await ledger.sweep({ currentEpochByGroup: { g: 2 } });
    assert.deepEqual(res.reclaimed, ['a']);
    assert.equal(await ledger.activeCount({ groupKey: 'g' }), 0);
  });

  it('breaks a stale lock (dead holder) and still acquires', async () => {
    // Pre-plant a stale lockfile from a dead pid.
    fs.writeFileSync(path.join(dir, 'slots.lock'),
      JSON.stringify({ pid: DEAD_PID, host: os.hostname(), acquiredAt: Date.now() }));
    let ledger = new SlotLedger({ dir, lockTimeoutMs: 2000, spinMs: 5 });
    let a = await ledger.acquire({ admissionId: 'a', groupKey: 'g', limit: 1 });
    assert.equal(a.granted, true);
  });

  it('times out (transient) when the lock is held by a live holder', async () => {
    // Live holder = this very process; age below maxHold so it is never broken.
    fs.writeFileSync(path.join(dir, 'slots.lock'),
      JSON.stringify({ pid: process.pid, host: os.hostname(), acquiredAt: Date.now() }));
    let ledger = new SlotLedger({ dir, lockTimeoutMs: 120, spinMs: 20, lockMaxHoldMs: 60000 });
    await assert.rejects(
      () => ledger.acquire({ admissionId: 'a', groupKey: 'g', limit: 1 }),
      (err) => err instanceof LedgerLockTimeoutError && err.transient === true,
    );
  });

  it('serializes two OS processes contending for capacity (no over-grant)', async () => {
    let limit = 3;
    let attempts = 12;
    let workerPath = path.join(dir, 'worker.mjs');
    fs.writeFileSync(workerPath, `
      import { SlotLedger } from ${JSON.stringify(MODULE_PATH)};
      const ledger = new SlotLedger({ dir: ${JSON.stringify(dir)}, lockTimeoutMs: 30000, spinMs: 3 });
      const tag = process.argv[2];
      let granted = 0;
      for (let i = 0; i < ${attempts}; i++) {
        const r = await ledger.acquire({ admissionId: tag + '-' + i, groupKey: 'g', limit: ${limit} });
        if (r.granted) granted++;
      }
      process.stdout.write(String(granted));
    `);

    function runWorker(tag) {
      return new Promise((resolve, reject) => {
        let child = spawn(process.execPath, [workerPath, tag], { stdio: ['ignore', 'pipe', 'inherit'] });
        let out = '';
        child.stdout.on('data', (d) => { out += d; });
        child.on('error', reject);
        child.on('close', (code) => code === 0 ? resolve(Number(out)) : reject(new Error(`worker ${tag} exited ${code}`)));
      });
    }

    let [g1, g2] = await Promise.all([runWorker('p1'), runWorker('p2')]);
    // No releases happen, so total grants across both processes is exactly the
    // cap — the lock prevents any over-grant despite concurrent contention.
    assert.equal(g1 + g2, limit, `expected exactly ${limit} grants, got ${g1}+${g2}`);
    assert.equal(await new SlotLedger({ dir }).activeCount({ groupKey: 'g' }), limit);
  });
});
