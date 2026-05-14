import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createTask, formatTaskResult, getActiveTasks, removeTask } from '../src/tools/results.js';

const TEST_CWD = path.join(os.tmpdir(), `agent-pool-results-${Date.now()}`);

describe('task results', () => {
  after(() => {
    removeTask('missing-prompt-task');
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
});
