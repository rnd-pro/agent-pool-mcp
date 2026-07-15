import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { isPathInside } from './path.js';

export function getVerificationDir(env = process.env) {
  if (env.AGENT_POOL_VERIFICATION_DIR) {
    return path.resolve(env.AGENT_POOL_VERIFICATION_DIR);
  }
  let home = env.AGENT_PORTAL_CONFIG_DIR || path.join(os.homedir(), '.agent-portal');
  return path.join(home, 'verification-evidence');
}

export function ensureDirPermissions(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true, mode: 0o700 });
  fs.chmodSync(dirPath, 0o700);
}

export function ensureVerificationLayout(env = process.env) {
  let verificationDir = getVerificationDir(env);
  let layout = {
    verificationDir,
    leasesDir: path.join(verificationDir, 'leases'),
    evidenceDir: path.join(verificationDir, 'evidence'),
    logsDir: path.join(verificationDir, 'logs'),
  };
  for (let dirPath of Object.values(layout)) ensureDirPermissions(dirPath);
  return layout;
}

export function assertInVerificationRoot(filePath, verificationDir) {
  if (!isPathInside(path.resolve(verificationDir), path.resolve(filePath))) {
    throw new Error('Access denied: path is outside verification root.');
  }
}

export function writePrivateFile(filePath, data) {
  ensureDirPermissions(path.dirname(filePath));
  let tmpPath = `${filePath}.tmp-${crypto.randomUUID()}`;
  fs.writeFileSync(tmpPath, data, { mode: 0o600 });
  fs.chmodSync(tmpPath, 0o600);
  fs.renameSync(tmpPath, filePath);
  fs.chmodSync(filePath, 0o600);
}

export function resolveLogRef(verificationDir, logRef) {
  if (typeof logRef !== 'string' || path.isAbsolute(logRef)) {
    throw new Error('Invalid log reference.');
  }
  let resolvedPath = path.resolve(verificationDir, logRef);
  assertInVerificationRoot(resolvedPath, verificationDir);
  return resolvedPath;
}

export function truncateFileToTail(filePath, maxBytes) {
  if (!fs.existsSync(filePath)) return;
  let stats = fs.statSync(filePath);
  if (stats.size <= maxBytes) {
    fs.chmodSync(filePath, 0o600);
    return;
  }

  let fd = fs.openSync(filePath, 'r');
  let tail = Buffer.alloc(maxBytes);
  try {
    fs.readSync(fd, tail, 0, maxBytes, stats.size - maxBytes);
  } finally {
    fs.closeSync(fd);
  }
  writePrivateFile(filePath, tail);
}

export function readHistory(historyPath) {
  if (!fs.existsSync(historyPath)) return [];
  try {
    return fs.readFileSync(historyPath, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line));
  } catch {
    return [];
  }
}

export function latestHistoryEntry(historyPath) {
  let entries = readHistory(historyPath);
  return entries.length ? entries[entries.length - 1] : null;
}
