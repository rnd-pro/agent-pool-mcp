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

// ─── Pipeline tick ──────────────────────────────────────────

import { readdirSync } from 'node:fs';

const PIPELINES_DIR = '.agent/pipelines';
const RUNS_DIR = '.agent/runs';

/**
 * Spawn a Gemini CLI agent for a pipeline step.
 * @param {object} stepDef - Step definition from pipeline
 * @param {object} run - Current run state
 * @param {string} runId
 * @param {string} [bounceReason] - If bouncing back, the reason
 * @returns {number} child PID
 */
function spawnStep(stepDef, run, runId, bounceReason) {
  let prompt = stepDef.prompt;
  if (bounceReason) {
    prompt = `${stepDef.prompt}\n\n⚠️ BOUNCE BACK: предыдущая попытка была отклонена следующим шагом.\nПричина: ${bounceReason}\nДополни и улучши результат.`;
  }

  // Inject pipeline context
  prompt = `[Pipeline: ${run.pipelineName}, Step: ${stepDef.name}, Run: ${runId}]\n\nTask:\n${prompt}\n\nWhen finished, call signal_step_complete with step name "${stepDef.name}".`;

  const args = [
    '-p', prompt,
    '--output-format', 'stream-json',
    '--approval-mode', stepDef.approvalMode || 'yolo',
  ];

  const child = spawn('gemini', args, {
    cwd: run.cwd || cwd,
    env: { ...process.env, TERM: 'dumb', CI: '1' },
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: true,
  });

  child.on('close', (code) => {
    // Update step exit code in run state
    try {
      const currentRun = JSON.parse(readFileSync(join(cwd, RUNS_DIR, `${runId}.json`), 'utf-8'));
      if (currentRun.steps[stepDef.name]) {
        currentRun.steps[stepDef.name].exitCode = code;
      }
      writeFileSync(join(cwd, RUNS_DIR, `${runId}.json`), JSON.stringify(currentRun, null, 2));
    } catch { /* ignore */ }
    console.error(`[pipeline] Step "${stepDef.name}" exited (code: ${code}, run: ${runId})`);
  });

  child.stdin.end();
  child.unref();

  console.error(`[pipeline] Started step "${stepDef.name}" → pid ${child.pid} (run: ${runId})`);
  return child.pid;
}

/**
 * Check if a process is alive.
 * @param {number} pid
 * @returns {boolean}
 */
function isAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch { return false; }
}

/**
 * Process pipeline runs — check triggers, advance steps.
 * @returns {boolean} true if any pipeline is actively running
 */
function tickPipelines() {
  const runsDir = join(cwd, RUNS_DIR);
  if (!existsSync(runsDir)) return false;

  const pipelinesDir = join(cwd, PIPELINES_DIR);
  let hasActive = false;

  for (const file of readdirSync(runsDir).filter(f => f.endsWith('.json'))) {
    let run;
    try { run = JSON.parse(readFileSync(join(runsDir, file), 'utf-8')); }
    catch { continue; }

    if (run.status !== 'running') continue;
    hasActive = true;

    // Load pipeline definition
    let pipeline;
    try {
      pipeline = JSON.parse(readFileSync(join(pipelinesDir, `${run.pipeline}.json`), 'utf-8'));
    } catch { continue; }

    const runId = file.replace('.json', '');
    let modified = false;

    for (const stepDef of pipeline.steps) {
      const step = run.steps[stepDef.name];
      if (!step) continue;

      // ── Handle bounce_pending: re-run the step ──
      if (step.status === 'bounce_pending') {
        step.status = 'running';
        step.startedAt = new Date().toISOString();
        step.pid = spawnStep(stepDef, run, runId, step.lastBounceReason);
        modified = true;
        continue;
      }

      // ── Handle running steps: check if process died ──
      if (step.status === 'running' && step.pid) {
        if (!isAlive(step.pid)) {
          // Process is dead — did agent signal?
          if (!step.signaled) {
            // Auto-fallback: check exit code
            if (step.exitCode === 0 || step.exitCode === null) {
              // Treat as success (agent forgot to signal)
              step.status = 'success';
              step.completedAt = new Date().toISOString();
              console.error(`[pipeline] Step "${stepDef.name}" auto-completed (pid dead, exit: ${step.exitCode})`);
            } else {
              // Failed
              step.status = 'failed';
              step.completedAt = new Date().toISOString();
              console.error(`[pipeline] Step "${stepDef.name}" failed (exit: ${step.exitCode})`);
              if (pipeline.onError === 'stop') {
                run.status = 'failed';
                run.completedAt = new Date().toISOString();
              }
            }
            modified = true;
          }
        }
        continue;
      }

      // ── Handle pending steps: check trigger ──
      if (step.status === 'pending') {
        let shouldStart = false;

        if (stepDef.trigger === 'start') {
          // First step — always start
          shouldStart = true;
        } else if (stepDef.trigger?.type === 'on_complete') {
          const depStep = run.steps[stepDef.trigger.step];
          shouldStart = depStep?.status === 'success';
        } else if (stepDef.trigger?.type === 'on_file') {
          const filePath = join(run.cwd || cwd, stepDef.trigger.path);
          if (existsSync(filePath)) {
            // File exists — check if producing process is dead
            const depStepName = pipeline.steps[pipeline.steps.indexOf(stepDef) - 1]?.name;
            const depStep = depStepName ? run.steps[depStepName] : null;
            if (!depStep?.pid || !isAlive(depStep.pid)) {
              shouldStart = true;
            }
          }
        }

        if (shouldStart && run.status === 'running') {
          step.status = 'running';
          step.startedAt = new Date().toISOString();
          step.pid = spawnStep(stepDef, run, runId);
          modified = true;
        }
      }

      // ── Handle waiting_bounce: restart when bounced step completes ──
      if (step.status === 'waiting_bounce') {
        const depStepName = stepDef.trigger?.step;
        if (depStepName && run.steps[depStepName]?.status === 'success') {
          step.status = 'running';
          step.startedAt = new Date().toISOString();
          step.pid = spawnStep(stepDef, run, runId);
          modified = true;
        }
      }
    }

    // Check if all steps are done
    const allDone = Object.values(run.steps).every(s =>
      s.status === 'success' || s.status === 'failed' || s.status === 'skipped' || s.status === 'cancelled',
    );
    if (allDone && run.status === 'running') {
      const hasFailed = Object.values(run.steps).some(s => s.status === 'failed');
      run.status = hasFailed ? 'failed' : 'success';
      run.completedAt = new Date().toISOString();
      modified = true;
      console.error(`[pipeline] Run ${runId} completed: ${run.status}`);
    }

    if (modified) {
      writeFileSync(join(runsDir, file), JSON.stringify(run, null, 2));
    }
  }

  return hasActive;
}

// ─── Main loop ──────────────────────────────────────────────

function tick() {
  const now = new Date();
  const schedules = readSchedules();
  const hasActivePipeline = tickPipelines();

  if (schedules.length === 0 && !hasActivePipeline) {
    // No work — check for pipeline definitions before exiting
    const pipelinesDir = join(cwd, PIPELINES_DIR);
    const runsDir = join(cwd, RUNS_DIR);
    const hasRuns = existsSync(runsDir) && readdirSync(runsDir).some(f => f.endsWith('.json'));
    if (!hasRuns) {
      console.error('[scheduler] No schedules or active pipelines. Daemon exiting.');
      releaseLock();
      process.exit(0);
    }
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

  // Adaptive polling: fast when pipeline active, slow otherwise
  const nextTickMs = hasActivePipeline ? 3000 : 30000;
  setTimeout(tick, nextTickMs);
}

// ─── Startup ────────────────────────────────────────────────

acquireLock();

process.on('SIGINT', () => { releaseLock(); process.exit(0); });
process.on('SIGTERM', () => { releaseLock(); process.exit(0); });

console.error(`[scheduler] Daemon started (pid ${process.pid}, cwd: ${cwd})`);
console.error(`[scheduler] Adaptive polling: 3s active / 30s idle`);

// Start the loop
tick();

