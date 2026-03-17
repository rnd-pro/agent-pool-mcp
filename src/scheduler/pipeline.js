/**
 * Pipeline management — CRUD for pipeline definitions and run state.
 *
 * Pipelines are stored as JSON templates in .agent/pipelines/.
 * Each execution creates a run state in .agent/runs/.
 *
 * @module agent-pool/scheduler/pipeline
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ensureDaemon } from './scheduler.js';

const PIPELINES_DIR = '.agent/pipelines';
const RUNS_DIR = '.agent/runs';

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
  const dir = join(cwd, PIPELINES_DIR);
  mkdirSync(dir, { recursive: true });

  const id = name.toLowerCase().replace(/[^a-z0-9-]/g, '-');
  const pipeline = {
    id,
    name,
    steps: steps.map((s, i) => ({
      name: s.name,
      prompt: s.prompt,
      skill: s.skill || null,
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
  const dir = join(cwd, PIPELINES_DIR);
  if (!existsSync(dir)) return [];
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
  const filePath = join(cwd, PIPELINES_DIR, `${pipelineId}.json`);
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

  const dir = join(cwd, RUNS_DIR);
  mkdirSync(dir, { recursive: true });

  const runId = randomUUID().split('-')[0];
  const steps = {};
  for (const step of pipeline.steps) {
    steps[step.name] = {
      status: 'pending',
      pid: null,
      exitCode: null,
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
  const filePath = join(cwd, RUNS_DIR, `${runId}.json`);
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
  const dir = join(cwd, RUNS_DIR);
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
  const dir = join(cwd, RUNS_DIR);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter(f => f.endsWith('.json'))
    .map(f => {
      try { return JSON.parse(readFileSync(join(dir, f), 'utf-8')); }
      catch { return null; }
    })
    .filter(r => r && (!pipelineId || r.pipeline === pipelineId))
    .sort((a, b) => (b.startedAt || '').localeCompare(a.startedAt || ''));
}

/**
 * Cancel a pipeline run.
 * @param {string} cwd
 * @param {string} runId
 * @returns {boolean}
 */
export function cancelRun(cwd, runId) {
  const run = getRun(cwd, runId);
  if (!run || run.status !== 'running') return false;

  // Kill any running step
  for (const [name, step] of Object.entries(run.steps)) {
    if (step.status === 'running' && step.pid) {
      try { process.kill(step.pid, 'SIGTERM'); } catch { /* already dead */ }
      step.status = 'cancelled';
    }
    if (step.status === 'pending') {
      step.status = 'skipped';
    }
  }
  run.status = 'cancelled';
  run.completedAt = new Date().toISOString();
  saveRun(cwd, runId, run);
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
  const dir = join(cwd, RUNS_DIR);
  if (!existsSync(dir)) return null;

  for (const f of readdirSync(dir).filter(f => f.endsWith('.json'))) {
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
 * @param {string} cwd
 * @param {string} stepName
 * @param {string} [output]
 * @param {string} [runId] - Specific run ID (recommended)
 * @returns {{ success: boolean, nextStep?: string }}
 */
export function signalStepComplete(cwd, stepName, output, runId) {
  let run, resolvedRunId;

  if (runId) {
    // Direct lookup by run ID
    run = getRun(cwd, runId);
    resolvedRunId = runId;
  } else {
    // Fallback: search by step name
    const found = findActiveRunByStep(cwd, stepName);
    if (!found) return { success: false };
    run = found.run;
    resolvedRunId = found.runId;
  }

  if (!run || run.status !== 'running') return { success: false };
  const step = run.steps[stepName];
  if (!step || step.status !== 'running') return { success: false };

  step.status = 'success';
  step.signaled = true;
  step.completedAt = new Date().toISOString();
  if (output) step.output = output;

  saveRun(cwd, resolvedRunId, run);
  return { success: true };
}

/**
 * Bounce back to a previous step. Called by agent via MCP tool.
 * @param {string} cwd
 * @param {string} targetStepName - Step to re-run
 * @param {string} reason - Why bouncing back
 * @param {string} [runId] - Specific run ID (recommended)
 * @returns {{ success: boolean, bounceCount?: number, maxBounces?: number }}
 */
export function bounceBack(cwd, targetStepName, reason, runId) {
  // Find active run where the caller is running
  const dir = join(cwd, RUNS_DIR);
  if (!existsSync(dir)) return { success: false };

  for (const f of readdirSync(dir).filter(f => f.endsWith('.json'))) {
    try {
      const run = JSON.parse(readFileSync(join(dir, f), 'utf-8'));
      if (run.status !== 'running') continue;

      const targetStep = run.steps[targetStepName];
      if (!targetStep) continue;

      // Find the pipeline definition for maxBounces
      const pipeline = getPipeline(run.cwd || cwd, run.pipeline);
      const stepDef = pipeline?.steps.find(s => s.name === targetStepName);
      const maxBounces = stepDef?.maxBounces ?? 2;

      if (targetStep.bounces >= maxBounces) {
        // Bounce limit reached — fail pipeline
        targetStep.status = 'failed';
        targetStep.lastBounceReason = `Bounce limit (${maxBounces}) reached. Last: ${reason}`;
        run.status = 'failed';
        run.completedAt = new Date().toISOString();
        saveRun(cwd, f.replace('.json', ''), run);
        return { success: false, bounceCount: targetStep.bounces, maxBounces };
      }

      // Reset target step to pending with bounce info
      targetStep.status = 'bounce_pending';
      targetStep.bounces += 1;
      targetStep.lastBounceReason = reason;
      targetStep.pid = null;
      targetStep.exitCode = null;
      targetStep.signaled = false;

      // Reset the calling step too
      const callingStepName = Object.keys(run.steps).find(name => {
        const s = run.steps[name];
        return s.status === 'running';
      });
      if (callingStepName) {
        run.steps[callingStepName].status = 'waiting_bounce';
      }

      saveRun(cwd, f.replace('.json', ''), run);
      return { success: true, bounceCount: targetStep.bounces, maxBounces };
    } catch { /* skip */ }
  }

  return { success: false };
}
