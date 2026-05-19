import { parseMarkdownFrontmatter, parseYamlBlock } from './frontmatter.js';

export { parseYamlBlock };

export function parseSimpleYaml(yamlText) {
  return parseYamlBlock(yamlText);
}

/**
 * Parse frontmatter from markdown content
 * @param {string} content - Raw markdown content
 * @returns {{ frontmatter: Object, body: string }}
 */
export function parseFrontmatter(content) {
  const parsed = parseMarkdownFrontmatter(content);
  if (!parsed) {
    return { frontmatter: {}, body: content };
  }
  return { frontmatter: parsed.meta, body: parsed.body };
}
