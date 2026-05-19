import { writeFileSync, existsSync, readFileSync } from 'node:fs';
import { ensureDirFor, getLegacyAgentPortalPath, getProjectStatePath } from '../runtime/paths.js';

const CONTEXT_FILE = 'active_context.json';

// In-memory cache for fast access
let activeFilesCache = new Set();
let cwdContext = '';

function getContextPath(cwd) {
  return getProjectStatePath(cwd, CONTEXT_FILE);
}

function getLegacyContextPath(cwd) {
  return getLegacyAgentPortalPath(cwd, CONTEXT_FILE);
}

function loadCache(cwd) {
  if (cwd !== cwdContext) {
    cwdContext = cwd;
    const filePath = getContextPath(cwd);
    const legacyPath = getLegacyContextPath(cwd);
    const sourcePath = existsSync(filePath) ? filePath : legacyPath;
    if (existsSync(sourcePath)) {
      try {
        const files = JSON.parse(readFileSync(sourcePath, 'utf-8'));
        activeFilesCache = new Set(files);
      } catch {
        activeFilesCache = new Set();
      }
    } else {
      activeFilesCache = new Set();
    }
  }
}

function syncToDisk(cwd) {
  const filePath = getContextPath(cwd);
  ensureDirFor(filePath);
  writeFileSync(filePath, JSON.stringify(Array.from(activeFilesCache), null, 2));
}

export function trackFiles(cwd, paths) {
  loadCache(cwd);
  for (const file of paths) {
    activeFilesCache.add(file);
  }
  syncToDisk(cwd);
  return Array.from(activeFilesCache);
}

export function untrackFiles(cwd, paths) {
  loadCache(cwd);
  if (!paths || paths.length === 0) {
    activeFilesCache.clear();
  } else {
    for (const file of paths) {
      activeFilesCache.delete(file);
    }
  }
  syncToDisk(cwd);
  return Array.from(activeFilesCache);
}

export function getTrackedFiles(cwd) {
  loadCache(cwd);
  return Array.from(activeFilesCache);
}
