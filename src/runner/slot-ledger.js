/**
 * SlotLedger — the single cross-process capacity authority for agent spawns.
 *
 * Both the agent-pool MCP server and the detached pipeline daemon reserve and
 * release execution slots through this ledger, serialized by one OS-level
 * advisory lock (an O_EXCL lockfile with a race-safe, liveness+age stale-break).
 * This replaces the per-process `getGroupActiveCount` counter so capacity is
 * decided in exactly one place regardless of which process is up.
 *
 * Design (workflow scheduler v5 AD-1):
 * - Slots are keyed by a board-minted `admissionId`. A slot is `reserved` at
 *   admission and `running` once the spawn is acked (which durably records
 *   `admissionId -> taskId`, the dedup map that survives a board crash).
 * - Reservations are epoch-stamped (`leaseEpoch`) and liveness-keyed
 *   (`{pid, host, generation}`) so a stale-epoch or dead-holder slot is
 *   reclaimable by whichever process is up — including the daemon's own tick.
 * - `acquireSlot`/`releaseSlot` are idempotent on `admissionId`.
 * - Local filesystem only: advisory file locks are unreliable on NFS/SMB.
 *
 * @module agent-pool/runner/slot-ledger
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const DEFAULT_LOCK_TIMEOUT_MS = 5000;    // give up acquiring → transient (re-enqueue)
const DEFAULT_LOCK_MAX_HOLD_MS = 10000;  // a lock older than this is broken as stale
const DEFAULT_RESERVATION_TTL_MS = 60000; // an unredeemed reservation is swept after this
const DEFAULT_SPIN_MS = 8;               // lock retry interval

/** Thrown when the ledger lock cannot be acquired within the timeout. */
export class LedgerLockTimeoutError extends Error {
  constructor(message) {
    super(message);
    this.name = 'LedgerLockTimeoutError';
    this.code = 'LEDGER_LOCK_TIMEOUT';
    this.transient = true;
  }
}

function defaultIsAlive(pid, host, selfHost) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  // A pid on a different host cannot be checked locally; treat as alive
  // (the design tracks the LOCAL pid even for SSH-remote legs, so host is
  // normally the local host).
  if (host && selfHost && host !== selfHost) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM'; // exists but not ours → alive
  }
}

/** Cross-process capacity ledger bound to a directory. */
export class SlotLedger {
  /**
   * @param {object} opts
   * @param {string} opts.dir — directory holding the ledger + lockfile (must be local FS)
   * @param {() => number} [opts.now]
   * @param {(pid: number, host: string) => boolean} [opts.isAlive]
   * @param {string} [opts.host]
   * @param {number} [opts.selfPid]
   * @param {string} [opts.generation] — stamp distinguishing this process incarnation
   * @param {number} [opts.lockTimeoutMs]
   * @param {number} [opts.lockMaxHoldMs]
   * @param {number} [opts.reservationTtlMs]
   * @param {number} [opts.spinMs]
   */
  constructor(opts = {}) {
    if (!opts.dir) throw new Error('SlotLedger: dir is required');
    this._dir = opts.dir;
    this._ledgerPath = path.join(opts.dir, 'slots.json');
    this._lockPath = path.join(opts.dir, 'slots.lock');
    this._now = opts.now || (() => Date.now());
    this._host = opts.host || os.hostname();
    this._selfPid = Number.isInteger(opts.selfPid) ? opts.selfPid : process.pid;
    this._generation = opts.generation || `${this._host}:${this._selfPid}`;
    this._isAlive = opts.isAlive || ((pid, host) => defaultIsAlive(pid, host, this._host));
    this._lockTimeoutMs = opts.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
    this._lockMaxHoldMs = opts.lockMaxHoldMs ?? DEFAULT_LOCK_MAX_HOLD_MS;
    this._reservationTtlMs = opts.reservationTtlMs ?? DEFAULT_RESERVATION_TTL_MS;
    this._spinMs = opts.spinMs ?? DEFAULT_SPIN_MS;
  }

  // ── Public API ─────────────────────────────────────────

  /**
   * Reserve a slot for `admissionId` in `groupKey` if the group is below
   * `limit`. Idempotent: an existing slot for `admissionId` is returned as
   * granted. A stale-epoch or dead slot is swept first so it does not count.
   *
   * @param {object} req
   * @param {string} req.admissionId
   * @param {string} req.groupKey
   * @param {number} [req.limit] — group capacity (no limit ⇒ always granted)
   * @param {number} [req.leaseEpoch] — owning board-admission epoch
   * @returns {Promise<{ granted: boolean, token?: string, reason?: string, slot?: object }>}
   */
  async acquire(req) {
    let { admissionId, groupKey, limit, leaseEpoch = 0 } = req || {};
    if (!admissionId) throw new Error('acquire: admissionId is required');
    return this._withLock((ledger) => {
      this._sweepInto(ledger);
      let existing = ledger.slots[admissionId];
      if (existing) {
        return { granted: true, token: admissionId, slot: existing };
      }
      if (Number.isFinite(limit) && limit >= 0) {
        let active = this._countGroup(ledger, groupKey);
        if (active >= limit) {
          return { granted: false, reason: 'group_at_capacity' };
        }
      }
      let slot = {
        admissionId,
        groupKey: groupKey || null,
        leaseEpoch,
        status: 'reserved',
        pid: this._selfPid,
        host: this._host,
        generation: this._generation,
        taskId: null,
        reservedAt: this._now(),
        updatedAt: this._now(),
      };
      ledger.slots[admissionId] = slot;
      this._writeLedger(ledger);
      return { granted: true, token: admissionId, slot };
    });
  }

  /**
   * Mark a reserved slot `running` and durably record `admissionId -> taskId`
   * (the dedup map). Call this BEFORE acking the spawn to the board, so the
   * positive map survives a board crash. Idempotent.
   *
   * @param {object} req
   * @param {string} req.admissionId
   * @param {string} req.taskId
   * @param {number} [req.pid] — the spawned task's liveness pid (local)
   * @param {string} [req.host]
   * @param {string} [req.generation]
   * @returns {Promise<{ ok: boolean, slot?: object, reason?: string }>}
   */
  async redeem(req) {
    let { admissionId, taskId, pid, host, generation } = req || {};
    if (!admissionId) throw new Error('redeem: admissionId is required');
    return this._withLock((ledger) => {
      let slot = ledger.slots[admissionId];
      if (!slot) return { ok: false, reason: 'unknown_admission' };
      slot.status = 'running';
      slot.taskId = taskId ?? slot.taskId ?? null;
      if (Number.isInteger(pid)) slot.pid = pid;
      if (host) slot.host = host;
      if (generation) slot.generation = generation;
      slot.updatedAt = this._now();
      this._writeLedger(ledger);
      return { ok: true, slot };
    });
  }

  /**
   * Release a slot. Idempotent + token-keyed: releasing an unknown/already-released
   * slot is a no-op. Callable by any process holding the lock (e.g. the daemon
   * at step close).
   *
   * @param {object} req
   * @param {string} req.admissionId
   * @returns {Promise<{ released: boolean }>}
   */
  async release(req) {
    let { admissionId } = req || {};
    if (!admissionId) throw new Error('release: admissionId is required');
    return this._withLock((ledger) => {
      if (!ledger.slots[admissionId]) return { released: false, alreadyReleased: true };
      delete ledger.slots[admissionId];
      this._writeLedger(ledger);
      return { released: true };
    });
  }

  /**
   * The admissionId echo: did this admission spawn, and is it live?
   *
   * @param {object} req
   * @param {string} req.admissionId
   * @returns {Promise<{ found: boolean, status?: string, taskId?: string|null, alive?: boolean, slot?: object }>}
   */
  async lookup(req) {
    let { admissionId } = req || {};
    if (!admissionId) throw new Error('lookup: admissionId is required');
    return this._withLock((ledger) => {
      let slot = ledger.slots[admissionId];
      if (!slot) return { found: false };
      let alive = slot.status === 'running'
        ? this._isAlive(slot.pid, slot.host)
        : (this._now() - slot.reservedAt) <= this._reservationTtlMs;
      return { found: true, status: slot.status, taskId: slot.taskId ?? null, alive, slot };
    });
  }

  /**
   * Live (reserved + running) slot count for a group, after sweeping dead/expired
   * slots. This is the single capacity authority replacing `getGroupActiveCount`.
   *
   * @param {object} req
   * @param {string} req.groupKey
   * @returns {Promise<number>}
   */
  async activeCount(req) {
    let { groupKey } = req || {};
    return this._withLock((ledger) => {
      let swept = this._sweepInto(ledger);
      if (swept) this._writeLedger(ledger);
      return this._countGroup(ledger, groupKey);
    });
  }

  /**
   * Reclaim dead-holder running slots and expired reservations. Optionally also
   * reclaim reservations whose `leaseEpoch` is older than the current epoch for
   * their group (pass `currentEpochByGroup`). Returns the reclaimed admissionIds.
   *
   * @param {object} [req]
   * @param {Record<string, number>} [req.currentEpochByGroup]
   * @returns {Promise<{ reclaimed: string[] }>}
   */
  async sweep(req = {}) {
    return this._withLock((ledger) => {
      let reclaimed = this._sweepInto(ledger, req.currentEpochByGroup);
      if (reclaimed.length) this._writeLedger(ledger);
      return { reclaimed };
    });
  }

  // ── Internals ──────────────────────────────────────────

  _countGroup(ledger, groupKey) {
    let n = 0;
    for (let slot of Object.values(ledger.slots)) {
      if ((slot.groupKey || null) === (groupKey || null)) n++;
    }
    return n;
  }

  // Remove dead/expired/stale-epoch slots from `ledger` in place. Returns the
  // list of reclaimed admissionIds (truthy length ⇒ caller should persist).
  _sweepInto(ledger, currentEpochByGroup = null) {
    let reclaimed = [];
    let now = this._now();
    for (let [admissionId, slot] of Object.entries(ledger.slots)) {
      let drop = false;
      if (slot.status === 'running') {
        if (!this._isAlive(slot.pid, slot.host)) drop = true;
      } else {
        // reserved: expire by TTL
        if (now - slot.reservedAt > this._reservationTtlMs) drop = true;
      }
      if (!drop && currentEpochByGroup) {
        let cur = currentEpochByGroup[slot.groupKey];
        if (Number.isFinite(cur) && Number.isFinite(slot.leaseEpoch) && slot.leaseEpoch < cur) {
          // Stale-epoch reservation whose admitter was displaced — reclaim it,
          // unless it already redeemed into a live running task.
          if (!(slot.status === 'running' && this._isAlive(slot.pid, slot.host))) drop = true;
        }
      }
      if (drop) {
        delete ledger.slots[admissionId];
        reclaimed.push(admissionId);
      }
    }
    return reclaimed;
  }

  _readLedger() {
    try {
      let raw = fs.readFileSync(this._ledgerPath, 'utf8');
      let data = JSON.parse(raw);
      if (!data || typeof data !== 'object' || typeof data.slots !== 'object') {
        return { slots: {} };
      }
      return data;
    } catch {
      return { slots: {} };
    }
  }

  // Durable write: tmp + fsync + atomic rename, so the dedup map is on stable
  // storage before redeem() returns (persisted-before-spawn-ack).
  _writeLedger(ledger) {
    let existedBefore = fs.existsSync(this._ledgerPath);
    let tmpPath = `${this._ledgerPath}.tmp.${this._selfPid}.${this._now()}`;
    let fd = fs.openSync(tmpPath, 'w');
    try {
      fs.writeSync(fd, JSON.stringify(ledger));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmpPath, this._ledgerPath);
    if (!existedBefore) this._fsyncDir(this._dir);
  }

  _fsyncDir(dir) {
    let dfd;
    try {
      dfd = fs.openSync(dir, 'r');
      fs.fsyncSync(dfd);
    } catch { /* best-effort */ }
    finally {
      if (dfd !== undefined) { try { fs.closeSync(dfd); } catch { /* ignore */ } }
    }
  }

  // Acquire the lock (async, may spin), run `fn(ledger)` SYNCHRONOUSLY (the
  // critical section never awaits, so it is atomic within this process and far
  // shorter than lockMaxHoldMs), then release.
  async _withLock(fn) {
    if (!fs.existsSync(this._dir)) fs.mkdirSync(this._dir, { recursive: true });
    await this._acquireLock();
    try {
      let ledger = this._readLedger();
      return fn(ledger);
    } finally {
      this._releaseLock();
    }
  }

  async _acquireLock() {
    let deadline = this._now() + this._lockTimeoutMs;
    for (;;) {
      try {
        let fd = fs.openSync(this._lockPath, 'wx'); // O_CREAT | O_EXCL
        try {
          fs.writeSync(fd, JSON.stringify({ pid: this._selfPid, host: this._host, acquiredAt: this._now() }));
        } finally {
          fs.closeSync(fd);
        }
        return;
      } catch (err) {
        if (err.code !== 'EEXIST') throw err;
        this._maybeBreakStaleLock();
        if (this._now() >= deadline) {
          throw new LedgerLockTimeoutError(`SlotLedger: lock acquire timed out after ${this._lockTimeoutMs}ms`);
        }
        await this._sleep(this._spinMs);
      }
    }
  }

  // Break a stale lock atomically: rename it aside (only one racer wins the
  // rename), then unlink. After that, normal O_EXCL contention resumes.
  _maybeBreakStaleLock() {
    let info;
    try {
      info = JSON.parse(fs.readFileSync(this._lockPath, 'utf8'));
    } catch {
      return; // unreadable/gone — next openSync('wx') will race normally
    }
    let stale = false;
    if (!info || !Number.isInteger(info.pid)) stale = true;
    else if (info.host === this._host && !this._isAlive(info.pid, info.host)) stale = true;
    else if (this._now() - (info.acquiredAt || 0) > this._lockMaxHoldMs) stale = true;
    if (!stale) return;
    let brokenPath = `${this._lockPath}.broken.${this._selfPid}.${this._now()}.${crypto.randomBytes(4).toString('hex')}`;
    try {
      fs.renameSync(this._lockPath, brokenPath); // atomic: only one racer succeeds
      fs.unlinkSync(brokenPath);
    } catch { /* another racer broke it first */ }
  }

  _releaseLock() {
    try { fs.unlinkSync(this._lockPath); } catch { /* already released/broken */ }
  }

  /**
   * Best-effort, lock-free live count for a group (running pid alive, or
   * reservation within TTL). For display and pre-checks only — the
   * authoritative gate is `acquire` under the lock.
   *
   * @param {string} groupKey
   * @returns {number}
   */
  activeCountSync(groupKey) {
    let ledger = this._readLedger();
    let now = this._now();
    let n = 0;
    for (let slot of Object.values(ledger.slots)) {
      if ((slot.groupKey || null) !== (groupKey || null)) continue;
      let live = slot.status === 'running'
        ? this._isAlive(slot.pid, slot.host)
        : (now - slot.reservedAt) <= this._reservationTtlMs;
      if (live) n++;
    }
    return n;
  }

  _sleep(ms) {
    // Not unref'd: the spin-wait must keep the event loop alive until the retry.
    return new Promise((resolve) => { setTimeout(resolve, ms); });
  }
}

// ── Singleton (the one ledger shared by the server, the daemon, and tasks) ──

const DEFAULT_LEDGER_DIR = path.join(os.homedir(), '.agent-portal', 'agent-pool-ledger');
let _singleton = null;

/**
 * Get the process-wide SlotLedger bound to a stable directory shared across the
 * agent-pool server and the detached daemon (env `AGENT_POOL_LEDGER_DIR`).
 *
 * @param {object} [opts]
 * @returns {SlotLedger}
 */
export function getSlotLedger(opts = {}) {
  if (!_singleton) {
    let dir = opts.dir || process.env.AGENT_POOL_LEDGER_DIR || DEFAULT_LEDGER_DIR;
    _singleton = new SlotLedger({ ...opts, dir });
  }
  return _singleton;
}

/** Reset the singleton (tests only). */
export function _resetSlotLedger() {
  _singleton = null;
}
