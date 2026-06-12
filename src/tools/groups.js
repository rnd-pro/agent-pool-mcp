/**
 * Agent Groups — named config presets for fractal orchestration.
 * Groups bundle provider/model profiles, approval mode, policy, timeout, and max_agents
 * into a reusable team config.
 *
 * @module agent-pool/tools/groups
 */

import fs from 'node:fs';
import { ensureDirFor, getGlobalConfigPath, getLegacyAgentPortalPath } from '../runtime/paths.js';

const GROUPS_FILE = 'resource-groups.json';
const GROUPS_STATE_FILE = 'resource-group-states.json';

/**
 * Get path to group-states.json for a project.
 *
 * @param {string} cwd - Project directory
 * @returns {string}
 */
function getGroupsStatePath(cwd) {
  return getGlobalConfigPath(GROUPS_STATE_FILE);
}

/**
 * Load group states from disk.
 *
 * @param {string} cwd - Project directory
 * @returns {Object<string, object>}
 */
function loadGroupStates(cwd) {
  const filePath = getGroupsStatePath(cwd);
  if (!fs.existsSync(filePath)) return {};
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return {};
  }
}

/**
 * Save group states to disk.
 *
 * @param {string} cwd - Project directory
 * @param {Object<string, object>} states
 */
function saveGroupStates(cwd, states) {
  const filePath = getGroupsStatePath(cwd);
  ensureDirFor(filePath);
  fs.writeFileSync(filePath, JSON.stringify(states, null, 2));
}

/**
 * Get path to groups.json for a project.
 *
 * @param {string} cwd - Project directory
 * @returns {string}
 */
function getGroupsPath(cwd) {
  return getGlobalConfigPath(GROUPS_FILE);
}

function getLegacyGroupsPath(cwd) {
  return getLegacyAgentPortalPath(cwd, 'groups.json');
}

/**
 * Load all groups from disk.
 *
 * @param {string} cwd - Project directory
 * @returns {Object<string, object>}
 */
function loadGroups(cwd) {
  const filePath = getGroupsPath(cwd);
  const legacyPath = getLegacyGroupsPath(cwd);
  let sourcePath = fs.existsSync(filePath) ? filePath : legacyPath;
  if (!fs.existsSync(sourcePath)) return {};
  try {
    return JSON.parse(fs.readFileSync(sourcePath, 'utf-8'));
  } catch {
    return {};
  }
}

/**
 * Save groups to disk.
 *
 * @param {string} cwd - Project directory
 * @param {Object<string, object>} groups
 */
function saveGroups(cwd, groups) {
  const filePath = getGroupsPath(cwd);
  ensureDirFor(filePath);
  fs.writeFileSync(filePath, JSON.stringify(groups, null, 2));
}

/**
 * Create or update a group.
 *
 * @param {string} cwd - Project directory
 * @param {object} config - Group configuration
 * @param {string} config.name - Group name (e.g. "backend-team")
 * @param {string} [config.provider] - Default CLI provider for agents in this group
 * @param {string} [config.model] - Default model for agents in this group
 * @param {Array<{provider?: string, model?: string, reasoningEffort?: string}>} [config.profiles] - Provider/model profiles
 * @param {string} [config.runner] - Default runner for agents in this group
 * @param {string} [config.skill] - Default skill for agents in this group
 * @param {string} [config.policy] - Default policy for agents in this group
 * @param {string} [config.approval_mode] - Default approval mode for agents in this group
 * @param {number} [config.max_agents] - Max concurrent agents in this group
 * @param {number} [config.timeout] - Default timeout in seconds for agents in this group
 * @param {string[]} [config.include_dirs] - Additional directories agents can access
 * @param {string} [config.model_tier] - Logical model tier ('basic', 'advanced')
 * @param {string} [config.rotation_mode] - Rotation strategy ('error_fallback' or 'round_robin')
 * @returns {{ name: string, created: boolean }}
 */
export function createGroup(cwd, config) {
  const groups = loadGroups(cwd);
  const existed = !!groups[config.name];

  groups[config.name] = {
    provider: config.provider || 'codex',
    model: config.model || null,
    profiles: Array.isArray(config.profiles) ? config.profiles : [],
    runner: config.runner || null,
    skill: config.skill || null,
    policy: config.policy || null,
    approval_mode: config.approval_mode || config.approvalMode || null,
    max_agents: config.max_agents ?? null,
    timeout: config.timeout ?? null,
    include_dirs: config.include_dirs || null,
    model_tier: config.model_tier || null,
    rotation_mode: config.rotation_mode || 'error_fallback',
    created_at: existed ? groups[config.name].created_at : new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  saveGroups(cwd, groups);
  return { name: config.name, created: !existed };
}

/**
 * List all groups.
 *
 * @param {string} cwd - Project directory
 * @returns {Array<{ name: string, provider: string|null, model: string|null, profiles: Array<object>, runner: string|null, skill: string|null, policy: string|null, approval_mode: string|null, max_agents: number|null, timeout: number|null }>}
 */
export function listGroups(cwd) {
  const groups = loadGroups(cwd);
  return Object.entries(groups).map(([name, config]) => ({
    name,
    ...config,
  }));
}

/**
 * Get a single group by name.
 *
 * @param {string} cwd - Project directory
 * @param {string} name - Group name
 * @returns {object|null}
 */
export function getGroup(cwd, name) {
  const groups = loadGroups(cwd);
  return groups[name] || null;
}

/**
 * Delete a group.
 *
 * @param {string} cwd - Project directory
 * @param {string} name - Group name
 * @returns {boolean}
 */
export function deleteGroup(cwd, name) {
  const groups = loadGroups(cwd);
  if (!groups[name]) return false;
  delete groups[name];
  saveGroups(cwd, groups);
  return true;
}

/**
 * Resolve the active provider/model profile for a group.
 * Maintains state across calls if rotation_mode is 'round_robin'.
 *
 * @param {string} cwd - Project directory
 * @param {string} name - Group name
 * @param {object|null} [groupOverride] - Already-loaded group config
 * @returns {{ provider: string|null, model: string|null, profile: object|null }}
 */
export function getGroupNextProfile(cwd, name, groupOverride = null) {
  const group = groupOverride || getGroup(cwd, name);
  if (!group) return { provider: null, model: null, profile: null };

  const profiles = Array.isArray(group.profiles) ? group.profiles : [];

  if (profiles.length > 0) {
    let profile;
    if (group.rotation_mode === 'round_robin') {
      const states = loadGroupStates(cwd);
      if (!states[name]) {
        states[name] = { currentIndex: 0 };
      }
      const index = states[name].currentIndex % profiles.length;
      profile = profiles[index];
      states[name].currentIndex = (index + 1) % profiles.length;
      saveGroupStates(cwd, states);
    } else {
      profile = profiles[0];
    }

    return {
      provider: profile.provider || group.provider || 'codex',
      model: profile.model || group.model || null,
      profile,
    };
  }

  return {
    provider: group.provider || 'codex',
    model: group.model || null,
    profile: null,
  };
}
