import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { TaskSecretStore, TASK_SECRET_ENV } from '../src/runner/task-secret-store.js';

describe('TaskSecretStore', () => {
  let dir;
  let store;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-secret-'));
    store = new TaskSecretStore({ dir });
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('mints a secret bound to the server-assigned slug and resolves it', () => {
    let { secret } = store.mint({
      taskId: 'task-1',
      admissionId: 'adm-1',
      serverAssignedSlug: 'backend-engineer',
    });
    assert.equal(typeof secret, 'string');
    assert.ok(secret.length >= 32);

    let binding = store.resolve(secret);
    assert.deepEqual(binding, {
      taskId: 'task-1',
      admissionId: 'adm-1',
      serverAssignedSlug: 'backend-engineer',
    });
  });

  it('an unknown or absent secret resolves to no binding (least privilege)', () => {
    store.mint({ taskId: 'task-1', serverAssignedSlug: 'backend-engineer' });
    assert.equal(store.resolve('not-a-real-secret'), null);
    assert.equal(store.resolve(''), null);
    assert.equal(store.resolve(undefined), null);
    assert.equal(store.resolve(null), null);
  });

  it('never persists the plaintext secret on disk (hashed at rest)', () => {
    let { secret } = store.mint({ taskId: 'task-1', serverAssignedSlug: 'agent-x' });
    let onDisk = fs.readFileSync(path.join(dir, 'task-secrets.json'), 'utf8');
    assert.ok(!onDisk.includes(secret), 'plaintext secret must not appear in the persisted map');
    // The verified slug is durable so the binding survives a restart.
    assert.ok(onDisk.includes('agent-x'));
    // A fresh store reading the same dir still resolves the binding.
    let reopened = new TaskSecretStore({ dir });
    assert.equal(reopened.resolve(secret).serverAssignedSlug, 'agent-x');
  });

  it('two mints produce distinct secrets and bindings', () => {
    let a = store.mint({ taskId: 'task-a', serverAssignedSlug: 'role-a' });
    let b = store.mint({ taskId: 'task-b', serverAssignedSlug: 'role-b' });
    assert.notEqual(a.secret, b.secret);
    assert.equal(store.resolve(a.secret).serverAssignedSlug, 'role-a');
    assert.equal(store.resolve(b.secret).serverAssignedSlug, 'role-b');
  });

  it('mint with no slug binds null (unverified → no privileged slug)', () => {
    let { secret } = store.mint({ taskId: 'task-1' });
    let binding = store.resolve(secret);
    assert.equal(binding.serverAssignedSlug, null);
  });

  it('revoke removes a binding and is idempotent', () => {
    let { secret } = store.mint({ taskId: 'task-1', serverAssignedSlug: 'role' });
    assert.equal(store.revoke(secret).removed, true);
    assert.equal(store.resolve(secret), null);
    assert.equal(store.revoke(secret).removed, false);
  });

  it('expired bindings do not resolve and are pruned', () => {
    let clock = 1000;
    let ttlStore = new TaskSecretStore({ dir, ttlMs: 50, now: () => clock });
    let { secret } = ttlStore.mint({ taskId: 'task-1', serverAssignedSlug: 'role' });
    assert.ok(ttlStore.resolve(secret));
    clock += 100; // past TTL
    assert.equal(ttlStore.resolve(secret), null);
    let { removed } = ttlStore.prune();
    assert.equal(removed, 1);
  });

  it('requires a taskId to mint', () => {
    assert.throws(() => store.mint({ serverAssignedSlug: 'role' }), /taskId is required/);
  });

  it('exposes the spawn env var name', () => {
    assert.equal(TASK_SECRET_ENV, 'AGENT_PORTAL_TASK_SECRET');
  });
});

describe('spawn env secret injection contract', () => {
  // Mirrors how every runner builds its child env: spread the parent env, then
  // set the secret key last and unconditionally. The minted secret must win and
  // an inherited parent secret must be scrubbed (set undefined → dropped by the
  // child) so a nested spawn can never impersonate the parent's verified slug.
  function buildChildEnv(parentEnv, taskSecret) {
    return {
      ...parentEnv,
      [TASK_SECRET_ENV]: taskSecret || undefined,
    };
  }

  it('the minted secret overrides any inherited value', () => {
    let env = buildChildEnv({ [TASK_SECRET_ENV]: 'parent-secret' }, 'minted-secret');
    assert.equal(env[TASK_SECRET_ENV], 'minted-secret');
  });

  it('a falsy secret scrubs the inherited value (set undefined)', () => {
    let env = buildChildEnv({ [TASK_SECRET_ENV]: 'parent-secret' }, null);
    assert.equal(env[TASK_SECRET_ENV], undefined);
  });
});
