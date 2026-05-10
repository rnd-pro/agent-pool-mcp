import { writeFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const CONTEXT_DIR = '.agent-portal';
const CONTEXT_FILE = 'active_context.json';

// In-memory cache for fast access
let activeFilesCache = new Set();
let cwdContext = '';

function getContextPath(cwd) {
  return join(cwd, CONTEXT_DIR, CONTEXT_FILE);
}

function loadCache(cwd) {
  if (cwd !== cwdContext) {
    cwdContext = cwd;
    const filePath = getContextPath(cwd);
    if (existsSync(filePath)) {
      try {
        const files = JSON.parse(readFileSync(filePath, 'utf-8'));
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
  const dirPath = join(cwd, CONTEXT_DIR);
  if (!existsSync(dirPath)) {
    mkdirSync(dirPath, { recursive: true });
  }
  writeFileSync(getContextPath(cwd), JSON.stringify(Array.from(activeFilesCache), null, 2));
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
