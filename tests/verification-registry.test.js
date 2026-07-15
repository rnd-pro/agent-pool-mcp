import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';

import {
  calculateFingerprint,
  prepareVerification,
  completeVerification,
  getVerificationEvidence,
} from '../src/tools/verification-registry.js';

const TEST_DIR = path.join(os.tmpdir(), `agent-pool-verification-test-${Date.now()}`);
const TEST_CWD = path.join(TEST_DIR, 'project-repo');
const VERIFICATION_DIR = path.join(TEST_DIR, 'verification-evidence-state');

async function waitFor(predicate, timeoutMs = 5000) {
  let deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for child process barrier.');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

function waitForChild(child) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('exit', code => {
      if (code !== 0) {
        reject(new Error(`Child exited with ${code}: ${stderr}`));
        return;
      }
      resolve(JSON.parse(stdout.trim()));
    });
  });
}

describe('verification-evidence-registry', () => {
  let envOverride = {};

  beforeEach(() => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
    fs.mkdirSync(TEST_DIR, { recursive: true });
    fs.mkdirSync(TEST_CWD, { recursive: true });
    fs.mkdirSync(VERIFICATION_DIR, { recursive: true });

    execFileSync('git', ['init', '-q'], { cwd: TEST_CWD, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: TEST_CWD, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: TEST_CWD, stdio: 'ignore' });
    fs.writeFileSync(path.join(TEST_CWD, 'readme.md'), 'initial');
    execFileSync('git', ['add', 'readme.md'], { cwd: TEST_CWD, stdio: 'ignore' });
    execFileSync('git', ['commit', '-q', '-m', 'initial commit'], { cwd: TEST_CWD, stdio: 'ignore' });

    envOverride = {
      ...process.env,
      AGENT_POOL_VERIFICATION_DIR: VERIFICATION_DIR,
    };
  });

  afterEach(() => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('throws structured contract error on validation failures and writes no lease', async () => {
    await assert.rejects(() => prepareVerification({
        check_kind: 'test',
        command: 'npm test',
        cwd: TEST_CWD,
        inputs: [],
        max_age_seconds: 300,
      }, envOverride), error => {
        assert.strictEqual(error.code, 'VERIFICATION_CONTRACT_INVALID');
        return /inputs list must be non-empty/.test(error.message);
      });

    await assert.rejects(() => prepareVerification({
        check_kind: 'test',
        command: 'npm test',
        cwd: TEST_CWD,
        inputs: ['nonexistent.js'],
        max_age_seconds: 300,
      }, envOverride), /Path does not exist or is unreadable/);

    let outsidePath = path.join(TEST_DIR, 'outside.js');
    fs.writeFileSync(outsidePath, 'outside');
    await assert.rejects(() => prepareVerification({
      check_kind: 'test',
      command: 'npm test',
      cwd: TEST_CWD,
      inputs: ['../outside.js'],
      max_age_seconds: 300,
    }, envOverride), /outside worktree root/);

    await assert.rejects(() => getVerificationEvidence({
      check_kind: 'test',
      command: 'npm test',
      cwd: TEST_CWD,
      inputs: [],
      max_age_seconds: 300,
    }, envOverride), /inputs list must be non-empty/);

    await assert.rejects(() => prepareVerification({
      check_kind: 'test',
      command: 'npm test',
      cwd: TEST_CWD,
      inputs: ['readme.md'],
      max_age_seconds: 300,
      cache_policy: 'unknown',
    }, envOverride), /cache_policy/);

    let leasesDir = path.join(VERIFICATION_DIR, 'leases');
    let files = fs.existsSync(leasesDir) ? fs.readdirSync(leasesDir) : [];
    assert.strictEqual(files.length, 0);
  });

  it('prevents path traversal using run_id and derives log name from UUID', async () => {
    fs.writeFileSync(path.join(TEST_CWD, 'index.js'), 'content');

    let res = await prepareVerification({
      check_kind: 'test',
      command: 'npm test',
      cwd: TEST_CWD,
      inputs: ['index.js'],
      run_id: '../../traversal',
      max_age_seconds: 300,
    }, envOverride);

    assert.strictEqual(res.decision, 'run');
    assert.ok(res.lease_id);
    assert.ok(res.log_ref);
    assert.ok(res.log_path);

    // Verify run_id traversal string is not in filenames
    assert.strictEqual(res.log_ref.includes('traversal'), false);
    assert.strictEqual(res.log_path.includes('traversal'), false);

    // Verify files reside strictly under verification root
    let resolvedLease = path.resolve(VERIFICATION_DIR, 'leases', `${res.fingerprint}.json`);
    let resolvedLog = path.resolve(VERIFICATION_DIR, res.log_ref);

    let relLease = path.relative(VERIFICATION_DIR, resolvedLease);
    let relLog = path.relative(VERIFICATION_DIR, resolvedLog);

    assert.strictEqual(relLease.startsWith('..'), false);
    assert.strictEqual(relLog.startsWith('..'), false);
  });

  it('manages opaque log_ref and absolute log_path correctly', async () => {
    fs.writeFileSync(path.join(TEST_CWD, 'index.js'), 'content');

    let res = await prepareVerification({
      check_kind: 'test',
      command: 'npm test',
      cwd: TEST_CWD,
      inputs: ['index.js'],
      max_age_seconds: 300,
    }, envOverride);

    assert.strictEqual(res.log_ref, `logs/${res.fingerprint}-${res.lease_id}.log`);
    assert.strictEqual(res.log_path, path.join(VERIFICATION_DIR, res.log_ref));
  });

  it('bounds log file size, summary, errors, and unlinks old log files', async () => {
    fs.writeFileSync(path.join(TEST_CWD, 'index.js'), 'content');

    // Perform 12 completions to force log unlinking (bound count = 10)
    let fingerprint;
    let logRefs = [];

    for (let i = 0; i < 12; i++) {
      let res = await prepareVerification({
        check_kind: 'test',
        command: 'npm test',
        cwd: TEST_CWD,
        inputs: ['index.js'],
        run_id: `run-${i}`,
        max_age_seconds: 300,
        cache_policy: 'force_fresh',
      }, envOverride);

      fingerprint = res.fingerprint;
      logRefs.push(res.log_ref);

      fs.writeFileSync(res.log_path, `${'a'.repeat(10000)}${'z'.repeat(10000)}`, 'utf8');

      await completeVerification({
        fingerprint,
        lease_id: res.lease_id,
        status: 'success',
        exit_code: 0,
        summary: 's'.repeat(1000), // exceeds 500 boundary
        errors: ['e'.repeat(1000)], // exceeds 500 boundary
      }, envOverride);
    }

    let latestLogPath = path.join(VERIFICATION_DIR, logRefs[11]);
    let stats = fs.statSync(latestLogPath);
    assert.strictEqual(stats.size, 10000);
    assert.strictEqual(fs.readFileSync(latestLogPath, 'utf8'), 'z'.repeat(10000));

    let oldLog0 = path.join(VERIFICATION_DIR, logRefs[0]);
    let oldLog1 = path.join(VERIFICATION_DIR, logRefs[1]);
    assert.strictEqual(fs.existsSync(oldLog0), false);
    assert.strictEqual(fs.existsSync(oldLog1), false);

    let evidencePath = path.join(VERIFICATION_DIR, 'evidence', `${fingerprint}.json`);
    let evidence = JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
    assert.strictEqual(evidence.result.summary.length, 500);
    assert.strictEqual(evidence.result.errors[0].length, 500);
  });

  it('invalidates fingerprints when command, repository, inputs, controls, or modes change', () => {
    let inputPath = path.join(TEST_CWD, 'index.js');
    let controlPath = path.join(TEST_CWD, 'test.config.json');
    fs.writeFileSync(inputPath, 'input-v1');
    fs.writeFileSync(controlPath, '{"mode":"v1"}');
    let params = {
      check_kind: 'test',
      command: 'npm test',
      cwd: TEST_CWD,
      inputs: ['index.js'],
      control_files: ['test.config.json'],
    };
    let base = calculateFingerprint(params).fingerprint;

    assert.notStrictEqual(calculateFingerprint({ ...params, command: 'npm test -- --watch' }).fingerprint, base);

    fs.writeFileSync(inputPath, 'input-v2');
    assert.notStrictEqual(calculateFingerprint(params).fingerprint, base);
    fs.writeFileSync(inputPath, 'input-v1');

    fs.writeFileSync(controlPath, '{"mode":"v2"}');
    assert.notStrictEqual(calculateFingerprint(params).fingerprint, base);
    fs.writeFileSync(controlPath, '{"mode":"v1"}');

    if (process.platform !== 'win32') {
      fs.chmodSync(inputPath, 0o755);
      assert.notStrictEqual(calculateFingerprint(params).fingerprint, base);
      fs.chmodSync(inputPath, 0o644);
    }

    let secondRepo = path.join(TEST_DIR, 'second-repo');
    fs.mkdirSync(secondRepo);
    execFileSync('git', ['init', '-q'], { cwd: secondRepo, stdio: 'ignore' });
    fs.writeFileSync(path.join(secondRepo, 'index.js'), 'input-v1');
    fs.writeFileSync(path.join(secondRepo, 'test.config.json'), '{"mode":"v1"}');
    assert.notStrictEqual(calculateFingerprint({ ...params, cwd: secondRepo }).fingerprint, base);

    let prototypePath = path.join(TEST_CWD, '__proto__');
    fs.writeFileSync(prototypePath, 'prototype-v1');
    let prototypeParams = { ...params, inputs: ['__proto__'] };
    let prototypeFingerprint = calculateFingerprint(prototypeParams).fingerprint;
    fs.writeFileSync(prototypePath, 'prototype-v2');
    assert.notStrictEqual(calculateFingerprint(prototypeParams).fingerprint, prototypeFingerprint);
  });

  it('rejects invalid env_fingerprints and fingerprints pre-hashed overrides', () => {
    assert.throws(() => {
      calculateFingerprint({
        check_kind: 'test',
        command: 'npm test',
        cwd: TEST_CWD,
        inputs: ['readme.md'],
        env_keys: ['VAR'],
        env_fingerprints: { VAR: 'invalid-non-sha256' },
      });
    }, /not a valid SHA-256 hex string/);

    let firstHash = crypto.createHash('sha256').update('first').digest('hex');
    let secondHash = crypto.createHash('sha256').update('second').digest('hex');
    let fp = calculateFingerprint({
      check_kind: 'test',
      command: 'npm test',
      cwd: TEST_CWD,
      inputs: ['readme.md'],
      env_fingerprints: { VAR: firstHash },
    });
    let changed = calculateFingerprint({
      check_kind: 'test',
      command: 'npm test',
      cwd: TEST_CWD,
      inputs: ['readme.md'],
      env_fingerprints: { VAR: secondHash },
    });

    assert.strictEqual(fp.details.env_hashes[0][1], firstHash);
    assert.notStrictEqual(fp.fingerprint, changed.fingerprint);

    let prototypeEnv = JSON.parse(`{"__proto__":"${firstHash}"}`);
    let prototypeFp = calculateFingerprint({
      check_kind: 'test',
      command: 'npm test',
      cwd: TEST_CWD,
      inputs: ['readme.md'],
      env_fingerprints: prototypeEnv,
    });
    assert.deepEqual(prototypeFp.details.env_hashes, [['__proto__', firstHash]]);
  });

  it('returns get state wait on live lease before evidence, and stale on expired age', async () => {
    fs.writeFileSync(path.join(TEST_CWD, 'index.js'), 'content');

    let res = await prepareVerification({
      check_kind: 'test',
      command: 'npm test',
      cwd: TEST_CWD,
      inputs: ['index.js'],
      max_age_seconds: 300,
    }, envOverride);

    let stateLease = await getVerificationEvidence({
      check_kind: 'test',
      command: 'npm test',
      cwd: TEST_CWD,
      inputs: ['index.js'],
      max_age_seconds: 300,
    }, envOverride);

    assert.strictEqual(stateLease.state, 'wait');
    assert.strictEqual(stateLease.log_ref, res.log_ref);
    assert.ok(stateLease.retry_after_seconds >= 1);

    await completeVerification({
      fingerprint: res.fingerprint.toUpperCase(),
      lease_id: res.lease_id,
      status: 'success',
      exit_code: 0,
    }, envOverride);

    let stateReusable = await getVerificationEvidence({
      check_kind: 'test',
      command: 'npm test',
      cwd: TEST_CWD,
      inputs: ['index.js'],
      max_age_seconds: 300,
    }, envOverride);

    assert.strictEqual(stateReusable.state, 'reusable');

    let evidencePath = path.join(VERIFICATION_DIR, 'evidence', `${res.fingerprint}.json`);
    let evidence = JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
    evidence.completed_at = Date.now() - 1000;
    fs.writeFileSync(evidencePath, JSON.stringify(evidence), 'utf8');

    let stateStale = await getVerificationEvidence({
      check_kind: 'test',
      command: 'npm test',
      cwd: TEST_CWD,
      inputs: ['index.js'],
      max_age_seconds: 0,
    }, envOverride);

    assert.strictEqual(stateStale.state, 'stale');
  });

  it('refuses semantically invalid green evidence', async () => {
    let params = {
      check_kind: 'test',
      command: 'npm test',
      cwd: TEST_CWD,
      inputs: ['readme.md'],
      max_age_seconds: 300,
    };
    let prepared = await prepareVerification(params, envOverride);
    await completeVerification({
      fingerprint: prepared.fingerprint,
      lease_id: prepared.lease_id,
      status: 'success',
      exit_code: 0,
    }, envOverride);

    let evidencePath = path.join(VERIFICATION_DIR, 'evidence', `${prepared.fingerprint}.json`);
    let evidence = JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
    evidence.status = 'failure';
    evidence.exit_code = 1;
    fs.writeFileSync(evidencePath, JSON.stringify(evidence));

    await assert.rejects(
      () => getVerificationEvidence(params, envOverride),
      /evidence state is invalid/,
    );
    await assert.rejects(
      () => prepareVerification(params, envOverride),
      /evidence state is invalid/,
    );
  });

  it('does not reuse older green evidence after a forced run fails', async () => {
    let params = {
      check_kind: 'test',
      command: 'npm test',
      cwd: TEST_CWD,
      inputs: ['readme.md'],
      max_age_seconds: 300,
    };
    let initial = await prepareVerification(params, envOverride);
    await completeVerification({
      fingerprint: initial.fingerprint,
      lease_id: initial.lease_id,
      status: 'success',
      exit_code: 0,
    }, envOverride);

    let forced = await prepareVerification({ ...params, cache_policy: 'force_fresh' }, envOverride);
    await completeVerification({
      fingerprint: forced.fingerprint,
      lease_id: forced.lease_id,
      status: 'failure',
      exit_code: 1,
      summary: 'targeted test failed',
    }, envOverride);

    let state = await getVerificationEvidence(params, envOverride);
    assert.strictEqual(state.state, 'missing');
    assert.strictEqual(state.latest_run.status, 'failure');
    assert.strictEqual(state.latest_run.log_ref, forced.log_ref);
  });

  it('rejects mismatched, superseded, or expired leases in completeVerification', async () => {
    fs.writeFileSync(path.join(TEST_CWD, 'index.js'), 'content');

    await assert.rejects(() => completeVerification({
      fingerprint: '../../outside',
      lease_id: 'lease',
      status: 'success',
      exit_code: 0,
    }, envOverride), /SHA-256/);

    await assert.rejects(() => prepareVerification({
      check_kind: 'test',
      command: 'npm test',
      cwd: TEST_CWD,
      inputs: ['index.js'],
      max_age_seconds: 300,
      lease_ttl: -1,
    }, envOverride), /lease_ttl/);

    let res = await prepareVerification({
      check_kind: 'test',
      command: 'npm test',
      cwd: TEST_CWD,
      inputs: ['index.js'],
      max_age_seconds: 300,
    }, envOverride);

    let leasePath = path.join(VERIFICATION_DIR, 'leases', `${res.fingerprint}.json`);
    let lease = JSON.parse(fs.readFileSync(leasePath, 'utf8'));
    lease.expires_at = Date.now() - 1;
    fs.writeFileSync(leasePath, JSON.stringify(lease), 'utf8');

    let expiredState = await getVerificationEvidence({
      check_kind: 'test',
      command: 'npm test',
      cwd: TEST_CWD,
      inputs: ['index.js'],
      max_age_seconds: 300,
    }, envOverride);
    assert.strictEqual(expiredState.state, 'expired');

    await assert.rejects(async () => {
      await completeVerification({
        fingerprint: res.fingerprint,
        lease_id: res.lease_id,
        status: 'success',
        exit_code: 0,
      }, envOverride);
    }, /Lease has already expired/);

    fs.unlinkSync(leasePath);

    let res2 = await prepareVerification({
      check_kind: 'test',
      command: 'npm test',
      cwd: TEST_CWD,
      inputs: ['index.js'],
      max_age_seconds: 300,
    }, envOverride);

    await assert.rejects(async () => {
      await completeVerification({
        fingerprint: res2.fingerprint,
        lease_id: 'mismatched-id',
        status: 'success',
        exit_code: 0,
      }, envOverride);
    }, /Lease is mismatched or superseded/);
  });

  it('ensures directory permissions are enforced on existing and new folders', async () => {
    fs.writeFileSync(path.join(TEST_CWD, 'index.js'), 'content');
    let logsDir = path.join(VERIFICATION_DIR, 'logs');
    fs.mkdirSync(logsDir, { recursive: true });
    if (process.platform !== 'win32') {
      fs.chmodSync(VERIFICATION_DIR, 0o755);
      fs.chmodSync(logsDir, 0o755);
    }

    let res = await prepareVerification({
      check_kind: 'test',
      command: 'npm test',
      cwd: TEST_CWD,
      inputs: ['index.js'],
      max_age_seconds: 300,
    }, envOverride);

    let leasesDir = path.join(VERIFICATION_DIR, 'leases');
    if (process.platform !== 'win32') {
      assert.strictEqual(fs.statSync(VERIFICATION_DIR).mode & 0o777, 0o700);
      assert.strictEqual(fs.statSync(logsDir).mode & 0o777, 0o700);
      assert.strictEqual(fs.statSync(leasesDir).mode & 0o777, 0o700);
      assert.strictEqual(fs.statSync(res.log_path).mode & 0o777, 0o600);
    }
  });

  it('throws validation error when an input directory contains a symlink', {
    skip: process.platform === 'win32',
  }, async () => {
    let subDir = path.join(TEST_CWD, 'subdir');
    fs.mkdirSync(subDir);
    let outsidePath = path.join(TEST_DIR, 'outside.js');
    fs.writeFileSync(outsidePath, 'outside');

    fs.symlinkSync(outsidePath, path.join(subDir, 'link.js'));

    await assert.rejects(async () => {
      await prepareVerification({
        check_kind: 'test',
        command: 'npm test',
        cwd: TEST_CWD,
        inputs: ['subdir'],
        max_age_seconds: 300,
      }, envOverride);
    }, /symbolic links/);
  });

  it('verifies Git worktree-root stability across linked worktrees', () => {
    let worktreePath = path.join(TEST_DIR, 'linked-worktree');
    execFileSync('git', ['worktree', 'add', '--detach', worktreePath, 'HEAD'], {
      cwd: TEST_CWD,
      stdio: 'ignore',
    });

    fs.writeFileSync(path.join(TEST_CWD, 'index.js'), 'content');
    fs.writeFileSync(path.join(worktreePath, 'index.js'), 'content');

    let fp1 = calculateFingerprint({
      check_kind: 'test',
      command: 'npm test',
      cwd: TEST_CWD,
      inputs: ['index.js'],
    });

    let fp2 = calculateFingerprint({
      check_kind: 'test',
      command: 'npm test',
      cwd: worktreePath,
      inputs: ['index.js'],
    });

    assert.strictEqual(fp1.fingerprint, fp2.fingerprint);
  });

  it('serializes prepare_verification calls using child Node processes and barrier', async () => {
    fs.writeFileSync(path.join(TEST_CWD, 'index.js'), 'content');

    let barrierPath = path.join(TEST_DIR, 'barrier.signal');
    let readyDir = path.join(TEST_DIR, 'ready');
    fs.mkdirSync(readyDir);
    fs.writeFileSync(barrierPath, 'wait');

    let registryUrl = pathToFileURL(path.resolve('src/tools/verification-registry.js')).href;
    let scriptContent = `
import fs from 'node:fs';
import path from 'node:path';
import { prepareVerification } from ${JSON.stringify(registryUrl)};

let args = JSON.parse(process.argv[1]);
fs.writeFileSync(path.join(args.readyDir, String(process.pid)), 'ready');
let sleeper = new Int32Array(new SharedArrayBuffer(4));
while (fs.existsSync(args.barrierPath)) Atomics.wait(sleeper, 0, 0, 5);
let result = await prepareVerification(args.params, args.env);
process.stdout.write(JSON.stringify(result));
`;

    let childArgs = {
      barrierPath,
      readyDir,
      params: {
        check_kind: 'test',
        command: 'npm test',
        cwd: TEST_CWD,
        inputs: ['index.js'],
        max_age_seconds: 300,
      },
      env: { AGENT_POOL_VERIFICATION_DIR: VERIFICATION_DIR },
    };

    let nodeArgs = ['--input-type=module', '--eval', scriptContent, JSON.stringify(childArgs)];
    let p1 = spawn(process.execPath, nodeArgs);
    let p2 = spawn(process.execPath, nodeArgs);
    let firstResult = waitForChild(p1);
    let secondResult = waitForChild(p2);
    let bothResults = Promise.all([firstResult, secondResult]);

    await Promise.race([
      waitFor(() => fs.readdirSync(readyDir).length === 2, 20000),
      bothResults.then(() => { throw new Error('Children exited before reaching the barrier.'); }),
    ]);
    fs.unlinkSync(barrierPath);
    let [res1, res2] = await bothResults;

    let decisions = [res1.decision, res2.decision];
    assert.deepEqual(decisions.sort(), ['run', 'wait']);
  });
});
