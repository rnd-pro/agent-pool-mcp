import fs from 'node:fs';
import path from 'node:path';

import {
  MAX_ERROR_LENGTH,
  MAX_ERRORS,
  MAX_HISTORY_BYTES,
  MAX_HISTORY_ENTRIES,
  MAX_LOG_BYTES,
  MAX_SUMMARY_LENGTH,
  SHA256_REGEX,
  VerificationContractError,
} from './contracts.js';
import { withFingerprintLock } from './lock.js';
import {
  assertInVerificationRoot,
  getVerificationDir,
  readHistory,
  resolveLogRef,
  truncateFileToTail,
  writePrivateFile,
} from './storage.js';

function validateCompletion({ fingerprint, leaseId, status, exitCode, summary, errors }) {
  if (typeof fingerprint !== 'string' || !SHA256_REGEX.test(fingerprint)) {
    throw new VerificationContractError('fingerprint must be a SHA-256 hex string.');
  }
  if (typeof leaseId !== 'string' || !leaseId.trim() || leaseId.length > 64) {
    throw new VerificationContractError('lease_id is required.');
  }
  if (!['success', 'failure', 'timeout', 'cancelled'].includes(status)) {
    throw new VerificationContractError('Invalid or missing status.');
  }
  if (!Number.isInteger(exitCode)) {
    throw new VerificationContractError('exit_code must be an integer.');
  }
  if (typeof summary !== 'string') {
    throw new VerificationContractError('summary must be a string.');
  }
  if (!Array.isArray(errors) || errors.some(error => typeof error !== 'string')) {
    throw new VerificationContractError('errors must contain only strings.');
  }
}

function removeReferencedLog(verificationDir, entry) {
  if (!entry || !entry.log_ref) return;
  try {
    fs.unlinkSync(resolveLogRef(verificationDir, entry.log_ref));
  } catch {
    // A missing historical log needs no cleanup.
  }
}

function appendHistory({ historyPath, verificationDir, entry }) {
  let entries = readHistory(historyPath);
  entries.push(entry);
  if (entries.length > MAX_HISTORY_ENTRIES) {
    for (let old of entries.slice(0, -MAX_HISTORY_ENTRIES)) {
      removeReferencedLog(verificationDir, old);
    }
    entries = entries.slice(-MAX_HISTORY_ENTRIES);
  }

  let serialized = entries.map(item => JSON.stringify(item)).join('\n') + '\n';
  while (Buffer.byteLength(serialized) > MAX_HISTORY_BYTES && entries.length > 1) {
    removeReferencedLog(verificationDir, entries.shift());
    serialized = entries.map(item => JSON.stringify(item)).join('\n') + '\n';
  }
  writePrivateFile(historyPath, serialized);
}

export async function completeVerification({
  fingerprint,
  lease_id,
  status,
  exit_code,
  summary = '',
  errors = [],
}, env = process.env) {
  validateCompletion({
    fingerprint,
    leaseId: lease_id,
    status,
    exitCode: exit_code,
    summary,
    errors,
  });
  fingerprint = fingerprint.toLowerCase();

  let verificationDir = getVerificationDir(env);
  let leasePath = path.join(verificationDir, 'leases', `${fingerprint}.json`);
  let evidencePath = path.join(verificationDir, 'evidence', `${fingerprint}.json`);
  let historyPath = path.join(verificationDir, 'logs', `${fingerprint}.jsonl`);
  for (let filePath of [leasePath, evidencePath, historyPath]) {
    assertInVerificationRoot(filePath, verificationDir);
  }

  return withFingerprintLock(fingerprint, env, async () => {
    let lease;
    try {
      lease = JSON.parse(fs.readFileSync(leasePath, 'utf8'));
    } catch {
      throw new Error('Lease not found or expired');
    }
    if (lease.lease_id !== lease_id) throw new Error('Lease is mismatched or superseded');
    if (Date.now() > lease.expires_at) throw new Error('Lease has already expired');

    let absoluteLogPath = resolveLogRef(verificationDir, lease.log_ref);
    truncateFileToTail(absoluteLogPath, MAX_LOG_BYTES);
    let boundedSummary = summary.substring(0, MAX_SUMMARY_LENGTH);
    let boundedErrors = errors.slice(0, MAX_ERRORS)
      .map(error => String(error || '').substring(0, MAX_ERROR_LENGTH));
    let isGreen = status === 'success' && exit_code === 0;
    let completedAt = Date.now();

    if (isGreen && lease.cache_policy !== 'non_cacheable') {
      writePrivateFile(evidencePath, JSON.stringify({
        fingerprint,
        status,
        exit_code,
        completed_at: completedAt,
        owner_id: lease.owner_id,
        result: {
          exit_code,
          status,
          errors: boundedErrors,
          summary: boundedSummary || 'Success',
        },
        log_ref: lease.log_ref,
        fingerprint_details: lease.details,
      }, null, 2));
    }

    appendHistory({
      historyPath,
      verificationDir,
      entry: {
        status,
        exit_code,
        completed_at: completedAt,
        owner_id: lease.owner_id,
        log_ref: lease.log_ref,
        summary: boundedSummary || (isGreen ? 'Success' : `Failed: ${exit_code}`),
      },
    });
    try {
      fs.unlinkSync(leasePath);
    } catch {
      // Completion already owns the lease; missing cleanup is harmless.
    }

    return { ok: true, fingerprint, status, exit_code, log_ref: lease.log_ref };
  });
}
