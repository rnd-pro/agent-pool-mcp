/**
 * Markdown Configuration Parser
 * Parses agent/skill configuration from Markdown files with YAML frontmatter.
 * Follows NO FALLBACKS principle for critical configuration.
 */

/**
 * Simple YAML parser for frontmatter (supports basic key-value pairs and arrays)
 * @param {string} yamlText - YAML text to parse
 * @returns {Object} Parsed object
 */
export function parseSimpleYaml(yamlText) {
  if (!yamlText || typeof yamlText !== 'string') {
    return {};
  }

  const result = {};
  const lines = yamlText.split('\n');
  let currentArrayKey = null;

  for (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, '');
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    // Array continuation
    if (currentArrayKey && trimmed.startsWith('- ')) {
      const item = trimmed.slice(2).trim();
      const parsedItem = item.startsWith('"') && item.endsWith('"')
        ? item.slice(1, -1)
        : (item.startsWith("'") && item.endsWith("'"))
          ? item.slice(1, -1)
          : item;
      result[currentArrayKey].push(parsedItem);
      continue;
    }

    // Key declaration
    const colonIndex = trimmed.indexOf(':');
    if (colonIndex === -1) continue;

    const key = trimmed.slice(0, colonIndex).trim();
    const value = trimmed.slice(colonIndex + 1).trim();
    if (!key) continue;

    // Start array if value empty and next lines have '- '
    if (value === '') {
      currentArrayKey = key;
      result[currentArrayKey] = [];
      continue;
    }

    currentArrayKey = null;

    // Parse value
    if (value === 'true') {
      result[key] = true;
    } else if (value === 'false') {
      result[key] = false;
    } else if (value === 'null') {
      result[key] = null;
    } else if (/^-?\d+$/.test(value)) {
      result[key] = parseInt(value, 10);
    } else if (/^-?\d+\.\d+$/.test(value)) {
      result[key] = parseFloat(value);
    } else if (value.startsWith('[') && value.endsWith(']')) {
      // Simple inline array: [a, b, c]
      const inner = value.slice(1, -1).trim();
      result[key] = inner ? inner.split(',').map(s => s.trim().replace(/^['"]|['"]$/g, '')) : [];
    } else if (value.startsWith('"') && value.endsWith('"')) {
      result[key] = value.slice(1, -1);
    } else if (value.startsWith("'") && value.endsWith("'")) {
      result[key] = value.slice(1, -1);
    } else {
      result[key] = value;
    }
  }

  return result;
}

/**
 * Parse frontmatter from markdown content
 * @param {string} content - Raw markdown content
 * @returns {{ frontmatter: Object, body: string }}
 */
export function parseFrontmatter(content) {
  if (!content || typeof content !== 'string') {
    throw new Error('Content must be a non-empty string');
  }

  const lines = content.split('\n');
  
  // Check if file starts with frontmatter delimiter
  if (lines[0].trim() !== '---') {
    return { frontmatter: {}, body: content };
  }

  // Find closing delimiter
  const endIndex = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
  if (endIndex === -1) {
    return { frontmatter: {}, body: content }; // Graceful degradation if no closing delimiter
  }

  // Extract frontmatter YAML
  const frontmatterLines = lines.slice(1, endIndex);
  const frontmatterText = frontmatterLines.join('\n');
  
  // Extract main content
  const body = lines.slice(endIndex + 1).join('\n').trim();

  // Parse YAML frontmatter
  let frontmatter = {};
  if (frontmatterText.trim()) {
    try {
      frontmatter = parseSimpleYaml(frontmatterText);
    } catch (error) {
      throw new Error(`Failed to parse frontmatter: ${error.message}`);
    }
  }

  return { frontmatter, body };
}
