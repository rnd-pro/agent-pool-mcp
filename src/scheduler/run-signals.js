/**
 * Run signal files — atomic communication between MCP server and daemon.
 *
 * Instead of MCP tools writing directly to run JSON (race condition),
 * they write small signal files that the daemon consumes on each tick.
 *
 * Signal types: STEP_COMPLETE, BOUNCE_BACK
 *
 * @module agent-pool/scheduler/run-signals
 */

import { writeFileSync, readFileSync, readdirSync, unlinkSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { getProjectStatePath } from '../runtime/paths.js';

const RUNS_DIR = 'runs';

function runsDir(cwd) {
  return getProjectStatePath(cwd, RUNS_DIR);
}

/**
 * Write a signal file for a specific run.
 * Signal files are atomic — no concurrent read-modify-write.
 * @param {string} cwd
 * @param {string} runId
 * @param {object} signal - { type, stepName, output?, reason?, targetStep? }
 */
export function writeSignal(cwd, runId, signal) {
  const dir = runsDir(cwd);
  mkdirSync(dir, { recursive: true });

  const id = randomUUID().split('-')[0];
  const fileName = `${runId}.signal-${id}.json`;
  const payload = {
    ...signal,
    timestamp: new Date().toISOString(),
  };

  writeFileSync(join(dir, fileName), JSON.stringify(payload));
}

/**
 * Consume all pending signal files for a run.
 * Returns signals sorted by timestamp. Does NOT delete them —
 * caller must call deleteSignals() after persisting state.
 * @param {string} cwd
 * @param {string} runId
 * @returns {Array<{ type: string, stepName: string, fileName: string, [key: string]: any }>}
 */
export function consumeSignals(cwd, runId) {
  const dir = runsDir(cwd);
  if (!existsSync(dir)) return [];

  const prefix = `${runId}.signal-`;
  const signalFiles = readdirSync(dir).filter(f => f.startsWith(prefix) && f.endsWith('.json'));

  const signals = [];
  for (const f of signalFiles) {
    try {
      const data = JSON.parse(readFileSync(join(dir, f), 'utf-8'));
      signals.push({ ...data, fileName: f });
    } catch {
      // Include corrupted files so they get cleaned up by deleteSignals
      signals.push({ type: '_corrupted', fileName: f });
    }
  }

  // Sort by timestamp for deterministic processing
  signals.sort((a, b) => (a.timestamp || '').localeCompare(b.timestamp || ''));
  return signals;
}

/**
 * Delete signal files after state has been persisted to disk.
 * @param {string} cwd
 * @param {Array<{ fileName: string }>} signals
 */
export function deleteSignals(cwd, signals) {
  const dir = runsDir(cwd);
  for (const s of signals) {
    try { unlinkSync(join(dir, s.fileName)); }
    catch { /* ignore */ }
  }
}
