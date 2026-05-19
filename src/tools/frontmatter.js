/**
 * Shared Markdown frontmatter parser.
 *
 * This intentionally supports the YAML subset used by agent, skill, and
 * workflow metadata: scalars, inline arrays, multiline arrays, inline objects,
 * and nested objects.
 *
 * @module agent-pool/tools/frontmatter
 */

/**
 * Parse YAML frontmatter from markdown content.
 *
 * @param {string} content - Raw markdown file content
 * @returns {{ meta: object, frontmatter: object, body: string } | null}
 */
export function parseMarkdownFrontmatter(content) {
  if (!content || typeof content !== 'string') {
    throw new Error('Content must be a non-empty string');
  }

  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) return null;

  const meta = parseYamlBlock(match[1]);
  const body = content.slice(match[0].length).trim();
  return { meta, frontmatter: meta, body };
}

/**
 * Parse a simple YAML block.
 *
 * @param {string} block - YAML text between --- delimiters
 * @returns {object}
 */
export function parseYamlBlock(block) {
  const lines = String(block || '').split(/\r?\n/);
  return parseIndentedBlock(lines, 0, 0, lines.length).result;
}

/**
 * @param {string[]} lines
 * @param {number} baseIndent
 * @param {number} start
 * @param {number} end
 * @returns {{ result: object, nextLine: number }}
 */
function parseIndentedBlock(lines, baseIndent, start, end) {
  const result = {};
  let i = start;

  while (i < end) {
    const line = lines[i];
    if (!line.trim() || line.trim().startsWith('#')) {
      i++;
      continue;
    }

    const indent = line.search(/\S/);
    if (indent < baseIndent) break;
    if (indent > baseIndent) {
      i++;
      continue;
    }

    const keyMatch = line.match(/^(\s*)([\w][\w_-]*)\s*:\s*(.*)/);
    if (!keyMatch) {
      i++;
      continue;
    }

    const key = keyMatch[2];
    let value = keyMatch[3].trim();

    if (value.startsWith('[') && value.endsWith(']')) {
      result[key] = parseInlineArray(value);
      i++;
      continue;
    }

    if (value.startsWith('{') && value.endsWith('}')) {
      result[key] = parseInlineObject(value);
      i++;
      continue;
    }

    if (value) {
      result[key] = castValue(value);
      i++;
      continue;
    }

    i++;
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

    let childEnd = i;
    while (childEnd < end) {
      const childLine = lines[childEnd];
      if (!childLine.trim() || childLine.trim().startsWith('#')) {
        childEnd++;
        continue;
      }
      const childLineIndent = childLine.search(/\S/);
      if (childLineIndent < childIndent) break;
      childEnd++;
    }

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
      result[key] = parseIndentedBlock(lines, childIndent, i, childEnd).result;
    }

    i = childEnd;
  }

  return { result, nextLine: i };
}

/**
 * @param {string} value
 * @returns {Array<string|number|boolean|null>}
 */
function parseInlineArray(value) {
  const inner = value.slice(1, -1).trim();
  return inner ? smartSplit(inner, ',').map(castValue).filter(v => v !== '') : [];
}

/**
 * @param {string} value
 * @returns {object}
 */
function parseInlineObject(value) {
  const inner = value.slice(1, -1).trim();
  const obj = {};
  for (const part of smartSplit(inner, ',')) {
    const colonIdx = part.indexOf(':');
    if (colonIdx === -1) continue;
    const key = part.slice(0, colonIdx).trim();
    const rawValue = part.slice(colonIdx + 1).trim();
    obj[key] = rawValue.startsWith('[') && rawValue.endsWith(']')
      ? parseInlineArray(rawValue)
      : castValue(rawValue);
  }
  return obj;
}

/**
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
 * @param {string} value
 * @returns {string|number|boolean|null}
 */
function castValue(value) {
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value === 'null' || value === '~') return null;
  if ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  return value;
}
