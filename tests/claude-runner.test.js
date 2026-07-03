import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let oldPath;
let oldArgsFile;
let oldEnvFile;
let oldStderr;
let oldPortalConfigDir;
let oldAnthropicBaseUrl;
let oldAnthropicAuthToken;
let oldAnthropicApiKey;
let oldGatewayDiscovery;
let tmpDir;

describe('claude runner', () => {
  beforeEach(() => {
    oldPath = process.env.PATH;
    oldArgsFile = process.env.CLAUDE_RUNNER_ARGS_FILE;
    oldEnvFile = process.env.CLAUDE_RUNNER_ENV_FILE;
    oldStderr = process.env.CLAUDE_RUNNER_STDERR;
    oldPortalConfigDir = process.env.PORTAL_CONFIG_DIR;
    oldAnthropicBaseUrl = process.env.ANTHROPIC_BASE_URL;
    oldAnthropicAuthToken = process.env.ANTHROPIC_AUTH_TOKEN;
    oldAnthropicApiKey = process.env.ANTHROPIC_API_KEY;
    oldGatewayDiscovery = process.env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-runner-test-'));
    process.env.PORTAL_CONFIG_DIR = tmpDir;

    let binPath = path.join(tmpDir, 'claude');
    fs.writeFileSync(binPath, `#!/usr/bin/env node
const fs = require('node:fs');
if (process.env.CLAUDE_RUNNER_ARGS_FILE) {
  fs.writeFileSync(process.env.CLAUDE_RUNNER_ARGS_FILE, JSON.stringify(process.argv.slice(2)));
}
if (process.env.CLAUDE_RUNNER_ENV_FILE) {
  fs.writeFileSync(process.env.CLAUDE_RUNNER_ENV_FILE, JSON.stringify({
    ANTHROPIC_SMALL_FAST_MODEL: process.env.ANTHROPIC_SMALL_FAST_MODEL || null,
    ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL || null,
    ANTHROPIC_AUTH_TOKEN: process.env.ANTHROPIC_AUTH_TOKEN || null,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || null,
    CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: process.env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY || null
  }));
}
if (process.env.CLAUDE_RUNNER_STDERR) {
  process.stderr.write(process.env.CLAUDE_RUNNER_STDERR);
}
const events = [
  { type: 'system', subtype: 'init', session_id: 'session-test' },
  { type: 'assistant', message: { content: [
    { type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'pwd' } },
    { type: 'text', text: 'Claude response' }
  ] } },
  { type: 'tool_result', tool_use_id: 'tool-1', content: [{ type: 'text', text: 'ok' }] },
  { type: 'result', result: 'Claude final response', total_cost_usd: 0.01, duration_ms: 123, num_turns: 1 }
];
for (const event of events) console.log(JSON.stringify(event));
`);
    fs.chmodSync(binPath, 0o755);
    process.env.PATH = `${tmpDir}${path.delimiter}${oldPath}`;
  });

  afterEach(() => {
    process.env.PATH = oldPath;
    if (oldArgsFile === undefined) {
      delete process.env.CLAUDE_RUNNER_ARGS_FILE;
    } else {
      process.env.CLAUDE_RUNNER_ARGS_FILE = oldArgsFile;
    }
    if (oldEnvFile === undefined) {
      delete process.env.CLAUDE_RUNNER_ENV_FILE;
    } else {
      process.env.CLAUDE_RUNNER_ENV_FILE = oldEnvFile;
    }
    if (oldStderr === undefined) {
      delete process.env.CLAUDE_RUNNER_STDERR;
    } else {
      process.env.CLAUDE_RUNNER_STDERR = oldStderr;
    }
    if (oldPortalConfigDir === undefined) {
      delete process.env.PORTAL_CONFIG_DIR;
    } else {
      process.env.PORTAL_CONFIG_DIR = oldPortalConfigDir;
    }
    if (oldAnthropicBaseUrl === undefined) {
      delete process.env.ANTHROPIC_BASE_URL;
    } else {
      process.env.ANTHROPIC_BASE_URL = oldAnthropicBaseUrl;
    }
    if (oldAnthropicAuthToken === undefined) {
      delete process.env.ANTHROPIC_AUTH_TOKEN;
    } else {
      process.env.ANTHROPIC_AUTH_TOKEN = oldAnthropicAuthToken;
    }
    if (oldAnthropicApiKey === undefined) {
      delete process.env.ANTHROPIC_API_KEY;
    } else {
      process.env.ANTHROPIC_API_KEY = oldAnthropicApiKey;
    }
    if (oldGatewayDiscovery === undefined) {
      delete process.env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY;
    } else {
      process.env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY = oldGatewayDiscovery;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('runs claude print mode and parses stream-json events', async () => {
    let argsFile = path.join(tmpDir, 'args.json');
    process.env.CLAUDE_RUNNER_ARGS_FILE = argsFile;

    let { runClaudeStreaming } = await import('../src/runner/claude-runner.js');
    let result = await runClaudeStreaming({ prompt: 'hello', cwd: tmpDir, timeout: 5 });

    assert.equal(result.exitCode, 0);
    assert.equal(result.sessionId, 'session-test');
    assert.equal(result.response, 'Claude final response');
    assert.equal(result.stats.costUsd, 0.01);
    assert.deepEqual(result.toolCalls, [{ name: 'Bash', args: { command: 'pwd' } }]);
    assert.deepEqual(result.toolResults, [{ name: 'tool', output: 'ok' }]);

    let args = JSON.parse(fs.readFileSync(argsFile, 'utf8'));
    assert.deepEqual(args.slice(0, 6), ['-p', 'hello', '--output-format', 'stream-json', '--verbose', '--permission-mode']);
    assert.equal(args[6], 'bypassPermissions');
  });

  it('maps read-only approval mode to Claude plan mode', async () => {
    let argsFile = path.join(tmpDir, 'args-plan.json');
    process.env.CLAUDE_RUNNER_ARGS_FILE = argsFile;

    let { runClaudeStreaming } = await import('../src/runner/claude-runner.js');
    await runClaudeStreaming({ prompt: 'hello', cwd: tmpDir, approvalMode: 'plan', timeout: 5 });

    let args = JSON.parse(fs.readFileSync(argsFile, 'utf8'));
    assert.equal(args[args.indexOf('--permission-mode') + 1], 'plan');
  });

  it('passes allowed tool patterns to Claude Code', async () => {
    let argsFile = path.join(tmpDir, 'args-allowed-tools.json');
    process.env.CLAUDE_RUNNER_ARGS_FILE = argsFile;

    let { runClaudeStreaming } = await import('../src/runner/claude-runner.js');
    await runClaudeStreaming({
      prompt: 'hello',
      cwd: tmpDir,
      approvalMode: 'auto_edit',
      allowedTools: ['Bash(node --check *)', 'Bash(node --test *)'],
      timeout: 5,
    });

    let args = JSON.parse(fs.readFileSync(argsFile, 'utf8'));
    let index = args.indexOf('--allowedTools');
    assert.notEqual(index, -1);
    assert.deepEqual(args.slice(index + 1, index + 3), ['Bash(node --check *)', 'Bash(node --test *)']);
    assert.equal(args[args.indexOf('--permission-mode') + 1], 'acceptEdits');
  });

  it('does not pass the UI default sentinel as a real model', async () => {
    let argsFile = path.join(tmpDir, 'args-default.json');
    process.env.CLAUDE_RUNNER_ARGS_FILE = argsFile;

    let { runClaudeStreaming } = await import('../src/runner/claude-runner.js');
    await runClaudeStreaming({ prompt: 'hello', cwd: tmpDir, model: 'default', timeout: 5 });

    let args = JSON.parse(fs.readFileSync(argsFile, 'utf8'));
    assert.equal(args.includes('--model'), false);
    assert.equal(args.includes('default'), false);
  });

  it('pins Claude small-fast requests to the explicit provider model', async () => {
    let argsFile = path.join(tmpDir, 'args-model.json');
    let envFile = path.join(tmpDir, 'env-model.json');
    process.env.CLAUDE_RUNNER_ARGS_FILE = argsFile;
    process.env.CLAUDE_RUNNER_ENV_FILE = envFile;

    let { runClaudeStreaming } = await import('../src/runner/claude-runner.js');
    await runClaudeStreaming({ prompt: 'hello', cwd: tmpDir, model: 'claude-sonnet-4-6', timeout: 5 });

    let args = JSON.parse(fs.readFileSync(argsFile, 'utf8'));
    let env = JSON.parse(fs.readFileSync(envFile, 'utf8'));
    assert.equal(args[args.indexOf('--model') + 1], 'claude-sonnet-4-6');
    assert.equal(env.ANTHROPIC_SMALL_FAST_MODEL, 'claude-sonnet-4-6');
  });

  it('passes Claude reasoning effort to Claude Code', async () => {
    let argsFile = path.join(tmpDir, 'args-effort.json');
    process.env.CLAUDE_RUNNER_ARGS_FILE = argsFile;

    let { runClaudeStreaming } = await import('../src/runner/claude-runner.js');
    await runClaudeStreaming({ prompt: 'hello', cwd: tmpDir, reasoningEffort: 'max', timeout: 5 });

    let args = JSON.parse(fs.readFileSync(argsFile, 'utf8'));
    assert.equal(args[args.indexOf('--effort') + 1], 'max');
  });

  it('does not inherit Anthropic proxy or API env into direct Claude runs', async () => {
    let envFile = path.join(tmpDir, 'env-direct.json');
    process.env.CLAUDE_RUNNER_ENV_FILE = envFile;
    process.env.ANTHROPIC_BASE_URL = 'http://proxy.local/anthropic';
    process.env.ANTHROPIC_AUTH_TOKEN = 'proxy-token';
    process.env.ANTHROPIC_API_KEY = 'api-key';
    process.env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY = '1';

    let { runClaudeStreaming } = await import('../src/runner/claude-runner.js');
    await runClaudeStreaming({ prompt: 'hello', cwd: tmpDir, timeout: 5 });

    let env = JSON.parse(fs.readFileSync(envFile, 'utf8'));
    assert.equal(env.ANTHROPIC_BASE_URL, null);
    assert.equal(env.ANTHROPIC_AUTH_TOKEN, null);
    assert.equal(env.ANTHROPIC_API_KEY, null);
    assert.equal(env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY, null);
  });
});
