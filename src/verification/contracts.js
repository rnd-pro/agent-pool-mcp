export const SHA256_REGEX = /^[0-9a-f]{64}$/i;
export const CACHE_POLICIES = new Set(['default', 'force_fresh', 'non_cacheable']);
export const MAX_CHECK_KIND_LENGTH = 100;
export const MAX_COMMAND_LENGTH = 8192;
export const MAX_OWNER_LENGTH = 100;
export const MAX_SUMMARY_LENGTH = 500;
export const MAX_ERROR_LENGTH = 500;
export const MAX_ERRORS = 10;
export const MAX_LOG_BYTES = 10000;
export const MAX_HISTORY_BYTES = 50000;
export const MAX_HISTORY_ENTRIES = 10;
export const MAX_LEASE_TTL_SECONDS = 86400;
export const MAX_INPUT_PATHS = 1024;
export const MAX_CONTROL_PATHS = 256;
export const MAX_ENV_KEYS = 128;
export const MAX_PATH_LENGTH = 4096;

export class VerificationContractError extends Error {
  constructor(message) {
    super(message);
    this.name = 'VerificationContractError';
    this.code = 'VERIFICATION_CONTRACT_INVALID';
  }
}
