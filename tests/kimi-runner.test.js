import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let oldPath;
let oldArgsFile;
let oldEnvFile;
let oldHomeDump;
let oldStderr;
let oldPortalConfigDir;
let oldPortalMcpUrl;
let oldKimiCodeHome;
let oldThinkingEffort;
let tmpDir;

describe('kimi runner', () => {
  beforeEach(() => {
    oldPath = process.env.PATH;
    oldArgsFile = process.env.KIMI_RUNNER_ARGS_FILE;
    oldEnvFile = process.env.KIMI_RUNNER_ENV_FILE;
    oldHomeDump = process.env.KIMI_RUNNER_HOME_DUMP;
    oldStderr = process.env.KIMI_RUNNER_STDERR;
    oldPortalConfigDir = process.env.PORTAL_CONFIG_DIR;
    oldPortalMcpUrl = process.env.PORTAL_MCP_URL;
    oldKimiCodeHome = process.env.KIMI_CODE_HOME;
    oldThinkingEffort = process.env.KIMI_MODEL_THINKING_EFFORT;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-runner-test-'));
    process.env.PORTAL_CONFIG_DIR = tmpDir;
    delete process.env.PORTAL_MCP_URL;
    delete process.env.KIMI_CODE_HOME;
    delete process.env.KIMI_MODEL_THINKING_EFFORT;

    let binPath = path.join(tmpDir, 'kimi');
    fs.writeFileSync(binPath, `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
if (process.env.KIMI_RUNNER_ARGS_FILE) {
  fs.writeFileSync(process.env.KIMI_RUNNER_ARGS_FILE, JSON.stringify(process.argv.slice(2)));
}
if (process.env.KIMI_RUNNER_ENV_FILE) {
  fs.writeFileSync(process.env.KIMI_RUNNER_ENV_FILE, JSON.stringify({
    KIMI_MODEL_THINKING_EFFORT: process.env.KIMI_MODEL_THINKING_EFFORT || null,
    KIMI_CODE_HOME: process.env.KIMI_CODE_HOME || null,
    PORTAL_MCP_URL: process.env.PORTAL_MCP_URL || null
  }));
}
if (process.env.KIMI_RUNNER_HOME_DUMP && process.env.KIMI_CODE_HOME) {
  let prefix = process.env.KIMI_RUNNER_HOME_DUMP;
  let configPath = path.join(process.env.KIMI_CODE_HOME, 'config.toml');
  let mcpPath = path.join(process.env.KIMI_CODE_HOME, 'mcp.json');
  fs.writeFileSync(prefix + '.config.toml', fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf8') : '');
  fs.writeFileSync(prefix + '.mcp.json', fs.existsSync(mcpPath) ? fs.readFileSync(mcpPath, 'utf8') : '');
}
if (process.env.KIMI_RUNNER_STDERR) {
  process.stderr.write(process.env.KIMI_RUNNER_STDERR);
}
const events = [
  { role: 'assistant', tool_calls: [
    { type: 'function', id: 'tool-1', function: { name: 'Bash', arguments: '{"command":"pwd"}' } }
  ] },
  { role: 'assistant', content: 'Kimi response' },
  { role: 'tool', tool_call_id: 'tool-1', content: 'ok' },
  { role: 'meta', type: 'session.resume_hint', session_id: 'session_test' }
];
for (const event of events) console.log(JSON.stringify(event));
`);
    fs.chmodSync(binPath, 0o755);
    process.env.PATH = `${tmpDir}${path.delimiter}${oldPath}`;
  });

  afterEach(() => {
    process.env.PATH = oldPath;
    for (let [key, value] of [
      ['KIMI_RUNNER_ARGS_FILE', oldArgsFile],
      ['KIMI_RUNNER_ENV_FILE', oldEnvFile],
      ['KIMI_RUNNER_HOME_DUMP', oldHomeDump],
      ['KIMI_RUNNER_STDERR', oldStderr],
      ['PORTAL_CONFIG_DIR', oldPortalConfigDir],
      ['PORTAL_MCP_URL', oldPortalMcpUrl],
      ['KIMI_CODE_HOME', oldKimiCodeHome],
      ['KIMI_MODEL_THINKING_EFFORT', oldThinkingEffort],
    ]) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('runs kimi print mode and parses stream-json events', async () => {
    let argsFile = path.join(tmpDir, 'args.json');
    process.env.KIMI_RUNNER_ARGS_FILE = argsFile;

    let { runKimiStreaming } = await import('../src/runner/kimi-runner.js');
    let result = await runKimiStreaming({ prompt: 'hello', cwd: tmpDir, timeout: 5 });

    assert.equal(result.exitCode, 0);
    assert.equal(result.sessionId, 'session_test');
    assert.equal(result.response, 'Kimi response');
    assert.equal(result.stats, null);
    assert.deepEqual(result.toolCalls, [{ name: 'Bash', args: { command: 'pwd' } }]);
    assert.deepEqual(result.toolResults, [{ name: 'tool', output: 'ok' }]);

    let args = JSON.parse(fs.readFileSync(argsFile, 'utf8'));
    assert.deepEqual(args.slice(0, 4), ['-p', 'hello', '--output-format', 'stream-json']);
  });

  it('passes the model via -m and skips the default sentinel', async () => {
    let argsFile = path.join(tmpDir, 'args-model.json');
    process.env.KIMI_RUNNER_ARGS_FILE = argsFile;

    let { runKimiStreaming } = await import('../src/runner/kimi-runner.js');
    await runKimiStreaming({ prompt: 'hello', cwd: tmpDir, model: 'kimi-code/k3', timeout: 5 });

    let args = JSON.parse(fs.readFileSync(argsFile, 'utf8'));
    assert.equal(args[args.indexOf('-m') + 1], 'kimi-code/k3');

    let defaultArgsFile = path.join(tmpDir, 'args-default.json');
    process.env.KIMI_RUNNER_ARGS_FILE = defaultArgsFile;
    await runKimiStreaming({ prompt: 'hello', cwd: tmpDir, model: 'default', timeout: 5 });

    let defaultArgs = JSON.parse(fs.readFileSync(defaultArgsFile, 'utf8'));
    assert.equal(defaultArgs.includes('-m'), false);
    assert.equal(defaultArgs.includes('default'), false);
  });

  it('resumes a session via -S', async () => {
    let argsFile = path.join(tmpDir, 'args-resume.json');
    process.env.KIMI_RUNNER_ARGS_FILE = argsFile;

    let { runKimiStreaming } = await import('../src/runner/kimi-runner.js');
    await runKimiStreaming({ prompt: 'hello', cwd: tmpDir, sessionId: 'session_abc123', timeout: 5 });

    let args = JSON.parse(fs.readFileSync(argsFile, 'utf8'));
    assert.equal(args[args.indexOf('-S') + 1], 'session_abc123');
    // -c is --continue, never a config override — it must never appear.
    assert.equal(args.includes('-c'), false);
  });

  it('passes thinking effort via KIMI_MODEL_THINKING_EFFORT env', async () => {
    let envFile = path.join(tmpDir, 'env-effort.json');
    process.env.KIMI_RUNNER_ENV_FILE = envFile;

    let { runKimiStreaming } = await import('../src/runner/kimi-runner.js');
    await runKimiStreaming({ prompt: 'hello', cwd: tmpDir, thinkingEffort: 'high', timeout: 5 });

    let env = JSON.parse(fs.readFileSync(envFile, 'utf8'));
    assert.equal(env.KIMI_MODEL_THINKING_EFFORT, 'high');

    let defaultEnvFile = path.join(tmpDir, 'env-effort-default.json');
    process.env.KIMI_RUNNER_ENV_FILE = defaultEnvFile;
    await runKimiStreaming({ prompt: 'hello', cwd: tmpDir, thinkingEffort: 'default', timeout: 5 });

    let defaultEnv = JSON.parse(fs.readFileSync(defaultEnvFile, 'utf8'));
    assert.equal(defaultEnv.KIMI_MODEL_THINKING_EFFORT, null);
  });

  it('isolates Kimi Code in a temp KIMI_CODE_HOME with deny rules for Agent tools', async () => {
    let envFile = path.join(tmpDir, 'env-home.json');
    let homeDump = path.join(tmpDir, 'home-dump');
    process.env.KIMI_RUNNER_ENV_FILE = envFile;
    process.env.KIMI_RUNNER_HOME_DUMP = homeDump;

    let { runKimiStreaming } = await import('../src/runner/kimi-runner.js');
    await runKimiStreaming({ prompt: 'hello', cwd: tmpDir, timeout: 5 });

    let env = JSON.parse(fs.readFileSync(envFile, 'utf8'));
    assert.ok(env.KIMI_CODE_HOME, 'KIMI_CODE_HOME must be set');
    assert.notEqual(env.KIMI_CODE_HOME, path.join(os.homedir(), '.kimi-code'));

    let configToml = fs.readFileSync(homeDump + '.config.toml', 'utf8');
    assert.match(configToml, /decision = "deny"/);
    assert.match(configToml, /pattern = "Agent"/);
    assert.match(configToml, /pattern = "AgentSwarm"/);

    // The isolated home is cleaned up after the run.
    assert.equal(fs.existsSync(env.KIMI_CODE_HOME), false);
  });

  it('injects the portal MCP server via mcp.json in KIMI_CODE_HOME', async () => {
    let homeDump = path.join(tmpDir, 'home-dump-mcp');
    process.env.KIMI_RUNNER_HOME_DUMP = homeDump;
    process.env.PORTAL_MCP_URL = 'http://portal.test/mcp';

    let { runKimiStreaming } = await import('../src/runner/kimi-runner.js');
    await runKimiStreaming({ prompt: 'hello', cwd: tmpDir, chat_id: 'chat-1', taskSecret: 'secret-1', timeout: 5 });

    let mcp = JSON.parse(fs.readFileSync(homeDump + '.mcp.json', 'utf8'));
    let server = mcp.mcpServers['agent-portal-chat'];
    assert.ok(server, 'agent-portal-chat MCP server must be declared');
    assert.equal(server.url, 'http://portal.test/mcp?chatId=chat-1');
    assert.equal(server.headers['X-Agent-Portal-Task-Secret'], 'secret-1');
  });
});
