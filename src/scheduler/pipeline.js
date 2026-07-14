/**
 * Pipeline management — CRUD for pipeline definitions and run state.
 *
 * Pipeline definitions are shared content: they are stored as JSON templates in the team-memory
 * `pipelines/` directory (single source of truth). Each execution creates local run state in the
 * portal home project-state directory.
 *
 * @module agent-pool/scheduler/pipeline
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ensureDaemon } from './scheduler.js';
import { killGroup } from '../runner/process-manager.js';
import { writeSignal } from './run-signals.js';
import { getProjectStatePath, getTeamMemoryPath } from '../runtime/paths.js';

const RUNS_DIR = 'runs';

// Pipeline definitions live in the team-memory `pipelines/` dir (single source of truth). Returns null
// when team memory is unconfigured — callers degrade to "no pipelines" rather than reading a stale
// per-project `.agent-portal/pipelines` checkout.
function pipelinesDir() {
  return getTeamMemoryPath('pipelines');
}

function runsDir(cwd) {
  return getProjectStatePath(cwd, RUNS_DIR);
}

function normalizeOptionalSetting(value, name) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new Error(`Invalid ${name}: must be a string`);
  let normalized = value.trim();
  if (!normalized) throw new Error(`Invalid ${name}: must be a non-empty string`);
  return normalized === 'default' ? null : normalized;
}

// ─── Helpers ────────────────────────────────────────────────

/**
 * Normalize trigger from various input formats to canonical form.
 * Handles: objects, 'start', step name strings, or missing values.
 * @param {*} trigger - Raw trigger value from user input
 * @param {number} i - Step index
 * @param {Array} steps - All steps array
 * @returns {string|object} Normalized trigger
 */
function normalizeTrigger(trigger, i, steps) {
  // No trigger → first step starts, others depend on previous
  if (!trigger) {
    return i === 0 ? 'start' : { type: 'on_complete', step: steps[i - 1].name };
  }
  // Already a proper object → keep as-is
  if (typeof trigger === 'object' && trigger.type) {
    return trigger;
  }
  // 'start' → first step
  if (trigger === 'start') {
    return 'start';
  }
  // Plain string → treat as on_complete dependency on that step name
  if (typeof trigger === 'string') {
    return { type: 'on_complete', step: trigger };
  }
  // Fallback
  return i === 0 ? 'start' : { type: 'on_complete', step: steps[i - 1].name };
}

// ─── Pipeline CRUD ──────────────────────────────────────────

/**
 * Create a pipeline definition.
 * @param {string} cwd
 * @param {object} opts
 * @param {string} opts.name
 * @param {Array<object>} opts.steps
 * @param {string} [opts.onError] - 'stop' (default) | 'skip'
 * @returns {{ pipelineId: string, path: string }}
 */
export function createPipeline(cwd, { name, steps, onError }) {
  const dir = pipelinesDir();
  if (!dir) throw new Error('Cannot create a pipeline: team memory is not configured.');
  mkdirSync(dir, { recursive: true });

  const id = name.toLowerCase().replace(/[^a-z0-9-]/g, '-');
  const pipeline = {
    id,
    name,
    steps: steps.map((s, i) => ({
      name: s.name,
      prompt: s.prompt || null,
      provider: s.provider || 'codex',
      model: s.model || null,
      reasoningEffort: normalizeOptionalSetting(s.reasoningEffort ?? s.reasoning_effort, 'reasoningEffort'),
      serviceTier: normalizeOptionalSetting(s.serviceTier ?? s.service_tier, 'serviceTier'),
      contentSource: s.contentSource || s.content_source || null,
      skill: s.skill || null,
      group: s.group || null,
      count: s.count ? parseInt(s.count, 10) : 1,
      approvalMode: s.approval_mode || 'yolo',
      timeout: s.timeout || 600,
      maxBounces: s.maxBounces ?? s.max_bounces ?? 2,
      trigger: normalizeTrigger(s.trigger, i, steps),
      expectedOutput: s.expectedOutput || s.expected_output || null,
    })),
    onError: onError || 'stop',
    createdAt: new Date().toISOString(),
  };

  const filePath = join(dir, `${id}.json`);
  writeFileSync(filePath, JSON.stringify(pipeline, null, 2));
  return { pipelineId: id, path: filePath };
}

/**
 * List all pipeline definitions.
 * @param {string} cwd
 * @returns {Array<object>}
 */
export function listPipelines(cwd) {
  const dir = pipelinesDir();
  if (!dir || !existsSync(dir)) return [];
  return readdirSync(dir)
    .filter(f => f.endsWith('.json'))
    .map(f => {
      try { return JSON.parse(readFileSync(join(dir, f), 'utf-8')); }
      catch { return null; }
    })
    .filter(Boolean);
}

/**
 * Get a pipeline definition by ID.
 * @param {string} cwd
 * @param {string} pipelineId
 * @returns {object|null}
 */
export function getPipeline(cwd, pipelineId) {
  const dir = pipelinesDir();
  if (!dir) return null;
  const filePath = join(dir, `${pipelineId}.json`);
  if (!existsSync(filePath)) return null;
  try { return JSON.parse(readFileSync(filePath, 'utf-8')); }
  catch { return null; }
}

// ─── Run Management ─────────────────────────────────────────

/**
 * Start a pipeline run. Creates run state and starts first step.
 * @param {string} cwd
 * @param {string} pipelineId
 * @returns {{ runId: string } | null}
 */
export function runPipeline(cwd, pipelineId) {
  const pipeline = getPipeline(cwd, pipelineId);
  if (!pipeline) return null;

  const dir = runsDir(cwd);
  mkdirSync(dir, { recursive: true });

  const runId = randomUUID().split('-')[0];
  const steps = {};
  for (const step of pipeline.steps) {
    steps[step.name] = {
      status: 'pending',
      pid: null,     // Legacy / single pid
      pids: [],      // Array for parallel execution
      exitCode: null,
      error: null,
      signaled: false,
      bounces: 0,
      lastBounceReason: null,
      startedAt: null,
      completedAt: null,
    };
  }

  const run = {
    id: runId,
    pipeline: pipelineId,
    pipelineName: pipeline.name,
    status: 'running',
    cwd,
    startedAt: new Date().toISOString(),
    completedAt: null,
    steps,
  };

  writeFileSync(join(dir, `${runId}.json`), JSON.stringify(run, null, 2));

  // Ensure daemon is running to process pipeline ticks
  ensureDaemon(cwd);

  return { runId };
}

/**
 * Read a run state.
 * @param {string} cwd
 * @param {string} runId
 * @returns {object|null}
 */
export function getRun(cwd, runId) {
  const filePath = join(runsDir(cwd), `${runId}.json`);
  if (!existsSync(filePath)) return null;
  try { return JSON.parse(readFileSync(filePath, 'utf-8')); }
  catch { return null; }
}

/**
 * Update a run state.
 * @param {string} cwd
 * @param {string} runId
 * @param {object} run
 */
export function saveRun(cwd, runId, run) {
  const dir = runsDir(cwd);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${runId}.json`), JSON.stringify(run, null, 2));
}

/**
 * List all runs (optionally filter by pipeline).
 * @param {string} cwd
 * @param {string} [pipelineId]
 * @returns {Array<object>}
 */
export function listRuns(cwd, pipelineId) {
  const dir = runsDir(cwd);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter(f => f.endsWith('.json') && !f.includes('.signal-'))
    .map(f => {
      try { return JSON.parse(readFileSync(join(dir, f), 'utf-8')); }
      catch { return null; }
    })
    .filter(r => r && (!pipelineId || r.pipeline === pipelineId))
    .sort((a, b) => (b.startedAt || '').localeCompare(a.startedAt || ''));
}

/**
 * Cancel a pipeline run. Writes a signal file for the daemon.
 * Kills running processes immediately for responsiveness.
 * @param {string} cwd
 * @param {string} runId
 * @returns {boolean}
 */
export function cancelRun(cwd, runId) {
  const run = getRun(cwd, runId);
  if (!run || run.status !== 'running') return false;

  // Kill running processes immediately (side-effect safe)
  for (const [name, step] of Object.entries(run.steps)) {
    if (step.status === 'running') {
      const pidsToKill = [...(step.pids || [])];
      if (step.pid && !pidsToKill.includes(step.pid)) pidsToKill.push(step.pid);
      for (const pid of pidsToKill) {
        killGroup(pid);
      }
    }
  }

  // Write signal file — daemon will apply the state change
  writeSignal(cwd, runId, {
    type: 'CANCEL_RUN',
  });

  return true;
}

// ─── Signal Handling ────────────────────────────────────────

/**
 * Find active run containing a step name.
 * @param {string} cwd
 * @param {string} stepName
 * @returns {{ run: object, runId: string } | null}
 */
export function findActiveRunByStep(cwd, stepName) {
  const dir = runsDir(cwd);
  if (!existsSync(dir)) return null;

  for (const f of readdirSync(dir).filter(f => f.endsWith('.json') && !f.includes('.signal-'))) {
    try {
      const run = JSON.parse(readFileSync(join(dir, f), 'utf-8'));
      if (run.status === 'running' && run.steps[stepName]) {
        return { run, runId: f.replace('.json', '') };
      }
    } catch { /* skip */ }
  }
  return null;
}

/**
 * Signal step completion. Called by agent via MCP tool.
 * Writes a signal file instead of mutating run state directly.
 * The daemon will consume this signal on its next tick.
 * @param {string} cwd
 * @param {string} stepName
 * @param {string} [output]
 * @param {string} [runId] - Specific run ID (recommended)
 * @returns {{ success: boolean }}
 */
export function signalStepComplete(cwd, stepName, output, runId) {
  let resolvedRunId = runId;

  if (!resolvedRunId) {
    // Fallback: search by step name
    const found = findActiveRunByStep(cwd, stepName);
    if (!found) return { success: false };
    resolvedRunId = found.runId;
  }

  // Verify run exists and is active
  const run = getRun(cwd, resolvedRunId);
  if (!run || run.status !== 'running') return { success: false };
  if (!run.steps[stepName] || run.steps[stepName].status !== 'running') return { success: false };

  // Write signal file — daemon will apply it
  writeSignal(cwd, resolvedRunId, {
    type: 'STEP_COMPLETE',
    stepName,
    output: output || null,
  });

  return { success: true };
}

/**
 * Bounce back to a previous step. Called by agent via MCP tool.
 * Writes a signal file instead of mutating run state directly.
 * @param {string} cwd
 * @param {string} targetStepName - Step to re-run
 * @param {string} reason - Why bouncing back
 * @param {string} [runId] - Specific run ID (recommended)
 * @returns {{ success: boolean, bounceCount?: number, maxBounces?: number }}
 */
export function bounceBack(cwd, targetStepName, reason, runId) {
  // Find the active run containing this step
  let resolvedRunId = runId;
  let run;

  if (resolvedRunId) {
    run = getRun(cwd, resolvedRunId);
  } else {
    const dir = runsDir(cwd);
    if (!existsSync(dir)) return { success: false };
    for (const f of readdirSync(dir).filter(f => f.endsWith('.json') && !f.includes('.signal-'))) {
      try {
        const r = JSON.parse(readFileSync(join(dir, f), 'utf-8'));
        if (r.status === 'running' && r.steps[targetStepName]) {
          run = r;
          resolvedRunId = f.replace('.json', '');
          break;
        }
      } catch { /* skip */ }
    }
  }

  if (!run || run.status !== 'running') return { success: false };

  const targetStep = run.steps[targetStepName];
  if (!targetStep) return { success: false };

  // Check bounce limit (read-only check — safe without lock)
  const pipeline = getPipeline(run.cwd || cwd, run.pipeline);
  const stepDef = pipeline?.steps.find(s => s.name === targetStepName);
  const maxBounces = stepDef?.maxBounces ?? 2;

  if (targetStep.bounces >= maxBounces) {
    return { success: false, bounceCount: targetStep.bounces, maxBounces };
  }

  // Find the calling step name (the step that's bouncing back)
  const callingStepName = Object.keys(run.steps).find(name =>
    run.steps[name].status === 'running' && name !== targetStepName,
  );

  // Write signal file — daemon will apply the state changes and kill processes
  writeSignal(cwd, resolvedRunId, {
    type: 'BOUNCE_BACK',
    stepName: targetStepName,
    callingStepName: callingStepName || null,
    reason,
  });

  return { success: true, bounceCount: targetStep.bounces + 1, maxBounces };
}
