import fs from 'node:fs';
import path from 'node:path';

import { VerificationContractError } from './contracts.js';
import { readGreenEvidence } from './evidence.js';
import { calculateFingerprint } from './fingerprint.js';
import { withFingerprintLock } from './lock.js';
import {
  assertInVerificationRoot,
  getVerificationDir,
  latestHistoryEntry,
} from './storage.js';

export async function getVerificationEvidence({
  check_kind,
  command,
  cwd = process.cwd(),
  inputs,
  control_files = [],
  env_keys = [],
  env_fingerprints = {},
  max_age_seconds,
}, env = process.env) {
  if (!Number.isInteger(max_age_seconds) || max_age_seconds < 0) {
    throw new VerificationContractError('max_age_seconds must be a non-negative integer.');
  }

  let { fingerprint } = calculateFingerprint({
    check_kind,
    command,
    cwd,
    inputs,
    control_files,
    env_keys,
    env_fingerprints,
  });
  let verificationDir = getVerificationDir(env);
  let evidencePath = path.join(verificationDir, 'evidence', `${fingerprint}.json`);
  let leasePath = path.join(verificationDir, 'leases', `${fingerprint}.json`);
  let historyPath = path.join(verificationDir, 'logs', `${fingerprint}.jsonl`);
  for (let filePath of [evidencePath, leasePath, historyPath]) {
    assertInVerificationRoot(filePath, verificationDir);
  }

  return withFingerprintLock(fingerprint, env, async () => {
    if (fs.existsSync(leasePath)) {
      try {
        let lease = JSON.parse(fs.readFileSync(leasePath, 'utf8'));
        let now = Date.now();
        if (now <= lease.expires_at) {
          return {
            fingerprint,
            age: null,
            state: 'wait',
            evidence: null,
            owner_id: lease.owner_id,
            expires_at: lease.expires_at,
            retry_after_seconds: Math.min(
              30,
              Math.max(1, Math.ceil((lease.expires_at - now) / 1000)),
            ),
            log_ref: lease.log_ref,
          };
        }
        return {
          fingerprint,
          age: null,
          state: 'expired',
          evidence: null,
          owner_id: lease.owner_id,
          expires_at: lease.expires_at,
          log_ref: lease.log_ref,
          latest_run: latestHistoryEntry(historyPath),
        };
      } catch (error) {
        if (error instanceof SyntaxError) {
          throw new Error('Verification lease state is unreadable.');
        }
        throw error;
      }
    }

    if (fs.existsSync(evidencePath)) {
      let evidence = readGreenEvidence(evidencePath, fingerprint);
      let age = (Date.now() - evidence.completed_at) / 1000;
      return {
        fingerprint,
        age,
        state: age <= max_age_seconds ? 'reusable' : 'stale',
        evidence: {
          status: evidence.status,
          completed_at: evidence.completed_at,
          owner_id: evidence.owner_id,
          result: evidence.result,
          log_ref: evidence.log_ref,
        },
      };
    }

    return {
      fingerprint,
      age: null,
      state: 'missing',
      evidence: null,
      latest_run: latestHistoryEntry(historyPath),
    };
  });
}
