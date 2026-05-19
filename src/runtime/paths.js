import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function portalHome(env = process.env) {
  return path.resolve(env.AGENT_PORTAL_CONFIG_DIR || path.join(os.homedir(), '.agent-portal'));
}

function projectKey(cwd = process.cwd()) {
  const root = path.resolve(cwd || process.cwd());
  const hash = createHash('sha1').update(root).digest('hex').slice(0, 12);
  const name = path.basename(root).replace(/[^a-zA-Z0-9._-]+/g, '-') || 'project';
  return `${name}-${hash}`;
}

export function getGlobalConfigPath(...parts) {
  return path.join(portalHome(), ...parts);
}

export function getProjectStateDir(cwd = process.cwd()) {
  return path.join(portalHome(), 'projects', projectKey(cwd));
}

export function getProjectStatePath(cwd = process.cwd(), ...parts) {
  return path.join(getProjectStateDir(cwd), ...parts);
}

export function ensureDirFor(filePath) {
  mkdirSync(path.dirname(filePath), { recursive: true });
}

export function getLegacyAgentPortalPath(cwd = process.cwd(), ...parts) {
  return path.join(path.resolve(cwd || process.cwd()), '.agent-portal', ...parts);
}
