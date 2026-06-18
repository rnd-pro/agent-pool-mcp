/**
 * Process Manager — tracks spawned Antigravity CLI processes and ensures cleanup.
 *
 * Fixes zombie process bug: spawns with detached=true, kills with
 * process.kill(-pid) to terminate the entire process group.
 *
 * @module agent-pool/runner/process-manager
 */

import { execSync } from 'node:child_process';
import os from 'node:os';

/** @type {Map<number, {taskId: string, startTime: number, label: string}>} */
const children = new Map();
const DEFAULT_KILL_GRACE_MS = 500;

/**
 * Register a spawned child process for tracking.
 *
 * @param {number} pid - Child process PID
 * @param {string} taskId - Associated task ID
 * @param {string} [label] - Human-readable label
 */
export function trackChild(pid, taskId, label = '') {
  children.set(pid, { taskId, startTime: Date.now(), label });
}

/**
 * Kill an entire process group by PID.
 * Uses negative PID to kill the process group (only works with detached processes).
 *
 * @param {number} pid - Process PID
 * @returns {boolean} Whether kill signal was sent
 */
export function killGroup(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(-pid, 'SIGTERM');
    children.delete(pid);
    scheduleKillEscalation(pid);
    return true;
  } catch (err) {
    // ESRCH = process not found (already dead)
    if (err.code === 'ESRCH') {
      children.delete(pid);
      return false;
    }
    // EPERM = no permission — try simple kill
    try {
      process.kill(pid, 'SIGTERM');
      children.delete(pid);
      scheduleKillEscalation(pid, false);
      return true;
    } catch {
      children.delete(pid);
      return false;
    }
  }
}

function scheduleKillEscalation(pid, group = true) {
  let timer = setTimeout(() => {
    try {
      process.kill(group ? -pid : pid, 0);
    } catch {
      return;
    }

    try {
      process.kill(group ? -pid : pid, 'SIGKILL');
    } catch {
      // Process already exited or cannot be killed; cleanup remains best effort.
    }
  }, DEFAULT_KILL_GRACE_MS);
  timer.unref?.();
}

/**
 * Untrack a child process (called on normal exit).
 *
 * @param {number} pid
 */
export function untrackChild(pid) {
  children.delete(pid);
}

/**
 * Kill all tracked child processes.
 * Called on SIGTERM/SIGINT for graceful shutdown.
 *
 * @returns {number} Number of processes killed
 */
export function killAll() {
  let killed = 0;
  for (const pid of children.keys()) {
    if (killGroup(pid)) killed++;
  }
  return killed;
}

/**
 * Kill all tracked child processes for a specific task.
 *
 * @param {string} taskId
 * @returns {{attempted: number, killed: number}}
 */
export function killChildrenForTask(taskId) {
  let attempted = 0;
  let killed = 0;
  for (const [pid, info] of [...children.entries()]) {
    if (info.taskId !== taskId) continue;
    attempted++;
    if (killGroup(pid)) killed++;
  }
  return { attempted, killed };
}

/**
 * List tracked child processes for a specific task.
 *
 * @param {string} taskId
 * @returns {Array<{pid: number, taskId: string, startTime: number, label: string}>}
 */
export function listChildrenForTask(taskId) {
  return listChildren().filter((child) => child.taskId === taskId);
}

/**
 * Get list of currently tracked processes.
 *
 * @returns {Array<{pid: number, taskId: string, startTime: number, label: string}>}
 */
export function listChildren() {
  return [...children.entries()].map(([pid, info]) => ({ pid, ...info }));
}

/**
 * Get system-wide Antigravity process load.
 * Counts all `agy` processes on the system, separating ours from external.
 *
 * @returns {{total: number, ours: number, external: number, warning: string|null, cpu: object, memory: object, capacity: object}}
 */
export function getSystemLoad() {
  let total = 0;
  try {
    const antigravityPath = execSync('which agy 2>/dev/null || true', { encoding: 'utf-8' }).trim();
    if (antigravityPath) {
      const out = execSync(`pgrep -f "${antigravityPath}" 2>/dev/null || true`, { encoding: 'utf-8' }).trim();
      if (out) {
        total = out.split('\n').filter(Boolean).length;
      }
    }
  } catch {
    // pgrep not available or failed
  }

  const ours = children.size;
  const external = Math.max(0, total - ours);
  const cpuCount = os.cpus().length || 1;
  const loadAverage = os.loadavg();
  const loadRatio1m = loadAverage[0] / cpuCount;
  const totalMemoryBytes = os.totalmem();
  const freeMemoryBytes = os.freemem();
  const usedMemoryRatio = totalMemoryBytes > 0
    ? (totalMemoryBytes - freeMemoryBytes) / totalMemoryBytes
    : null;

  let warning = null;
  if (external > 0) {
    warning = `⚠️ System load: ${external} other Antigravity process${external > 1 ? 'es' : ''} running — responses may be slower.`;
  }

  let state = 'available';
  let reason = null;
  if (usedMemoryRatio !== null && usedMemoryRatio >= 0.9) {
    state = 'constrained';
    reason = 'memory';
  } else if (loadRatio1m >= 1.5) {
    state = 'constrained';
    reason = 'cpu';
  } else if (loadRatio1m >= 1 || external > 0) {
    state = 'busy';
    reason = external > 0 ? 'external_agents' : 'cpu';
  }

  return {
    total,
    ours,
    external,
    warning,
    cpu: {
      count: cpuCount,
      loadAvg1m: loadAverage[0],
      loadAvg5m: loadAverage[1],
      loadAvg15m: loadAverage[2],
      loadRatio1m,
    },
    memory: {
      totalBytes: totalMemoryBytes,
      freeBytes: freeMemoryBytes,
      usedRatio: usedMemoryRatio,
    },
    process: {
      trackedChildren: ours,
    },
    capacity: {
      state,
      reason,
      recommendedMaxParallelTasks: Math.max(1, Math.floor(cpuCount / 2)),
    },
  };
}

// Cleanup on exit signals
process.on('SIGTERM', () => {
  const count = killAll();
  if (count > 0) {
    console.error(`[agent-pool] SIGTERM: killed ${count} child process(es)`);
  }
  process.exit(0);
});

process.on('SIGINT', () => {
  const count = killAll();
  if (count > 0) {
    console.error(`[agent-pool] SIGINT: killed ${count} child process(es)`);
  }
  process.exit(0);
});
