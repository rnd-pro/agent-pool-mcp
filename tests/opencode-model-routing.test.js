import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

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
  for (let attempt = 0; attempt < 60; attempt += 1) {
    let result = await sendRequest(server, 'tools/call', {
      name: 'get_task_result',
      arguments: { task_id: taskId },
    }, firstRequestId + attempt);
    let text = result.content?.[0]?.text ?? '';
    if (!text.includes('Task is still running')) return result;
    await delay(50);
  }
  throw new Error(`Task ${taskId} did not complete`);
}

async function waitForModelDiscovery(server, modelId, firstRequestId) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    let result = await sendRequest(server, 'tools/list', {}, firstRequestId + attempt);
    let delegateTool = result.tools?.find(tool => tool.name === 'delegate_task');
    let description = delegateTool?.inputSchema?.properties?.model?.description ?? '';
    if (description.includes(modelId)) return;
    await delay(50);
  }
  throw new Error(`OpenCode model discovery did not expose ${modelId}`);
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

describe('OpenCode model routing', () => {
  it('fails closed for an unknown group model and preserves the exact known model', async () => {
    let tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-pool-opencode-routing-'));
    let binDir = path.join(tempDir, 'bin');
    let workspace = path.join(tempDir, 'workspace');
    let argsFile = path.join(tempDir, 'run-args.json');
    let portalConfig = path.join(tempDir, 'portal-home');
    fs.mkdirSync(binDir, { recursive: true });
    fs.mkdirSync(workspace, { recursive: true });
    fs.mkdirSync(portalConfig, { recursive: true });
    fs.writeFileSync(path.join(portalConfig, 'agent-portal.json'), JSON.stringify({
      providerModels: {
        opencode: ['openrouter/stealth/ox-alpha'],
      },
    }));

    let opencodePath = path.join(binDir, 'opencode');
    fs.writeFileSync(opencodePath, `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === 'models') {
  console.log('openrouter/known-fallback');
  process.exit(0);
}
if (args[0] === 'session' && args[1] === 'list') {
  console.log('[]');
  process.exit(0);
}
fs.writeFileSync(process.env.OPENCODE_RUN_ARGS_FILE, JSON.stringify(args));
if (args.some(arg => arg.includes('simulate provider failure'))) {
  console.log(JSON.stringify({
    type: 'error',
    error: {
      name: 'APIError',
      data: {
        message: 'exact provider error',
        responseHeaders: { 'set-cookie': 'private-cookie' },
        responseBody: '{"user_id":"private-user"}',
      },
    },
  }));
  process.exit(2);
}
console.log(JSON.stringify({ type: 'text', text: 'bounded result', sessionID: 'ses-routing-test' }));
`);
    fs.chmodSync(opencodePath, 0o755);

    let server = spawn(process.execPath, [path.join(PACKAGE_ROOT, 'index.js')], {
      cwd: workspace,
      env: {
        ...process.env,
        PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
        HOME: path.join(tempDir, 'home'),
        AGENT_PORTAL_CONFIG_DIR: portalConfig,
        AGENT_POOL_DEPTH: '0',
        OPENCODE_RUN_ARGS_FILE: argsFile,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    try {
      await sendRequest(server, 'initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'opencode-routing-test', version: '1.0.0' },
      }, 1);
      await waitForModelDiscovery(server, 'openrouter/stealth/ox-alpha', 10);

      await sendRequest(server, 'tools/call', {
        name: 'create_group',
        arguments: {
          name: 'ox-alpha-pilot',
          profiles: [{ provider: 'opencode', model: 'openrouter/not-a-real-model' }],
          max_agents: 1,
        },
      }, 70);

      let rejected = await sendRequest(server, 'tools/call', {
        name: 'delegate_task',
        arguments: {
          resource_group: 'ox-alpha-pilot',
          prompt: 'must not run',
          cwd: workspace,
          context_mode: 'off',
        },
      }, 71);
      let rejectedText = rejected.content?.[0]?.text ?? '';
      assert.equal(rejected.isError, true, JSON.stringify(rejected));
      assert.match(rejectedText, /Unknown OpenCode model/);
      assert.match(rejectedText, /Execution was not started/);
      assert.doesNotMatch(rejectedText, /Task ID/);
      assert.equal(
        fs.existsSync(argsFile),
        false,
        fs.existsSync(argsFile) ? `unexpected OpenCode args: ${fs.readFileSync(argsFile, 'utf8')}` : 'unknown model must not spawn OpenCode',
      );

      await sendRequest(server, 'tools/call', {
        name: 'create_group',
        arguments: {
          name: 'ox-alpha-pilot',
          profiles: [{ provider: 'opencode', model: 'openrouter/stealth/ox-alpha' }],
          opencode_catalog_override: true,
          max_agents: 1,
        },
      }, 72);

      let delegated = await sendRequest(server, 'tools/call', {
        name: 'delegate_task',
        arguments: {
          resource_group: 'ox-alpha-pilot',
          prompt: 'run exact model',
          cwd: workspace,
          context_mode: 'off',
        },
      }, 73);
      let delegatedText = delegated.content?.[0]?.text ?? '';
      let taskId = delegatedText.match(/`([0-9a-f-]{36})`/)?.[1];
      assert.ok(taskId, delegatedText);

      let result = await waitForTask(server, taskId, 80);
      assert.match(result.content?.[0]?.text ?? '', /bounded result/);

      let runArgs = JSON.parse(fs.readFileSync(argsFile, 'utf8'));
      assert.equal(runArgs[0], 'run');
      assert.equal(runArgs[runArgs.indexOf('-m') + 1], 'openrouter/stealth/ox-alpha');

      let failed = await sendRequest(server, 'tools/call', {
        name: 'delegate_task',
        arguments: {
          resource_group: 'ox-alpha-pilot',
          prompt: 'simulate provider failure',
          cwd: workspace,
          context_mode: 'off',
        },
      }, 150);
      let failedTaskId = (failed.content?.[0]?.text ?? '').match(/`([0-9a-f-]{36})`/)?.[1];
      assert.ok(failedTaskId);

      let failedResult = await waitForTask(server, failedTaskId, 160);
      let failedResultText = failedResult.content?.[0]?.text ?? '';
      assert.match(failedResultText, /exact provider error/);
      assert.doesNotMatch(failedResultText, /set-cookie|private-cookie|user_id|private-user/);

      let listed = await sendRequest(server, 'tools/call', {
        name: 'list_tasks',
        arguments: {},
      }, 230);
      let taskState = JSON.parse(listed.content[0].text);
      let failedTask = taskState.tasks.find(task => task.id === failedTaskId);
      assert.equal(failedTask?.status, 'error');
      assert.match(failedTask.promptSha256, /^[a-f0-9]{64}$/);
      assert.ok(failedTask.promptBytes > Buffer.byteLength('simulate provider failure'));
      assert.equal(
        failedTask.modelSha256,
        createHash('sha256').update('openrouter/stealth/ox-alpha').digest('hex'),
      );
      assert.match(failedTask.resourceConfigSha256, /^[a-f0-9]{64}$/);
    } finally {
      await stopServer(server);
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
