import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function portalHome(env = process.env) {
  return path.resolve(env.AGENT_PORTAL_CONFIG_DIR || path.join(os.homedir(), '.agent-portal'));
}

function readPortalConfig(env = process.env) {
  let configPath = env.PORTAL_CONFIG_PATH || path.join(portalHome(env), 'agent-portal.json');
  try {
    return JSON.parse(readFileSync(configPath, 'utf8'));
  } catch {
    return {};
  }
}

/**
 * Resolve the team-memory content directory as an absolute path, used directly.
 *
 * Single source of truth, no cwd-relative fallback:
 *   1. AGENT_PORTAL_MEMORY_ROOT env (tests / CI / headless override)
 *   2. config-store `agentPortal.teamMemoryRoot` (the Agent Portal setting)
 *   3. null when unconfigured — callers degrade to an empty memory and the UI
 *      surfaces the "configure team memory" state.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string|null}
 */
export function getTeamMemoryRoot(env = process.env) {
  if (env.AGENT_PORTAL_MEMORY_ROOT) return path.resolve(env.AGENT_PORTAL_MEMORY_ROOT);
  let configured = readPortalConfig(env)?.agentPortal?.teamMemoryRoot;
  return configured ? path.resolve(configured) : null;
}

/**
 * Join parts onto the team-memory root, or null when unconfigured.
 * @param {...string} parts
 * @returns {string|null}
 */
export function getTeamMemoryPath(...parts) {
  let root = getTeamMemoryRoot();
  return root ? path.join(root, ...parts) : null;
}

function projectKey(cwd = process.cwd()) {
  const root = path.resolve(cwd || process.cwd());
  const hash = createHash('sha1').update(root).digest('hex').slice(0, 12);
  const name = path.basename(root).replace(/[^a-zA-Z0-9._-]+/g, '-') || 'project';
  return `${name}-${hash}`;
}

export function getGlobalConfigPath(...parts) {
  return path.join(portalHome(), ...parts);
}

export function getProjectStateDir(cwd = process.cwd()) {
  return path.join(portalHome(), 'projects', projectKey(cwd));
}

export function getProjectStatePath(cwd = process.cwd(), ...parts) {
  return path.join(getProjectStateDir(cwd), ...parts);
}

export function ensureDirFor(filePath) {
  mkdirSync(path.dirname(filePath), { recursive: true });
}

export function getLegacyAgentPortalPath(cwd = process.cwd(), ...parts) {
  return path.join(path.resolve(cwd || process.cwd()), '.agent-portal', ...parts);
}
