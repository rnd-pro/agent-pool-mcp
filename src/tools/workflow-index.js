/**
 * Lightweight YAML Frontmatter parser and Tag Index.
 * Zero external dependencies — parses the subset of YAML used in workflow files.
 *
 * Supports: strings, string arrays (both inline and multi-line), objects, booleans.
 *
 * @module context-x/workflow-index
 */

import fs from 'node:fs';
import path from 'node:path';

// ─── Frontmatter Parser ─────────────────────────────────────

/**
 * Parse YAML frontmatter from a markdown string.
 * Expects `---` delimiters. Returns null if no frontmatter found.
 *
 * @param {string} content - Raw markdown file content
 * @returns {{ meta: object, body: string } | null}
 */
export function parseFrontmatter(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return null;

  const yamlBlock = match[1];
  const body = content.slice(match[0].length).trim();
  const meta = parseYamlBlock(yamlBlock);

  return { meta, body };
}

/**
 * Parse a simple YAML block (key: value pairs, arrays, nested objects).
 * Handles the subset used in workflow frontmatter — not a full YAML parser.
 *
 * @param {string} block - YAML text between --- delimiters
 * @returns {object}
 */
function parseYamlBlock(block) {
  const lines = block.split(/\r?\n/);
  return parseIndentedBlock(lines, 0, 0, lines.length).result;
}

/**
 * Recursively parse lines at a given indent level.
 * @param {string[]} lines
 * @param {number} baseIndent - expected indent for keys at this level
 * @param {number} start - start line index
 * @param {number} end - end line index (exclusive)
 * @returns {{ result: object, nextLine: number }}
 */
function parseIndentedBlock(lines, baseIndent, start, end) {
  const result = {};
  let i = start;

  while (i < end) {
    const line = lines[i];

    // Skip empty lines and comments
    if (!line.trim() || line.trim().startsWith('#')) {
      i++;
      continue;
    }

    // Calculate indent
    const indent = line.search(/\S/);
    if (indent < baseIndent) break; // Dedented — return to parent
    if (indent > baseIndent) { i++; continue; } // Skip unexpected indent

    const keyMatch = line.match(/^(\s*)([\w][\w_-]*)\s*:\s*(.*)/);
    if (!keyMatch) { i++; continue; }

    const key = keyMatch[2];
    let value = keyMatch[3].trim();

    // Inline array: [a, b, c]
    if (value.startsWith('[') && value.endsWith(']')) {
      result[key] = value
        .slice(1, -1)
        .split(',')
        .map(s => s.trim().replace(/^["']|["']$/g, ''))
        .filter(Boolean);
      i++;
      continue;
    }

    // Inline object: { key: value, key2: value2 }
    if (value.startsWith('{') && value.endsWith('}')) {
      result[key] = parseInlineObject(value);
      i++;
      continue;
    }

    // Value on same line
    if (value) {
      result[key] = castValue(value);
      i++;
      continue;
    }

    // No value — look ahead for children
    i++;
    // Find the child indent level from the next non-empty line
    let childIndent = -1;
    for (let j = i; j < end; j++) {
      if (lines[j].trim() && !lines[j].trim().startsWith('#')) {
        childIndent = lines[j].search(/\S/);
        break;
      }
    }

    if (childIndent <= baseIndent) {
      result[key] = null;
      continue;
    }

    // Find where child block ends
    let childEnd = i;
    while (childEnd < end) {
      const cl = lines[childEnd];
      if (!cl.trim() || cl.trim().startsWith('#')) { childEnd++; continue; }
      const ci = cl.search(/\S/);
      if (ci < childIndent) break;
      childEnd++;
    }

    // Detect if children are array items (start with -)
    const childSlice = lines.slice(i, childEnd).filter(l => l.trim());
    const isArray = childSlice.length > 0 && childSlice.every(l => {
      const trimmed = l.trim();
      return trimmed.startsWith('- ') || trimmed === '';
    });

    if (isArray) {
      result[key] = childSlice
        .filter(l => l.trim().startsWith('- '))
        .map(l => castValue(l.trim().slice(2).trim()));
    } else {
      // Recurse for nested object
      const nested = parseIndentedBlock(lines, childIndent, i, childEnd);
      result[key] = nested.result;
    }

    i = childEnd;
  }

  return { result, nextLine: i };
}

/**
 * Parse an inline YAML object: { key: value, key2: value2 }
 * @param {string} str
 * @returns {object}
 */
function parseInlineObject(str) {
  const inner = str.slice(1, -1).trim();
  const obj = {};
  // Split by comma, respecting nested brackets
  const parts = smartSplit(inner, ',');
  for (const part of parts) {
    const colonIdx = part.indexOf(':');
    if (colonIdx === -1) continue;
    const k = part.slice(0, colonIdx).trim();
    let v = part.slice(colonIdx + 1).trim();
    if (v.startsWith('[') && v.endsWith(']')) {
      obj[k] = v
        .slice(1, -1)
        .split(',')
        .map(s => s.trim().replace(/^["']|["']$/g, ''))
        .filter(Boolean);
    } else {
      obj[k] = castValue(v);
    }
  }
  return obj;
}

/**
 * Split string by delimiter, respecting brackets.
 * @param {string} str
 * @param {string} delimiter
 * @returns {string[]}
 */
function smartSplit(str, delimiter) {
  const parts = [];
  let depth = 0;
  let current = '';
  for (const ch of str) {
    if (ch === '[' || ch === '{') depth++;
    else if (ch === ']' || ch === '}') depth--;
    if (ch === delimiter && depth === 0) {
      parts.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

/**
 * Cast a YAML string value to its JS type.
 * @param {string} val
 * @returns {string|number|boolean|null}
 */
function castValue(val) {
  if (val === 'true') return true;
  if (val === 'false') return false;
  if (val === 'null' || val === '~') return null;
  // Remove quotes
  if ((val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))) {
    return val.slice(1, -1);
  }
  // Number
  if (/^-?\d+(\.\d+)?$/.test(val)) return Number(val);
  return val;
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
