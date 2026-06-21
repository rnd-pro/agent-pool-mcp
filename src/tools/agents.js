/**
 * Agents management — core logic for parsing Agent entities and composing their context.
 * Follows NO FALLBACKS principle (HR8).
 *
 * @module agent-pool/tools/agents
 */

import fs from 'node:fs';
import { parseFrontmatter } from './markdown-parser.js';
import { findSkill } from './skills.js';
import { getTeamMemoryPath } from '../runtime/paths.js';

/**
 * Resolve atomic skills into the agent body.
 * Prepend frontmatter skills to the top, and replace inline {{skill:name}} tags.
 *
 * @param {string} cwd - Project root
 * @param {string[]} frontmatterSkills - Array of skill names to prepend
 * @param {string} body - Agent body content
 * @returns {string} Fully assembled agent body
 * @throws {Error} If any required skill is not found
 */
export function resolveSkills(cwd, frontmatterSkills, body) {
  let assembledBody = '';

  // 1. Resolve frontmatter skills (prepended)
  if (Array.isArray(frontmatterSkills)) {
    for (const skillName of frontmatterSkills) {
      const skill = findSkill(cwd, skillName);
      if (!skill) {
        throw new Error(`Required skill '${skillName}' not found across any tier`);
      }
      const { body: skillBody } = parseFrontmatter(skill.content);
      assembledBody += `${skillBody}\n\n`;
    }
  }

  // 2. Resolve inline skills in the body: {{skill:skillName}}
  const resolvedInlineBody = body.replace(/\{\{\s*skill\s*:\s*([^}]+)\s*\}\}/g, (match, skillName) => {
    const trimmedName = skillName.trim();
    const skill = findSkill(cwd, trimmedName);
    if (!skill) {
      throw new Error(`Required inline skill '${trimmedName}' not found across any tier`);
    }
    const { body: skillBody } = parseFrontmatter(skill.content);
    return skillBody;
  });

  assembledBody += resolvedInlineBody;

  return assembledBody.trim();
}

/**
 * Load an agent entity, parsing its configuration and resolving its skills.
 *
 * @param {string} cwd - Project root
 * @param {string} agentSlug - Agent slug (with or without .md)
 * @returns {Object} Agent configuration and assembled system prompt
 * @throws {Error} If agent is missing, invalid, or has missing critical configuration
 */
export function loadAgent(cwd, agentSlug) {
  const fileName = agentSlug.endsWith('.md') ? agentSlug : `${agentSlug}.md`;
  const agentPath = getTeamMemoryPath('agents', fileName);

  if (!agentPath || !fs.existsSync(agentPath)) {
    throw new Error(`Agent not found: ${agentSlug}`);
  }

  const content = fs.readFileSync(agentPath, 'utf-8');
  const { frontmatter, body } = parseFrontmatter(content);

  // Apply NO FALLBACKS principle for orchestration resources.
  // Agents point to a resource group; groups own concrete provider/model profiles.
  if (!frontmatter.resource_group && !frontmatter.resourceGroup && !frontmatter.group) {
    throw new Error(`Agent '${agentSlug}' is missing required field: 'resource_group'`);
  }
  const modelsArray = Array.isArray(frontmatter.models) ? frontmatter.models : [];

  // Build the configuration object
  const agentConfig = {
    slug: agentSlug.replace('.md', ''),
    name: frontmatter.name || agentSlug.replace('.md', ''),
    description: frontmatter.description || '',
    role: frontmatter.role || 'executor',
    resourceGroup: frontmatter.resource_group || frontmatter.resourceGroup || frontmatter.group,
    provider: frontmatter.provider,
    model: frontmatter.model,
    models: modelsArray.length > 0 ? modelsArray : undefined,
    icon: frontmatter.icon,
    color: frontmatter.color,
    visibleAgents: Array.isArray(frontmatter.visibleAgents) ? frontmatter.visibleAgents : [],
  };

  // Resolve skills and assemble the system prompt
  const skillsArray = Array.isArray(frontmatter.skills) ? frontmatter.skills : [];
  try {
    agentConfig.systemPrompt = resolveSkills(cwd, skillsArray, body);
  } catch (error) {
    throw new Error(`Failed to resolve skills for agent '${agentSlug}': ${error.message}`);
  }

  return agentConfig;
}
