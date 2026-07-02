/**
 * Agent Resolver — lightweight agent entity parser for agent-pool.
 * 
 * Reads `agents/*.md` files with YAML frontmatter from the team-memory content root, resolves skill
 * composition from the configured global skills root, and returns ready-to-use agent definitions.
 * 
 * Zero external dependencies. Mirrors portal's agent-parser.js logic.
 * 
 * @module agent-pool/agents/agent-resolver
 */

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import { parseMarkdownFrontmatter } from '../tools/frontmatter.js';
import { getSkillsRoot, getTeamMemoryRoot } from '../runtime/paths.js';

// Resolve the agents + skills content directories from configured roots. Agents still live under the
// team-memory content root; global skills can be pointed at a dedicated skills root through config.
// There is intentionally NO per-project `.agent-portal/{agents,skills}` fallback.
function resolveContentDirs() {
  const memRoot = getTeamMemoryRoot();
  const skillsRoot = getSkillsRoot();
  if (!memRoot) return { agentsDir: null, skillsDir: null };
  return { agentsDir: join(memRoot, 'agents'), skillsDir: skillsRoot };
}

// ─── Frontmatter Parser ────────────────────────────────────

/**
 * Parse YAML-like frontmatter from markdown.
 * @param {string} raw - full file content
 * @returns {{ meta: object, body: string }}
 */
function parseFrontmatter(raw) {
  let parsed = parseMarkdownFrontmatter(raw);
  return parsed ? { meta: parsed.meta, body: parsed.body } : { meta: {}, body: raw.trim() };
}

// ─── Skill Resolution ───────────────────────────────────────

/** @type {Map<string, string>|null} */
let _skillCache = null;
let _skillCacheDir = null;
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
  if (_skillCache && _skillCacheDir === skillsDir && (now - _skillCacheTime < SKILL_CACHE_TTL)) return _skillCache;

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
  _skillCacheDir = skillsDir;
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
    if (!content) throw new Error(`Required skill '${name}' not found`);
    parts.push(content);
  }

  let resolvedBody = body.replace(/\{\{skill:([\w][\w-]*)\}\}/g, (_, name) => {
    let content = map.get(name);
    if (!content) throw new Error(`Required inline skill '${name}' not found`);
    return content;
  });

  parts.push(resolvedBody);
  return parts.join('\n\n---\n\n');
}

function arrayFromMeta(value) {
  return Array.isArray(value) ? value : [];
}

/**
 * Resolve only agent routing/access metadata without assembling its prompt.
 *
 * Dynamic context planning must not load fixed agent instructions or frontmatter
 * skills. Those belong to the static agent layer and are assembled only when the
 * concrete agent is actually launched.
 *
 * @param {string} cwd - Project root
 * @param {string} slug - Agent name (e.g. 'backend-engineer')
 * @returns {{ slug: string, description: string, role: string, resourceGroup: string|null, provider: string|null, model: string|null, models: string[], contextTags: string[] } | null}
 */
export function resolveAgentMetadata(cwd, slug) {
  if (!slug) return null;

  const { agentsDir } = resolveContentDirs();
  if (!agentsDir) {
    console.error(`[agent-resolver] Team memory not configured; cannot resolve agent '${slug}'.`);
    return null;
  }
  const filePath = join(agentsDir, `${slug}.md`);

  if (!existsSync(filePath)) {
    console.error(`[agent-resolver] Agent '${slug}' not found (looked in ${agentsDir}).`);
    return null;
  }

  try {
    const raw = readFileSync(filePath, 'utf8');
    const { meta } = parseFrontmatter(raw);
    return {
      slug: meta.name || slug,
      description: meta.description || '',
      role: meta.role || 'executor',
      resourceGroup: meta.resource_group || meta.resourceGroup || meta.group || null,
      provider: meta.provider || null,
      model: meta.model || null,
      models: arrayFromMeta(meta.models),
      contextTags: arrayFromMeta(meta.context_tags || meta.contextTags),
    };
  } catch (err) {
    console.error(`[agent-resolver] Failed to parse agent metadata '${slug}':`, err.message);
    return null;
  }
}

// ─── Agent Resolution ───────────────────────────────────────

/** @type {Map<string, { def: object, ts: number }>} */
const _agentCache = new Map();
const AGENT_CACHE_TTL = 5000;

/**
 * Resolve an agent by slug from the team-memory `agents/{slug}.md`.
 * Returns the full agent definition with resolved skills prompt.
 * 
 * @param {string} cwd - Project root
 * @param {string} slug - Agent name (e.g. 'backend-engineer')
 * @returns {{ slug: string, prompt: string, resourceGroup: string|null, provider: string|null, model: string|null, models: string[], icon: string, color: string, description: string, role: string, skills: string[] } | null}
 */
export function resolveAgent(cwd, slug) {
  if (!slug) return null;

  const { agentsDir, skillsDir } = resolveContentDirs();
  if (!agentsDir) {
    console.error(`[agent-resolver] Team memory not configured; cannot resolve agent '${slug}'.`);
    return null;
  }
  const cacheKey = `${agentsDir}:${slug}`;
  const cached = _agentCache.get(cacheKey);
  if (cached && (Date.now() - cached.ts < AGENT_CACHE_TTL)) return cached.def;

  const filePath = join(agentsDir, `${slug}.md`);

  if (!existsSync(filePath)) {
    console.error(`[agent-resolver] Agent '${slug}' not found (looked in ${agentsDir}).`);
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
      models: arrayFromMeta(meta.models),
      skills: skillNames,
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
  const { agentsDir } = resolveContentDirs();
  if (!agentsDir || !existsSync(agentsDir)) return [];

  try {
    return readdirSync(agentsDir)
      .filter(f => f.endsWith('.md'))
      .map(f => basename(f, '.md'));
  } catch {
    return [];
  }
}

/**
 * Build a catalog summary of available agents for injection into an agent prompt.
 * @param {string} cwd - Project root
 * @param {{ excludeSlug?: string }} [options]
 * @returns {string} Formatted agent catalog
 */
export function buildAgentCatalog(cwd, options = {}) {
  const slugs = listAgentSlugs(cwd);
  if (slugs.length === 0) return '';

  const lines = [];
  const excludeSlug = options.excludeSlug || null;
  for (const slug of slugs) {
    if (slug === excludeSlug) continue;
    const def = resolveAgent(cwd, slug);
    if (def) {
      const groupInfo = def.resourceGroup ? `, group: ${def.resourceGroup}` : '';
      lines.push(`- **${slug}** (${def.role}${groupInfo}): ${def.description}`);
    }
  }

  if (!lines.length) return '';
  return `[Available Agents]\n${lines.join('\n')}`;
}
