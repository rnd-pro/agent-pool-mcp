import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
  CACHE_POLICIES,
  MAX_LEASE_TTL_SECONDS,
  MAX_OWNER_LENGTH,
  VerificationContractError,
} from './contracts.js';
import { readGreenEvidence } from './evidence.js';
import { calculateFingerprint } from './fingerprint.js';
import { withFingerprintLock } from './lock.js';
import {
  assertInVerificationRoot,
  ensureVerificationLayout,
  resolveLogRef,
  writePrivateFile,
} from './storage.js';

function validateOptions({ maxAgeSeconds, cachePolicy, leaseTtl, runId }) {
  if (!Number.isInteger(maxAgeSeconds) || maxAgeSeconds < 0) {
    throw new VerificationContractError('max_age_seconds must be a non-negative integer.');
  }
  if (!CACHE_POLICIES.has(cachePolicy)) {
    throw new VerificationContractError('cache_policy must be default, force_fresh, or non_cacheable.');
  }
  if (!Number.isInteger(leaseTtl) || leaseTtl < 1 || leaseTtl > MAX_LEASE_TTL_SECONDS) {
    throw new VerificationContractError(
      `lease_ttl must be an integer from 1 to ${MAX_LEASE_TTL_SECONDS} seconds.`,
    );
  }
  if (typeof runId !== 'string') {
    throw new VerificationContractError('run_id must be a string.');
  }
}

function readLease(leasePath) {
  if (!fs.existsSync(leasePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(leasePath, 'utf8'));
  } catch {
    throw new Error('Verification lease state is unreadable.');
  }
}

function getReusableEvidence(evidencePath, fingerprint, maxAgeSeconds) {
  let evidence = readGreenEvidence(evidencePath, fingerprint);
  if (!evidence) return null;
  let age = (Date.now() - evidence.completed_at) / 1000;
  if (age > maxAgeSeconds) return null;
  return {
    decision: 'reuse',
    age,
    freshness: 'fresh',
    evidence: {
      status: evidence.status,
      completed_at: evidence.completed_at,
      owner_id: evidence.owner_id,
      result: evidence.result,
      log_ref: evidence.log_ref,
    },
  };
}

export async function prepareVerification({
  check_kind,
  command,
  cwd = process.cwd(),
  inputs,
  control_files = [],
  env_keys = [],
  env_fingerprints = {},
  max_age_seconds,
  cache_policy = 'default',
  lease_ttl = 300,
  run_id = '',
}, env = process.env) {
  validateOptions({
    maxAgeSeconds: max_age_seconds,
    cachePolicy: cache_policy,
    leaseTtl: lease_ttl,
    runId: run_id,
  });

  let { fingerprint, details } = calculateFingerprint({
    check_kind,
    command,
    cwd,
    inputs,
    control_files,
    env_keys,
    env_fingerprints,
  });
  let { verificationDir, leasesDir, evidenceDir } = ensureVerificationLayout(env);
  let leasePath = path.join(leasesDir, `${fingerprint}.json`);
  let evidencePath = path.join(evidenceDir, `${fingerprint}.json`);
  assertInVerificationRoot(leasePath, verificationDir);
  assertInVerificationRoot(evidencePath, verificationDir);

  return withFingerprintLock(fingerprint, env, async () => {
    let existingLease = readLease(leasePath);
    if (existingLease) {
      let now = Date.now();
      if (now <= existingLease.expires_at) {
        let remaining = Math.max(1, Math.ceil((existingLease.expires_at - now) / 1000));
        return {
          decision: 'wait',
          fingerprint,
          lease_id: existingLease.lease_id,
          expires_at: existingLease.expires_at,
          owner_id: existingLease.owner_id,
          log_ref: existingLease.log_ref,
          retry_after_seconds: Math.min(30, remaining),
        };
      }
      if (existingLease.log_ref) {
        try {
          fs.unlinkSync(resolveLogRef(verificationDir, existingLease.log_ref));
        } catch {
          // Missing abandoned logs do not block lease recovery.
        }
      }
    }

    if (cache_policy === 'default') {
      let reusable = getReusableEvidence(evidencePath, fingerprint, max_age_seconds);
      if (reusable) return { ...reusable, fingerprint };
    }
    if (fs.existsSync(evidencePath)) fs.unlinkSync(evidencePath);

    let leaseId = crypto.randomUUID();
    let expiresAt = Date.now() + (lease_ttl * 1000);
    let logRef = `logs/${fingerprint}-${leaseId}.log`;
    let absoluteLogPath = path.join(verificationDir, logRef);
    assertInVerificationRoot(absoluteLogPath, verificationDir);
    writePrivateFile(absoluteLogPath, '');
    writePrivateFile(leasePath, JSON.stringify({
      fingerprint,
      lease_id: leaseId,
      owner_id: run_id.substring(0, MAX_OWNER_LENGTH) || 'unknown',
      acquired_at: Date.now(),
      expires_at: expiresAt,
      cache_policy,
      log_ref: logRef,
      details,
    }, null, 2));

    return {
      decision: 'run',
      fingerprint,
      lease_id: leaseId,
      expires_at: expiresAt,
      log_ref: logRef,
      log_path: absoluteLogPath,
    };
  });
}
