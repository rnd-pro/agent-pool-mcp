/**
 * Process Manager — tracks spawned Gemini CLI processes and ensures cleanup.
 *
 * Fixes zombie process bug: spawns with detached=true, kills with
 * process.kill(-pid) to terminate the entire process group.
 *
 * @module agent-pool/runner/process-manager
 */

/** @type {Map<number, {taskId: string, startTime: number, label: string}>} */
const children = new Map();

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
  try {
    process.kill(-pid, 'SIGTERM');
    children.delete(pid);
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
      return true;
    } catch {
      children.delete(pid);
      return false;
    }
  }
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
 * Get list of currently tracked processes.
 *
 * @returns {Array<{pid: number, taskId: string, startTime: number, label: string}>}
 */
export function listChildren() {
  return [...children.entries()].map(([pid, info]) => ({ pid, ...info }));
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
