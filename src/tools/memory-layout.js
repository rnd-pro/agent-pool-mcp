import fs from 'node:fs';
import path from 'node:path';

import { parseFrontmatter } from './markdown-parser.js';
import { getTeamMemoryRoot, getTeamMemoryPath } from '../runtime/paths.js';

function toPosix(value) {
  return String(value || '').replaceAll(path.sep, '/').replace(/^\.?\//, '');
}

function fileExists(cwd, rel) {
  return fs.existsSync(path.join(cwd, rel));
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function rootPackage(cwd) {
  return readJson(path.join(cwd, 'package.json')) || {};
}

function hasDependency(cwd, dependency) {
  let pkg = rootPackage(cwd);
  let sections = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];
  return sections.some(section => Object.hasOwn(pkg[section] || {}, dependency));
}

function globSignalMatches(pattern, files, cwd) {
  let normalized = toPosix(pattern);
  let normalizedFiles = files.map(toPosix);

  if (!normalized.includes('*')) {
    return fileExists(cwd, normalized)
      || normalizedFiles.some(file => file === normalized || file.startsWith(`${normalized}/`));
  }

  if (normalized.startsWith('**/*.')) {
    let suffix = normalized.slice('**/*'.length);
    return normalizedFiles.some(file => file.endsWith(suffix));
  }

  let [prefix] = normalized.split('*');
  prefix = prefix.replace(/\/$/, '');
  return Boolean(prefix && normalizedFiles.some(file => file.startsWith(prefix)));
}

function contextIsActive(context, files, cwd) {
  if (context.scope === 'global') return true;
  let activation = context.activation || {};
  let anyFiles = activation.anyFiles || [];
  let anyPaths = activation.anyPaths || [];
  let anyDependencies = activation.anyDependencies || [];

  return anyFiles.some(signal => globSignalMatches(signal, files, cwd))
    || anyPaths.some(signal => globSignalMatches(signal, files, cwd))
    || anyDependencies.some(dep => hasDependency(cwd, dep));
}

function scanMarkdownFiles(dir, options = {}) {
  if (!fs.existsSync(dir)) return [];
  let files = [];
  let skipNames = new Set(options.skipNames || []);

  for (let entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || skipNames.has(entry.name)) continue;
    let fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...scanMarkdownFiles(fullPath, options));
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      files.push(fullPath);
    }
  }
  return files;
}

function listWorkspaceNames() {
  let memoryRoot = getTeamMemoryRoot();
  if (!memoryRoot) return [];
  let root = path.join(memoryRoot, 'workspace');
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
    .map(entry => entry.name)
    .sort((a, b) => a.localeCompare(b));
}

function listContextFiles() {
  let root = getTeamMemoryRoot();
  if (!root) return [];
  let globalAndProvider = scanMarkdownFiles(path.join(root, 'contexts'), {
    skipNames: ['projects'],
  });
  let workspaceContexts = listWorkspaceNames()
    .map(name => path.join(root, 'workspace', name, 'context.md'))
    .filter(filePath => fs.existsSync(filePath));
  return [...globalAndProvider, ...workspaceContexts];
}

function contextFromFile(filePath) {
  let root = getTeamMemoryRoot();
  let rel = toPosix(root ? path.relative(root, filePath) : filePath);
  let workspaceMatch = rel.match(/^workspace\/([^/]+)\/context\.md$/);
  let { frontmatter } = parseFrontmatter(fs.readFileSync(filePath, 'utf8'));

  return {
    id: frontmatter.id || workspaceMatch?.[1] || path.basename(filePath, '.md'),
    scope: frontmatter.scope || (workspaceMatch ? 'project' : 'project'),
    path: rel,
    workspace: workspaceMatch?.[1] || null,
    activation: frontmatter.activation || null,
    relatedSkills: frontmatter.related_skills || frontmatter.relatedSkills || [],
    relatedWorkflows: frontmatter.related_workflows || frontmatter.relatedWorkflows || [],
    providerContracts: frontmatter.provider_contracts || frontmatter.providerContracts || [],
  };
}

export function getGlobalSkillsDir() {
  let root = getTeamMemoryRoot();
  return root ? path.join(root, 'skills') : null;
}

export function getGlobalWorkflowsDir() {
  let root = getTeamMemoryRoot();
  return root ? path.join(root, 'workflows') : null;
}

export function resolveActiveContexts(cwd, files = []) {
  let scopeRank = { global: 0, provider: 1, project: 2 };
  return listContextFiles()
    .map(filePath => contextFromFile(filePath))
    .filter(context => contextIsActive(context, files, cwd))
    .sort((a, b) => (scopeRank[a.scope] ?? 3) - (scopeRank[b.scope] ?? 3) || a.id.localeCompare(b.id))
    .map(context => ({
      id: context.id,
      scope: context.scope,
      path: context.path,
      workspace: context.workspace,
      skills: context.relatedSkills,
      workflows: context.relatedWorkflows,
      providerContracts: context.providerContracts || [],
    }));
}

export function activeWorkspaceNames(cwd, files = []) {
  return resolveActiveContexts(cwd, files)
    .filter(context => context.scope === 'project' && context.workspace)
    .map(context => context.workspace);
}

export function getSkillDirs(cwd, files = []) {
  let root = getTeamMemoryRoot();
  if (!root) return [];
  let dirs = [{ dir: getGlobalSkillsDir(), tier: 'global', workspace: null }];
  for (let workspace of activeWorkspaceNames(cwd, files)) {
    dirs.push({
      dir: path.join(root, 'workspace', workspace, 'skills'),
      tier: 'workspace',
      workspace,
    });
  }
  return dirs;
}

export function getWorkflowDirs(cwd, files = []) {
  let root = getTeamMemoryRoot();
  if (!root) return [];
  let dirs = [{ dir: getGlobalWorkflowsDir(), idPrefix: '', scope: 'global', workspace: null }];
  for (let workspace of activeWorkspaceNames(cwd, files)) {
    dirs.push({
      dir: path.join(root, 'workspace', workspace, 'workflows'),
      idPrefix: workspace,
      scope: 'workspace',
      workspace,
    });
  }
  return dirs;
}

export function getSingleActiveWorkspace(cwd, files = []) {
  let workspaces = activeWorkspaceNames(cwd, files);
  if (workspaces.length === 1) return workspaces[0];
  if (workspaces.length === 0) {
    throw new Error('No active workspace/<project>/context.md matched this repository');
  }
  throw new Error(`Multiple active workspaces matched: ${workspaces.join(', ')}`);
}

export function getWorkspaceSkillsDir(cwd, workspace) {
  return getTeamMemoryPath('workspace', workspace, 'skills');
}
