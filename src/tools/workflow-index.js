/**
 * Lightweight YAML Frontmatter parser and Tag Index.
 * Zero external dependencies — parses the subset of YAML used in workflow files.
 *
 * Supports: strings, string arrays (both inline and multi-line), objects, booleans.
 *
 * @module agent-pool/workflow-index
 */

import fs from 'node:fs';
import path from 'node:path';
import { parseMarkdownFrontmatter } from './frontmatter.js';

// ─── Frontmatter Parser ─────────────────────────────────────

/**
 * Parse YAML frontmatter from a markdown string.
 * Expects `---` delimiters. Returns null if no frontmatter found.
 *
 * @param {string} content - Raw markdown file content
 * @returns {{ meta: object, body: string } | null}
 */
export function parseFrontmatter(content) {
  let parsed = parseMarkdownFrontmatter(content);
  return parsed ? { meta: parsed.meta, body: parsed.body } : null;
}

// ─── Tag Index ──────────────────────────────────────────────

/**
 * @typedef {object} WorkflowNode
 * @property {string} id - Derived from filename (without extension)
 * @property {string} filePath - Absolute path to the .md file
 * @property {object} meta - Parsed frontmatter metadata
 * @property {string} body - Markdown body (content after frontmatter)
 */

/**
 * Build a tag-based index from a directory of workflow markdown files.
 * Recursively scans for .md files with frontmatter.
 *
 * @param {string} dir - Directory to scan
 * @returns {{ nodes: Map<string, WorkflowNode>, tagIndex: Map<string, string[]> }}
 */
export function buildTagIndex(dir) {
  /** @type {Map<string, WorkflowNode>} */
  const nodes = new Map();
  /** @type {Map<string, string[]>} inverted index: tag → [nodeId, ...] */
  const tagIndex = new Map();

  const files = walkMdFiles(dir);

  for (const filePath of files) {
    const content = fs.readFileSync(filePath, 'utf-8');
    const parsed = parseFrontmatter(content);
    if (!parsed || !parsed.meta) continue;

    const id = path.basename(filePath, '.md');
    const node = { id, filePath, meta: parsed.meta, body: parsed.body };
    nodes.set(id, node);

    // Index by tags
    const tags = parsed.meta.tags;
    if (Array.isArray(tags)) {
      for (const tag of tags) {
        if (!tagIndex.has(tag)) tagIndex.set(tag, []);
        tagIndex.get(tag).push(id);
      }
    }
  }

  return { nodes, tagIndex };
}

/**
 * Search nodes by tags. Returns nodes that match ALL provided tags.
 *
 * @param {Map<string, WorkflowNode>} nodes
 * @param {Map<string, string[]>} tagIndex
 * @param {string[]} tags - Tags to match (AND logic)
 * @returns {WorkflowNode[]}
 */
export function searchByTags(nodes, tagIndex, tags) {
  if (!tags || tags.length === 0) return [];

  // Start with the rarest tag for efficiency
  const tagSets = tags
    .map(tag => new Set(tagIndex.get(tag) || []))
    .sort((a, b) => a.size - b.size);

  // Intersect all tag sets
  let result = tagSets[0];
  for (let i = 1; i < tagSets.length; i++) {
    result = new Set([...result].filter(id => tagSets[i].has(id)));
  }

  return [...result].map(id => nodes.get(id)).filter(Boolean);
}

/**
 * Get a lightweight list of matching nodes (for Lazy Context Selection).
 * Returns only id, name, and description — NOT the full body content.
 *
 * @param {WorkflowNode[]} matchedNodes
 * @returns {Array<{ id: string, name: string, description: string }>}
 */
export function toLightList(matchedNodes) {
  return matchedNodes.map(node => ({
    id: node.id,
    name: node.meta.name || node.id,
    description: node.meta.description || '',
  }));
}

// ─── Helpers ────────────────────────────────────────────────

/**
 * Recursively walk a directory and collect .md file paths.
 * @param {string} dir
 * @param {string[]} [fileList]
 * @returns {string[]}
 */
function walkMdFiles(dir, fileList = []) {
  if (!fs.existsSync(dir)) return fileList;
  const entries = fs.readdirSync(dir);
  for (const entry of entries) {
    if (entry === '.git' || entry === 'node_modules') continue;
    const fullPath = path.join(dir, entry);
    if (fs.statSync(fullPath).isDirectory()) {
      walkMdFiles(fullPath, fileList);
    } else if (entry.endsWith('.md')) {
      fileList.push(fullPath);
    }
  }
  return fileList;
}
