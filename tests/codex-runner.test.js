import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resetConfig } from '../src/runner/config.js';

let oldPath;
let oldArgsFile;
let oldEnvFile;
let oldStderr;
let oldPortalMcpUrl;
let oldRunnerMode;
let oldAgentPoolNpmCache;
let oldCwd;
let tmpDir;

describe('codex runner', () => {
  beforeEach(() => {
    oldPath = process.env.PATH;
    oldArgsFile = process.env.CODEX_RUNNER_ARGS_FILE;
    oldEnvFile = process.env.CODEX_RUNNER_ENV_FILE;
    oldStderr = process.env.CODEX_RUNNER_STDERR;
    oldPortalMcpUrl = process.env.PORTAL_MCP_URL;
    oldRunnerMode = process.env.CODEX_RUNNER_MODE;
    oldAgentPoolNpmCache = process.env.AGENT_POOL_NPM_CACHE;
    oldCwd = process.cwd();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-runner-test-'));

    let binPath = path.join(tmpDir, 'codex');
    fs.writeFileSync(binPath, `#!/usr/bin/env node
const fs = require('node:fs');
if (process.env.CODEX_RUNNER_ARGS_FILE) {
  fs.writeFileSync(process.env.CODEX_RUNNER_ARGS_FILE, JSON.stringify(process.argv.slice(2)));
}
if (process.env.CODEX_RUNNER_ENV_FILE) {
  fs.writeFileSync(process.env.CODEX_RUNNER_ENV_FILE, JSON.stringify({
    NPM_CONFIG_CACHE: process.env.NPM_CONFIG_CACHE || null,
    npm_config_cache: process.env.npm_config_cache || null
  }));
}
if (process.env.CODEX_RUNNER_STDERR) {
  process.stderr.write(process.env.CODEX_RUNNER_STDERR);
}
if (process.env.CODEX_RUNNER_MODE === 'failure-exit') {
  process.exit(2);
} else if (process.env.CODEX_RUNNER_MODE === 'missing-rollout-on-resume' && process.argv.includes('resume')) {
  process.stderr.write('Error: thread/resume: thread/resume failed: no rollout found for thread id stale-thread (code -32600)\\n');
  process.exit(1);
} else if (process.env.CODEX_RUNNER_MODE === 'bootstrap-stall') {
  console.log(JSON.stringify({ type: 'session_meta', payload: {} }));
  console.log(JSON.stringify({ type: 'event_msg', payload: { type: 'task_started' } }));
  setInterval(() => {}, 1000);
} else if (process.env.CODEX_RUNNER_MODE === 'stderr-after-start') {
  console.log(JSON.stringify({ type: 'thread.started', thread_id: 'thread-test' }));
  setInterval(() => process.stderr.write('still waiting on stderr\\n'), 50);
} else {
  const events = [
    { type: 'thread.started', thread_id: 'thread-test' },
    { type: 'item.completed', item: { type: 'command_execution', command: 'pwd', aggregated_output: 'ok', exit_code: 0, status: 'completed' } },
    { type: 'item.completed', item: { type: 'agent_message', text: 'Codex response' } },
    { type: 'turn.completed', usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 2, reasoning_output_tokens: 3 } }
  ];
  for (const event of events) console.log(JSON.stringify(event));
}
`);
    fs.chmodSync(binPath, 0o755);
    process.env.PATH = `${tmpDir}${path.delimiter}${oldPath}`;
  });

  afterEach(() => {
    process.env.PATH = oldPath;
    if (oldArgsFile === undefined) {
      delete process.env.CODEX_RUNNER_ARGS_FILE;
    } else {
      process.env.CODEX_RUNNER_ARGS_FILE = oldArgsFile;
    }
    if (oldEnvFile === undefined) {
      delete process.env.CODEX_RUNNER_ENV_FILE;
    } else {
      process.env.CODEX_RUNNER_ENV_FILE = oldEnvFile;
    }
    if (oldStderr === undefined) {
      delete process.env.CODEX_RUNNER_STDERR;
    } else {
      process.env.CODEX_RUNNER_STDERR = oldStderr;
    }
    if (oldPortalMcpUrl === undefined) {
      delete process.env.PORTAL_MCP_URL;
    } else {
      process.env.PORTAL_MCP_URL = oldPortalMcpUrl;
    }
    if (oldRunnerMode === undefined) {
      delete process.env.CODEX_RUNNER_MODE;
    } else {
      process.env.CODEX_RUNNER_MODE = oldRunnerMode;
    }
    if (oldAgentPoolNpmCache === undefined) {
      delete process.env.AGENT_POOL_NPM_CACHE;
    } else {
      process.env.AGENT_POOL_NPM_CACHE = oldAgentPoolNpmCache;
    }
    process.chdir(oldCwd);
    resetConfig();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('runs codex exec --json and parses JSONL events', async () => {
    let argsFile = path.join(tmpDir, 'args.json');
    process.env.CODEX_RUNNER_ARGS_FILE = argsFile;

    let { runCodexStreaming } = await import('../src/runner/codex-runner.js');
    let result = await runCodexStreaming({ prompt: 'hello', cwd: tmpDir, timeout: 5 });

    assert.equal(result.exitCode, 0);
    assert.equal(result.sessionId, 'thread-test');
    assert.equal(result.response, 'Codex response');
    assert.equal(result.stats.tokens.total, 3);
    assert.deepEqual(result.toolCalls, [{ name: 'shell', args: { command: 'pwd' } }]);

    let args = JSON.parse(fs.readFileSync(argsFile, 'utf8'));
    assert.deepEqual(args.slice(0, 6), ['-a', 'never', 'exec', '--json', '-s', 'danger-full-access']);
    assert.match(args.at(-1), /hello$/);
  });

  it('passes a writable npm cache to Codex child processes', async () => {
    let envFile = path.join(tmpDir, 'env.json');
    let npmCache = path.join(tmpDir, 'npm-cache');
    process.env.CODEX_RUNNER_ENV_FILE = envFile;
    process.env.AGENT_POOL_NPM_CACHE = npmCache;

    let { runCodexStreaming } = await import('../src/runner/codex-runner.js');
    await runCodexStreaming({ prompt: 'hello', cwd: tmpDir, timeout: 5 });

    let env = JSON.parse(fs.readFileSync(envFile, 'utf8'));
    assert.equal(env.NPM_CONFIG_CACHE, npmCache);
    assert.equal(env.npm_config_cache, npmCache);
    fs.writeFileSync(path.join(env.NPM_CONFIG_CACHE, 'probe'), 'ok');
  });

  it('filters Codex stdin notice out of final errors', async () => {
    process.env.CODEX_RUNNER_STDERR = 'Reading additional input from stdin...\n';

    let { runCodexStreaming } = await import('../src/runner/codex-runner.js');
    let result = await runCodexStreaming({ prompt: 'hello', cwd: tmpDir, timeout: 5 });

    assert.deepEqual(result.errors, []);
  });

  it('fails and kills Codex when bootstrap output never becomes substantive', async () => {
    process.env.CODEX_RUNNER_MODE = 'bootstrap-stall';
    fs.writeFileSync(path.join(tmpDir, 'agent-pool.config.json'), JSON.stringify({
      limits: {
        bootstrapTimeout: 0.2,
        timeout: 5,
      },
    }));
    process.chdir(tmpDir);
    resetConfig();

    let { runCodexStreaming } = await import('../src/runner/codex-runner.js');
    let startedAt = Date.now();
    let result = await runCodexStreaming({ prompt: 'hello', cwd: tmpDir, timeout: 5 });

    assert.equal(result.bootstrapStalled, true);
    assert.equal(result.exitCode, -1);
    assert.equal(result.softTimeout, false);
    assert.ok(result.totalEvents <= 2);
    assert.match(result.errors.join('\n'), /Codex bootstrap stalled/);
    assert.ok(Date.now() - startedAt < 2000);
  });

  it('does not treat stderr-only noise as Codex progress after bootstrap', async () => {
    process.env.CODEX_RUNNER_MODE = 'stderr-after-start';
    fs.writeFileSync(path.join(tmpDir, 'agent-pool.config.json'), JSON.stringify({
      limits: {
        bootstrapTimeout: 1,
        timeout: 0.2,
        hardTimeoutMultiplier: 3,
        hardTimeoutMax: 2,
      },
    }));
    process.chdir(tmpDir);
    resetConfig();

    let { runCodexStreaming } = await import('../src/runner/codex-runner.js');
    let startedAt = Date.now();
    let result = await runCodexStreaming({ prompt: 'hello', cwd: tmpDir, timeout: 0.2 });

    assert.equal(result.softTimeout, true);
    assert.equal(result.exitCode, null);
    assert.equal(result.bootstrapStalled, undefined);
    assert.ok(Date.now() - startedAt < 1500);
  });

  it('does not pass the UI default sentinel as a real model', async () => {
    let argsFile = path.join(tmpDir, 'args-default.json');
    process.env.CODEX_RUNNER_ARGS_FILE = argsFile;

    let { runCodexStreaming } = await import('../src/runner/codex-runner.js');
    await runCodexStreaming({ prompt: 'hello', cwd: tmpDir, model: 'default', timeout: 5 });

    let args = JSON.parse(fs.readFileSync(argsFile, 'utf8'));
    assert.equal(args.includes('--model'), false);
    assert.equal(args.includes('default'), false);
  });

  it('passes Codex model and reasoning effort overrides, including service tier and validation', async () => {
    let argsFile = path.join(tmpDir, 'args-reasoning.json');
    process.env.CODEX_RUNNER_ARGS_FILE = argsFile;

    let { runCodexStreaming } = await import('../src/runner/codex-runner.js');
    await runCodexStreaming({
      prompt: 'hello',
      cwd: tmpDir,
      model: 'gpt-5.5',
      reasoningEffort: 'ultra',
      serviceTier: 'priority',
      timeout: 5,
    });

    let args = JSON.parse(fs.readFileSync(argsFile, 'utf8'));
    assert.equal(args[args.indexOf('--model') + 1], 'gpt-5.5');

    const reasoningIndex = args.indexOf('model_reasoning_effort="ultra"');
    assert.ok(reasoningIndex > 0);
    assert.equal(args[reasoningIndex - 1], '-c');

    const tierIndex = args.indexOf('service_tier="priority"');
    assert.ok(tierIndex > 0);
    assert.equal(args[tierIndex - 1], '-c');

    await assert.rejects(
      () => runCodexStreaming({ prompt: 'hello', cwd: tmpDir, reasoningEffort: 123, timeout: 5 }),
      /Invalid reasoningEffort: must be a string/
    );

    await assert.rejects(
      () => runCodexStreaming({ prompt: 'hello', cwd: tmpDir, reasoningEffort: '   ', timeout: 5 }),
      /Invalid reasoningEffort: must be a non-empty string/
    );

    await assert.rejects(
      () => runCodexStreaming({ prompt: 'hello', cwd: tmpDir, serviceTier: true, timeout: 5 }),
      /Invalid serviceTier: must be a string/
    );

    await assert.rejects(
      () => runCodexStreaming({ prompt: 'hello', cwd: tmpDir, serviceTier: '', timeout: 5 }),
      /Invalid serviceTier: must be a non-empty string/
    );
  });

  it('trims default setting sentinels instead of forwarding them', async () => {
    let argsFile = path.join(tmpDir, 'args-default-settings.json');
    process.env.CODEX_RUNNER_ARGS_FILE = argsFile;
    let { runCodexStreaming } = await import('../src/runner/codex-runner.js');

    await runCodexStreaming({
      prompt: 'hello',
      cwd: tmpDir,
      reasoningEffort: ' default ',
      serviceTier: ' default ',
      timeout: 5,
    });

    let args = JSON.parse(fs.readFileSync(argsFile, 'utf8'));
    assert.equal(args.some(arg => arg.startsWith('model_reasoning_effort=')), false);
    assert.equal(args.some(arg => arg.startsWith('service_tier=')), false);
  });

  it('passes a chat-scoped portal MCP config override to Codex', async () => {
    let argsFile = path.join(tmpDir, 'args-chat-mcp.json');
    process.env.CODEX_RUNNER_ARGS_FILE = argsFile;
    process.env.PORTAL_MCP_URL = 'http://127.0.0.1:52395/mcp?transport=stream';

    let { runCodexStreaming } = await import('../src/runner/codex-runner.js');
    await runCodexStreaming({
      prompt: 'hello',
      cwd: tmpDir,
      chat_id: 'chat 123',
      timeout: 5,
    });

    let args = JSON.parse(fs.readFileSync(argsFile, 'utf8'));
    let configIndex = args.indexOf('-c');
    assert.notEqual(configIndex, -1);
    assert.equal(
      args[configIndex + 1],
      'mcp_servers.agent-portal-chat={url="http://127.0.0.1:52395/mcp?transport=stream&chatId=chat%20123"}',
    );
    assert.ok(args.includes('tools.network_access=true'));
    assert.ok(args.includes('sandbox_workspace_write.network_access=true'));
    assert.ok(args.includes('mcp_servers.agent-portal-chat.tools.workflow_board.approval_mode="approve"'));
    assert.ok(args.includes('mcp_servers.agent-portal-chat.tools.get_chat_task_result.approval_mode="approve"'));
  });

  it('maps approval modes to Codex sandbox modes', async () => {
    let argsFile = path.join(tmpDir, 'args-plan.json');
    process.env.CODEX_RUNNER_ARGS_FILE = argsFile;

    let { runCodexStreaming } = await import('../src/runner/codex-runner.js');
    await runCodexStreaming({ prompt: 'hello', cwd: tmpDir, approvalMode: 'plan', timeout: 5 });

    let args = JSON.parse(fs.readFileSync(argsFile, 'utf8'));
    assert.equal(args[args.indexOf('-s') + 1], 'read-only');

    argsFile = path.join(tmpDir, 'args-auto-edit.json');
    process.env.CODEX_RUNNER_ARGS_FILE = argsFile;
    await runCodexStreaming({ prompt: 'hello', cwd: tmpDir, approvalMode: 'auto_edit', timeout: 5 });

    args = JSON.parse(fs.readFileSync(argsFile, 'utf8'));
    assert.equal(args[args.indexOf('-s') + 1], 'workspace-write');
    assert.deepEqual(args.slice(0, 6), ['-a', 'never', 'exec', '--json', '-s', 'workspace-write']);
  });

  it('uses codex exec resume when sessionId is provided', async () => {
    let argsFile = path.join(tmpDir, 'args-resume.json');
    process.env.CODEX_RUNNER_ARGS_FILE = argsFile;

    let { runCodexStreaming } = await import('../src/runner/codex-runner.js');
    await runCodexStreaming({ prompt: 'continue', cwd: tmpDir, sessionId: 'thread-test', timeout: 5 });

    let args = JSON.parse(fs.readFileSync(argsFile, 'utf8'));
    assert.deepEqual(args.slice(0, 6), ['-a', 'never', 'exec', 'resume', '--json', 'thread-test']);
    assert.match(args.at(-1), /continue$/);
  });

  it('falls back to a fresh Codex thread when resume rollout is missing', async () => {
    let argsFile = path.join(tmpDir, 'args-missing-rollout.json');
    process.env.CODEX_RUNNER_ARGS_FILE = argsFile;
    process.env.CODEX_RUNNER_MODE = 'missing-rollout-on-resume';

    let { runCodexStreaming } = await import('../src/runner/codex-runner.js');
    let result = await runCodexStreaming({
      prompt: 'continue',
      cwd: tmpDir,
      sessionId: 'stale-thread',
      timeout: 5,
    });

    assert.equal(result.exitCode, 0);
    assert.equal(result.sessionId, 'thread-test');
    assert.equal(result.response, 'Codex response');

    let args = JSON.parse(fs.readFileSync(argsFile, 'utf8'));
    assert.deepEqual(args.slice(0, 6), ['-a', 'never', 'exec', '--json', '-s', 'danger-full-access']);
    assert.equal(args.includes('stale-thread'), false);
    assert.match(args.at(-1), /continue$/);
  });

  it('surfaces non-zero exit code and stderr from CLI when invalid/unknown settings are rejected by Codex CLI', async () => {
    let argsFile = path.join(tmpDir, 'args-failure.json');
    process.env.CODEX_RUNNER_ARGS_FILE = argsFile;
    process.env.CODEX_RUNNER_STDERR = 'Error: Unknown config value service_tier="unsupported"\n';
    process.env.CODEX_RUNNER_MODE = 'failure-exit';

    let { runCodexStreaming } = await import('../src/runner/codex-runner.js');
    let result = await runCodexStreaming({
      prompt: 'hello',
      cwd: tmpDir,
      serviceTier: 'unsupported',
      timeout: 5,
    });

    assert.equal(result.exitCode, 2);
    assert.deepEqual(result.errors, ['Error: Unknown config value service_tier="unsupported"']);

    let args = JSON.parse(fs.readFileSync(argsFile, 'utf8'));
    const tierIndex = args.indexOf('service_tier="unsupported"');
    assert.ok(tierIndex > 0);
    assert.equal(args[tierIndex - 1], '-c');
  });
});
