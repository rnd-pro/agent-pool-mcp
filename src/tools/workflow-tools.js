/**
 * MCP handlers for active file context and workflow discovery.
 *
 * @module agent-pool/tools/workflow-tools
 */

import path from 'node:path';

import { getTrackedFiles } from './file-tracker.js';
import { buildTagIndex, searchByTags, toLightList } from './workflow-index.js';

/**
 * @param {object} args
 * @param {string} defaultCwd
 * @returns {string}
 */
function getWorkflowsDir(args = {}, defaultCwd = process.cwd()) {
  return path.join(args.cwd || defaultCwd, '.agent-portal', 'workflows');
}

/**
 * @param {object} args
 * @param {string} defaultCwd
 */
function getWorkflowIndex(args = {}, defaultCwd = process.cwd()) {
  return buildTagIndex(getWorkflowsDir(args, defaultCwd));
}

/**
 * @param {object} args
 * @param {string} defaultCwd
 */
export function handleGetTrackedFiles(args = {}, defaultCwd = process.cwd()) {
  return {
    content: [{
      type: 'text',
      text: JSON.stringify({ tracked_files: getTrackedFiles(args.cwd || defaultCwd) }, null, 2),
    }],
  };
}

/**
 * @param {object} args
 * @param {string} defaultCwd
 */
export function handleListWorkflows(args = {}, defaultCwd = process.cwd()) {
  const { nodes } = getWorkflowIndex(args, defaultCwd);
  const groups = new Map();

  for (const node of nodes.values()) {
    let rel = path.relative(getWorkflowsDir(args, defaultCwd), node.filePath);
    let parts = rel.split(path.sep);
    let groupName = parts.length > 1 ? parts[0] : node.id;
    if (!groups.has(groupName)) {
      groups.set(groupName, {
        name: groupName,
        description: '',
        entryPoint: null,
        steps: [],
      });
    }
    let group = groups.get(groupName);
    group.steps.push({
      id: node.id,
      name: node.meta.name || node.id,
      description: node.meta.description || '',
      tags: node.meta.tags || [],
      group: node.meta.group || '',
    });
    if (!group.entryPoint || node.meta.entryPoint === true || node.id.startsWith('01-')) {
      group.entryPoint = node.id;
    }
    if (!group.description && node.meta.description) {
      group.description = node.meta.description;
    }
  }

  let workflows = Array.from(groups.values()).map((group) => ({
    ...group,
    steps: group.steps.sort((a, b) => a.id.localeCompare(b.id)),
  })).sort((a, b) => a.name.localeCompare(b.name));

  return { content: [{ type: 'text', text: JSON.stringify(workflows, null, 2) }] };
}

/**
 * @param {object} args
 * @param {string} defaultCwd
 */
export function handleSearchByTags(args = {}, defaultCwd = process.cwd()) {
  const { nodes, tagIndex } = getWorkflowIndex(args, defaultCwd);
  let matched = searchByTags(nodes, tagIndex, args.tags || []);

  if (matched.length === 0) {
    return { content: [{ type: 'text', text: JSON.stringify({ matches: [] }, null, 2) }] };
  }

  if (matched.length > 1) {
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          action_required: 'get_workflow_content',
          matches: toLightList(matched),
        }, null, 2),
      }],
    };
  }

  return {
    content: [{
      type: 'text',
      text: JSON.stringify(formatWorkflowNode(matched[0]), null, 2),
    }],
  };
}

/**
 * @param {object} args
 * @param {string} defaultCwd
 */
export function handleGetWorkflowContent(args = {}, defaultCwd = process.cwd()) {
  const { nodes } = getWorkflowIndex(args, defaultCwd);
  let node = nodes.get(args.nodeId);
  if (!node) {
    return {
      content: [{ type: 'text', text: `Workflow node not found: ${args.nodeId}` }],
      isError: true,
    };
  }
  return { content: [{ type: 'text', text: JSON.stringify(formatWorkflowNode(node), null, 2) }] };
}

function formatWorkflowNode(node) {
  let transitions = node.meta.transitions || {};
  return {
    id: node.id,
    name: node.meta.name || node.id,
    description: node.meta.description || '',
    group: node.meta.group || '',
    tags: node.meta.tags || [],
    transitions,
    availableDecisions: Object.keys(transitions),
    content: node.body,
  };
}
