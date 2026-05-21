import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let oldPath;
let oldArgsFile;
let oldStderr;
let tmpDir;

describe('codex runner', () => {
  beforeEach(() => {
    oldPath = process.env.PATH;
    oldArgsFile = process.env.CODEX_RUNNER_ARGS_FILE;
    oldStderr = process.env.CODEX_RUNNER_STDERR;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-runner-test-'));

    let binPath = path.join(tmpDir, 'codex');
    fs.writeFileSync(binPath, `#!/usr/bin/env node
const fs = require('node:fs');
if (process.env.CODEX_RUNNER_ARGS_FILE) {
  fs.writeFileSync(process.env.CODEX_RUNNER_ARGS_FILE, JSON.stringify(process.argv.slice(2)));
}
if (process.env.CODEX_RUNNER_STDERR) {
  process.stderr.write(process.env.CODEX_RUNNER_STDERR);
}
const events = [
  { type: 'thread.started', thread_id: 'thread-test' },
  { type: 'item.completed', item: { type: 'command_execution', command: 'pwd', aggregated_output: 'ok', exit_code: 0, status: 'completed' } },
  { type: 'item.completed', item: { type: 'agent_message', text: 'Codex response' } },
  { type: 'turn.completed', usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 2, reasoning_output_tokens: 3 } }
];
for (const event of events) console.log(JSON.stringify(event));
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
    if (oldStderr === undefined) {
      delete process.env.CODEX_RUNNER_STDERR;
    } else {
      process.env.CODEX_RUNNER_STDERR = oldStderr;
    }
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
    assert.deepEqual(args.slice(0, 4), ['exec', '--json', '-s', 'danger-full-access']);
    assert.match(args.at(-1), /hello$/);
  });

  it('filters Codex stdin notice out of final errors', async () => {
    process.env.CODEX_RUNNER_STDERR = 'Reading additional input from stdin...\n';

    let { runCodexStreaming } = await import('../src/runner/codex-runner.js');
    let result = await runCodexStreaming({ prompt: 'hello', cwd: tmpDir, timeout: 5 });

    assert.deepEqual(result.errors, []);
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
  });

  it('uses codex exec resume when sessionId is provided', async () => {
    let argsFile = path.join(tmpDir, 'args-resume.json');
    process.env.CODEX_RUNNER_ARGS_FILE = argsFile;

    let { runCodexStreaming } = await import('../src/runner/codex-runner.js');
    await runCodexStreaming({ prompt: 'continue', cwd: tmpDir, sessionId: 'thread-test', timeout: 5 });

    let args = JSON.parse(fs.readFileSync(argsFile, 'utf8'));
    assert.deepEqual(args.slice(0, 4), ['exec', 'resume', '--json', 'thread-test']);
    assert.match(args.at(-1), /continue$/);
  });
});
