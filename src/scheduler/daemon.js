#!/usr/bin/env node

/**
 * Scheduler Daemon — standalone detached process.
 * Reads schedule.json, spawns CLI agents on cron schedule.
 * Survives parent process death (MCP server, IDE, CLI).
 *
 * Usage: spawned by MCP server with detached:true + unref()
 * NOT meant to be run manually.
 *
 * @module agent-pool/scheduler/daemon
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync, readdirSync, renameSync } from 'node:fs';
import { spawn, execSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { matchesCron } from './cron.js';
import { getGroup, getGroupNextModel, getGroupNextProfile } from '../tools/groups.js';
import { getRunner } from '../runner/config.js';
import { buildSshSpawn } from '../runner/ssh.js';
import { killGroup } from '../runner/process-manager.js';
import { consumeSignals, deleteSignals } from './run-signals.js';
import { getClaudeGatewayEnv } from '../runner/provider-config.js';
import { getLegacyAgentPortalPath, getProjectStatePath } from '../runtime/paths.js';

const POLL_INTERVAL_MS = 30_000; // Check schedules every 30 seconds
const PID_FILE = 'scheduler.pid';
const SCHEDULE_FILE = 'schedule.json';
const RESULTS_DIR = 'scheduled-results';

/** @type {string} */
const cwd = process.argv[2] || process.cwd();
const DEFAULT_PROVIDER = 'codex';

function schedulePath() {
  const localPath = getProjectStatePath(cwd, SCHEDULE_FILE);
  return existsSync(localPath) ? localPath : getLegacyAgentPortalPath(cwd, SCHEDULE_FILE);
}

function writeSchedulePath() {
  return getProjectStatePath(cwd, SCHEDULE_FILE);
}

function resultsDir() {
  return getProjectStatePath(cwd, RESULTS_DIR);
}

function pidPath() {
  return getProjectStatePath(cwd, PID_FILE);
}

function codexSandbox(approvalMode) {
  if (approvalMode === 'plan') return 'read-only';
  if (approvalMode === 'auto_edit') return 'workspace-write';
  return 'danger-full-access';
}

function claudePermissionMode(approvalMode) {
  if (approvalMode === 'plan') return 'plan';
  if (approvalMode === 'auto_edit') return 'acceptEdits';
  return 'bypassPermissions';
}

function providerGatewayEnv(provider) {
  return provider === 'claude' ? getClaudeGatewayEnv(null) : {};
}

function buildCliArgs(provider, prompt, opts = {}) {
  const model = opts.model && opts.model !== 'default' ? opts.model : null;
  if (provider === 'gemini') {
    const args = [
      '-p', prompt,
      '--output-format', 'stream-json',
      '--approval-mode', opts.approvalMode || 'yolo',
    ];
    if (model) args.push('-m', model);
    return args;
  }
  if (provider === 'claude') {
    const args = [
      '-p', prompt,
      '--output-format', 'stream-json',
      '--verbose',
      '--permission-mode', claudePermissionMode(opts.approvalMode),
    ];
    if (model) args.push('--model', model);
    return args;
  }

  const args = [
    'exec',
    '--json',
    '-s', codexSandbox(opts.approvalMode),
  ];
  if (model) args.push('--model', model);
  args.push(prompt);
  return args;
}

function extractResponse(provider, stdout) {
  const events = stdout.split('\n').filter(Boolean).map((line) => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean);

  if (provider === 'codex') {
    const messages = events
      .filter((e) => e.type === 'item.completed' && e.item?.type === 'agent_message')
      .map((e) => e.item.text || '')
      .filter(Boolean);
    return { events, response: messages.join('\n') };
  }

  if (provider === 'claude') {
    const resultEvent = events.find((e) => e.type === 'result' && typeof e.result === 'string');
    if (resultEvent?.result) return { events, response: resultEvent.result };

    const messages = events
      .filter((e) => e.type === 'assistant' && e.message?.content)
      .flatMap((e) => e.message.content)
      .filter((block) => block.type === 'text' && block.text)
      .map((block) => block.text);
    return { events, response: messages.join('\n') };
  }

  const messages = events.filter((e) => e.type === 'message' && e.role === 'assistant');
  const resultEvent = events.find((e) => e.type === 'result');
  return { events, response: resultEvent?.response || messages.map((m) => m.content || m.text || '').join('\n') };
}

// ─── PID file management ────────────────────────────────────

/**
 * Write PID file. Exit if another daemon is already running.
 */
function acquireLock() {
  const filePath = pidPath();
  if (existsSync(filePath)) {
    try {
      const existingPid = parseInt(readFileSync(filePath, 'utf-8').trim());
      // Check if process is still alive
      process.kill(existingPid, 0);
      // Process exists — exit, another daemon is running
      console.error(`[scheduler] Another daemon running (pid ${existingPid}). Exiting.`);
      process.exit(0);
    } catch {
      // Process dead — stale PID file, we can take over
    }
  }
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, String(process.pid));
}

/**
 * Remove PID file on exit.
 */
function releaseLock() {
  try {
    const filePath = pidPath();
    if (existsSync(filePath)) {
      const storedPid = readFileSync(filePath, 'utf-8').trim();
      if (storedPid === String(process.pid)) {
        unlinkSync(filePath);
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
  const filePath = schedulePath();
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
  const filePath = writeSchedulePath();
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(schedules, null, 2));
}

// ─── CLI execution ──────────────────────────────────────────

/**
 * Run a CLI task and save the result.
 * @param {object} schedule
 */
function executeSchedule(schedule) {
  const timestamp = Date.now();
  const dir = resultsDir();
  const resultFile = join(dir, `${schedule.id}_${timestamp}.json`);
  mkdirSync(dir, { recursive: true });

  const provider = schedule.provider || DEFAULT_PROVIDER;
  let prompt = schedule.prompt;
  if (schedule.skill) {
    // Skills are pre-provisioned, just pass as part of prompt
    prompt = `Activate skill "${schedule.skill}" first.\n\n${prompt}`;
  }
  const args = buildCliArgs(provider, prompt, {
    approvalMode: schedule.approvalMode || 'yolo',
    model: schedule.model,
  });

  const child = spawn(provider, args, {
    cwd: schedule.cwd || cwd,
    env: { ...process.env, TERM: 'dumb', CI: '1', ...providerGatewayEnv(provider) },
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: true,
  });

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => { stdout += d.toString(); });
  child.stderr.on('data', (d) => { stderr += d.toString(); });

  child.on('close', (code) => {
    const { events, response } = extractResponse(provider, stdout);

    const result = {
      scheduleId: schedule.id,
      prompt: schedule.prompt,
      cron: schedule.cron,
      provider,
      model: schedule.model || null,
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
  console.error(`[scheduler] Started: ${schedule.id} → ${provider} pid ${child.pid}`);
}

// ─── Pipeline tick ──────────────────────────────────────────────────

const PIPELINES_DIR = '.agent-portal/pipelines';
const RUNS_DIR = 'runs';

function runsDir() {
  return getProjectStatePath(cwd, RUNS_DIR);
}

/**
 * In-memory pipeline state cache.
 * Loaded from disk on startup, updated in-place during ticks.
 * Written to disk on state transitions (write-through).
 * @type {Map<string, object>}
 */
const runCache = new Map();

/**
 * Load all active runs from disk into the in-memory cache.
 * Called once on daemon startup.
 */
function loadRunCache() {
  const dir = runsDir();
  if (!existsSync(dir)) return;
  for (const f of readdirSync(dir).filter(f => f.endsWith('.json') && !f.includes('.signal-'))) {
    try {
      const run = JSON.parse(readFileSync(join(dir, f), 'utf-8'));
      const runId = f.replace('.json', '');
      runCache.set(runId, run);
    } catch { /* skip corrupted */ }
  }
  console.error(`[pipeline] Loaded ${runCache.size} runs into memory cache`);
}

/**
 * Persist a run to disk atomically (write-then-rename).
 * Prevents corruption if daemon crashes mid-write.
 * @param {string} runId
 * @param {object} run
 */
function persistRun(runId, run) {
  const dir = runsDir();
  mkdirSync(dir, { recursive: true });
  const target = join(dir, `${runId}.json`);
  const tmp = join(dir, `${runId}.json.tmp`);
  writeFileSync(tmp, JSON.stringify(run, null, 2));
  // Atomic rename (same filesystem) — prevents corruption on crash
  try { renameSync(tmp, target); }
  catch { writeFileSync(target, JSON.stringify(run, null, 2)); }
}

/**
 * Apply consumed signal files to a run's in-memory state.
 * @param {object} run - Run state object (mutated in place)
 * @param {Array} signals - Consumed signal objects
 * @param {object} pipeline - Pipeline definition
 * @returns {boolean} true if any signal was applied
 */
function applySignals(run, signals, pipeline) {
  let modified = false;
  for (const signal of signals) {
    if (signal.type === 'STEP_COMPLETE') {
      const step = run.steps[signal.stepName];
      if (step && step.status === 'running') {
        step.status = 'success';
        step.signaled = true;
        step.completedAt = new Date().toISOString();
        if (signal.output) step.output = signal.output;
        modified = true;
        console.error(`[pipeline] Signal: step "${signal.stepName}" completed`);
      }
    } else if (signal.type === 'BOUNCE_BACK') {
      const targetStep = run.steps[signal.stepName];
      if (!targetStep) continue;

      const stepDef = pipeline?.steps.find(s => s.name === signal.stepName);
      const maxBounces = stepDef?.maxBounces ?? 2;

      if (targetStep.bounces >= maxBounces) {
        // Bounce limit reached
        targetStep.status = 'failed';
        targetStep.lastBounceReason = `Bounce limit (${maxBounces}) reached. Last: ${signal.reason}`;
        run.status = 'failed';
        run.completedAt = new Date().toISOString();
        console.error(`[pipeline] Bounce limit reached for "${signal.stepName}"`);
      } else {
        // Reset target step
        targetStep.status = 'bounce_pending';
        targetStep.bounces = (targetStep.bounces || 0) + 1;
        targetStep.lastBounceReason = signal.reason;

        // Kill running processes for this step
        const pidsToKill = [...(targetStep.pids || [])];
        if (targetStep.pid && !pidsToKill.includes(targetStep.pid)) pidsToKill.push(targetStep.pid);
        for (const pid of pidsToKill) killGroup(pid);

        targetStep.pid = null;
        targetStep.pids = [];
        targetStep.exitCode = null;
        targetStep.signaled = false;

        // Reset calling step
        if (signal.callingStepName && run.steps[signal.callingStepName]) {
          run.steps[signal.callingStepName].status = 'waiting_bounce';
        }
        console.error(`[pipeline] Bounce: step "${signal.stepName}" reset (reason: ${signal.reason})`);
      }
      modified = true;
    } else if (signal.type === 'CANCEL_RUN') {
      // Cancel the entire run
      for (const [name, step] of Object.entries(run.steps)) {
        if (step.status === 'running') step.status = 'cancelled';
        if (step.status === 'pending') step.status = 'skipped';
      }
      run.status = 'cancelled';
      run.completedAt = new Date().toISOString();
      console.error(`[pipeline] Signal: run cancelled`);
      modified = true;
    }
  }
  return modified;
}

/**
 * Spawn CLI agent(s) for a pipeline step.
 * @param {object} stepDef - Step definition from pipeline
 * @param {object} run - Current run state
 * @param {string} runId
 * @param {string} [bounceReason] - If bouncing back, the reason
 * @param {string} [fallbackModel] - Specific model to use for error fallback
 * @returns {number[]} Array of child PIDs
 */
function spawnStep(stepDef, run, runId, bounceReason, fallbackModel) {
  const count = stepDef.count || 1;
  const pids = [];

  // Resolve group
  let groupConfig = {};
  if (stepDef.group) {
    groupConfig = getGroup(run.cwd || cwd, stepDef.group) || {};
  }

  const groupProfile = stepDef.group ? getGroupNextProfile(run.cwd || cwd, stepDef.group, groupConfig) : { provider: null, model: null };
  const skill = stepDef.skill || groupConfig.skill;
  const policy = groupConfig.policy; // currently policy only from group
  const provider = stepDef.provider || groupProfile.provider || groupConfig.provider || DEFAULT_PROVIDER;
  const runnerId = groupConfig.runner;
  const runner = runnerId ? getRunner(runnerId) : { type: 'local' };
  const isRemote = runner && runner.type === 'ssh';

  for (let i = 0; i < count; i++) {
    let prompt = stepDef.prompt || '';

    // ── Resolve contentSource if prompt is missing or we want to augment ──
    if (stepDef.contentSource && !prompt) {
      try {
        const sourceJson = JSON.stringify(stepDef.contentSource).replace(/'/g, "'\\''");
        // Use URL to get current directory robustly
        const scriptPath = join(dirname(new URL(import.meta.url).pathname), 'resolve-content.js');
        prompt = execSync(`node ${scriptPath} '${sourceJson}'`, { 
          cwd: run.cwd || cwd, 
          encoding: 'utf-8' 
        }).trim();
      } catch (err) {
        console.error(`[daemon] Failed to resolve contentSource for step ${stepDef.name}: ${err.message}`);
        prompt = `Failed to resolve content source: ${err.message}`;
      }
    }

    if (bounceReason) {
      prompt = `${prompt}\n\n⚠️ BOUNCE BACK: предыдущая попытка была отклонена следующим шагом.\nПричина: ${bounceReason}\nДополни и улучши результат.`;
    }

    if (count > 1) {
      prompt = `[Agent ${i + 1}/${count}]\n\n${prompt}`;
    }

    // Inject pipeline context
    prompt = `[Pipeline: ${run.pipelineName}, Step: ${stepDef.name}, Run: ${runId}]\n\nTask:\n${prompt}\n\nWhen finished, call signal_step_complete with step_name "${stepDef.name}" and run_id "${runId}".`;

    let model = stepDef.model || groupProfile.model || groupConfig.model;
    if (fallbackModel) {
      model = fallbackModel;
    } else if (groupConfig.rotation_mode === 'round_robin') {
      const nextModel = getGroupNextModel(run.cwd || cwd, stepDef.group);
      if (nextModel) model = nextModel;
    } else if (groupConfig.fallback_profiles?.length > 0) {
      // error_fallback: start with the first model
      model = groupConfig.fallback_profiles[0];
    }

    if (skill) {
      // Skills can be active via prompt injection, as we do for scheduled tasks
      prompt = `Activate skill "${skill}" first.\n\n${prompt}`;
    }
    const args = buildCliArgs(provider, prompt, {
      approvalMode: stepDef.approvalMode || 'yolo',
      model,
    });
    if (provider === 'gemini' && policy) {
      args.push('--policy', policy);
    }
    if (provider === 'gemini' && groupConfig.include_dirs?.length > 0) {
      for (const dir of groupConfig.include_dirs) {
        args.push('--include-directories', dir);
      }
    }

    let spawnCmd, spawnArgs, spawnOpts;
    if (stepDef.type === 'execution_node') {
      spawnCmd = 'sh';
      spawnArgs = ['-c', stepDef.command || prompt];
      spawnOpts = {
        cwd: run.cwd || cwd,
        env: {
          ...process.env,
          PIPELINE_RUN_ID: runId,
          PIPELINE_STEP: stepDef.name
        },
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: true,
      };
      if (count > 1) spawnOpts.env.AGENT_INDEX = String(i);
    } else if (isRemote) {
      const ssh = buildSshSpawn(runner, args, run.cwd || cwd, provider);
      spawnCmd = ssh.command;
      spawnArgs = ssh.args;
      spawnOpts = { stdio: ['pipe', 'pipe', 'pipe'], detached: true };
    } else {
      spawnCmd = provider;
      spawnArgs = args;
      const currentDepth = parseInt(process.env.AGENT_POOL_DEPTH ?? '0');
      spawnOpts = {
        cwd: run.cwd || cwd,
        env: {
          ...process.env,
          TERM: 'dumb',
          CI: '1',
          AGENT_POOL_DEPTH: String(currentDepth + 1),
          ...providerGatewayEnv(provider),
        },
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: true,
      };
      if (count > 1) spawnOpts.env.AGENT_INDEX = String(i);
    }

    const child = spawn(spawnCmd, spawnArgs, spawnOpts);

    child.on('close', (code) => {
      // Update step exit code in in-memory state directly (same process)
      const currentRun = runCache.get(runId);
      if (currentRun?.steps[stepDef.name]) {
        if (code !== 0) {
          currentRun.steps[stepDef.name].exitCode = code;
        } else if (currentRun.steps[stepDef.name].exitCode === null) {
          currentRun.steps[stepDef.name].exitCode = 0;
        }
        // Write-through to disk
        persistRun(runId, currentRun);
      }
      console.error(`[pipeline] Step "${stepDef.name}" [pid ${child.pid}] exited (code: ${code}, run: ${runId})`);
    });

    child.stdin.end();
    child.unref();

    console.error(`[pipeline] Started step "${stepDef.name}" → pid ${child.pid} (run: ${runId})`);
    pids.push(child.pid);
  }

  return pids;
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
 * Process pipeline runs — consume signals, check triggers, advance steps.
 * Uses in-memory cache for state; persists to disk on changes.
 * @returns {boolean} true if any pipeline is actively running
 */
function tickPipelines() {
  // Pick up new runs added to disk since last tick (e.g., from runPipeline)
  const runStateDir = runsDir();
  if (existsSync(runStateDir)) {
    for (const f of readdirSync(runStateDir).filter(f => f.endsWith('.json') && !f.includes('.signal-') && !f.endsWith('.tmp'))) {
      const runId = f.replace('.json', '');
      if (!runCache.has(runId)) {
        try {
          const run = JSON.parse(readFileSync(join(runStateDir, f), 'utf-8'));
          runCache.set(runId, run);
          console.error(`[pipeline] Picked up new run: ${runId}`);
        } catch { /* skip corrupted */ }
      }
    }
  }

  const pipelinesDir = join(cwd, PIPELINES_DIR);
  let hasActive = false;

  // Iterate over a copy of keys to allow modification of runCache during iteration
  for (const runId of Array.from(runCache.keys())) {
    const run = runCache.get(runId);

    // Evict completed runs from cache (memory leak fix)
    if (run.status !== 'running') {
      // Clean up any orphaned/late signals for completed runs
      const lateSignals = consumeSignals(cwd, runId);
      if (lateSignals.length > 0) {
        deleteSignals(cwd, lateSignals);
        console.error(`[pipeline] Cleaned ${lateSignals.length} orphaned signal(s) for completed run ${runId}`);
      }
      runCache.delete(runId);
      continue;
    }
    hasActive = true;

    // Load pipeline definition
    let pipeline;
    try {
      pipeline = JSON.parse(readFileSync(join(pipelinesDir, `${run.pipeline}.json`), 'utf-8'));
    } catch {
      console.error(`[pipeline] Could not load pipeline definition for run ${runId}: ${run.pipeline}.json`);
      continue;
    }

    // 1. Consume and apply signal files
    const signals = consumeSignals(cwd, runId);
    let modified = false;

    if (signals.length > 0) {
      modified = applySignals(run, signals, pipeline);
      if (modified) {
        // Durability: persist state BEFORE deleting signals
        persistRun(runId, run);
        deleteSignals(cwd, signals);
      }
    }

    // 2. Process each step
    for (const stepDef of pipeline.steps) {
      const step = run.steps[stepDef.name];
      if (!step) continue;

      // ── Handle bounce_pending: re-run the step ──
      if (step.status === 'bounce_pending') {
        step.status = 'running';
        step.startedAt = new Date().toISOString();
        const pids = spawnStep(stepDef, run, runId, step.lastBounceReason);
        step.pids = pids;
        if (pids.length > 0) step.pid = pids[0];
        modified = true;
        continue;
      }

      // ── Handle running steps: check if process died ──
      if (step.status === 'running') {
        const pids = step.pids?.length > 0 ? step.pids : (step.pid ? [step.pid] : []);
        if (pids.length === 0) continue;

        let livingPids = 0;
        for (const pid of pids) if (isAlive(pid)) livingPids++;

        const isParallel = pids.length > 1;

        if (isParallel) {
          // Parallel semantics: rely entirely on exit codes
          if (step.exitCode !== null && step.exitCode !== 0) {
            // Fail fast: kill siblings
            for (const pid of pids) if (isAlive(pid)) killGroup(pid);

            const groupConfig = stepDef.group ? (getGroup(run.cwd || cwd, stepDef.group) || {}) : {};
            const fallbacks = groupConfig.fallback_profiles || [];
            const rotationMode = groupConfig.rotation_mode || 'error_fallback';
            step.fallbackIndex = step.fallbackIndex || 0;

            if (rotationMode === 'error_fallback' && step.fallbackIndex + 1 < fallbacks.length) {
              step.fallbackIndex++;
              const nextModel = fallbacks[step.fallbackIndex];
              console.error(`[pipeline] Step "${stepDef.name}" parallel failed (exit: ${step.exitCode}). Fallback: retrying all agents with model ${nextModel}`);
              
              step.status = 'running';
              step.startedAt = new Date().toISOString();
              step.exitCode = null; // reset
              const newPids = spawnStep(stepDef, run, runId, null, nextModel);
              step.pids = newPids;
              if (newPids.length > 0) step.pid = newPids[0];
            } else {
              step.status = 'failed';
              step.completedAt = new Date().toISOString();
              console.error(`[pipeline] Step "${stepDef.name}" parallel failed (exit: ${step.exitCode})`);
              if (pipeline.onError === 'stop') {
                run.status = 'failed';
                run.completedAt = new Date().toISOString();
              }
            }
            modified = true;
          } else if (livingPids === 0) {
            // All dead and no errors
            step.status = 'success';
            step.completedAt = new Date().toISOString();
            console.error(`[pipeline] Step "${stepDef.name}" parallel completed successfully`);
            modified = true;
          }
        } else {
          // Sequential semantics (count 1)
          const pid = pids[0];
          if (!isAlive(pid)) {
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
                const groupConfig = stepDef.group ? (getGroup(run.cwd || cwd, stepDef.group) || {}) : {};
                const fallbacks = groupConfig.fallback_profiles || [];
                const rotationMode = groupConfig.rotation_mode || 'error_fallback';
                step.fallbackIndex = step.fallbackIndex || 0;

                if (rotationMode === 'error_fallback' && step.fallbackIndex + 1 < fallbacks.length) {
                  step.fallbackIndex++;
                  const nextModel = fallbacks[step.fallbackIndex];
                  console.error(`[pipeline] Step "${stepDef.name}" failed (exit: ${step.exitCode}). Fallback: retrying with model ${nextModel} (${step.fallbackIndex + 1}/${fallbacks.length})`);
                  
                  step.status = 'running';
                  step.startedAt = new Date().toISOString();
                  step.exitCode = null; // reset
                  const pids = spawnStep(stepDef, run, runId, null, nextModel);
                  step.pids = pids;
                  if (pids.length > 0) step.pid = pids[0];
                } else {
                  step.status = 'failed';
                  step.completedAt = new Date().toISOString();
                  console.error(`[pipeline] Step "${stepDef.name}" failed (exit: ${step.exitCode})`);
                  if (pipeline.onError === 'stop') {
                    run.status = 'failed';
                    run.completedAt = new Date().toISOString();
                  }
                }
              }
              modified = true;
            }
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
        } else if (stepDef.trigger?.type === 'on_complete_all') {
          // Fan-in: wait for ALL listed steps to complete
          const deps = stepDef.trigger.steps || [];
          shouldStart = deps.length > 0 && deps.every(
            name => run.steps[name]?.status === 'success',
          );
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
          const pids = spawnStep(stepDef, run, runId);
          step.pids = pids;
          if (pids.length > 0) step.pid = pids[0];
          modified = true;
        }
      }

      // ── Handle waiting_bounce: restart when bounced step completes ──
      if (step.status === 'waiting_bounce') {
        const depStepName = stepDef.trigger?.step;
        if (depStepName && run.steps[depStepName]?.status === 'success') {
          step.status = 'running';
          step.startedAt = new Date().toISOString();
          const pids = spawnStep(stepDef, run, runId);
          step.pids = pids;
          if (pids.length > 0) step.pid = pids[0];
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
      persistRun(runId, run);
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
    const runStateDir = runsDir();
    const hasRuns = existsSync(runStateDir) && readdirSync(runStateDir).some(f => f.endsWith('.json'));
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

// ─── Startup ────────────────────────────────────────────────────

acquireLock();
loadRunCache();

process.on('SIGINT', () => { releaseLock(); process.exit(0); });
process.on('SIGTERM', () => { releaseLock(); process.exit(0); });

console.error(`[scheduler] Daemon started (pid ${process.pid}, cwd: ${cwd})`);
console.error(`[scheduler] Adaptive polling: 3s active / 30s idle`);

// Start the loop
tick();
