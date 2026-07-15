import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { ensureDirPermissions, getVerificationDir } from './storage.js';

const LOCK_TIMEOUT_MS = 5000;
const LOCK_MAX_HOLD_MS = 10000;
const SPIN_MS = 8;

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

function tryAcquireLock(lockPath, selfPid, lockToken, now) {
  try {
    let fd = fs.openSync(lockPath, 'wx', 0o600);
    try {
      fs.writeSync(fd, JSON.stringify({ pid: selfPid, token: lockToken, acquiredAt: now }));
    } finally {
      fs.closeSync(fd);
    }
    fs.chmodSync(lockPath, 0o600);
    return true;
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    return false;
  }
}

function maybeBreakStaleLock(lockPath, selfPid, now) {
  let info;
  try {
    info = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  } catch {
    return;
  }
  let stale = !info || !Number.isInteger(info.pid)
    || !isPidAlive(info.pid)
    || now - (info.acquiredAt || 0) > LOCK_MAX_HOLD_MS;
  if (!stale) return;

  let suffix = crypto.randomBytes(4).toString('hex');
  let brokenPath = `${lockPath}.broken.${selfPid}.${now}.${suffix}`;
  try {
    fs.renameSync(lockPath, brokenPath);
    fs.unlinkSync(brokenPath);
  } catch {
    // Another process recovered the lock first.
  }
}

function releaseLock(lockPath, lockToken) {
  try {
    if (!fs.existsSync(lockPath)) return;
    let data = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    if (data && data.token === lockToken) fs.unlinkSync(lockPath);
  } catch {
    // A superseded or already removed lock needs no cleanup.
  }
}

export async function withFingerprintLock(fingerprint, env, operation) {
  let locksDir = path.join(getVerificationDir(env), 'locks');
  ensureDirPermissions(locksDir);

  let lockPath = path.join(locksDir, `${fingerprint}.lock`);
  let selfPid = process.pid;
  let lockToken = crypto.randomUUID();
  let deadline = Date.now() + LOCK_TIMEOUT_MS;

  for (;;) {
    let now = Date.now();
    if (tryAcquireLock(lockPath, selfPid, lockToken, now)) break;
    maybeBreakStaleLock(lockPath, selfPid, now);
    if (Date.now() >= deadline) {
      throw new Error(`Lock timeout for fingerprint ${fingerprint}`);
    }
    await new Promise(resolve => setTimeout(resolve, SPIN_MS));
  }

  try {
    return await operation();
  } finally {
    releaseLock(lockPath, lockToken);
  }
}
