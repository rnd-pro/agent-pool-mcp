/**
 * Provider-neutral verification-evidence registry.
 *
 * @module agent-pool/verification-registry
 */

export { completeVerification } from '../verification/complete.js';
export { VerificationContractError } from '../verification/contracts.js';
export {
  calculateFingerprint,
  getRepositoryIdentity,
  getWorktreeRoot,
  validateAndNormalizePath,
} from '../verification/fingerprint.js';
export { prepareVerification } from '../verification/prepare.js';
export { getVerificationEvidence } from '../verification/status.js';
export { getVerificationDir } from '../verification/storage.js';
