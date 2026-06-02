/**
 * Skills management — team-global and active workspace skill system for CLI agents.
 *
 * Global skills live in `.agent-portal/skills/`.
 * Project skills live in `.agent-portal/workspace/<project>/skills/`.
 * Managed as markdown files with YAML frontmatter.
 *
 * @module agent-pool/tools/skills
 */

import path from 'node:path';
import fs from 'node:fs';
import { parseFrontmatter } from './markdown-parser.js';
import { getSkillDirs, getSingleActiveWorkspace, getWorkspaceSkillsDir } from './memory-layout.js';

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
 * Read skills from a directory recursively.
 *
 * @param {string} dir - Skills directory
 * @param {{tier: string, workspace: string|null}} source
 * @returns {Array<{fileName: string, name: string, description: string, category: string, tags: string[], appliesTo: object|null, tokenCost: string|null, autoload: boolean|null, tier: string, workspace: string|null, filePath: string}>}
 */
function readSkillsFromDir(dir, source) {
  if (!fs.existsSync(dir)) return [];

  const files = [];
  function scan(currentDir) {
    const isRoot = currentDir === dir;
    for (const f of fs.readdirSync(currentDir)) {
      if (f.startsWith('.')) continue;
      if (source.tier === 'global' && isRoot && f === 'workspace') continue;
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
      tags: Array.isArray(frontmatter.tags) ? frontmatter.tags : [],
      appliesTo: frontmatter.applies_to || frontmatter.appliesTo || null,
      tokenCost: frontmatter.token_cost || frontmatter.tokenCost || null,
      autoload: typeof frontmatter.autoload === 'boolean' ? frontmatter.autoload : null,
      tier: source.tier,
      workspace: source.workspace || null,
      filePath,
    };
  });
}

/**
 * List global skills and active workspace skills.
 * Sorted by category then name.
 *
 * @param {string} cwd - Project root
 * @param {{files?: string[]}} [options]
 * @returns {Array<{fileName: string, name: string, description: string, category: string, tags: string[], appliesTo: object|null, tokenCost: string|null, autoload: boolean|null, tier: string, workspace: string|null, filePath: string}>}
 */
export function listSkills(cwd, options = {}) {
  const arr = getSkillDirs(cwd, options.files || [])
    .flatMap(source => readSkillsFromDir(source.dir, source));
  arr.sort((a, b) => {
    if (a.category !== b.category) return a.category.localeCompare(b.category);
    if (a.tier !== b.tier) return a.tier.localeCompare(b.tier);
    return a.name.localeCompare(b.name);
  });
  return arr;
}

/**
 * Find a global or active workspace skill by name.
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
 * Return one skill with metadata and markdown body.
 *
 * @param {string} cwd - Project root
 * @param {string} skillName - Skill name (with or without .md)
 * @param {{files?: string[]}} [options]
 * @returns {{ name: string, description: string, category: string, tags: string[], tokenCost: string|null, autoload: boolean|null, tier: string, fileName: string, content: string } | null}
 */
export function getSkillContent(cwd, skillName, options = {}) {
  const targetName = skillName.endsWith('.md') ? skillName.replace('.md', '') : skillName;
  const all = listSkills(cwd, { files: options.files || [] });
  const match = all.find(s => s.name === targetName || s.fileName === skillName);
  if (!match) return null;

  return {
    name: match.name,
    description: match.description,
    category: match.category,
    tags: match.tags || [],
    tokenCost: match.tokenCost || null,
    autoload: match.autoload,
    tier: match.tier,
    fileName: match.fileName,
    content: fs.readFileSync(match.filePath, 'utf-8'),
  };
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
  const workspace = getSingleActiveWorkspace(cwd);
  const targetDir = getWorkspaceSkillsDir(cwd, workspace);
  fs.mkdirSync(targetDir, { recursive: true });

  const fileName = sanitizeSkillName(skillName.endsWith('.md') ? skillName : `${skillName}.md`);
  const filePath = path.join(targetDir, fileName);

  const content = [
    '---',
    `name: ${skillName.replace('.md', '')}`,
    `description: ${description}`,
    'category: workspace',
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
  const match = all.find(s => s.tier === 'workspace' && (s.name === targetName || s.fileName === skillName));
  
  if (match && fs.existsSync(match.filePath)) {
    fs.unlinkSync(match.filePath);
    return true;
  }
  return false;
}

/**
 * Provision a skill for a delegated task.
 * Checks that the skill exists in global or active workspace skills.
 *
 * @param {string} cwd - Project root
 * @param {string} skillName - Skill name
 * @returns {{name: string, provisioned: boolean, tier: string} | null}
 */
export function provisionSkill(cwd, skillName) {
  const targetName = skillName.endsWith('.md') ? skillName.replace('.md', '') : skillName;

  const match = listSkills(cwd).find(s => s.name === targetName || s.fileName === skillName);
  if (match) {
    return { name: match.name, provisioned: false, tier: match.tier };
  }

  return null;
}
