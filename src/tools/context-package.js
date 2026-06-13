import path from 'node:path';
import { resolveContext } from './context-resolver.js';

const DEFAULT_MAX_CHARS = 6000;
const FOCUS_GRAPH_LIMITS = {
  files: 8,
  symbols: 12,
  imports: 8,
  dependencies: 12,
  web: 8,
  items: 6,
};

function normalizeFiles(files = []) {
  if (!Array.isArray(files)) return [];
  return [...new Set(files.map(file => String(file || '').trim()).filter(Boolean))];
}

function relPath(cwd, file) {
  if (!file) return '';
  return path.isAbsolute(file) ? path.relative(cwd, file) : file;
}

function compactText(value, limit = 180) {
  let text = String(value || '').replace(/\s+/g, ' ').trim();
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 3)).trimEnd()}...`;
}

function addLines(lines, title, items, formatter) {
  lines.push(`${title}:`);
  if (!items.length) {
    lines.push('- none');
    return;
  }
  for (let item of items) lines.push(formatter(item));
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function truncateItems(items, limit = FOCUS_GRAPH_LIMITS.items) {
  let list = asArray(items).map(item => String(item || '').trim()).filter(Boolean);
  let shown = list.slice(0, limit);
  if (list.length > shown.length) shown.push(`+${list.length - shown.length} more`);
  return shown;
}

function formatFocusGraphLines(focusGraph = {}) {
  if (!focusGraph || typeof focusGraph !== 'object') return [];

  let lines = ['Focus graph:'];
  let files = truncateItems(focusGraph.files, FOCUS_GRAPH_LIMITS.files);
  if (files.length) lines.push(`- files: ${files.join(', ')}`);

  let symbols = asArray(focusGraph.symbols).slice(0, FOCUS_GRAPH_LIMITS.symbols);
  if (symbols.length) {
    lines.push('- symbols:');
    for (let symbol of symbols) {
      let label = [
        symbol.id,
        symbol.name ? `(${symbol.name})` : '',
        symbol.type ? `type=${symbol.type}` : '',
        symbol.file ? `file=${symbol.file}${symbol.line ? `:${symbol.line}` : ''}` : '',
        symbol.methods ? `methods=${asArray(symbol.methods).length}` : '',
      ].filter(Boolean).join(' ');
      lines.push(`  - ${label}`);
    }
  }

  let imports = asArray(focusGraph.imports).slice(0, FOCUS_GRAPH_LIMITS.imports);
  if (imports.length) {
    lines.push('- imports:');
    for (let item of imports) {
      let sources = truncateItems(item.sources || item.imports);
      lines.push(`  - ${item.file || 'unknown'} <- ${sources.join(', ') || 'none'}`);
    }
  }

  let web = asArray(focusGraph.web).slice(0, FOCUS_GRAPH_LIMITS.web);
  if (web.length) {
    lines.push('- web components:');
    for (let item of web) {
      let label = [
        item.symbol || item.id || 'unknown',
        item.tag ? `tag=${item.tag}` : '',
        item.file ? `file=${item.file}` : '',
        item.template ? `template=${item.template}` : '',
        item.style ? `style=${item.style}` : '',
      ].filter(Boolean).join(' ');
      lines.push(`  - ${label}`);
      let details = [
        item.children?.length ? `children=${truncateItems(item.children).join(',')}` : '',
        item.events?.length ? `events=${truncateItems(item.events).join(',')}` : '',
        item.dispatches?.length ? `dispatches=${truncateItems(item.dispatches).join(',')}` : '',
        item.subscriptions?.length ? `subscriptions=${truncateItems(item.subscriptions).join(',')}` : '',
        item.bindings?.length ? `bindings=${truncateItems(item.bindings, 4).join(',')}` : '',
        item.tokens?.length ? `tokens=${truncateItems(item.tokens, 4).join(',')}` : '',
      ].filter(Boolean);
      if (details.length) lines.push(`    ${details.join(' ')}`);
    }
  }

  let dependencies = asArray(focusGraph.dependencies).slice(0, FOCUS_GRAPH_LIMITS.dependencies);
  if (dependencies.length) {
    lines.push('- dependencies:');
    for (let dep of dependencies) {
      let parts = [
        dep.symbol || dep.id || 'unknown',
        dep.imports?.length ? `imports=${truncateItems(dep.imports).join(',')}` : '',
        dep.usedBy?.length ? `usedBy=${truncateItems(dep.usedBy).join(',')}` : '',
        dep.calls?.length ? `calls=${truncateItems(dep.calls).join(',')}` : '',
        dep.files?.length ? `files=${truncateItems(dep.files).join(',')}` : '',
        dep.elements?.length ? `elements=${truncateItems(dep.elements).join(',')}` : '',
      ].filter(Boolean);
      lines.push(`  - ${parts.join(' ')}`);
    }
  }

  return lines.length > 1 ? lines : [];
}

function capContextText(text, maxChars) {
  if (text.length <= maxChars) return text;
  const marker = '\n... [truncated to fit context package limit]\n[/Resolved Context Package]';
  return `${text.slice(0, Math.max(0, maxChars - marker.length)).trimEnd()}${marker}`;
}

/**
 * Build a compact context package for delegated agents.
 * @param {object} args
 * @param {string} defaultCwd
 * @returns {{plan: object, text: string}}
 */
export function buildResolvedContextPackage(args = {}, defaultCwd = process.cwd()) {
  let cwd = path.resolve(args.cwd || defaultCwd);
  let files = normalizeFiles(args.files).map(file => relPath(cwd, file).replaceAll(path.sep, '/'));
  let plan = resolveContext({
    ...args,
    cwd,
    files,
    mode: args.mode === 'items' ? 'both' : (args.mode || 'plan'),
    max_skills: args.max_skills || 8,
    max_workflows: args.max_workflows || 8,
  }, defaultCwd);

  let lines = [
    '[Resolved Context Package]',
    'Source: Agent Portal metadata resolver',
    'Mode: orchestration',
    'Precedence: this package overrides generic bootstrap instructions to broadly scan .agent-portal for this delegated task.',
    'Child-agent policy: trust this package first; load only referenced skills/workflows unless the task proves context is missing.',
    'Missing context: call resolve_context or `mcp-agent-portal context resolve` when available; shell inspection is emergency-only and must inspect frontmatter only.',
    `Zones: ${(plan.zones || []).join(', ') || 'none'}`,
    `Tool profile: ${plan.toolProfile || 'implementation'}`,
  ];

  addLines(lines, 'Active contexts', plan.contexts || [], context => {
    let workspace = context.workspace ? ` workspace=${context.workspace}` : '';
    return `- ${context.id || 'unknown'} scope=${context.scope || 'unknown'}${workspace} path=${context.path || ''}`;
  });

  addLines(lines, 'Focus files', files, file => `- ${file}`);
  let focusGraphLines = formatFocusGraphLines(args.focus_graph || args.focusGraph);
  if (focusGraphLines.length) lines.push(...focusGraphLines);

  addLines(lines, 'Selected skills', plan.skills || [], skill => {
    let tier = skill.tier || skill.tokenCost || 'unknown';
    let category = skill.category || 'uncategorized';
    let description = compactText(skill.description, 150);
    return `- ${skill.name} category=${category} tier=${tier}${description ? ` desc=${description}` : ''}`;
  });

  addLines(lines, 'Selected workflows', plan.workflows || [], workflow => {
    let description = compactText(workflow.description, 150);
    return `- ${workflow.id}${description ? ` desc=${description}` : ''}`;
  });

  lines.push('Explicit mode instructions:');
  lines.push('- Do not load full markdown skill/workflow bodies during startup.');
  lines.push('- Use referenced metadata first; enrich one skill, workflow, or file context only when needed.');
  lines.push('- `context_mode: "off"` is the only supported opt-out from package injection.');
  lines.push('[/Resolved Context Package]');

  let requestedMax = Number.isFinite(args.max_chars) ? args.max_chars : DEFAULT_MAX_CHARS;
  let maxChars = Math.min(DEFAULT_MAX_CHARS, Math.max(200, requestedMax));
  return {
    plan,
    text: capContextText(lines.join('\n'), maxChars),
  };
}

export function buildFocusGraphContext(focusGraph = {}) {
  return formatFocusGraphLines(focusGraph).join('\n');
}
