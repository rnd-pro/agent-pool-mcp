/**
 * Process Manager — tracks spawned Antigravity CLI processes and ensures cleanup.
 *
 * Fixes zombie process bug: spawns with detached=true, kills with
 * process.kill(-pid) to terminate the entire process group.
 *
 * @module agent-pool/runner/process-manager
 */

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';

/** @type {Map<number, {taskId: string, startTime: number, label: string}>} */
const children = new Map();
const DEFAULT_KILL_GRACE_MS = 500;
const MIB = 1024 * 1024;
const DEFAULT_ESTIMATED_TASK_MEMORY_BYTES = 512 * MIB;
const DEFAULT_MEMORY_RESERVE_BYTES = 512 * MIB;

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
export function getSystemLoad(options = {}) {
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
  const availableMemoryBytes = getAvailableMemoryBytes(totalMemoryBytes, freeMemoryBytes);
  const usedMemoryRatio = totalMemoryBytes > 0
    ? (totalMemoryBytes - availableMemoryBytes) / totalMemoryBytes
    : null;
  const estimatedNewTaskBytes = positiveIntegerEnv(
    'AGENT_POOL_ESTIMATED_TASK_MEMORY_BYTES',
    positiveIntegerEnv('AGENT_POOL_ESTIMATED_TASK_MEMORY_MB', DEFAULT_ESTIMATED_TASK_MEMORY_BYTES / MIB) * MIB,
  );
  const memoryReserveBytes = positiveIntegerEnv(
    'AGENT_POOL_MEMORY_RESERVE_BYTES',
    positiveIntegerEnv('AGENT_POOL_MEMORY_RESERVE_MB', DEFAULT_MEMORY_RESERVE_BYTES / MIB) * MIB,
  );
  const runningTaskCount = nonNegativeInteger(options.runningTaskCount, ours);
  const capacity = calculateCapacity({
    cpuCount,
    loadRatio1m,
    availableMemoryBytes,
    external,
    trackedChildren: ours,
    runningTaskCount,
    estimatedNewTaskBytes,
    memoryReserveBytes,
  });

  let warning = null;
  if (external > 0) {
    warning = `⚠️ System load: ${external} other Antigravity process${external > 1 ? 'es' : ''} running — responses may be slower.`;
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
      availableBytes: availableMemoryBytes,
      usedRatio: usedMemoryRatio,
      estimatedNewTaskBytes,
      reserveBytes: memoryReserveBytes,
      availableForNewTasksBytes: capacity.availableForNewTasksBytes,
      requiredForNextTaskBytes: estimatedNewTaskBytes,
      deficitForNextTaskBytes: capacity.deficitForNextTaskBytes,
      estimatedAdditionalTaskSlots: capacity.estimatedAdditionalTaskSlots,
    },
    process: {
      trackedChildren: ours,
    },
    capacity: {
      state: capacity.state,
      reason: capacity.reason,
      recommendedMaxParallelTasks: capacity.recommendedMaxParallelTasks,
      estimatedAdditionalTaskSlots: capacity.estimatedAdditionalTaskSlots,
    },
  };
}

/**
 * Calculate host capacity for new agent tasks.
 * `recommendedMaxParallelTasks` is total safe parallelism including already
 * running tracked children; already-started children do not consume memory twice.
 *
 * @param {object} input
 * @param {number} input.cpuCount
 * @param {number} input.loadRatio1m
 * @param {number} input.availableMemoryBytes
 * @param {number} input.external
 * @param {number} input.trackedChildren
 * @param {number} input.runningTaskCount
 * @param {number} input.estimatedNewTaskBytes
 * @param {number} input.memoryReserveBytes
 * @returns {{state: string, reason: string|null, availableForNewTasksBytes: number, deficitForNextTaskBytes: number, estimatedAdditionalTaskSlots: number, recommendedMaxParallelTasks: number}}
 */
export function calculateCapacity(input) {
  const cpuCount = Math.max(1, nonNegativeInteger(input.cpuCount, 1));
  const cpuParallelLimit = Math.max(1, Math.floor(cpuCount / 2));
  const availableMemoryBytes = Math.max(0, nonNegativeInteger(input.availableMemoryBytes, 0));
  const estimatedNewTaskBytes = Math.max(1, nonNegativeInteger(input.estimatedNewTaskBytes, DEFAULT_ESTIMATED_TASK_MEMORY_BYTES));
  const memoryReserveBytes = Math.max(0, nonNegativeInteger(input.memoryReserveBytes, DEFAULT_MEMORY_RESERVE_BYTES));
  const availableForNewTasksBytes = Math.max(0, availableMemoryBytes - memoryReserveBytes);
  const estimatedAdditionalTaskSlots = Math.floor(availableForNewTasksBytes / estimatedNewTaskBytes);
  const deficitForNextTaskBytes = Math.max(0, estimatedNewTaskBytes - availableForNewTasksBytes);
  const currentTaskSlots = Math.max(
    nonNegativeInteger(input.trackedChildren, 0),
    nonNegativeInteger(input.runningTaskCount, 0),
  );
  const memoryParallelLimit = currentTaskSlots + estimatedAdditionalTaskSlots;
  const recommendedMaxParallelTasks = Math.min(cpuParallelLimit, memoryParallelLimit);

  let state = 'available';
  let reason = null;
  if (estimatedAdditionalTaskSlots < 1) {
    state = 'constrained';
    reason = 'memory';
  } else if (input.loadRatio1m >= 1.5) {
    state = 'constrained';
    reason = 'cpu';
  } else if (input.loadRatio1m >= 1 || input.external > 0) {
    state = 'busy';
    reason = input.external > 0 ? 'external_agents' : 'cpu';
  }

  return {
    state,
    reason,
    availableForNewTasksBytes,
    deficitForNextTaskBytes,
    estimatedAdditionalTaskSlots,
    recommendedMaxParallelTasks,
  };
}

function getAvailableMemoryBytes(totalMemoryBytes, fallbackFreeBytes) {
  let available = null;
  if (process.platform === 'linux') {
    available = readLinuxAvailableMemoryBytes();
  } else if (process.platform === 'darwin') {
    available = readDarwinAvailableMemoryBytes();
  }
  if (!Number.isFinite(available) || available <= 0) {
    available = fallbackFreeBytes;
  }
  return Math.min(totalMemoryBytes, Math.max(fallbackFreeBytes, available));
}

function readLinuxAvailableMemoryBytes() {
  try {
    const meminfo = fs.readFileSync('/proc/meminfo', 'utf8');
    const match = meminfo.match(/^MemAvailable:\s+(\d+)\s+kB/im);
    return match ? Number.parseInt(match[1], 10) * 1024 : null;
  } catch {
    return null;
  }
}

function readDarwinAvailableMemoryBytes() {
  try {
    return parseDarwinVmStatAvailableBytes(execSync('vm_stat', { encoding: 'utf-8' }));
  } catch {
    return null;
  }
}

export function parseDarwinVmStatAvailableBytes(text) {
  const pageSizeMatch = String(text).match(/page size of\s+(\d+)\s+bytes/i);
  const pageSize = pageSizeMatch ? Number.parseInt(pageSizeMatch[1], 10) : 4096;
  const pageCount = (name) => {
    const match = String(text).match(new RegExp(`Pages ${name}:\\s+(\\d+)\\.`, 'i'));
    return match ? Number.parseInt(match[1], 10) : 0;
  };
  const pages = pageCount('free') + pageCount('speculative') + pageCount('inactive');
  return pages > 0 ? pages * pageSize : null;
}

function positiveIntegerEnv(name, fallback) {
  const parsed = Number.parseInt(process.env[name] || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function nonNegativeInteger(value, fallback) {
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
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
