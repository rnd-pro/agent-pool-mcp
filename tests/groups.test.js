import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TEST_CWD = path.join(os.tmpdir(), `agent-pool-groups-test-${Date.now()}`);
const TEST_HOME = path.join(TEST_CWD, 'portal-home');

describe('groups.js', () => {
  let createGroup, listGroups, getGroup, deleteGroup, getGroupNextProfile;
  let createTask, completeTask;
  let callTool;
  let previousConfigDir;
  let previousPoolDepth;

  before(async () => {
    previousConfigDir = process.env.AGENT_PORTAL_CONFIG_DIR;
    previousPoolDepth = process.env.AGENT_POOL_DEPTH;
    process.env.AGENT_PORTAL_CONFIG_DIR = TEST_HOME;
    process.env.AGENT_POOL_DEPTH = '0';

    const mod = await import('../src/tools/groups.js');
    createGroup = mod.createGroup;
    listGroups = mod.listGroups;
    getGroup = mod.getGroup;
    deleteGroup = mod.deleteGroup;
    getGroupNextProfile = mod.getGroupNextProfile;

    let serverMod = await import('../src/server.js');
    let resultsMod = await import('../src/tools/results.js');
    createTask = resultsMod.createTask;
    completeTask = resultsMod.completeTask;
    resultsMod.setNotifyCallback(null);

    let server = serverMod.createServer();
    let handler = server._requestHandlers.get('tools/call');
    assert.equal(typeof handler, 'function');
    resultsMod.setNotifyCallback(null);
    callTool = (name, args) => handler({
      method: 'tools/call',
      params: { name, arguments: args },
    }, {});

    if (!fs.existsSync(TEST_CWD)) {
      fs.mkdirSync(TEST_CWD, { recursive: true });
    }
  });

  after(() => {
    if (previousConfigDir === undefined) {
      delete process.env.AGENT_PORTAL_CONFIG_DIR;
    } else {
      process.env.AGENT_PORTAL_CONFIG_DIR = previousConfigDir;
    }
    if (previousPoolDepth === undefined) {
      delete process.env.AGENT_POOL_DEPTH;
    } else {
      process.env.AGENT_POOL_DEPTH = previousPoolDepth;
    }
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

  it('listGroups returns fields needed for error-reporting summary', () => {
    let list = listGroups(TEST_CWD);
    for (let g of list) {
      assert.strictEqual(typeof g.name, 'string', 'group must expose name');
      assert.ok(g.name.length > 0, 'group name must be non-empty');
      assert.ok('provider' in g, 'group must expose provider field');
      assert.ok('model' in g, 'group must expose model field');
    }
  });

  it('delegate_task missing resource_group reports defined alternatives', async () => {
    createGroup(TEST_CWD, {
      name: 'report-available',
      provider: 'mock',
      model: 'stable',
    });

    let response = await callTool('delegate_task', {
      cwd: TEST_CWD,
      provider: 'mock',
      resource_group: 'missing-report-group',
      prompt: 'probe missing resource group',
    });
    let text = response.content[0].text;

    assert.equal(response.isError, true);
    assert.match(text, /Resource group `missing-report-group` not found/);
    assert.match(text, /Available resource groups/);
    assert.match(text, /`report-available` \(provider: mock, model: stable\)/);
    assert.doesNotMatch(text, /  - `missing-report-group`/);
    assert.doesNotMatch(text, /Use `list_groups`/);
  });

  it('delegate_task saturated resource_group reports only groups with capacity', async () => {
    createGroup(TEST_CWD, {
      name: 'saturated-primary',
      provider: 'mock',
      max_agents: 1,
    });
    createGroup(TEST_CWD, {
      name: 'saturated-secondary',
      provider: 'mock',
      max_agents: 1,
    });
    createGroup(TEST_CWD, {
      name: 'capacity-fallback',
      provider: 'mock',
      max_agents: 2,
      profiles: [
        { provider: 'mock', model: 'fallback-primary' },
        { provider: 'mock', model: 'fallback-secondary' },
      ],
    });

    createTask('running-saturated-primary', 'primary', null, 'plan', TEST_CWD,
      'test', null, null, null, null, 'saturated-primary');
    createTask('running-saturated-secondary', 'secondary', null, 'plan', TEST_CWD,
      'test', null, null, null, null, 'saturated-secondary');

    try {
      let response = await callTool('delegate_task', {
        cwd: TEST_CWD,
        provider: 'mock',
        resource_group: 'saturated-primary',
        prompt: 'probe saturated resource group',
      });
      let text = response.content[0].text;

      assert.equal(response.isError, true);
      assert.match(
        text,
        /Resource group `saturated-primary` is at capacity \(1\/1 active tasks\)/,
      );
      assert.match(text, /Available resource groups/);
      assert.match(text, /`capacity-fallback`/);
      assert.match(text, /fallback: mock\/fallback-primary -> mock\/fallback-secondary/);
      assert.match(text, /capacity: 0\/2/);
      assert.doesNotMatch(text, /`saturated-secondary`/);
    } finally {
      completeTask('running-saturated-primary', { exitCode: 0, response: '' });
      completeTask('running-saturated-secondary', { exitCode: 0, response: '' });
    }
  });

  it('getGroup returns null for non-existent group', () => {
    let g = getGroup(TEST_CWD, 'nonexistent-group');
    assert.strictEqual(g, null);
  });

  it('getGroupNextProfile returns null provider/model for missing group', () => {
    let profile = getGroupNextProfile(TEST_CWD, 'nonexistent-group');
    assert.deepStrictEqual(profile, { provider: null, model: null, profile: null });
  });

  it('deleteGroup removes the group', () => {
    const deleted = deleteGroup(TEST_CWD, 'error-group');
    assert.strictEqual(deleted, true);
    
    const group = getGroup(TEST_CWD, 'error-group');
    assert.strictEqual(group, null);
    
    const list = listGroups(TEST_CWD);
    assert.equal(list.some(g => g.name === 'error-group'), false);
    assert.ok(list.find(g => g.name === 'test-group'));
    assert.ok(list.find(g => g.name === 'profile-group'));
  });
});
