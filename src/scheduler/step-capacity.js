/**
 * Step capacity seam — the daemon's pure capacity decision over the shared slot
 * ledger.
 *
 * The detached pipeline daemon spawns agents independently of the MCP server, so
 * it must gate `max_agents` resource groups through the SAME cross-process ledger
 * (`src/runner/slot-ledger.js`) the server uses in `handleDelegate`. Gating lives
 * here as dependency-light logic over an injected ledger and `getGroup`, so the
 * admission decision is testable without spawning a CLI or running the daemon.
 *
 * Semantics: gate at the STEP level — each daemon pipeline step in a group with
 * `max_agents` consumes exactly ONE ledger slot (regardless of its internal
 * parallel `count`), mirroring the server's one-slot-per-delegate. A step with no
 * group, or a group without `max_agents`, never touches the ledger.
 *
 * @module agent-pool/scheduler/step-capacity
 */

/**
 * Deterministic, idempotent admission id for a daemon step. The ledger's
 * `acquireSync` is idempotent on this id, so re-ticking the same step is safe.
 *
 * @param {string} runId
 * @param {string} stepName
 * @returns {string}
 */
export function stepAdmissionId(runId, stepName) {
  return `daemon:${runId}:${stepName}`;
}

/**
 * Resolve the gating group + capacity for a step. Reads the group config through
 * the injected `getGroup(run.cwd || cwd, stepDef.group)`.
 *
 * @param {object} stepDef - Step definition from the pipeline
 * @param {object} run - Current run state (provides `cwd`)
 * @param {(cwd: string, name: string) => (object|null)} getGroup
 * @param {string} cwd - Daemon cwd fallback
 * @returns {{ group: string|null, limit: number|null }}
 */
export function resolveStepLimit(stepDef, run, getGroup, cwd) {
  if (!stepDef.group) return { group: null, limit: null };
  const groupConfig = getGroup(run.cwd || cwd, stepDef.group);
  return { group: stepDef.group, limit: groupConfig?.max_agents ?? null };
}

/**
 * Decide whether a step may spawn this tick and reserve its slot if so.
 *
 * Ungated steps (no group, or a group without `max_agents`) never call the
 * ledger and are always admitted. Gated steps reserve exactly one slot via
 * `ledger.acquireSync`; a denied acquire returns `admitted:false` so the caller
 * defers the spawn and retries next tick.
 *
 * @param {import('../runner/slot-ledger.js').SlotLedger} ledger
 * @param {object} args
 * @param {object} args.stepDef
 * @param {object} args.run
 * @param {string} args.runId
 * @param {(cwd: string, name: string) => (object|null)} args.getGroup
 * @param {string} args.cwd
 * @returns {{ admitted: boolean, admissionId: string|null, group: string|null, reason?: string }}
 */
export function admitStep(ledger, { stepDef, run, runId, getGroup, cwd }) {
  const { group, limit } = resolveStepLimit(stepDef, run, getGroup, cwd);
  if (!limit) {
    return { admitted: true, admissionId: null, group };
  }
  const admissionId = stepAdmissionId(runId, stepDef.name);
  const acq = ledger.acquireSync({ admissionId, groupKey: group, limit });
  if (acq.granted) {
    return { admitted: true, admissionId, group };
  }
  return { admitted: false, admissionId, group, reason: acq.reason || 'group_at_capacity' };
}

/**
 * Redeem a step's reserved slot once it has spawned, attaching the live pid so the
 * ledger sweep reclaims it by pid-liveness rather than the reservation TTL. Without
 * this a long-running gated step (process alive past the reservation TTL) would have
 * its still-live slot swept and the group over-subscribed. Mirrors the server's
 * `setTaskPid` → `redeem` step. No-op for ungated steps or a spawn that produced no
 * pid.
 *
 * @param {import('../runner/slot-ledger.js').SlotLedger} ledger
 * @param {string|null|undefined} admissionId
 * @param {{ runId: string, stepName: string, pid: number }} holder
 */
export function redeemStepSlot(ledger, admissionId, { runId, stepName, pid } = {}) {
  if (!admissionId || !Number.isInteger(pid)) return;
  ledger.redeemSync({ admissionId, taskId: `${runId}:${stepName}`, pid });
}

/**
 * Release a step's slot at close. Idempotent: a missing/already-released slot is
 * a no-op, and a falsy admissionId (ungated step) is ignored.
 *
 * @param {import('../runner/slot-ledger.js').SlotLedger} ledger
 * @param {string|null|undefined} admissionId
 */
export function releaseStepSlot(ledger, admissionId) {
  if (!admissionId) return;
  ledger.releaseSync({ admissionId });
}
