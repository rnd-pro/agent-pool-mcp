/**
 * Skills management — list, create, delete Gemini CLI skills.
 *
 * @module agent-pool/tools/skills
 */

import path from 'node:path';
import fs from 'node:fs';

/**
 * Get the skills directory for a project.
 *
 * @param {string} cwd - Project root
 * @returns {string}
 */
function getSkillsDir(cwd) {
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
 * List available skills in a project.
 *
 * @param {string} cwd - Project root
 * @returns {Array<{fileName: string, name: string, description: string}>}
 */
export function listSkills(cwd) {
  const skillsDir = getSkillsDir(cwd);
  if (!fs.existsSync(skillsDir)) return [];

  const files = fs.readdirSync(skillsDir).filter((f) => f.endsWith('.md'));
  return files.map((fileName) => {
    const content = fs.readFileSync(path.join(skillsDir, fileName), 'utf-8');
    const { name, description } = parseFrontmatter(content);
    return {
      fileName,
      name: name || fileName.replace('.md', ''),
      description: description || '(no description)',
    };
  });
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
  const skillsDir = getSkillsDir(cwd);
  fs.mkdirSync(skillsDir, { recursive: true });

  const fileName = skillName.endsWith('.md') ? skillName : `${skillName}.md`;
  const filePath = path.join(skillsDir, fileName);

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
  const skillsDir = getSkillsDir(cwd);
  const fileName = skillName.endsWith('.md') ? skillName : `${skillName}.md`;
  const filePath = path.join(skillsDir, fileName);

  if (!fs.existsSync(filePath)) return false;
  fs.unlinkSync(filePath);
  return true;
}
