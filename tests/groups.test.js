import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TEST_CWD = path.join(os.tmpdir(), `agent-pool-groups-test-${Date.now()}`);
const TEST_HOME = path.join(TEST_CWD, 'portal-home');

describe('groups.js', () => {
  let createGroup, listGroups, getGroup, deleteGroup, getGroupNextProfile;

  before(async () => {
    process.env.AGENT_PORTAL_CONFIG_DIR = TEST_HOME;
    const mod = await import('../src/tools/groups.js');
    createGroup = mod.createGroup;
    listGroups = mod.listGroups;
    getGroup = mod.getGroup;
    deleteGroup = mod.deleteGroup;
    getGroupNextProfile = mod.getGroupNextProfile;

    if (!fs.existsSync(TEST_CWD)) {
      fs.mkdirSync(TEST_CWD, { recursive: true });
    }
  });

  after(() => {
    delete process.env.AGENT_PORTAL_CONFIG_DIR;
    if (fs.existsSync(TEST_CWD)) {
      fs.rmSync(TEST_CWD, { recursive: true, force: true });
    }
  });

  it('createGroup creates a group with rotation settings', () => {
    const res = createGroup(TEST_CWD, {
      name: 'test-group',
      rotation_mode: 'round_robin',
      profiles: [
        { provider: 'codex', model: 'modelA' },
        { provider: 'codex', model: 'modelB' },
        { provider: 'codex', model: 'modelC' },
      ],
      approval_mode: 'auto_edit',
      timeout: 450,
    });

    assert.strictEqual(res.name, 'test-group');
    assert.strictEqual(res.created, true);

    const group = getGroup(TEST_CWD, 'test-group');
    assert.strictEqual(group.rotation_mode, 'round_robin');
    assert.deepStrictEqual(group.profiles, [
      { provider: 'codex', model: 'modelA' },
      { provider: 'codex', model: 'modelB' },
      { provider: 'codex', model: 'modelC' },
    ]);
    assert.equal('fallback_profiles' in group, false);
    assert.strictEqual(group.approval_mode, 'auto_edit');
    assert.strictEqual(group.timeout, 450);
  });

  it('getGroupNextProfile with error_fallback always returns the first ordered profile', () => {
    createGroup(TEST_CWD, {
      name: 'error-group',
      rotation_mode: 'error_fallback',
      profiles: [
        { provider: 'claude', model: 'primary' },
        { provider: 'claude', model: 'secondary' },
      ],
    });

    assert.deepStrictEqual(getGroupNextProfile(TEST_CWD, 'error-group'), {
      provider: 'claude',
      model: 'primary',
      profile: { provider: 'claude', model: 'primary' },
    });
    assert.deepStrictEqual(getGroupNextProfile(TEST_CWD, 'error-group'), {
      provider: 'claude',
      model: 'primary',
      profile: { provider: 'claude', model: 'primary' },
    });
  });

  it('getGroupNextProfile with round_robin rotates cyclically and persists', () => {
    assert.strictEqual(getGroupNextProfile(TEST_CWD, 'test-group').model, 'modelA');
    assert.strictEqual(getGroupNextProfile(TEST_CWD, 'test-group').model, 'modelB');
    assert.strictEqual(getGroupNextProfile(TEST_CWD, 'test-group').model, 'modelC');
    assert.strictEqual(getGroupNextProfile(TEST_CWD, 'test-group').model, 'modelA');

    // Check persistence in file
    const stateFile = path.join(TEST_HOME, 'resource-group-states.json');
    assert.ok(fs.existsSync(stateFile));
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
    assert.strictEqual(state['test-group'].currentIndex, 1);
  });

  it('getGroupNextProfile resolves provider/model profiles', () => {
    createGroup(TEST_CWD, {
      name: 'profile-group',
      rotation_mode: 'round_robin',
      profiles: [
        { provider: 'codex', model: 'gpt-5.5', reasoningEffort: 'xhigh' },
        { provider: 'opencode', model: 'openrouter/test-model' },
      ],
    });

    assert.deepStrictEqual(getGroupNextProfile(TEST_CWD, 'profile-group'), {
      provider: 'codex',
      model: 'gpt-5.5',
      profile: { provider: 'codex', model: 'gpt-5.5', reasoningEffort: 'xhigh' },
    });
    assert.deepStrictEqual(getGroupNextProfile(TEST_CWD, 'profile-group'), {
      provider: 'opencode',
      model: 'openrouter/test-model',
      profile: { provider: 'opencode', model: 'openrouter/test-model' },
    });
  });

  it('listGroups and getGroup basic CRUD', () => {
    const list = listGroups(TEST_CWD);
    assert.strictEqual(list.length, 3); // test-group, error-group, profile-group
    
    assert.ok(list.find(g => g.name === 'test-group'));
  });

  it('deleteGroup removes the group', () => {
    const deleted = deleteGroup(TEST_CWD, 'error-group');
    assert.strictEqual(deleted, true);
    
    const group = getGroup(TEST_CWD, 'error-group');
    assert.strictEqual(group, null);
    
    const list = listGroups(TEST_CWD);
    assert.strictEqual(list.length, 2);
  });
});
