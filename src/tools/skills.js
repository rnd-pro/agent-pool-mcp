/**
 * Skills management — 3-tier skill system for Gemini CLI agents.
 *
 * Tiers (lookup order):
 *   1. Project:     {cwd}/.gemini/skills/
 *   2. User Global: ~/.gemini/skills/
 *   3. Built-in:    {server}/skills/   (read-only, shipped with agent-pool)
 *
 * @module agent-pool/tools/skills
 */

import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { parseFrontmatter } from './markdown-parser.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Built-in skills directory (read-only, ships with MCP server) */
const BUILTIN_SKILLS_DIR = path.resolve(__dirname, '..', '..', 'skills');

/** User-global skills directory */
const USER_GLOBAL_SKILLS_DIR = path.join(os.homedir(), '.agent-portal', 'skills');

/**
 * Sanitize skill name to prevent path traversal.
 * Rejects names containing path separators or traversal sequences.
 *
 * @param {string} name - Raw skill name
 * @returns {string} Sanitized name
 * @throws {Error} If name contains path traversal or is invalid
 */
function sanitizeSkillName(name) {
  if (!name || name.includes('/') || name.includes('\\') || name.includes('..')) {
    throw new Error(`Invalid skill name: '${name}' (must not contain path separators or '..')`);
  }
  const sanitized = path.basename(name);
  if (!sanitized || sanitized === '.' || sanitized === '..') {
    throw new Error(`Invalid skill name: '${name}'`);
  }
  return sanitized;
}

/**
 * Get the project-level skills directory.
 *
 * @param {string} cwd - Project root
 * @returns {string}
 */
function getProjectSkillsDir(cwd) {
  return path.join(cwd, '.agents', 'skills');
}


/**
 * Read skills from a directory recursively.
 *
 * @param {string} dir - Skills directory
 * @param {string} tier - Tier label: 'project', 'global', 'built-in'
 * @returns {Array<{fileName: string, name: string, description: string, category: string, tier: string, filePath: string}>}
 */
function readSkillsFromDir(dir, tier) {
  if (!fs.existsSync(dir)) return [];

  const files = [];
  function scan(currentDir) {
    for (const f of fs.readdirSync(currentDir)) {
      if (f.startsWith('.')) continue;
      const fullPath = path.join(currentDir, f);
      if (fs.statSync(fullPath).isDirectory()) {
        scan(fullPath);
      } else if (f.endsWith('.md')) {
        files.push(fullPath);
      }
    }
  }
  scan(dir);

  return files.map((filePath) => {
    const content = fs.readFileSync(filePath, 'utf-8');
    const { frontmatter } = parseFrontmatter(content);
    const fileName = path.basename(filePath);
    
    const relativePath = path.relative(dir, filePath);
    const dirName = path.dirname(relativePath);
    const fallbackCategory = dirName === '.' ? 'uncategorized' : dirName.split(path.sep)[0];
    
    return {
      fileName,
      name: frontmatter.name || fileName.replace('.md', ''),
      description: frontmatter.description || '(no description)',
      category: frontmatter.category || frontmatter.group || fallbackCategory,
      tier,
      filePath,
    };
  });
}

/**
 * List skills from all 3 tiers. Project overrides global, global overrides built-in.
 * Sorted by category then name.
 *
 * @param {string} cwd - Project root
 * @returns {Array<{fileName: string, name: string, description: string, category: string, tier: string, filePath: string}>}
 */
export function listSkills(cwd) {
  const builtIn = readSkillsFromDir(BUILTIN_SKILLS_DIR, 'built-in');
  const userGlobal = readSkillsFromDir(USER_GLOBAL_SKILLS_DIR, 'global');
  const project = readSkillsFromDir(getProjectSkillsDir(cwd), 'project');

  // Merge: project overrides global overrides built-in (by name)
  const merged = new Map();
  for (const skill of builtIn) merged.set(skill.name, skill);
  for (const skill of userGlobal) merged.set(skill.name, skill);
  for (const skill of project) merged.set(skill.name, skill);

  const arr = [...merged.values()];
  arr.sort((a, b) => {
    if (a.category !== b.category) return a.category.localeCompare(b.category);
    return a.name.localeCompare(b.name);
  });
  return arr;
}

/**
 * Find a skill by name across all tiers. Lookup: project → global → built-in.
 *
 * @param {string} cwd - Project root
 * @param {string} skillName - Skill name (with or without .md)
 * @returns {{filePath: string, content: string, tier: string} | null}
 */
export function findSkill(cwd, skillName) {
  const targetName = skillName.endsWith('.md') ? skillName.replace('.md', '') : skillName;
  const all = listSkills(cwd);
  const match = all.find(s => s.name === targetName || s.fileName === skillName);
  
  if (match) {
    return {
      filePath: match.filePath,
      content: fs.readFileSync(match.filePath, 'utf-8'),
      tier: match.tier,
    };
  }
  return null;
}

/**
 * Create or update a skill file.
 *
 * @param {string} cwd - Project root
 * @param {string} skillName - Skill file name (without .md)
 * @param {string} description - Short description
 * @param {string} instructions - Markdown instructions body
 * @param {string} [scope='project'] - 'project' or 'global'
 * @returns {string} Path to created file
 */
export function createSkill(cwd, skillName, description, instructions, scope = 'project') {
  const targetDir = scope === 'global' ? USER_GLOBAL_SKILLS_DIR : getProjectSkillsDir(cwd);
  fs.mkdirSync(targetDir, { recursive: true });

  const fileName = sanitizeSkillName(skillName.endsWith('.md') ? skillName : `${skillName}.md`);
  const filePath = path.join(targetDir, fileName);

  const content = [
    '---',
    `name: ${skillName.replace('.md', '')}`,
    `description: ${description}`,
    '---',
    '',
    instructions,
    '',
  ].join('\n');

  fs.writeFileSync(filePath, content, 'utf-8');
  return filePath;
}

/**
 * Delete a skill file.
 *
 * @param {string} cwd - Project root
 * @param {string} skillName - Skill name (with or without .md)
 * @param {string} [scope='project'] - 'project' or 'global'
 * @returns {boolean} Whether the file was deleted
 */
export function deleteSkill(cwd, skillName, scope = 'project') {
  const targetName = skillName.endsWith('.md') ? skillName.replace('.md', '') : skillName;
  const all = listSkills(cwd);
  const match = all.find(s => s.tier === scope && (s.name === targetName || s.fileName === skillName));
  
  if (match && fs.existsSync(match.filePath)) {
    fs.unlinkSync(match.filePath);
    return true;
  }
  return false;
}

/**
 * Install a skill into a project by copying from global or built-in tier.
 * Adds an origin comment to the frontmatter.
 *
 * @param {string} cwd - Project root
 * @param {string} skillName - Skill name to install
 * @returns {{installed: boolean, from: string, to: string, tier: string} | null}
 */
export function installSkill(cwd, skillName) {
  const targetName = skillName.endsWith('.md') ? skillName.replace('.md', '') : skillName;
  
  const builtIn = readSkillsFromDir(BUILTIN_SKILLS_DIR, 'built-in');
  const userGlobal = readSkillsFromDir(USER_GLOBAL_SKILLS_DIR, 'global');
  const available = [...userGlobal, ...builtIn];
  
  const match = available.find(s => s.name === targetName || s.fileName === skillName);
  if (match && fs.existsSync(match.filePath)) {
    const projectDir = getProjectSkillsDir(cwd);
    fs.mkdirSync(projectDir, { recursive: true });
    
    const destPath = path.join(projectDir, match.fileName);
    let content = fs.readFileSync(match.filePath, 'utf-8');
    
    const date = new Date().toISOString().split('T')[0];
    const originComment = `<!-- Installed from ${match.tier}: ${match.filePath} on ${date} -->`;
    content = content.replace(/^(---\n[\s\S]*?\n---\n)/, `$1\n${originComment}\n`);
    
    fs.writeFileSync(destPath, content, 'utf-8');
    return { installed: true, from: match.filePath, to: destPath, tier: match.tier };
  }
  return null;
}

/**
 * Provision a skill for a delegated task.
 * Copies the skill from global/built-in into the project's .gemini/skills/
 * so Gemini CLI can activate it natively via activate_skill tool.
 *
 * If the skill is already in the project tier, does nothing.
 *
 * @param {string} cwd - Project root
 * @param {string} skillName - Skill name
 * @returns {{name: string, provisioned: boolean, tier: string} | null}
 */
export function provisionSkill(cwd, skillName) {
  const targetName = skillName.endsWith('.md') ? skillName.replace('.md', '') : skillName;
  
  const project = readSkillsFromDir(getProjectSkillsDir(cwd), 'project');
  const projectMatch = project.find(s => s.name === targetName || s.fileName === skillName);
  if (projectMatch) {
    return { name: projectMatch.name, provisioned: false, tier: 'project' };
  }

  const builtIn = readSkillsFromDir(BUILTIN_SKILLS_DIR, 'built-in');
  const userGlobal = readSkillsFromDir(USER_GLOBAL_SKILLS_DIR, 'global');
  const available = [...userGlobal, ...builtIn];
  const match = available.find(s => s.name === targetName || s.fileName === skillName);
  
  if (match && fs.existsSync(match.filePath)) {
    const projectDir = getProjectSkillsDir(cwd);
    fs.mkdirSync(projectDir, { recursive: true });
    const destPath = path.join(projectDir, match.fileName);
    fs.copyFileSync(match.filePath, destPath);
    return { name: match.name, provisioned: true, tier: match.tier };
  }

  return null;
}
