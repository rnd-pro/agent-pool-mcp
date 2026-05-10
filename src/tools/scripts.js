/**
 * Scripts Database — tools for managing JIT automation scripts.
 * Agents can save and list scripts in the .agent-portal/scripts/ directory.
 *
 * @module agent-pool/tools/scripts
 */

import { writeFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const SCRIPTS_DIR = '.agent-portal/scripts';

/**
 * Get the scripts directory path for a project.
 *
 * @param {string} cwd - Project directory
 * @returns {string}
 */
function getScriptsDir(cwd) {
  return join(cwd, SCRIPTS_DIR);
}

/**
 * Save a script to the database.
 *
 * @param {string} cwd - Project directory
 * @param {string} name - Name of the script (without extension)
 * @param {string} code - The script content
 * @param {string} [ext="js"] - Extension (e.g. "js", "sh", "py")
 * @returns {string} The relative path to the saved script
 */
export function saveScript(cwd, name, code, ext = 'js') {
  const dir = getScriptsDir(cwd);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const fileName = `${name}.${ext.replace(/^\./, '')}`;
  const filePath = join(dir, fileName);

  writeFileSync(filePath, code, 'utf-8');
  return join(SCRIPTS_DIR, fileName);
}

/**
 * List all scripts in the database.
 *
 * @param {string} cwd - Project directory
 * @returns {Array<{ name: string, ext: string, size: number, path: string }>}
 */
export function listScripts(cwd) {
  const dir = getScriptsDir(cwd);
  if (!existsSync(dir)) {
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
      path: join(SCRIPTS_DIR, file)
    };
  });
}
