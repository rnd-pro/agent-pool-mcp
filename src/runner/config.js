/**
 * Agent Pool configuration — single source of truth for all operational settings.
 *
 * Loads from agent-pool.config.json (project or global) and merges with defaults.
 * All limits, safety, and runner settings are centralized here.
 *
 * Search order:
 *   1. CWD/agent-pool.config.json (project-level)
 *   2. ~/.config/agent-pool/config.json (global)
 *   3. Built-in defaults
 *
 * @module agent-pool/runner/config
 */

import fs from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';

/**
 * @typedef {object} RunnerDef
 * @property {string} id - Runner identifier
 * @property {'local'|'ssh'} type - Runner type
 * @property {string} [host] - SSH host (for type=ssh)
 * @property {string} [cwd] - Remote working directory (for type=ssh)
 */

/**
 * @typedef {object} LimitsConfig
 * @property {number} timeout - Soft timeout in seconds (default: 600)
 * @property {number} hardTimeoutMultiplier - Hard timeout = timeout × this (default: 2)
 * @property {number} hardTimeoutMax - Hard timeout cap in seconds (default: 1800)
 * @property {number} maxSteps - Max agent steps per task before kill (default: 50)
 * @property {number} maxConcurrent - Max concurrent agent processes (default: 5)
 * @property {number} maxDepth - Max orchestration depth (default: 3)
 */

/**
 * @typedef {object} SafetyConfig
 * @property {string[]} badCwdList - CWD values to reject (default: ['/', '/tmp', '/private/tmp'])
 * @property {string} defaultApprovalMode - Default approval mode (default: 'yolo')
 */

/**
 * @typedef {object} HistoryConfig
 * @property {number} retentionDays - Days to retain session history (default: 3)
 * @property {boolean} autoCleanup - Auto-cleanup on startup (default: true)
 */

/**
 * @typedef {object} AgentPoolConfig
 * @property {RunnerDef[]} runners
 * @property {string} defaultRunner
 * @property {string} defaultModel
 * @property {LimitsConfig} limits
 * @property {SafetyConfig} safety
 * @property {HistoryConfig} history
 */

/** @type {AgentPoolConfig} */
const DEFAULTS = {
  runners: [{ id: 'local', type: 'local' }],
  defaultRunner: 'local',
  defaultModel: 'gemini-3.1-pro-preview',
  limits: {
    timeout: 600,
    hardTimeoutMultiplier: 2,
    hardTimeoutMax: 1800,
    maxSteps: 50,
    maxConcurrent: 5,
    maxDepth: 3,
  },
  safety: {
    badCwdList: ['/', '/tmp', '/private/tmp'],
    defaultApprovalMode: 'yolo',
  },
  history: {
    retentionDays: 3,
    autoCleanup: true,
  },
};

/** @type {AgentPoolConfig|null} */
let cachedConfig = null;

/**
 * Deep merge two objects (1 level deep for sub-objects).
 * @param {object} defaults
 * @param {object} overrides
 * @returns {object}
 */
function mergeConfig(defaults, overrides) {
  let result = { ...defaults };
  for (let key of Object.keys(overrides)) {
    if (
      result[key] && typeof result[key] === 'object' && !Array.isArray(result[key])
      && overrides[key] && typeof overrides[key] === 'object' && !Array.isArray(overrides[key])
    ) {
      result[key] = { ...result[key], ...overrides[key] };
    } else {
      result[key] = overrides[key];
    }
  }
  return result;
}

/**
 * Load config from agent-pool.config.json, merged with defaults.
 * Search order: CWD, ~/.config/agent-pool/, fallback to defaults.
 *
 * @returns {AgentPoolConfig}
 */
export function loadConfig() {
  if (cachedConfig) return cachedConfig;

  const candidates = [
    path.join(process.cwd(), 'agent-pool.config.json'),
    path.join(homedir(), '.config', 'agent-pool', 'config.json'),
  ];

  for (const filePath of candidates) {
    if (fs.existsSync(filePath)) {
      try {
        const raw = fs.readFileSync(filePath, 'utf-8');
        const parsed = JSON.parse(raw);
        cachedConfig = mergeConfig(DEFAULTS, parsed);
        console.error(`[agent-pool] Config loaded from ${filePath}`);
        return cachedConfig;
      } catch (err) {
        console.error(`[agent-pool] Failed to parse ${filePath}: ${err.message}`);
      }
    }
  }

  cachedConfig = { ...DEFAULTS };
  return cachedConfig;
}

/**
 * Get a specific runner by ID.
 *
 * @param {string} [runnerId] - Runner ID, defaults to defaultRunner
 * @returns {RunnerDef}
 */
export function getRunner(runnerId) {
  const config = loadConfig();
  const id = runnerId ?? config.defaultRunner;
  const runner = config.runners.find((r) => r.id === id);
  if (!runner) {
    console.error(`[agent-pool] Runner "${id}" not found, falling back to local`);
    return { id: 'local', type: 'local' };
  }
  return runner;
}

/**
 * Invalidate cached config (for testing or hot reload).
 */
export function resetConfig() {
  cachedConfig = null;
}

