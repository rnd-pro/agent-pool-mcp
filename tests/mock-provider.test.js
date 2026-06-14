import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(__dirname, '..');

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sendRequest(serverProc, method, params, id) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    let settled = false;
    let timer = setTimeout(() => {
      finish();
      reject(new Error(`Timed out waiting for ${method} response ${id}`));
    }, 5000);

    function finish() {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      serverProc.stdout.removeListener('data', onData);
    }

    function onData(data) {
      buffer += data.toString();
      let lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (let line of lines) {
        if (!line.trim()) continue;
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (message.id !== id) continue;
        finish();
        if (message.error) {
          reject(new Error(message.error.message || JSON.stringify(message.error)));
        } else {
          resolve(message.result);
        }
        return;
      }
    }

    serverProc.stdout.on('data', onData);
    serverProc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
}

async function stopServer(serverProc) {
  if (!serverProc || serverProc.exitCode !== null || serverProc.signalCode !== null) return;
  await new Promise((resolve) => {
    let timer = setTimeout(() => {
      serverProc.kill('SIGTERM');
      resolve();
    }, 1000);
    serverProc.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    serverProc.stdin.end();
  });
}

async function waitForCompletedResult(serverProc, taskId, nextId) {
  let lastResult = null;
  for (let attempt = 0; attempt < 30; attempt++) {
    lastResult = await sendRequest(serverProc, 'tools/call', {
      name: 'get_task_result',
      arguments: { task_id: taskId },
    }, nextId + attempt);
    let text = lastResult.content?.[0]?.text ?? '';
    if (!text.includes('Task is still running')) return lastResult;
    await delay(50);
  }
  return lastResult;
}

describe('mock provider delegation', () => {
  it('completes through the mock runner without spawning a CLI process', async () => {
    let tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-pool-mock-provider-'));
    let home = path.join(tmpDir, 'home');
    let cwd = path.join(tmpDir, 'workspace');
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(cwd, { recursive: true });

    let serverProc = spawn(process.execPath, [path.join(PACKAGE_ROOT, 'index.js')], {
      cwd,
      env: {
        ...process.env,
        HOME: home,
        AGENT_POOL_DEPTH: '0',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    try {
      await sendRequest(serverProc, 'initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'mock-provider-test', version: '1.0.0' },
      }, 1);

      let delegated = await sendRequest(serverProc, 'tools/call', {
        name: 'delegate_task',
        arguments: {
          provider: 'mock',
          prompt: 'probe mock',
        },
      }, 2);
      let delegateText = delegated.content?.[0]?.text ?? '';
      let taskId = delegateText.match(/`([0-9a-f-]{36})`/)?.[1];
      assert.ok(taskId, delegateText);

      let result = await waitForCompletedResult(serverProc, taskId, 3);
      let resultText = result.content?.[0]?.text ?? '';
      assert.match(resultText, /Mock final response/);
      assert.match(resultText, /Provider: mock/);
      assert.doesNotMatch(resultText, /Task is still running/);
      assert.doesNotMatch(resultText, /PID:/);

      let listResult = await sendRequest(serverProc, 'tools/call', {
        name: 'list_tasks',
        arguments: {},
      }, 40);
      let taskState = JSON.parse(listResult.content[0].text);
      let task = taskState.tasks.find((item) => item.id === taskId);
      assert.equal(task.status, 'done');
      assert.equal(task.provider, 'mock');
      assert.equal(task.pid, null);
    } finally {
      await stopServer(serverProc);
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
