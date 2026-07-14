import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getProjectStatePath } from '../src/runtime/paths.js';

let PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function sendRequest(server, method, params, id) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    let timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for ${method}`));
    }, 5000);

    function cleanup() {
      clearTimeout(timer);
      server.stdout.removeListener('data', onData);
    }

    function onData(chunk) {
      buffer += chunk.toString();
      let lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (let line of lines) {
        if (!line.trim()) continue;
        let message;
        try { message = JSON.parse(line); } catch { continue; }
        if (message.id !== id) continue;
        cleanup();
        if (message.error) reject(new Error(message.error.message || JSON.stringify(message.error)));
        else resolve(message.result);
        return;
      }
    }

    server.stdout.on('data', onData);
    server.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
}

async function waitForTask(server, taskId, firstRequestId) {
  for (let attempt = 0; attempt < 60; attempt++) {
    let result = await sendRequest(server, 'tools/call', {
      name: 'get_task_result',
      arguments: { task_id: taskId },
    }, firstRequestId + attempt);
    let text = result.content?.[0]?.text ?? '';
    if (!text.includes('Task is still running')) return result;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`Task ${taskId} did not complete`);
}

function taskIds(result) {
  let text = result.content?.[0]?.text ?? '';
  return [...text.matchAll(/[0-9a-f]{8}-[0-9a-f-]{27}/g)].map(match => match[0]);
}

async function stopServer(server) {
  if (!server || server.exitCode !== null || server.signalCode !== null) return;
  await new Promise(resolve => {
    let timer = setTimeout(() => {
      server.kill('SIGTERM');
      resolve();
    }, 1000);
    server.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    server.stdin.end();
  });
}

describe('Codex settings delegation propagation', () => {
  it('forwards direct, group, and fallback overrides to every Codex attempt', async () => {
    let tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-pool-codex-delegation-'));
    let binDir = path.join(tempDir, 'bin');
    let workspace = path.join(tempDir, 'workspace');
    let argsFile = path.join(tempDir, 'args.jsonl');
    fs.mkdirSync(binDir, { recursive: true });
    fs.mkdirSync(workspace, { recursive: true });
    let codexPath = path.join(binDir, 'codex');
    fs.writeFileSync(codexPath, `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
if (!args.includes('exec')) {
  console.log('codex 0.test');
  process.exit(0);
}
fs.appendFileSync(process.env.CODEX_SETTINGS_ARGS_FILE, JSON.stringify(args) + '\\n');
if (args.includes('first-model')) {
  process.stderr.write('first model failed\\n');
  process.exit(2);
}
for (const event of [
  { type: 'thread.started', thread_id: 'thread-test' },
  { type: 'item.completed', item: { type: 'agent_message', text: 'Codex response' } },
  { type: 'turn.completed', usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 } }
]) console.log(JSON.stringify(event));
`);
    fs.chmodSync(codexPath, 0o755);

    let server = spawn(process.execPath, [path.join(PACKAGE_ROOT, 'index.js')], {
      cwd: workspace,
      env: {
        ...process.env,
        PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
        HOME: path.join(tempDir, 'home'),
        AGENT_PORTAL_CONFIG_DIR: path.join(tempDir, 'portal-home'),
        AGENT_POOL_DEPTH: '0',
        CODEX_SETTINGS_ARGS_FILE: argsFile,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    try {
      await sendRequest(server, 'initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'codex-settings-test', version: '1.0.0' },
      }, 1);

      let direct = await sendRequest(server, 'tools/call', {
        name: 'delegate_task',
        arguments: {
          provider: 'codex',
          prompt: 'direct settings',
          cwd: workspace,
          reasoningEffort: 'ultra',
          serviceTier: 'priority',
        },
      }, 2);
      await waitForTask(server, taskIds(direct)[0], 10);

      await sendRequest(server, 'tools/call', {
        name: 'create_group',
        arguments: {
          name: 'settings-group',
          profiles: [{ provider: 'codex', model: 'default' }],
        },
      }, 80);
      let grouped = await sendRequest(server, 'tools/call', {
        name: 'delegate_to_group',
        arguments: {
          group: 'settings-group',
          prompt: 'group settings',
          cwd: workspace,
          reasoningEffort: 'max',
          serviceTier: 'priority',
        },
      }, 81);
      await waitForTask(server, taskIds(grouped)[0], 90);

      await sendRequest(server, 'tools/call', {
        name: 'create_group',
        arguments: {
          name: 'fallback-group',
          rotation_mode: 'error_fallback',
          profiles: [
            { provider: 'codex', model: 'first-model' },
            { provider: 'codex', model: 'second-model' },
          ],
        },
      }, 160);
      let fallback = await sendRequest(server, 'tools/call', {
        name: 'delegate_task',
        arguments: {
          resource_group: 'fallback-group',
          prompt: 'fallback settings',
          cwd: workspace,
          reasoningEffort: 'ultra',
          serviceTier: 'priority',
        },
      }, 161);
      await waitForTask(server, taskIds(fallback)[0], 170);

      let unsupported = await sendRequest(server, 'tools/call', {
          name: 'delegate_task',
          arguments: {
            provider: 'antigravity',
            prompt: 'unsupported setting',
            cwd: workspace,
            reasoningEffort: 'high',
          },
        }, 230);
      assert.equal(unsupported.isError, true);
      assert.match(unsupported.content?.[0]?.text || '', /reasoningEffort is only supported by Codex and Claude/);

      let previousConfigDir = process.env.AGENT_PORTAL_CONFIG_DIR;
      process.env.AGENT_PORTAL_CONFIG_DIR = path.join(tempDir, 'portal-home');
      try {
        let scheduledDir = getProjectStatePath(workspace, 'scheduled-results');
        fs.mkdirSync(scheduledDir, { recursive: true });
        fs.writeFileSync(path.join(scheduledDir, 'failed.json'), JSON.stringify({
          scheduleId: 'failed-schedule',
          executedAt: new Date().toISOString(),
          exitCode: 2,
          totalEvents: 0,
          response: '',
          error: 'unknown service tier priority-plus',
        }));
        let scheduledResult = await sendRequest(server, 'tools/call', {
          name: 'get_scheduled_results',
          arguments: { cwd: workspace, schedule_id: 'failed-schedule' },
        }, 231);
        assert.match(scheduledResult.content?.[0]?.text || '', /unknown service tier priority-plus/);

        let runsDir = getProjectStatePath(workspace, 'runs');
        fs.mkdirSync(runsDir, { recursive: true });
        fs.writeFileSync(path.join(runsDir, 'failed-run.json'), JSON.stringify({
          id: 'failed-run',
          pipelineName: 'Failure diagnostics',
          status: 'failed',
          steps: {
            review: { status: 'failed', exitCode: 2, error: 'invalid reasoning effort future-level' },
          },
        }));
        let pipelineResult = await sendRequest(server, 'tools/call', {
          name: 'get_pipeline_status',
          arguments: { cwd: workspace, run_id: 'failed-run' },
        }, 232);
        assert.match(pipelineResult.content?.[0]?.text || '', /exit 2/);
        assert.match(pipelineResult.content?.[0]?.text || '', /invalid reasoning effort future-level/);
      } finally {
        if (previousConfigDir === undefined) delete process.env.AGENT_PORTAL_CONFIG_DIR;
        else process.env.AGENT_PORTAL_CONFIG_DIR = previousConfigDir;
      }

      let calls = fs.readFileSync(argsFile, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      assert.equal(calls.length, 4);
      assert.ok(calls[0].includes('model_reasoning_effort="ultra"'));
      assert.ok(calls[0].includes('service_tier="priority"'));
      assert.ok(calls[1].includes('model_reasoning_effort="max"'));
      assert.ok(calls[1].includes('service_tier="priority"'));
      for (let call of calls.slice(2)) {
        assert.ok(call.includes('model_reasoning_effort="ultra"'));
        assert.ok(call.includes('service_tier="priority"'));
      }
      assert.equal(calls[2].includes('first-model'), true);
      assert.equal(calls[3].includes('second-model'), true);
    } finally {
      await stopServer(server);
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
