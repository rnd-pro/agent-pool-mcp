import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  completeTask,
  createTask,
  finishTask,
  formatTaskResult,
  getActiveTasks,
  listAllTasks,
  listTaskState,
  pushTaskEvent,
  pushTaskStderr,
  removeTask,
  setTaskPid,
  updateTaskResult,
} from '../src/tools/results.js';
import { listChildren, trackChild, untrackChild } from '../src/runner/process-manager.js';

const TEST_CWD = path.join(os.tmpdir(), `agent-pool-results-${Date.now()}`);

describe('task results', () => {
  after(() => {
    removeTask('missing-prompt-task');
    removeTask('running-format-task');
    removeTask('retained-result-task');
    removeTask('soft-timeout-task');
    removeTask('finish-parent-task');
    removeTask('finish-child-task');
    removeTask('finish-done-task');
    removeTask('list-tracked-task');
    removeTask('list-nochildren-task');
    removeTask('list-event-task');
    untrackChild(2147484001);
    untrackChild(2147484002);
    untrackChild(2147484003);
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

  it('formats running task progress and diagnostics', () => {
    fs.mkdirSync(TEST_CWD, { recursive: true });
    createTask('running-format-task', 'inspect prompt', 'custom wait hint', 'yolo', TEST_CWD);
    pushTaskEvent('running-format-task', {
      type: 'tool_use',
      tool_id: 'tool-1',
      tool_name: 'read_file',
      parameters: { file_path: '/tmp/example/project/src/index.js' },
      timestamp: '2026-01-01T00:00:00.000Z',
    });
    pushTaskEvent('running-format-task', {
      type: 'tool_result',
      tool_id: 'tool-1',
      status: 'success',
      output: 'loaded file contents',
      timestamp: '2026-01-01T00:00:02.000Z',
    });
    pushTaskEvent('running-format-task', {
      type: 'message',
      role: 'assistant',
      content: 'reviewing the implementation',
    });
    pushTaskStderr('running-format-task', '429 Too Many Requests retryDelayMs: 42000');

    const result = formatTaskResult('running-format-task');

    assert.match(result.content[0].text, /Task is still running/);
    assert.match(result.content[0].text, /full-access/);
    assert.match(result.content[0].text, /custom wait hint/);
    assert.match(result.content[0].text, /Tools \(1\)/);
    assert.match(result.content[0].text, /read_file/);
    assert.match(result.content[0].text, /loaded file contents/);
    assert.match(result.content[0].text, /Rate limited \(429 × 2\)/);
    assert.match(result.content[0].text, /reviewing the implementation/);
    assert.match(result.content[1].text, /^__EVENTS__:/);
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

  it('finishes running task trees and clears tracked child processes', () => {
    fs.mkdirSync(TEST_CWD, { recursive: true });
    createTask('finish-parent-task', 'parent prompt', null, 'plan', TEST_CWD);
    createTask('finish-child-task', 'child prompt', null, 'plan', TEST_CWD, 'reviewer', 'finish-parent-task');

    setTaskPid('finish-parent-task', 2147483001);
    trackChild(2147483001, 'finish-parent-task', 'fake-parent');
    trackChild(2147483002, 'finish-child-task', 'fake-child');

    const result = finishTask('finish-parent-task');
    const parent = listAllTasks().find((item) => item.id === 'finish-parent-task');
    const child = listAllTasks().find((item) => item.id === 'finish-child-task');

    assert.match(result.content[0].text, /running -> cancelled/);
    assert.equal(parent.status, 'cancelled');
    assert.equal(parent.pid, null);
    assert.equal(child.status, 'cancelled');
    assert.deepEqual(listChildren().filter((childProcess) => childProcess.taskId.startsWith('finish-')), []);
  });

  it('finishes completed tasks without deleting reports unless requested', () => {
    fs.mkdirSync(TEST_CWD, { recursive: true });
    createTask('finish-done-task', 'done prompt', null, 'plan', TEST_CWD);
    completeTask('finish-done-task', { exitCode: 0, response: 'Persisted report' });

    const kept = finishTask('finish-done-task');
    const report = formatTaskResult('finish-done-task');

    assert.match(kept.content[0].text, /already done/);
    assert.match(report.content[0].text, /Persisted report/);

    finishTask('finish-done-task', { remove_from_memory: true });
    const removed = formatTaskResult('finish-done-task');

    assert.equal(removed.isError, true);
  });

  it('exposes tracked child process info per task in listTaskState', () => {
    fs.mkdirSync(TEST_CWD, { recursive: true });
    createTask('list-tracked-task', 'task with children', null, 'plan', TEST_CWD);
    setTaskPid('list-tracked-task', 2147484001);
    trackChild(2147484001, 'list-tracked-task', 'spawn');
    trackChild(2147484002, 'list-tracked-task', 'worker');
    createTask('list-nochildren-task', 'task without children', null, 'plan', TEST_CWD);

    const result = listTaskState();
    const tracked = result.tasks.find((t) => t.id === 'list-tracked-task');
    const nochildren = result.tasks.find((t) => t.id === 'list-nochildren-task');

    assert.equal(tracked.trackedChildren.length, 2);
    assert.ok(tracked.trackedChildren.every((c) => typeof c.pid === 'number' && typeof c.label === 'string' && typeof c.elapsedMs === 'number'));
    assert.equal(nochildren.trackedChildren.length, 0);
  });

  it('exposes safe event counters in listTaskState without raw live diagnostics', () => {
    fs.mkdirSync(TEST_CWD, { recursive: true });
    createTask('list-event-task', 'task with events', null, 'plan', TEST_CWD);

    let before = listTaskState().tasks.find((t) => t.id === 'list-event-task');
    assert.equal(before.eventCount, 0);
    assert.equal(before.lastEventAt, null);
    assert.equal('liveEvents' in before, false);
    assert.equal('stderr' in before, false);

    pushTaskEvent('list-event-task', {
      type: 'tool_use',
      tool_name: 'read_file',
      parameters: { path: 'src/index.js' },
    });
    pushTaskStderr('list-event-task', 'secret stderr diagnostics');

    let afterEvent = listTaskState().tasks.find((t) => t.id === 'list-event-task');
    assert.equal(afterEvent.eventCount, 1);
    assert.equal(typeof afterEvent.lastEventAt, 'number');
    assert.equal('liveEvents' in afterEvent, false);
    assert.equal('stderr' in afterEvent, false);
    assert.equal(JSON.stringify(afterEvent).includes('secret stderr diagnostics'), false);
  });

  it('detects stale tracked processes when taskStore has no matching entry', () => {
    fs.mkdirSync(TEST_CWD, { recursive: true });
    trackChild(2147484003, 'stale-orphan-task', 'orphan');

    const result = listTaskState();

    assert.equal(result.staleProcesses.length, 1);
    const stale = result.staleProcesses[0];
    assert.equal(stale.pid, 2147484003);
    assert.equal(stale.taskId, 'stale-orphan-task');
    assert.equal(stale.label, 'orphan');
    assert.ok(typeof stale.elapsedMs === 'number');
    assert.ok(!result.tasks.some((t) => t.id === 'stale-orphan-task'));
  });
});
