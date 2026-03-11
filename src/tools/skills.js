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

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Built-in skills directory (read-only, ships with MCP server) */
const BUILTIN_SKILLS_DIR = path.resolve(__dirname, '..', '..', 'skills');

/** User-global skills directory */
const USER_GLOBAL_SKILLS_DIR = path.join(os.homedir(), '.gemini', 'skills');

/**
 * Get the project-level skills directory.
 *
 * @param {string} cwd - Project root
 * @returns {string}
 */
function getProjectSkillsDir(cwd) {
  return path.join(cwd, '.gemini', 'skills');
}

/**
 * Parse YAML frontmatter from markdown content.
 *
 * @param {string} content - Markdown file content
 * @returns {{name: string, description: string, body: string}}
 */
function parseFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return { name: '', description: '', body: content };

  const frontmatter = match[1];
  const body = match[2].trim();
  const result = { name: '', description: '', body };

  for (const line of frontmatter.split('\n')) {
    const [key, ...valueParts] = line.split(':');
    const value = valueParts.join(':').trim();
    if (key.trim() === 'name') result.name = value;
    if (key.trim() === 'description') result.description = value;
  }

  return result;
}

/**
 * Read skills from a directory.
 *
 * @param {string} dir - Skills directory
 * @param {string} tier - Tier label: 'project', 'global', 'built-in'
 * @returns {Array<{fileName: string, name: string, description: string, tier: string, filePath: string}>}
 */
function readSkillsFromDir(dir, tier) {
  if (!fs.existsSync(dir)) return [];

  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.md'));
  return files.map((fileName) => {
    const filePath = path.join(dir, fileName);
    const content = fs.readFileSync(filePath, 'utf-8');
    const { name, description } = parseFrontmatter(content);
    return {
      fileName,
      name: name || fileName.replace('.md', ''),
      description: description || '(no description)',
      tier,
      filePath,
    };
  });
}

/**
 * List skills from all 3 tiers. Project overrides global, global overrides built-in.
 *
 * @param {string} cwd - Project root
 * @returns {Array<{fileName: string, name: string, description: string, tier: string, filePath: string}>}
 */
export function listSkills(cwd) {
  const builtIn = readSkillsFromDir(BUILTIN_SKILLS_DIR, 'built-in');
  const userGlobal = readSkillsFromDir(USER_GLOBAL_SKILLS_DIR, 'global');
  const project = readSkillsFromDir(getProjectSkillsDir(cwd), 'project');

  // Merge: project overrides global overrides built-in (by fileName)
  const merged = new Map();
  for (const skill of builtIn) merged.set(skill.fileName, skill);
  for (const skill of userGlobal) merged.set(skill.fileName, skill);
  for (const skill of project) merged.set(skill.fileName, skill);

  return [...merged.values()];
}

/**
 * Find a skill by name across all tiers. Lookup: project → global → built-in.
 *
 * @param {string} cwd - Project root
 * @param {string} skillName - Skill name (with or without .md)
 * @returns {{filePath: string, content: string, tier: string} | null}
 */
export function findSkill(cwd, skillName) {
  const fileName = skillName.endsWith('.md') ? skillName : `${skillName}.md`;

  const dirs = [
    { dir: getProjectSkillsDir(cwd), tier: 'project' },
    { dir: USER_GLOBAL_SKILLS_DIR, tier: 'global' },
    { dir: BUILTIN_SKILLS_DIR, tier: 'built-in' },
  ];

  for (const { dir, tier } of dirs) {
    const filePath = path.join(dir, fileName);
    if (fs.existsSync(filePath)) {
      return {
        filePath,
        content: fs.readFileSync(filePath, 'utf-8'),
        tier,
      };
    }
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

  const fileName = skillName.endsWith('.md') ? skillName : `${skillName}.md`;
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
  const targetDir = scope === 'global' ? USER_GLOBAL_SKILLS_DIR : getProjectSkillsDir(cwd);
  const fileName = skillName.endsWith('.md') ? skillName : `${skillName}.md`;
  const filePath = path.join(targetDir, fileName);

  if (!fs.existsSync(filePath)) return false;
  fs.unlinkSync(filePath);
  return true;
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
  const fileName = skillName.endsWith('.md') ? skillName : `${skillName}.md`;

  // Only search global and built-in (not project — that's where we're installing to)
  const dirs = [
    { dir: USER_GLOBAL_SKILLS_DIR, tier: 'global' },
    { dir: BUILTIN_SKILLS_DIR, tier: 'built-in' },
  ];

  for (const { dir, tier } of dirs) {
    const sourcePath = path.join(dir, fileName);
    if (fs.existsSync(sourcePath)) {
      const projectDir = getProjectSkillsDir(cwd);
      fs.mkdirSync(projectDir, { recursive: true });

      const destPath = path.join(projectDir, fileName);
      let content = fs.readFileSync(sourcePath, 'utf-8');

      // Add origin comment after frontmatter
      const date = new Date().toISOString().split('T')[0];
      const originComment = `<!-- Installed from ${tier}: ${sourcePath} on ${date} -->`;
      content = content.replace(/^(---\n[\s\S]*?\n---\n)/, `$1\n${originComment}\n`);

      fs.writeFileSync(destPath, content, 'utf-8');
      return { installed: true, from: sourcePath, to: destPath, tier };
    }
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
  const fileName = skillName.endsWith('.md') ? skillName : `${skillName}.md`;
  const canonicalName = skillName.replace('.md', '');

  // Check if already in project
  const projectPath = path.join(getProjectSkillsDir(cwd), fileName);
  if (fs.existsSync(projectPath)) {
    return { name: canonicalName, provisioned: false, tier: 'project' };
  }

  // Search global and built-in
  const dirs = [
    { dir: USER_GLOBAL_SKILLS_DIR, tier: 'global' },
    { dir: BUILTIN_SKILLS_DIR, tier: 'built-in' },
  ];

  for (const { dir, tier } of dirs) {
    const sourcePath = path.join(dir, fileName);
    if (fs.existsSync(sourcePath)) {
      const projectDir = getProjectSkillsDir(cwd);
      fs.mkdirSync(projectDir, { recursive: true });

      // Copy to project for native Gemini CLI discovery
      fs.copyFileSync(sourcePath, projectPath);
      return { name: canonicalName, provisioned: true, tier };
    }
  }

  return null;
}
