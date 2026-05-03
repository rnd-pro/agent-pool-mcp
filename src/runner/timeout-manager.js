import { killGroup } from './process-manager.js';

/**
 * Creates a dynamic watchdog timer that manages both soft inactivity timeouts and hard max timeouts.
 *
 * @param {number} timeoutMs 
 * @param {function} onSoftTimeout 
 * @param {object} config 
 * @param {object} child 
 * @returns {object|null} watchdog object or null if timeoutMs is 0
 */
export function createProcessWatchdog(timeoutMs, onSoftTimeout, config, child) {
  if (timeoutMs <= 0) return null;

  let timer = null;
  let hardTimeoutHandle = null;

  let watchdog = {
    kick() {
      if (this.timer) clearTimeout(this.timer);
      this.timer = setTimeout(() => {
        this.timer = null;
        onSoftTimeout();
      }, timeoutMs);
    },
    stop() {
      if (this.timer) {
        clearTimeout(this.timer);
        this.timer = null;
      }
      if (hardTimeoutHandle) {
        clearTimeout(hardTimeoutHandle);
        hardTimeoutHandle = null;
      }
    }
  };

  // Start the soft inactivity timer
  watchdog.kick();

  // Hard timeout safety net — kill process group to prevent infinite zombies
  let hardTimeoutMs = Math.min(
    timeoutMs * config.limits.hardTimeoutMultiplier,
    config.limits.hardTimeoutMax * 1000
  );

  hardTimeoutHandle = setTimeout(() => {
    if (child.exitCode === null) {
      console.error(`[timeout-manager] HARD TIMEOUT: killing PID ${child.pid} after ${hardTimeoutMs / 1000}s`);
      killGroup(child.pid);
    }
  }, hardTimeoutMs);

  return watchdog;
}
