/**
 * Agent Groups — named config presets for fractal orchestration.
 * Groups bundle runner, skill, policy, and max_agents into a reusable team config.
 *
 * @module agent-pool/tools/groups
 */

import fs from 'node:fs';
import path from 'node:path';

const GROUPS_DIR = '.agents';
const GROUPS_FILE = 'groups.json';

/**
 * Get path to groups.json for a project.
 *
 * @param {string} cwd - Project directory
 * @returns {string}
 */
function getGroupsPath(cwd) {
  return path.join(cwd, GROUPS_DIR, GROUPS_FILE);
}

/**
 * Load all groups from disk.
 *
 * @param {string} cwd - Project directory
 * @returns {Object<string, object>}
 */
function loadGroups(cwd) {
  const filePath = getGroupsPath(cwd);
  if (!fs.existsSync(filePath)) return {};
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
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
  const dirPath = path.join(cwd, GROUPS_DIR);
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
  fs.writeFileSync(getGroupsPath(cwd), JSON.stringify(groups, null, 2));
}

/**
 * Create or update a group.
 *
 * @param {string} cwd - Project directory
 * @param {object} config - Group configuration
 * @param {string} config.name - Group name (e.g. "backend-team")
 * @param {string} [config.runner] - Default runner for agents in this group
 * @param {string} [config.skill] - Default skill for agents in this group
 * @param {string} [config.policy] - Default policy for agents in this group
 * @param {number} [config.max_agents] - Max concurrent agents in this group
 * @param {string[]} [config.include_dirs] - Additional directories agents can access
 * @returns {{ name: string, created: boolean }}
 */
export function createGroup(cwd, config) {
  const groups = loadGroups(cwd);
  const existed = !!groups[config.name];

  groups[config.name] = {
    runner: config.runner || null,
    skill: config.skill || null,
    policy: config.policy || null,
    max_agents: config.max_agents || null,
    include_dirs: config.include_dirs || null,
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
 * @returns {Array<{ name: string, runner: string|null, skill: string|null, policy: string|null, max_agents: number|null }>}
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
