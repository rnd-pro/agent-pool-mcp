/**
 * Schedule management — CRUD operations for schedule.json
 * and daemon lifecycle control.
 *
 * @module agent-pool/scheduler/scheduler
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { nextCronRun } from './cron.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DAEMON_SCRIPT = join(__dirname, 'daemon.js');

const SCHEDULE_FILE = '.agent/schedule.json';
const RESULTS_DIR = '.agent/scheduled-results';
const PID_FILE = '.agent/scheduler.pid';

// ─── Schedule CRUD ──────────────────────────────────────────

/**
 * Read all schedules.
 * @param {string} cwd
 * @returns {Array<object>}
 */
export function readSchedules(cwd) {
  const filePath = join(cwd, SCHEDULE_FILE);
  if (!existsSync(filePath)) return [];
  try {
    return JSON.parse(readFileSync(filePath, 'utf-8'));
  } catch {
    return [];
  }
}

/**
 * Write schedules to file.
 * @param {string} cwd
 * @param {Array<object>} schedules
 */
function writeSchedules(cwd, schedules) {
  const filePath = join(cwd, SCHEDULE_FILE);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(schedules, null, 2));
}

/**
 * Add a new schedule and ensure daemon is running.
 *
 * @param {string} cwd - Working directory
 * @param {object} opts
 * @param {string} opts.prompt - Task prompt
 * @param {string} opts.cron - Cron expression (5-field)
 * @param {string} [opts.skill] - Skill to activate
 * @param {string} [opts.approvalMode] - yolo | auto_edit | plan
 * @param {boolean} [opts.catchup] - Run missed schedules on restart
 * @param {string} [opts.taskCwd] - Working directory for the task
 * @returns {{ scheduleId: string, nextRun: string | null }}
 */
export function addSchedule(cwd, { prompt, cron, skill, approvalMode, catchup, taskCwd }) {
  const schedules = readSchedules(cwd);
  const id = randomUUID().split('-')[0]; // short ID
  const schedule = {
    id,
    prompt,
    cron,
    cwd: taskCwd || cwd,
    skill: skill || null,
    approvalMode: approvalMode || 'yolo',
    catchup: catchup ?? false,
    lastRun: null,
    createdAt: new Date().toISOString(),
  };

  schedules.push(schedule);
  writeSchedules(cwd, schedules);

  // Ensure daemon is running
  ensureDaemon(cwd);

  const next = nextCronRun(cron, new Date());

  return {
    scheduleId: id,
    nextRun: next ? next.toISOString() : null,
  };
}

/**
 * Remove a schedule by ID.
 * @param {string} cwd
 * @param {string} scheduleId
 * @returns {boolean} true if found and removed
 */
export function removeSchedule(cwd, scheduleId) {
  const schedules = readSchedules(cwd);
  const idx = schedules.findIndex((s) => s.id === scheduleId);
  if (idx === -1) return false;
  schedules.splice(idx, 1);
  writeSchedules(cwd, schedules);
  return true;
}

/**
 * List schedules with next run time.
 * @param {string} cwd
 * @returns {Array<object>}
 */
export function listSchedules(cwd) {
  const schedules = readSchedules(cwd);
  return schedules.map((s) => {
    const next = nextCronRun(s.cron, new Date());
    return {
      ...s,
      nextRun: next ? next.toISOString() : null,
    };
  });
}

// ─── Results ────────────────────────────────────────────────

/**
 * Get results for a schedule (or all).
 * @param {string} cwd
 * @param {string} [scheduleId] - Filter by schedule ID
 * @returns {Array<object>}
 */
export function getScheduledResults(cwd, scheduleId) {
  const dir = join(cwd, RESULTS_DIR);
  if (!existsSync(dir)) return [];

  const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
  const results = [];

  for (const file of files.slice(-20)) { // Last 20 results
    try {
      const data = JSON.parse(readFileSync(join(dir, file), 'utf-8'));
      if (!scheduleId || data.scheduleId === scheduleId) {
        results.push(data);
      }
    } catch { /* skip corrupt files */ }
  }

  return results.sort((a, b) => b.executedAt.localeCompare(a.executedAt));
}

// ─── Daemon lifecycle ───────────────────────────────────────

/**
 * Check if scheduler daemon is running.
 * @param {string} cwd
 * @returns {{ running: boolean, pid: number | null }}
 */
export function getDaemonStatus(cwd) {
  const pidPath = join(cwd, PID_FILE);
  if (!existsSync(pidPath)) return { running: false, pid: null };

  try {
    const pid = parseInt(readFileSync(pidPath, 'utf-8').trim());
    process.kill(pid, 0); // Check if alive (signal 0 = no-op)
    return { running: true, pid };
  } catch {
    // Stale PID file
    try { unlinkSync(pidPath); } catch { /* ignore */ }
    return { running: false, pid: null };
  }
}

/**
 * Start the daemon if not already running.
 * @param {string} cwd
 * @returns {{ started: boolean, pid: number | null }}
 */
export function ensureDaemon(cwd) {
  const status = getDaemonStatus(cwd);
  if (status.running) return { started: false, pid: status.pid };

  const child = spawn('node', [DAEMON_SCRIPT, cwd], {
    cwd,
    detached: true,
    stdio: 'ignore',
    env: { ...process.env },
  });
  child.unref();

  return { started: true, pid: child.pid };
}

/**
 * Stop the daemon.
 * @param {string} cwd
 * @returns {boolean} true if stopped
 */
export function stopDaemon(cwd) {
  const status = getDaemonStatus(cwd);
  if (!status.running) return false;

  try {
    process.kill(status.pid, 'SIGTERM');
    return true;
  } catch {
    return false;
  }
}
