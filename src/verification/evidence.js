import fs from 'node:fs';

export function readGreenEvidence(evidencePath, expectedFingerprint) {
  if (!fs.existsSync(evidencePath)) return null;

  let evidence;
  try {
    evidence = JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
  } catch {
    throw new Error('Verification evidence state is unreadable.');
  }

  let valid = evidence
    && evidence.fingerprint === expectedFingerprint
    && evidence.status === 'success'
    && evidence.exit_code === 0
    && Number.isFinite(evidence.completed_at)
    && evidence.result?.status === 'success'
    && evidence.result?.exit_code === 0;
  if (!valid) throw new Error('Verification evidence state is invalid.');
  return evidence;
}
