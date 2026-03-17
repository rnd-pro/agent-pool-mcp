#!/usr/bin/env node

/**
 * Scheduler Daemon — standalone detached process.
 * Reads schedule.json, spawns Gemini CLI agents on cron schedule.
 * Survives parent process death (MCP server, IDE, CLI).
 *
 * Usage: spawned by MCP server with detached:true + unref()
 * NOT meant to be run manually.
 *
 * @module agent-pool/scheduler/daemon
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { matchesCron } from './cron.js';

const POLL_INTERVAL_MS = 30_000; // Check schedules every 30 seconds
const PID_FILE = '.agent/scheduler.pid';
const SCHEDULE_FILE = '.agent/schedule.json';
const RESULTS_DIR = '.agent/scheduled-results';

/** @type {string} */
const cwd = process.argv[2] || process.cwd();

// ─── PID file management ────────────────────────────────────

/**
 * Write PID file. Exit if another daemon is already running.
 */
function acquireLock() {
  const pidPath = join(cwd, PID_FILE);
  if (existsSync(pidPath)) {
    try {
      const existingPid = parseInt(readFileSync(pidPath, 'utf-8').trim());
      // Check if process is still alive
      process.kill(existingPid, 0);
      // Process exists — exit, another daemon is running
      console.error(`[scheduler] Another daemon running (pid ${existingPid}). Exiting.`);
      process.exit(0);
    } catch {
      // Process dead — stale PID file, we can take over
    }
  }
  mkdirSync(dirname(pidPath), { recursive: true });
  writeFileSync(pidPath, String(process.pid));
}

/**
 * Remove PID file on exit.
 */
function releaseLock() {
  try {
    const pidPath = join(cwd, PID_FILE);
    if (existsSync(pidPath)) {
      const storedPid = readFileSync(pidPath, 'utf-8').trim();
      if (storedPid === String(process.pid)) {
        unlinkSync(pidPath);
      }
    }
  } catch { /* ignore */ }
}

// ─── Schedule management ────────────────────────────────────

/**
 * Read schedules from JSON file.
 * @returns {Array<{id: string, prompt: string, cron: string, cwd: string, skill?: string, approvalMode?: string, catchup?: boolean, lastRun?: string, createdAt: string}>}
 */
function readSchedules() {
  const filePath = join(cwd, SCHEDULE_FILE);
  if (!existsSync(filePath)) return [];
  try {
    return JSON.parse(readFileSync(filePath, 'utf-8'));
  } catch {
    return [];
  }
}

/**
 * Update schedule in JSON file (e.g., set lastRun).
 * @param {string} scheduleId
 * @param {object} updates
 */
function updateSchedule(scheduleId, updates) {
  const schedules = readSchedules();
  const idx = schedules.findIndex((s) => s.id === scheduleId);
  if (idx === -1) return;
  Object.assign(schedules[idx], updates);
  writeFileSync(join(cwd, SCHEDULE_FILE), JSON.stringify(schedules, null, 2));
}

// ─── Gemini CLI execution ───────────────────────────────────

/**
 * Run a Gemini CLI task and save the result.
 * @param {object} schedule
 */
function executeSchedule(schedule) {
  const timestamp = Date.now();
  const resultFile = join(cwd, RESULTS_DIR, `${schedule.id}_${timestamp}.json`);
  mkdirSync(join(cwd, RESULTS_DIR), { recursive: true });

  const args = [
    '-p', schedule.prompt,
    '--output-format', 'stream-json',
    '--approval-mode', schedule.approvalMode || 'yolo',
  ];
  if (schedule.skill) {
    // Skills are pre-provisioned, just pass as part of prompt
    args[1] = `Activate skill "${schedule.skill}" first.\n\n${schedule.prompt}`;
  }

  const child = spawn('gemini', args, {
    cwd: schedule.cwd || cwd,
    env: { ...process.env, TERM: 'dumb', CI: '1' },
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: true,
  });

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => { stdout += d.toString(); });
  child.stderr.on('data', (d) => { stderr += d.toString(); });

  child.on('close', (code) => {
    // Parse stream-json events for the final response
    const events = stdout.split('\n').filter(Boolean).map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean);

    const messages = events.filter((e) => e.type === 'message' && e.role === 'assistant');
    const resultEvent = events.find((e) => e.type === 'result');
    const response = resultEvent?.response || messages.map((m) => m.content || m.text || '').join('\n');

    const result = {
      scheduleId: schedule.id,
      prompt: schedule.prompt,
      cron: schedule.cron,
      executedAt: new Date(timestamp).toISOString(),
      completedAt: new Date().toISOString(),
      exitCode: code,
      response: response.substring(0, 5000),
      totalEvents: events.length,
    };

    try {
      writeFileSync(resultFile, JSON.stringify(result, null, 2));
    } catch { /* ignore write errors */ }

    console.error(`[scheduler] Completed: ${schedule.id} (exit: ${code})`);
  });

  child.stdin.end();
  child.unref();

  updateSchedule(schedule.id, { lastRun: new Date().toISOString() });
  console.error(`[scheduler] Started: ${schedule.id} → gemini pid ${child.pid}`);
}

// ─── Main loop ──────────────────────────────────────────────

function tick() {
  const now = new Date();
  const schedules = readSchedules();

  if (schedules.length === 0) {
    // No schedules — exit daemon to free resources
    console.error('[scheduler] No schedules remaining. Daemon exiting.');
    releaseLock();
    process.exit(0);
  }

  for (const schedule of schedules) {
    if (!schedule.cron || !schedule.prompt) continue;

    // Check if cron matches current minute
    if (!matchesCron(schedule.cron, now)) continue;

    // Deduplicate: don't run if already ran this minute
    if (schedule.lastRun) {
      const lastRun = new Date(schedule.lastRun);
      if (lastRun.getFullYear() === now.getFullYear() &&
          lastRun.getMonth() === now.getMonth() &&
          lastRun.getDate() === now.getDate() &&
          lastRun.getHours() === now.getHours() &&
          lastRun.getMinutes() === now.getMinutes()) {
        continue; // Already ran this minute
      }
    }

    // Atomic execution lock (prevents dual-daemon runs)
    const lockFile = join(cwd, '.agent', 'locks', `${schedule.id}_${now.getTime()}.lock`);
    try {
      mkdirSync(dirname(lockFile), { recursive: true });
      writeFileSync(lockFile, String(process.pid), { flag: 'wx' }); // wx = fail if exists
    } catch {
      continue; // Another daemon got the lock
    }

    executeSchedule(schedule);
  }
}

// ─── Startup ────────────────────────────────────────────────

acquireLock();

process.on('SIGINT', () => { releaseLock(); process.exit(0); });
process.on('SIGTERM', () => { releaseLock(); process.exit(0); });

console.error(`[scheduler] Daemon started (pid ${process.pid}, cwd: ${cwd})`);
console.error(`[scheduler] Polling every ${POLL_INTERVAL_MS / 1000}s`);

// Initial tick
tick();

// Main loop
setInterval(tick, POLL_INTERVAL_MS);
