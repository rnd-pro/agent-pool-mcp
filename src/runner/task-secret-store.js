/**
 * TaskSecretStore — the per-task-secret → verified-slug correlation map.
 *
 * At spawn the server mints a per-task secret and injects it into the spawned
 * process environment as a non-overridable var. This store is the durable map
 * from that secret to the server-verified identity of the task:
 *
 *   secret → { taskId, admissionId, serverAssignedSlug, createdAt }
 *
 * The map is the trust anchor for the portal's principal layer: a connection
 * that presents a known secret resolves to `serverAssignedSlug` (the slug the
 * server assigned), so the agent cannot self-claim a privileged slug in its
 * payload. An unknown/absent secret has no entry → no binding → the portal
 * falls back to least privilege.
 *
 * The secret itself is sensitive: it is the bearer credential. It is never
 * logged and is stored hashed, so the on-disk map cannot be replayed to forge a
 * connection if the file leaks. Lookups hash the presented secret and match.
 *
 * Persistence mirrors the slot ledger: one shared directory (env
 * `AGENT_POOL_LEDGER_DIR`) so the map survives a server restart and is readable
 * by whichever process resolves the binding. Writes are atomic (tmp + rename).
 *
 * @module agent-pool/runner/task-secret-store
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const SECRET_BYTES = 32;
// Entries older than this are swept on read so the map does not grow without
// bound across server lifetimes. A task's binding is only useful while the task
// can still connect; a generous TTL covers long-running agents.
const DEFAULT_SECRET_TTL_MS = 24 * 60 * 60 * 1000;

const DEFAULT_DIR = path.join(os.homedir(), '.agent-portal', 'agent-pool-ledger');

function hashSecret(secret) {
  return crypto.createHash('sha256').update(String(secret)).digest('hex');
}

/** Durable per-task-secret → verified-slug map bound to a directory. */
export class TaskSecretStore {
  /**
   * @param {object} [opts]
   * @param {string} [opts.dir] — directory holding the map (shared with the ledger)
   * @param {() => number} [opts.now]
   * @param {number} [opts.ttlMs]
   */
  constructor(opts = {}) {
    this._dir = opts.dir || process.env.AGENT_POOL_LEDGER_DIR || DEFAULT_DIR;
    this._path = path.join(this._dir, 'task-secrets.json');
    this._now = opts.now || (() => Date.now());
    this._ttlMs = Number.isFinite(opts.ttlMs) ? opts.ttlMs : DEFAULT_SECRET_TTL_MS;
  }

  /**
   * Mint a fresh per-task secret and durably bind it to the task identity.
   * Returns the plaintext secret to inject into the spawned process; only its
   * hash is persisted.
   *
   * @param {object} req
   * @param {string} req.taskId
   * @param {string|null} [req.admissionId]
   * @param {string|null} [req.serverAssignedSlug] — the verified slug to resolve to
   * @returns {{ secret: string }}
   */
  mint(req) {
    let { taskId, admissionId = null, serverAssignedSlug = null } = req || {};
    if (!taskId) throw new Error('mint: taskId is required');
    let secret = crypto.randomBytes(SECRET_BYTES).toString('hex');
    let map = this._read();
    this._sweep(map);
    map[hashSecret(secret)] = {
      taskId,
      admissionId: admissionId || null,
      serverAssignedSlug: serverAssignedSlug || null,
      createdAt: this._now(),
    };
    this._write(map);
    return { secret };
  }

  /**
   * Resolve a presented secret to its verified binding, or null if unknown,
   * expired, or absent. The result NEVER contains the secret.
   *
   * @param {string} secret
   * @returns {{ taskId: string, admissionId: string|null, serverAssignedSlug: string|null }|null}
   */
  resolve(secret) {
    if (!secret || typeof secret !== 'string') return null;
    let map = this._read();
    let entry = map[hashSecret(secret)];
    if (!entry) return null;
    if (this._expired(entry)) return null;
    return {
      taskId: entry.taskId,
      admissionId: entry.admissionId ?? null,
      serverAssignedSlug: entry.serverAssignedSlug ?? null,
    };
  }

  /**
   * Forget a task's binding by secret. Idempotent.
   *
   * @param {string} secret
   * @returns {{ removed: boolean }}
   */
  revoke(secret) {
    if (!secret || typeof secret !== 'string') return { removed: false };
    let map = this._read();
    let key = hashSecret(secret);
    if (!(key in map)) return { removed: false };
    delete map[key];
    this._write(map);
    return { removed: true };
  }

  /** Drop expired entries. Returns the count removed. */
  prune() {
    let map = this._read();
    let removed = this._sweep(map);
    if (removed) this._write(map);
    return { removed };
  }

  // ── Internals ──────────────────────────────────────────

  _expired(entry) {
    if (!this._ttlMs) return false;
    return this._now() - (entry.createdAt || 0) > this._ttlMs;
  }

  _sweep(map) {
    let removed = 0;
    for (let [key, entry] of Object.entries(map)) {
      if (this._expired(entry)) {
        delete map[key];
        removed++;
      }
    }
    return removed;
  }

  _read() {
    try {
      let data = JSON.parse(fs.readFileSync(this._path, 'utf8'));
      return data && typeof data === 'object' ? data : {};
    } catch {
      return {};
    }
  }

  _write(map) {
    if (!fs.existsSync(this._dir)) fs.mkdirSync(this._dir, { recursive: true });
    let tmp = `${this._path}.tmp.${process.pid}.${this._now()}`;
    let fd = fs.openSync(tmp, 'w');
    try {
      fs.writeSync(fd, JSON.stringify(map));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, this._path);
  }
}

let _singleton = null;

/**
 * Get the process-wide TaskSecretStore bound to the shared ledger directory.
 *
 * @param {object} [opts]
 * @returns {TaskSecretStore}
 */
export function getTaskSecretStore(opts = {}) {
  if (!_singleton) _singleton = new TaskSecretStore(opts);
  return _singleton;
}

/** Reset the singleton (tests only). */
export function _resetTaskSecretStore() {
  _singleton = null;
}

/** The env var carrying the per-task secret into the spawned process. */
export const TASK_SECRET_ENV = 'AGENT_PORTAL_TASK_SECRET';
