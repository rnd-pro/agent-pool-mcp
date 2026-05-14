/**
 * Agent Resolver — lightweight agent entity parser for agent-pool.
 * 
 * Reads `.agent-portal/agents/*.md` files with YAML frontmatter, resolves skill composition
 * from `.agent-portal/skills/`, and returns ready-to-use agent definitions.
 * 
 * Zero external dependencies. Mirrors portal's agent-parser.js logic.
 * 
 * @module agent-pool/agents/agent-resolver
 */

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';

// ─── Frontmatter Parser ────────────────────────────────────

/**
 * Parse YAML-like frontmatter from markdown.
 * @param {string} raw - full file content
 * @returns {{ meta: object, body: string }}
 */
function parseFrontmatter(raw) {
  let match = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return { meta: {}, body: raw.trim() };

  let yamlBlock = match[1];
  let body = match[2].trim();
  let meta = {};
  let currentKey = null;
  let isArray = false;

  for (let line of yamlBlock.split('\n')) {
    let trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    if (trimmed.startsWith('- ') && currentKey && isArray) {
      meta[currentKey].push(trimmed.slice(2).trim());
      continue;
    }

    let kvMatch = trimmed.match(/^(\w+):\s*(.*)$/);
    if (kvMatch) {
      let key = kvMatch[1];
      let val = kvMatch[2].trim();

      if (val === '') {
        meta[key] = [];
        currentKey = key;
        isArray = true;
      } else if (val.startsWith('[') && val.endsWith(']')) {
        meta[key] = val.slice(1, -1).split(',').map(s => s.trim()).filter(Boolean);
        currentKey = key;
        isArray = false;
      } else {
        if (val === 'true') val = true;
        else if (val === 'false') val = false;
        else if (/^\d+$/.test(val)) val = parseInt(val, 10);
        else if (/^\d+\.\d+$/.test(val)) val = parseFloat(val);
        else if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1);
        }
        meta[key] = val;
        currentKey = key;
        isArray = false;
      }
    }
  }

  return { meta, body };
}

// ─── Skill Resolution ───────────────────────────────────────

/** @type {Map<string, string>|null} */
let _skillCache = null;
let _skillCacheTime = 0;
const SKILL_CACHE_TTL = 5000;

/**
 * Build a map of skill names → raw file content.
 * Recursively scans the skills directory.
 * @param {string} skillsDir
 * @returns {Map<string, string>}
 */
function getSkillMap(skillsDir) {
  const now = Date.now();
  if (_skillCache && (now - _skillCacheTime < SKILL_CACHE_TTL)) return _skillCache;

  let map = new Map();
  if (!existsSync(skillsDir)) return map;

  function scan(dir) {
    for (const f of readdirSync(dir)) {
      if (f.startsWith('.')) continue;
      const fullPath = join(dir, f);
      if (statSync(fullPath).isDirectory()) {
        scan(fullPath);
      } else if (f.endsWith('.md')) {
        const raw = readFileSync(fullPath, 'utf8');
        const { meta } = parseFrontmatter(raw);
        const name = meta.name || basename(f, '.md');
        map.set(name, raw.trim());
      }
    }
  }

  scan(skillsDir);
  _skillCache = map;
  _skillCacheTime = now;
  return map;
}

/**
 * Resolve skills: prepend frontmatter skills + inline {{skill:name}} references.
 * @param {string} body
 * @param {string[]} skillNames
 * @param {string} skillsDir
 * @returns {string}
 */
function resolveSkills(body, skillNames, skillsDir) {
  let parts = [];
  const map = getSkillMap(skillsDir);

  for (let name of skillNames) {
    let content = map.get(name);
    if (content) parts.push(content);
  }

  let resolvedBody = body.replace(/\{\{skill:([\w][\w-]*)\}\}/g, (_, name) => {
    let content = map.get(name);
    return content || `<!-- skill "${name}" not found -->`;
  });

  parts.push(resolvedBody);
  return parts.join('\n\n---\n\n');
}

// ─── Agent Resolution ───────────────────────────────────────

/** @type {Map<string, { def: object, ts: number }>} */
const _agentCache = new Map();
const AGENT_CACHE_TTL = 5000;

/**
 * Resolve an agent by slug from `.agent-portal/agents/{slug}.md`.
 * Returns the full agent definition with resolved skills prompt.
 * 
 * @param {string} cwd - Project root
 * @param {string} slug - Agent name (e.g. 'backend-engineer')
 * @returns {{ slug: string, prompt: string, resourceGroup: string, provider: string, model: string, models: string[], policy: string, timeout: number, icon: string, color: string, description: string, role: string } | null}
 */
export function resolveAgent(cwd, slug) {
  if (!slug) return null;

  const cacheKey = `${cwd}:${slug}`;
  const cached = _agentCache.get(cacheKey);
  if (cached && (Date.now() - cached.ts < AGENT_CACHE_TTL)) return cached.def;

  const agentsDir = join(cwd, '.agent-portal', 'agents');
  const skillsDir = join(cwd, '.agent-portal', 'skills');
  const filePath = join(agentsDir, `${slug}.md`);

  if (!existsSync(filePath)) {
    console.error(`[agent-resolver] Agent file not found: ${filePath}`);
    return null;
  }

  try {
    const raw = readFileSync(filePath, 'utf8');
    const { meta, body } = parseFrontmatter(raw);

    const skillNames = Array.isArray(meta.skills) ? meta.skills : [];
    const prompt = resolveSkills(body, skillNames, skillsDir);

    const def = {
      slug: meta.name || slug,
      description: meta.description || '',
      role: meta.role || 'executor',
      icon: meta.icon || 'smart_toy',
      color: meta.color || '#666',
      resourceGroup: meta.resource_group || meta.resourceGroup || meta.group || null,
      provider: meta.provider || null,
      model: meta.model || null,
      models: Array.isArray(meta.models) ? meta.models : [],
      rotation: meta.rotation || 'on_error',
      skills: skillNames,
      policy: meta.policy || 'read-write',
      timeout: meta.timeout || 600,
      prompt,
    };

    _agentCache.set(cacheKey, { def, ts: Date.now() });
    return def;
  } catch (err) {
    console.error(`[agent-resolver] Failed to parse agent '${slug}':`, err.message);
    return null;
  }
}

/**
 * List all available agent slugs in a project.
 * @param {string} cwd - Project root
 * @returns {string[]}
 */
export function listAgentSlugs(cwd) {
  const agentsDir = join(cwd, '.agent-portal', 'agents');
  if (!existsSync(agentsDir)) return [];

  try {
    return readdirSync(agentsDir)
      .filter(f => f.endsWith('.md'))
      .map(f => basename(f, '.md'));
  } catch {
    return [];
  }
}

/**
 * Build a catalog summary of available agents for injection into orchestrator prompt.
 * @param {string} cwd - Project root
 * @returns {string} Formatted agent catalog
 */
export function buildAgentCatalog(cwd) {
  const slugs = listAgentSlugs(cwd);
  if (slugs.length === 0) return '';

  const lines = [];
  for (const slug of slugs) {
    const def = resolveAgent(cwd, slug);
    if (def) {
      const groupInfo = def.resourceGroup ? `, group: ${def.resourceGroup}` : '';
      lines.push(`- **${slug}** (${def.role}${groupInfo}): ${def.description}`);
    }
  }

  return `[Available Agents]\n${lines.join('\n')}`;
}
