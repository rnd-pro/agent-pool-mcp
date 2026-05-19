import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { completeTask, createTask, formatTaskResult, getActiveTasks, listAllTasks, removeTask, updateTaskResult } from '../src/tools/results.js';

const TEST_CWD = path.join(os.tmpdir(), `agent-pool-results-${Date.now()}`);

describe('task results', () => {
  after(() => {
    removeTask('missing-prompt-task');
    removeTask('retained-result-task');
    removeTask('soft-timeout-task');
    fs.rmSync(TEST_CWD, { recursive: true, force: true });
  });

  it('formats active task summaries even when prompt is missing', () => {
    fs.mkdirSync(TEST_CWD, { recursive: true });
    createTask('missing-prompt-task', undefined, null, 'plan', TEST_CWD);

    const active = getActiveTasks();
    const result = formatTaskResult('missing-prompt-task');

    assert.match(active, /missing-/);
    assert.match(result.content[0].text, /Task is still running/);
  });

  it('retains completed task reports across multiple get_task_result calls', () => {
    fs.mkdirSync(TEST_CWD, { recursive: true });
    createTask('retained-result-task', 'audit prompt', null, 'plan', TEST_CWD, 'reviewer', 'parent-chat', 'chat-1', null, null, 'review', {
      provider: 'claude',
      model: 'deepseek/deepseek-v4-pro',
      sessionId: 'session-1',
    });
    completeTask('retained-result-task', {
      exitCode: 0,
      response: 'Full audit report body',
      sessionId: 'session-2',
      stats: { total_tokens: 123 },
    });

    let first = formatTaskResult('retained-result-task');
    let second = formatTaskResult('retained-result-task');
    let task = listAllTasks().find((item) => item.id === 'retained-result-task');

    assert.match(first.content[0].text, /Full audit report body/);
    assert.match(second.content[0].text, /Full audit report body/);
    assert.match(second.content[0].text, /Provider: claude/);
    assert.ok(second.content[0].text.includes('Model: deepseek/deepseek-v4-pro'));
    assert.equal(task.chatId, 'chat-1');
    assert.equal(task.resourceGroup, 'review');
    assert.equal(task.sessionId, 'session-2');
  });

  it('updates soft-timeout tasks with final results and refreshes metadata', () => {
    fs.mkdirSync(TEST_CWD, { recursive: true });
    createTask('soft-timeout-task', 'slow prompt', null, 'plan', TEST_CWD, 'reviewer', null, 'chat-2', null, null, 'review', {
      provider: 'claude',
      model: 'deepseek/deepseek-v4-pro',
    });
    completeTask('soft-timeout-task', {
      exitCode: 0,
      response: 'Partial response',
      softTimeout: true,
      timeoutSeconds: 300,
    });

    updateTaskResult('soft-timeout-task', {
      exitCode: 0,
      response: 'Final response',
      sessionId: 'session-final',
      stats: { total_tokens: 456 },
    });

    let result = formatTaskResult('soft-timeout-task');
    let task = listAllTasks().find((item) => item.id === 'soft-timeout-task');

    assert.match(result.content[0].text, /Final response/);
    assert.doesNotMatch(result.content[0].text, /Soft timeout/);
    assert.equal(task.sessionId, 'session-final');
  });
});
