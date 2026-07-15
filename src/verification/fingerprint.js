import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import {
  MAX_CHECK_KIND_LENGTH,
  MAX_COMMAND_LENGTH,
  MAX_CONTROL_PATHS,
  MAX_ENV_KEYS,
  MAX_INPUT_PATHS,
  MAX_PATH_LENGTH,
  SHA256_REGEX,
  VerificationContractError,
} from './contracts.js';
import { isPathInside } from './path.js';

function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

export function getRepositoryIdentity(cwd) {
  let resolvedCwd = resolveCwd(cwd);
  try {
    let gitCommonDir = execFileSync('git', ['rev-parse', '--git-common-dir'], {
      cwd: resolvedCwd,
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
      timeout: 2000,
    }).trim();
    return fs.realpathSync(path.resolve(resolvedCwd, gitCommonDir));
  } catch {
    return resolvedCwd;
  }
}

export function getWorktreeRoot(cwd) {
  let resolvedCwd = resolveCwd(cwd);
  try {
    let toplevel = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: resolvedCwd,
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
      timeout: 2000,
    }).trim();
    return fs.realpathSync(toplevel);
  } catch {
    return resolvedCwd;
  }
}

function resolveCwd(cwd) {
  try {
    return fs.realpathSync(path.resolve(cwd));
  } catch {
    throw new VerificationContractError('cwd does not exist or is unreadable.');
  }
}

function collectFiles(dirPath) {
  let results = [];
  for (let entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
    let fullPath = path.join(dirPath, entry.name);
    let stats = fs.lstatSync(fullPath);
    if (stats.isSymbolicLink()) {
      throw new VerificationContractError('Input directories must not contain symbolic links.');
    }
    if (entry.isDirectory()) results.push(...collectFiles(fullPath));
    else if (entry.isFile()) results.push(fullPath);
    else throw new VerificationContractError('Input directories must contain only regular files and directories.');
  }
  return results;
}

export function validateAndNormalizePath(baseDir, worktreeRoot, inputPath) {
  if (typeof inputPath !== 'string' || !inputPath) {
    throw new VerificationContractError('Path must be a non-empty string.');
  }
  if (inputPath.length > MAX_PATH_LENGTH) {
    throw new VerificationContractError(`Path must not exceed ${MAX_PATH_LENGTH} characters.`);
  }

  let absolutePath = path.resolve(baseDir, inputPath);
  let stats;
  try {
    stats = fs.lstatSync(absolutePath);
  } catch {
    throw new VerificationContractError(`Path does not exist or is unreadable: "${inputPath}"`);
  }
  if (stats.isSymbolicLink()) {
    throw new VerificationContractError(`Forbidden symlink encountered: "${inputPath}"`);
  }

  let realPath = fs.realpathSync(absolutePath);
  if (!isPathInside(worktreeRoot, realPath)) {
    throw new VerificationContractError(`Path lies outside worktree root: "${inputPath}"`);
  }
  stats = fs.statSync(realPath);
  if (!stats.isFile() && !stats.isDirectory()) {
    throw new VerificationContractError(`Path is neither a regular file nor a directory: "${inputPath}"`);
  }
  return {
    realPath,
    relativePath: path.relative(worktreeRoot, realPath),
    stats,
  };
}

function hashPath(worktreeRoot, relativePath) {
  let absolutePath = path.resolve(worktreeRoot, relativePath);
  let stats = fs.statSync(absolutePath);
  let hashes = Object.create(null);
  if (stats.isDirectory()) {
    hashes[`${relativePath}/`] = { hash: sha256('directory'), mode: stats.mode };
    for (let filePath of collectFiles(absolutePath).sort()) {
      let realPath = fs.realpathSync(filePath);
      if (!isPathInside(worktreeRoot, realPath)) {
        throw new VerificationContractError('Input directory child escapes the worktree root.');
      }
      let relativeFile = path.relative(worktreeRoot, realPath);
      let fileStats = fs.statSync(realPath);
      hashes[relativeFile] = { hash: sha256(fs.readFileSync(realPath)), mode: fileStats.mode };
    }
  } else {
    hashes[relativePath] = { hash: sha256(fs.readFileSync(absolutePath)), mode: stats.mode };
  }
  return hashes;
}

function validateContract({ check_kind, command, inputs, control_files, env_keys, env_fingerprints }) {
  if (typeof check_kind !== 'string' || !check_kind.trim()) {
    throw new VerificationContractError('check_kind must be a non-empty string.');
  }
  if (check_kind.length > MAX_CHECK_KIND_LENGTH) {
    throw new VerificationContractError(`check_kind must not exceed ${MAX_CHECK_KIND_LENGTH} characters.`);
  }
  if (typeof command !== 'string' || !command.trim()) {
    throw new VerificationContractError('command must be a non-empty string.');
  }
  if (command.length > MAX_COMMAND_LENGTH) {
    throw new VerificationContractError(`command must not exceed ${MAX_COMMAND_LENGTH} characters.`);
  }
  if (!Array.isArray(inputs) || !inputs.length) {
    throw new VerificationContractError('inputs list must be non-empty.');
  }
  if (!Array.isArray(control_files) || !Array.isArray(env_keys)) {
    throw new VerificationContractError('control_files and env_keys must be arrays.');
  }
  if (inputs.length > MAX_INPUT_PATHS || control_files.length > MAX_CONTROL_PATHS) {
    throw new VerificationContractError('Verification path manifest is too large.');
  }
  if (!env_fingerprints || Array.isArray(env_fingerprints) || typeof env_fingerprints !== 'object') {
    throw new VerificationContractError('env_fingerprints must be an object.');
  }
}

export function calculateFingerprint({
  check_kind,
  command,
  cwd,
  inputs,
  control_files = [],
  env_keys = [],
  env_fingerprints = {},
}) {
  validateContract({ check_kind, command, inputs, control_files, env_keys, env_fingerprints });
  let resolvedCwd = resolveCwd(cwd);
  let worktreeRoot = getWorktreeRoot(resolvedCwd);
  let repoId = sha256(getRepositoryIdentity(resolvedCwd));

  let normalizedInputs = [...new Set(inputs.map(item => (
    validateAndNormalizePath(resolvedCwd, worktreeRoot, item).relativePath
  )))].sort();
  let normalizedControls = [...new Set(control_files.map(item => (
    validateAndNormalizePath(resolvedCwd, worktreeRoot, item).relativePath
  )))].sort();
  let inputHashes = Object.assign(
    Object.create(null),
    ...normalizedInputs.map(item => hashPath(worktreeRoot, item)),
  );
  let controlHashes = Object.assign(
    Object.create(null),
    ...normalizedControls.map(item => hashPath(worktreeRoot, item)),
  );

  let envHashes = Object.create(null);
  let environmentKeys = [...new Set([...env_keys, ...Object.keys(env_fingerprints)])].sort();
  if (environmentKeys.length > MAX_ENV_KEYS) {
    throw new VerificationContractError(`Environment fingerprint set must not exceed ${MAX_ENV_KEYS} keys.`);
  }
  for (let key of environmentKeys) {
    if (typeof key !== 'string' || !key) {
      throw new VerificationContractError('Environment fingerprint keys must be non-empty strings.');
    }
    if (env_fingerprints[key] !== undefined) {
      let hash = env_fingerprints[key];
      if (typeof hash !== 'string' || !SHA256_REGEX.test(hash)) {
        throw new VerificationContractError(`env_fingerprint for key "${key}" is not a valid SHA-256 hex string.`);
      }
      envHashes[key] = hash.toLowerCase();
    } else {
      envHashes[key] = sha256(process.env[key] || '');
    }
  }

  let platform = { node: process.version, platform: process.platform, arch: process.arch };
  let canonical = {
    check_kind,
    command_hash: sha256(command),
    relative_cwd: path.relative(worktreeRoot, resolvedCwd),
    repo_id: repoId,
    inputs: Object.keys(inputHashes).sort().map(key => [key, inputHashes[key].hash, inputHashes[key].mode]),
    control_files: Object.keys(controlHashes).sort().map(key => [key, controlHashes[key].hash, controlHashes[key].mode]),
    platform,
    env_hashes: Object.keys(envHashes).sort().map(key => [key, envHashes[key]]),
  };
  return {
    fingerprint: sha256(JSON.stringify(canonical)),
    details: {
      check_kind,
      command_hash: canonical.command_hash,
      relative_cwd: canonical.relative_cwd,
      repo_id: repoId,
      input_manifest_hash: sha256(JSON.stringify(canonical.inputs)),
      input_file_count: canonical.inputs.length,
      control_manifest_hash: sha256(JSON.stringify(canonical.control_files)),
      control_file_count: canonical.control_files.length,
      platform,
      env_hashes: canonical.env_hashes,
    },
  };
}
