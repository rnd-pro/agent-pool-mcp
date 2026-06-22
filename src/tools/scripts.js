/**
 * Scripts Database — tools for managing JIT automation scripts.
 * Agents can save and list scripts in the team-memory `scripts/` directory.
 *
 * @module agent-pool/tools/scripts
 */

import { writeFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { getTeamMemoryPath } from '../runtime/paths.js';

const SCRIPTS_SEGMENT = 'scripts';

/**
 * Resolve the scripts directory inside team memory, or null when unconfigured.
 *
 * @returns {string|null}
 */
function getScriptsDir() {
  return getTeamMemoryPath(SCRIPTS_SEGMENT);
}

/**
 * Save a script to the database.
 *
 * @param {string} cwd - Project directory (unused; scripts live in team memory)
 * @param {string} name - Name of the script (without extension)
 * @param {string} code - The script content
 * @param {string} [ext="js"] - Extension (e.g. "js", "sh", "py")
 * @returns {string} The path to the saved script, relative to the team-memory root
 * @throws {Error} When team memory is not configured
 */
export function saveScript(cwd, name, code, ext = 'js') {
  const dir = getScriptsDir();
  if (!dir) {
    throw new Error('Cannot save script: team memory is not configured');
  }
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const fileName = `${name}.${ext.replace(/^\./, '')}`;
  const filePath = join(dir, fileName);

  writeFileSync(filePath, code, 'utf-8');
  return join(SCRIPTS_SEGMENT, fileName);
}

/**
 * List all scripts in the database.
 *
 * @param {string} cwd - Project directory (unused; scripts live in team memory)
 * @returns {Array<{ name: string, ext: string, size: number, path: string }>}
 */
export function listScripts(cwd) {
  const dir = getScriptsDir();
  if (!dir || !existsSync(dir)) {
    return [];
  }

  const files = readdirSync(dir);
  return files.map((file) => {
    const fullPath = join(dir, file);
    let size = 0;
    try {
      size = Buffer.byteLength(readFileSync(fullPath, 'utf-8'));
    } catch (e) { /* file may be unreadable — show 0 size */ }

    const parts = file.split('.');
    const ext = parts.length > 1 ? parts.pop() : '';
    const name = parts.join('.');

    return {
      name,
      ext,
      size,
      path: join(SCRIPTS_SEGMENT, file)
    };
  });
}
