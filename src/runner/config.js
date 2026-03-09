/**
 * Runner configuration — loads and resolves runner definitions.
 *
 * Supports local and SSH runners. SSH config (keys, ports, jump hosts)
 * is handled by ~/.ssh/config — we only store host and remote cwd.
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

const DEFAULT_CONFIG = {
  runners: [{ id: 'local', type: 'local' }],
  defaultRunner: 'local',
};

/** @type {{runners: RunnerDef[], defaultRunner: string}|null} */
let cachedConfig = null;

/**
 * Load runner config from agent-pool.config.json.
 * Search order: CWD, ~/.config/agent-pool/, fallback to default (local only).
 *
 * @returns {{runners: RunnerDef[], defaultRunner: string}}
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
        cachedConfig = {
          runners: parsed.runners ?? DEFAULT_CONFIG.runners,
          defaultRunner: parsed.defaultRunner ?? 'local',
        };
        console.error(`[agent-pool] Config loaded from ${filePath}`);
        return cachedConfig;
      } catch (err) {
        console.error(`[agent-pool] Failed to parse ${filePath}: ${err.message}`);
      }
    }
  }

  cachedConfig = DEFAULT_CONFIG;
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
