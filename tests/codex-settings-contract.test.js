import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getToolDefinitions } from '../src/tool-definitions.js';
import { boundedProcessError } from '../src/runner/process-error.js';

describe('Codex execution settings contracts', () => {
  let tempDir;
  let previousConfigDir;
  let previousMemoryRoot;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-pool-codex-settings-'));
    previousConfigDir = process.env.AGENT_PORTAL_CONFIG_DIR;
    previousMemoryRoot = process.env.AGENT_PORTAL_MEMORY_ROOT;
    process.env.AGENT_PORTAL_CONFIG_DIR = path.join(tempDir, 'portal-home');
    process.env.AGENT_PORTAL_MEMORY_ROOT = path.join(tempDir, 'team-memory');
  });

  afterEach(() => {
    mock.restoreAll();
    syncBuiltinESMExports();
    if (previousConfigDir === undefined) delete process.env.AGENT_PORTAL_CONFIG_DIR;
    else process.env.AGENT_PORTAL_CONFIG_DIR = previousConfigDir;
    if (previousMemoryRoot === undefined) delete process.env.AGENT_PORTAL_MEMORY_ROOT;
    else process.env.AGENT_PORTAL_MEMORY_ROOT = previousMemoryRoot;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('exposes settings on direct, group, schedule, and pipeline tool schemas', () => {
    let definitions = getToolDefinitions();
    let byName = Object.fromEntries(definitions.map(definition => [definition.name, definition]));
    for (let toolName of ['delegate_task', 'delegate_task_readonly', 'delegate_to_group', 'schedule_task']) {
      let properties = byName[toolName].inputSchema.properties;
      assert.ok(properties.reasoningEffort, `${toolName} reasoningEffort`);
      assert.ok(properties.serviceTier, `${toolName} serviceTier`);
    }
    let stepProperties = byName.create_pipeline.inputSchema.properties.steps.items.properties;
    assert.ok(stepProperties.reasoningEffort);
    assert.ok(stepProperties.serviceTier);
  });

  it('persists canonical schedule settings before the daemon consumes them', async () => {
    let spawnMock = mock.method(childProcess, 'spawn', () => ({ pid: 41001, unref() {} }));
    syncBuiltinESMExports();
    let scheduler = await import(`../src/scheduler/scheduler.js?settings=${Date.now()}`);
    let cwd = path.join(tempDir, 'workspace');
    fs.mkdirSync(cwd, { recursive: true });

    scheduler.addSchedule(cwd, {
      prompt: 'review changes',
      cron: '0 9 * * MON-FRI',
      provider: 'codex',
      model: 'gpt-5.6-sol',
      reasoningEffort: ' high ',
      serviceTier: ' priority ',
      taskCwd: cwd,
    });

    let [schedule] = scheduler.readSchedules(cwd);
    assert.equal(schedule.reasoningEffort, 'high');
    assert.equal(schedule.serviceTier, 'priority');
    assert.equal(spawnMock.mock.callCount(), 1);
    assert.throws(
      () => scheduler.addSchedule(cwd, { prompt: 'x', cron: '0 9 * * *', reasoningEffort: ' ' }),
      /reasoningEffort.*non-empty/,
    );
  });

  it('persists canonical settings on pipeline steps', async () => {
    let pipelineModule = await import(`../src/scheduler/pipeline.js?settings=${Date.now()}`);
    let cwd = path.join(tempDir, 'workspace');
    fs.mkdirSync(cwd, { recursive: true });

    let { pipelineId } = pipelineModule.createPipeline(cwd, {
      name: 'Codex Settings',
      steps: [{
        name: 'review',
        prompt: 'Review changes',
        provider: 'codex',
        model: 'gpt-5.6-terra',
        reasoningEffort: ' max ',
        serviceTier: ' priority ',
      }],
    });
    let pipeline = pipelineModule.getPipeline(cwd, pipelineId);

    assert.equal(pipeline.steps[0].reasoningEffort, 'max');
    assert.equal(pipeline.steps[0].serviceTier, 'priority');
  });

  it('keeps bounded CLI diagnostics for failed scheduled and pipeline runs', () => {
    let diagnostic = boundedProcessError(`\u001b[31munknown service tier\u001b[0m\0${'x'.repeat(3000)}`, 2);

    assert.match(diagnostic, /^unknown service tier/);
    assert.equal(diagnostic.includes('\u001b'), false);
    assert.equal(diagnostic.includes('\0'), false);
    assert.equal(diagnostic.length, 2000);
    assert.equal(boundedProcessError('', 2), 'Process exited with code 2');
  });
});
