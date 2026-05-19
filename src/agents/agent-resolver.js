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
import { join, basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseMarkdownFrontmatter } from '../tools/frontmatter.js';

const MODULE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

function getAgentRootCandidates(cwd) {
  const candidates = [
    process.env.AGENT_PORTAL_MEMORY_ROOT,
    process.env.AGENT_PORTAL_AGENTS_ROOT,
    cwd,
    process.cwd(),
    MODULE_ROOT,
  ].filter(Boolean).map(root => resolve(root));
  return [...new Set(candidates)];
}

function resolveAgentRoot(cwd, slug = null) {
  for (const root of getAgentRootCandidates(cwd)) {
    const agentsDir = join(root, '.agent-portal', 'agents');
    if (slug && existsSync(join(agentsDir, `${slug}.md`))) return root;
    if (!slug && existsSync(agentsDir)) return root;
  }
  return resolve(cwd || process.cwd());
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

function approvalModeFromMeta(meta) {
  const explicit = meta.approval_mode || meta.approvalMode || meta.access_mode || meta.accessMode;
  if (explicit) return explicit;
  if (meta.policy === 'read-only') return 'plan';
  if (meta.policy === 'admin') return 'yolo';
  if (meta.policy === 'read-write') return 'auto_edit';
  return null;
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
 * @returns {{ slug: string, description: string, role: string, resourceGroup: string|null, provider: string|null, model: string|null, models: string[], policy: string, approvalMode: string|null, contextTags: string[] } | null}
 */
export function resolveAgentMetadata(cwd, slug) {
  if (!slug) return null;

  const agentRoot = resolveAgentRoot(cwd, slug);
  const agentsDir = join(agentRoot, '.agent-portal', 'agents');
  const filePath = join(agentsDir, `${slug}.md`);

  if (!existsSync(filePath)) {
    console.error(`[agent-resolver] Agent '${slug}' not found in any .agent-portal/agents root for cwd=${cwd}`);
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
      policy: meta.policy || 'read-write',
      approvalMode: approvalModeFromMeta(meta),
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
 * Resolve an agent by slug from `.agent-portal/agents/{slug}.md`.
 * Returns the full agent definition with resolved skills prompt.
 * 
 * @param {string} cwd - Project root
 * @param {string} slug - Agent name (e.g. 'backend-engineer')
 * @returns {{ slug: string, prompt: string, resourceGroup: string, provider: string, model: string, models: string[], policy: string, timeout: number, icon: string, color: string, description: string, role: string } | null}
 */
export function resolveAgent(cwd, slug) {
  if (!slug) return null;

  const agentRoot = resolveAgentRoot(cwd, slug);
  const cacheKey = `${agentRoot}:${slug}`;
  const cached = _agentCache.get(cacheKey);
  if (cached && (Date.now() - cached.ts < AGENT_CACHE_TTL)) return cached.def;

  const agentsDir = join(agentRoot, '.agent-portal', 'agents');
  const skillsDir = join(agentRoot, '.agent-portal', 'skills');
  const filePath = join(agentsDir, `${slug}.md`);

  if (!existsSync(filePath)) {
    console.error(`[agent-resolver] Agent '${slug}' not found in any .agent-portal/agents root for cwd=${cwd}`);
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
      rotation: meta.rotation || 'on_error',
      skills: skillNames,
      policy: meta.policy || 'read-write',
      approvalMode: approvalModeFromMeta(meta),
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
  const agentRoot = resolveAgentRoot(cwd);
  const agentsDir = join(agentRoot, '.agent-portal', 'agents');
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
