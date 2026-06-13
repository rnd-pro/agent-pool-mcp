import path from 'node:path';
import { listSkills } from './skills.js';
import { getWorkflowDirs, resolveActiveContexts as resolveMemoryContexts } from './memory-layout.js';
import { buildTagIndexForDirs } from './workflow-index.js';
import { resolveAgentMetadata } from '../agents/agent-resolver.js';

const ZONES = {
  ui: {
    tags: ['ui', 'frontend', 'browser', 'symbiote', 'component', 'design-system'],
    paths: [/^web\//, /^src\/client\//, /\.tpl\.js$/, /\.css\.js$/],
    keywords: ['ui', 'frontend', 'browser', 'component', 'symbiote', 'layout', 'screen', 'button', 'селект', 'браузер', 'интерфейс'],
    toolProfile: 'implementation',
  },
  server: {
    tags: ['server', 'backend', 'api', 'node'],
    paths: [/^src\/node\/server\//, /^src\/node\/proxy\//],
    keywords: ['server', 'backend', 'api', 'route', 'websocket', 'ws', 'endpoint', 'сервер', 'бэкенд'],
    toolProfile: 'implementation',
  },
  database: {
    tags: ['database', 'db', 'postgres', 'sql', 'storage'],
    paths: [/db/i, /database/i, /postgres/i, /migration/i],
    keywords: ['database', 'postgres', 'sql', 'migration', 'db', 'база', 'данные'],
    toolProfile: 'implementation',
  },
  mcp: {
    tags: ['mcp', 'tools', 'tooling'],
    paths: [/mcp/i, /tool-definitions\.js$/, /tools\//],
    keywords: ['mcp', 'tool', 'tools/list', 'delegate_task', 'инструмент', 'эм си пи'],
    toolProfile: 'orchestrator',
  },
  runner: {
    tags: ['runner', 'cli', 'agent-runtime'],
    paths: [/runner\//, /scheduler\//, /daemon\.js$/],
    keywords: ['runner', 'claude code', 'codex', 'antigravity', 'opencode', 'cli', 'spawn', 'scheduler'],
    toolProfile: 'implementation',
  },
  gateway: {
    tags: ['gateway', 'anthropic', 'provider', 'deepseek', 'proxy'],
    paths: [/anthropic-gateway\.js$/, /provider-config\.js$/, /gateway/i],
    keywords: ['gateway', 'anthropic', 'deepseek', 'provider', 'proxy', 'гейтвей', 'дипсик'],
    toolProfile: 'implementation',
  },
  tests: {
    tags: ['tests', 'testing', 'qa', 'verification'],
    paths: [/^test\//, /\/tests?\//, /\.test\.js$/],
    keywords: ['test', 'tests', 'coverage', 'qa', 'verify', 'провер', 'тест'],
    toolProfile: 'review',
  },
  docs: {
    tags: ['docs', 'documentation', 'markdown'],
    paths: [/README/i, /\.md$/, /^docs\//],
    keywords: ['docs', 'readme', 'documentation', 'markdown', 'документ', 'описание'],
    toolProfile: 'review',
  },
  'context-system': {
    tags: ['context', 'skills', 'metadata', 'tooling'],
    paths: [
      /\.agent-portal\/skills\//,
      /\.agent-portal\/workspace\/[^/]+\/skills\//,
      /\.agent-portal\/workspace\/[^/]+\/context\.md$/,
      /context-resolver\.js$/,
      /workflow-index\.js$/,
      /skills\.js$/,
    ],
    keywords: ['skills metadata', 'skill tags', 'context resolver', 'dynamic context', 'скилл', 'контекст', 'динамический контекст'],
    toolProfile: 'implementation',
  },
  'workflow-system': {
    tags: ['workflow', 'pipeline', 'process'],
    paths: [/\.agent-portal\/workflows\//, /\.agent-portal\/workspace\/[^/]+\/workflows\//, /workflow/i, /pipeline/i],
    keywords: ['workflow', 'pipeline', 'flow', 'process', 'воркфлоу', 'пайплайн'],
    toolProfile: 'workflow',
  },
  config: {
    tags: ['config', 'settings'],
    paths: [/\.agent-portal\/agents\//, /config/i, /\.json$/, /\.ya?ml$/, /\.toml$/],
    keywords: ['config', 'settings', 'agent metadata', 'agent role', 'настрой', 'конфиг', 'метаданные агента'],
    toolProfile: 'review',
  },
};

const PROFILE_TOOLS = {
  direct: ['discover_tools', 'call_tool', 'get_portal_status'],
  review: ['discover_tools', 'call_tool', 'get_skeleton', 'get_ai_context', 'get_task_result', 'list_workflows', 'search_by_tags'],
  implementation: ['discover_tools', 'call_tool', 'get_skeleton', 'get_ai_context', 'delegate_task', 'get_task_result', 'list_skills', 'search_by_tags'],
  orchestrator: ['discover_tools', 'call_tool', 'delegate_task', 'delegate_task_readonly', 'get_task_result', 'list_groups', 'delegate_to_group', 'list_skills', 'list_workflows'],
  workflow: ['discover_tools', 'call_tool', 'list_workflows', 'search_by_tags', 'get_workflow_content', 'signal_step_complete', 'bounce_back'],
};

function uniq(values) {
  return [...new Set(values.filter(Boolean))];
}

function normalizeText(value) {
  return String(value || '').toLowerCase();
}

function relPath(cwd, file) {
  if (!file) return '';
  return path.isAbsolute(file) ? path.relative(cwd, file) : file;
}

function skillNameFromRef(ref) {
  let value = String(ref || '');
  if (value.startsWith('skills/') || value.includes('/skills/')) return path.basename(value, '.md');
  return value && !value.includes('/') ? value : null;
}

function workflowIdFromRef(ref) {
  let value = String(ref || '');
  let workspaceMatch = value.match(/^workspace\/([^/]+)\/workflows\/(.+)\.md$/);
  if (workspaceMatch) return `${workspaceMatch[1]}/${workspaceMatch[2]}`;
  if (!value.startsWith('workflows/')) return null;
  return value.replace(/^workflows\//, '').replace(/\.md$/, '');
}

function resolveActiveContexts(cwd, files) {
  return resolveMemoryContexts(cwd, files)
    .map(context => ({
      id: context.id,
      scope: context.scope,
      path: context.path,
      workspace: context.workspace || null,
      skills: context.skills.map(skillNameFromRef).filter(Boolean),
      workflows: context.workflows.map(workflowIdFromRef).filter(Boolean),
      providerContracts: context.providerContracts || [],
    }));
}

function scoreZone(zone, prompt, files) {
  let score = 0;
  for (let keyword of zone.keywords) {
    if (prompt.includes(keyword.toLowerCase())) score += 2;
  }
  for (let file of files) {
    if (zone.paths.some(re => re.test(file))) score += 4;
  }
  return score;
}

function inferZones({ cwd = process.cwd(), prompt = '', files = [], agent = null }) {
  let lowerPrompt = normalizeText(prompt);
  let normalizedFiles = files.map(file => relPath(cwd, file).replaceAll(path.sep, '/'));
  let scored = Object.entries(ZONES)
    .map(([name, zone]) => ({ name, score: scoreZone(zone, lowerPrompt, normalizedFiles) }))
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));

  if (agent?.role === 'reviewer') scored.push({ name: 'tests', score: 1 });

  let zones = uniq(scored.sort((a, b) => b.score - a.score).map(item => item.name));
  return zones.length > 0 ? zones.slice(0, 4) : ['server'];
}

function tagsForZones(zones, agent) {
  return uniq([
    ...zones.flatMap(zone => ZONES[zone]?.tags || []),
    ...(agent?.contextTags || []),
    agent?.role,
  ]);
}

function matchSkills(cwd, tags, limit, contextSkillNames = [], files = []) {
  let tagSet = new Set(tags.map(normalizeText));
  let contextSkillSet = new Set(contextSkillNames);
  return listSkills(cwd, { files })
    .filter(skill => skill.category !== 'agents')
    .map(skill => {
      let skillTags = skill.tags?.length ? skill.tags : [skill.category];
      let score = skillTags.reduce((sum, tag) => sum + (tagSet.has(normalizeText(tag)) ? 1 : 0), 0);
      if (contextSkillSet.has(skill.name)) score += score > 0 ? 5 : 1;
      return { skill, score };
    })
    .filter(item => item.score > 0 || item.skill.autoload === true)
    .sort((a, b) => b.score - a.score || a.skill.name.localeCompare(b.skill.name))
    .slice(0, limit)
    .map(({ skill, score }) => ({
      name: skill.name,
      description: skill.description,
      category: skill.category,
      tier: skill.tier || null,
      workspace: skill.workspace || null,
      tags: skill.tags || [],
      tokenCost: skill.tokenCost || null,
      autoload: skill.autoload,
      score,
    }));
}

function matchWorkflows(cwd, tags, limit, files = []) {
  let { nodes, tagIndex } = buildTagIndexForDirs(getWorkflowDirs(cwd, files));
  let matched = [];
  let seen = new Set();

  for (let tag of tags) {
    for (let id of tagIndex.get(tag) || []) {
      if (seen.has(id)) continue;
      seen.add(id);
      let node = nodes.get(id);
      if (!node) continue;
      matched.push({
        id: node.id,
        name: node.meta.name || node.id,
        description: node.meta.description || '',
        tags: node.meta.tags || [],
        group: node.meta.group || '',
      });
    }
  }

  return matched.slice(0, limit);
}

function contextWorkflowMatches(cwd, workflowIds, files = []) {
  if (!workflowIds.length) return [];
  let { nodes } = buildTagIndexForDirs(getWorkflowDirs(cwd, files));
  return workflowIds
    .map(id => nodes.get(id))
    .filter(Boolean)
    .map(node => ({
      id: node.id,
      name: node.meta.name || node.id,
      description: node.meta.description || '',
      tags: node.meta.tags || [],
      group: node.meta.group || '',
    }));
}

function chooseToolProfile(zones, agent) {
  if (agent?.role === 'orchestrator') return 'orchestrator';
  if (agent?.role === 'reviewer') return 'review';
  if (zones.includes('workflow-system')) return 'workflow';
  if (agent?.role === 'executor') return 'implementation';
  if (zones.includes('mcp') && !zones.includes('ui') && !zones.includes('server')) return 'orchestrator';
  return 'implementation';
}

function costRank(tokenCost) {
  if (tokenCost === 'low') return 1;
  if (tokenCost === 'medium') return 2;
  if (tokenCost === 'high') return 3;
  return 2;
}

function buildContextItems({ cwd, skills, workflows, files }) {
  let items = [];

  for (let skill of skills) {
    items.push({
      id: `skill:${skill.name}`,
      type: 'skill',
      title: skill.name,
      description: skill.description,
      tags: skill.tags?.length ? skill.tags : [skill.category].filter(Boolean),
      priority: skill.autoload === true ? 100 : Math.max(1, skill.score || 1) * 10,
      tokenCost: skill.tokenCost || 'unknown',
      autoload: skill.autoload === true,
      loadWith: 'get_skill_content',
      args: { name: skill.name, cwd, files },
    });
  }

  for (let workflow of workflows) {
    items.push({
      id: `workflow:${workflow.id}`,
      type: 'workflow',
      title: workflow.name,
      description: workflow.description,
      tags: workflow.tags || [],
      priority: Math.max(1, workflow.tags?.length || 1) * 5,
      tokenCost: 'medium',
      autoload: false,
      loadWith: 'get_workflow_content',
      args: { nodeId: workflow.id, cwd, files },
    });
  }

  for (let file of files) {
    let rel = relPath(cwd, file).replaceAll(path.sep, '/');
    if (!rel) continue;
    if (rel.startsWith('.agent-portal/agents/')) continue;
    items.push({
      id: `file-context:${rel}`,
      type: 'file-context',
      title: rel,
      description: 'Focused project-graph context for a known relevant file.',
      tags: ['file-context'],
      priority: 30,
      tokenCost: 'small',
      autoload: false,
      loadWith: 'get_focus_zone',
      args: { path: cwd, recentFiles: [rel] },
    });
  }

  return items.sort((a, b) => {
    if (b.priority !== a.priority) return b.priority - a.priority;
    return costRank(a.tokenCost) - costRank(b.tokenCost) || a.id.localeCompare(b.id);
  });
}

/**
 * Resolve a compact context plan for an agent task.
 * @param {object} args
 * @param {string} defaultCwd
 * @returns {object}
 */
export function resolveContext(args = {}, defaultCwd = process.cwd()) {
  let cwd = args.cwd || defaultCwd;
  let task = args.task || args.prompt || '';
  let agent = args.agent_slug ? resolveAgentMetadata(cwd, args.agent_slug) : null;
  let files = Array.isArray(args.files) ? args.files : [];
  let activeContexts = resolveActiveContexts(cwd, files);
  let contextSkillNames = uniq(activeContexts.flatMap(context => context.skills || []));
  let contextWorkflowIds = uniq(activeContexts.flatMap(context => context.workflows || []));
  let zones = inferZones({ cwd, prompt: task, files, agent });
  let tags = tagsForZones(zones, agent);
  let toolProfile = chooseToolProfile(zones, agent);
  let skills = matchSkills(cwd, tags, args.max_skills || 8, contextSkillNames, files);
  let workflows = uniq([
    ...contextWorkflowMatches(cwd, contextWorkflowIds, files),
    ...matchWorkflows(cwd, tags, args.max_workflows || 8, files),
  ].map(workflow => JSON.stringify(workflow))).map(workflow => JSON.parse(workflow)).slice(0, args.max_workflows || 8);
  let items = buildContextItems({ cwd, skills, workflows, files });
  let mode = args.mode || 'plan';

  let plan = {
    zones,
    confidence: zones.length === 1 ? 0.62 : 0.78,
    tags,
    toolProfile,
    tools: PROFILE_TOOLS[toolProfile] || PROFILE_TOOLS.implementation,
    skills,
    workflows,
    contexts: activeContexts,
    contextPolicy: {
      startup: 'metadata-only',
      loadFullSkillWith: 'get_skill_content',
      loadFullWorkflowWith: 'get_workflow_content',
      scanContextMetadataFrom: '.agent-portal/contexts/**/*.md + .agent-portal/workspace/*/context.md',
      atomicItems: 'Use items[] with loadWith/args to enrich one skill, workflow, or file-context at a time.',
    },
    notes: [
      'This resolver returns indexes and recommendations only; it does not load full skill/workflow markdown.',
      'Use mode: "items" or "both" to get atomic enrichment handles.',
      'Use files[] for higher confidence when the task mentions concrete paths.',
    ],
  };

  if (mode === 'items') {
    return {
      zones,
      confidence: plan.confidence,
      tags,
      toolProfile,
      items,
      contextPolicy: plan.contextPolicy,
      notes: plan.notes,
    };
  }

  if (mode === 'both') {
    return { ...plan, items };
  }

  return plan;
}

export function handleResolveContext(args = {}, defaultCwd = process.cwd()) {
  return {
    content: [{
      type: 'text',
      text: JSON.stringify(resolveContext(args, defaultCwd), null, 2),
    }],
  };
}
