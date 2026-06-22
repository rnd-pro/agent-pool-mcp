import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { SlotLedger } from '../src/runner/slot-ledger.js';
import {
  stepAdmissionId,
  resolveStepLimit,
  admitStep,
  redeemStepSlot,
  releaseStepSlot,
} from '../src/scheduler/step-capacity.js';

const DEAD_PID = 2147483646; // guaranteed not a live process

// A fake getGroup over a fixed config map: (cwd, name) => config|null.
function fakeGetGroup(groups) {
  return (_cwd, name) => groups[name] || null;
}

describe('step-capacity (WS-LEDGER daemon gating)', () => {
  let dir;
  const cwd = '/tmp/project';
  const run = { cwd };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'step-capacity-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('admits an ungated step (no group) without touching the ledger', () => {
    let ledger = new SlotLedger({ dir });
    let getGroup = fakeGetGroup({});
    let res = admitStep(ledger, {
      stepDef: { name: 'build' },
      run,
      runId: 'r1',
      getGroup,
      cwd,
    });
    assert.equal(res.admitted, true);
    assert.equal(res.admissionId, null);
    assert.equal(res.group, null);
    assert.equal(ledger.activeCountSync(null), 0);
  });

  it('admits a step whose group has no max_agents without touching the ledger', () => {
    let ledger = new SlotLedger({ dir });
    let getGroup = fakeGetGroup({ g: { provider: 'codex' } });
    let res = admitStep(ledger, {
      stepDef: { name: 'build', group: 'g' },
      run,
      runId: 'r1',
      getGroup,
      cwd,
    });
    assert.equal(res.admitted, true);
    assert.equal(res.admissionId, null);
    assert.equal(res.group, 'g');
    assert.equal(ledger.activeCountSync('g'), 0);
  });

  it('gates under capacity and denies the over-limit step', () => {
    let ledger = new SlotLedger({ dir });
    let getGroup = fakeGetGroup({ g: { max_agents: 2 } });
    let mk = (name) => ({ stepDef: { name, group: 'g' }, run, runId: 'r1', getGroup, cwd });

    let a = admitStep(ledger, mk('s1'));
    let b = admitStep(ledger, mk('s2'));
    assert.equal(a.admitted, true);
    assert.equal(a.admissionId, 'daemon:r1:s1');
    assert.equal(b.admitted, true);

    let c = admitStep(ledger, mk('s3'));
    assert.equal(c.admitted, false);
    assert.equal(c.reason, 'group_at_capacity');
    assert.equal(c.group, 'g');
    assert.equal(ledger.activeCountSync('g'), 2);
  });

  it('is idempotent: re-admitting the same step does not consume a second slot', () => {
    let ledger = new SlotLedger({ dir });
    let getGroup = fakeGetGroup({ g: { max_agents: 2 } });
    let args = { stepDef: { name: 's1', group: 'g' }, run, runId: 'r1', getGroup, cwd };

    assert.equal(admitStep(ledger, args).admitted, true);
    assert.equal(admitStep(ledger, args).admitted, true); // re-tick, same admissionId
    assert.equal(ledger.activeCountSync('g'), 1);
  });

  it('releases a slot so a new step can be admitted', () => {
    let ledger = new SlotLedger({ dir });
    let getGroup = fakeGetGroup({ g: { max_agents: 1 } });
    let mk = (name) => ({ stepDef: { name, group: 'g' }, run, runId: 'r1', getGroup, cwd });

    let a = admitStep(ledger, mk('s1'));
    assert.equal(a.admitted, true);
    assert.equal(admitStep(ledger, mk('s2')).admitted, false); // full

    releaseStepSlot(ledger, a.admissionId);
    assert.equal(admitStep(ledger, mk('s2')).admitted, true); // slot freed
    assert.equal(ledger.activeCountSync('g'), 1);
  });

  it('release tolerates a falsy/unknown admissionId (idempotent no-op)', () => {
    let ledger = new SlotLedger({ dir });
    // No throw on ungated (null) or unknown admissionId.
    releaseStepSlot(ledger, null);
    releaseStepSlot(ledger, undefined);
    releaseStepSlot(ledger, 'daemon:r1:never-admitted');
    assert.equal(ledger.activeCountSync('g'), 0);
  });

  it('self-heals: sweepSync reclaims a slot whose holder pid is dead', () => {
    let ledger = new SlotLedger({ dir });
    let getGroup = fakeGetGroup({ g: { max_agents: 1 } });
    let a = admitStep(ledger, { stepDef: { name: 's1', group: 'g' }, run, runId: 'r1', getGroup, cwd });
    // Redeem the admitted slot with a guaranteed-dead pid (mirrors a step whose
    // spawned process died with the daemon down).
    ledger.redeemSync({ admissionId: a.admissionId, taskId: 't', pid: DEAD_PID });

    assert.deepEqual(ledger.sweepSync().reclaimed, [a.admissionId]);
    assert.equal(ledger.activeCountSync('g'), 0);
  });

  it('redeemStepSlot attaches a live pid so the slot survives the reservation TTL sweep', () => {
    let clock = 1000;
    let ledger = new SlotLedger({
      dir,
      now: () => clock,
      reservationTtlMs: 5000,
      isAlive: () => true, // the redeemed holder is alive
    });
    let getGroup = fakeGetGroup({ g: { max_agents: 1 } });
    let a = admitStep(ledger, { stepDef: { name: 's1', group: 'g' }, run, runId: 'r1', getGroup, cwd });
    assert.equal(a.admitted, true);

    // Daemon redeems the reserved slot with the spawned pid (post-spawn).
    redeemStepSlot(ledger, a.admissionId, { runId: 'r1', stepName: 's1', pid: 4242 });

    // Advance far past the reservation TTL. A still-reserved slot would be swept
    // here; a redeemed slot with a live holder must be retained — otherwise a
    // long-running step's live slot is freed and the group over-subscribed.
    clock += 60000;
    assert.deepEqual(ledger.sweepSync().reclaimed, []);
    assert.equal(ledger.activeCountSync('g'), 1);
  });

  it('redeemStepSlot is a no-op for an ungated step or a spawn with no pid', () => {
    let ledger = new SlotLedger({ dir });
    // Falsy admissionId (ungated) and non-integer pid must not throw or write.
    redeemStepSlot(ledger, null, { runId: 'r1', stepName: 's1', pid: 4242 });
    redeemStepSlot(ledger, 'daemon:r1:s1', { runId: 'r1', stepName: 's1', pid: undefined });
    assert.equal(ledger.activeCountSync('g'), 0);
  });

  it('stepAdmissionId is deterministic', () => {
    assert.equal(stepAdmissionId('r1', 'build'), 'daemon:r1:build');
    assert.equal(stepAdmissionId('run-9', 'review'), 'daemon:run-9:review');
  });

  it('resolveStepLimit covers no-group, no-max_agents, and limited cases', () => {
    let getGroup = fakeGetGroup({
      capped: { max_agents: 3 },
      uncapped: { provider: 'codex' },
    });

    assert.deepEqual(
      resolveStepLimit({ name: 's' }, run, getGroup, cwd),
      { group: null, limit: null },
    );
    assert.deepEqual(
      resolveStepLimit({ name: 's', group: 'uncapped' }, run, getGroup, cwd),
      { group: 'uncapped', limit: null },
    );
    assert.deepEqual(
      resolveStepLimit({ name: 's', group: 'capped' }, run, getGroup, cwd),
      { group: 'capped', limit: 3 },
    );
    // Unknown group → no config → null limit (ungated).
    assert.deepEqual(
      resolveStepLimit({ name: 's', group: 'missing' }, run, getGroup, cwd),
      { group: 'missing', limit: null },
    );
  });
});
