/**
 * Skills management — project-level skill system for CLI agents.
 *
 * Skills live in `.agent-portal/skills/` inside each project.
 * Managed as markdown files with YAML frontmatter.
 *
 * @module agent-pool/tools/skills
 */

import path from 'node:path';
import fs from 'node:fs';
import { parseFrontmatter } from './markdown-parser.js';

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
  return path.join(cwd, '.agent-portal', 'skills');
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
 * List skills from the project's .agent-portal/skills/ directory.
 * Sorted by category then name.
 *
 * @param {string} cwd - Project root
 * @returns {Array<{fileName: string, name: string, description: string, category: string, tier: string, filePath: string}>}
 */
export function listSkills(cwd) {
  const project = readSkillsFromDir(getProjectSkillsDir(cwd), 'project');
  const arr = [...project];
  arr.sort((a, b) => {
    if (a.category !== b.category) return a.category.localeCompare(b.category);
    return a.name.localeCompare(b.name);
  });
  return arr;
}

/**
 * Find a project skill by name.
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
 * @returns {string} Path to created file
 */
export function createSkill(cwd, skillName, description, instructions) {
  const targetDir = getProjectSkillsDir(cwd);
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
 * @returns {boolean} Whether the file was deleted
 */
export function deleteSkill(cwd, skillName) {
  const targetName = skillName.endsWith('.md') ? skillName.replace('.md', '') : skillName;
  const all = listSkills(cwd);
  const match = all.find(s => s.name === targetName || s.fileName === skillName);
  
  if (match && fs.existsSync(match.filePath)) {
    fs.unlinkSync(match.filePath);
    return true;
  }
  return false;
}

/**
 * Provision a skill for a delegated task.
 * Checks that the skill exists in .agent-portal/skills/.
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

  return null;
}
