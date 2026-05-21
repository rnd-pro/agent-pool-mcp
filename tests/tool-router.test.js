import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createToolRouter } from '../src/tools/toolRouter.js';

function makeRouter(overrides = {}) {
  let calls = [];
  let handlers = {
    handleFinishTask: async (args) => {
      calls.push(['finish_task', args]);
      return { content: [{ type: 'text', text: 'finished' }] };
    },
    handleListTasks: async (args) => {
      calls.push(['list_tasks', args]);
      return { content: [{ type: 'text', text: '' }] };
    },
    ...overrides.handlers,
  };

  return {
    calls,
    router: createToolRouter({
      handlers,
      guardToolCall: overrides.guardToolCall || (() => null),
      getActiveTasks: overrides.getActiveTasks || (() => '\n\nActive tasks: one'),
    }),
  };
}

describe('tool router', () => {
  it('routes finish_task and appends active task footer', async () => {
    let { router, calls } = makeRouter();

    let response = await router({
      params: {
        name: 'finish_task',
        arguments: { task_id: 'task-1', remove_from_memory: true },
      },
    });

    assert.deepEqual(calls, [['finish_task', { task_id: 'task-1', remove_from_memory: true }]]);
    assert.equal(response.isError, undefined);
    assert.equal(response.content[0].text, 'finished\n\nActive tasks: one');
  });

  it('returns guard responses before dispatch', async () => {
    let { router, calls } = makeRouter({
      guardToolCall: () => ({ content: [{ type: 'text', text: 'blocked' }], isError: true }),
    });

    let response = await router({ params: { name: 'finish_task', arguments: {} } });

    assert.deepEqual(calls, []);
    assert.equal(response.isError, true);
    assert.equal(response.content[0].text, 'blocked');
  });

  it('wraps handler errors and preserves active task context', async () => {
    let { router } = makeRouter({
      handlers: {
        handleFinishTask: async () => {
          throw new Error('provider unavailable');
        },
      },
    });

    let response = await router({ params: { name: 'finish_task', arguments: {} } });

    assert.equal(response.isError, true);
    assert.equal(response.content[0].text, 'CLI provider error: provider unavailable\n\nActive tasks: one');
  });

  it('reports unknown tools with active task context', async () => {
    let { router } = makeRouter();

    let response = await router({ params: { name: 'missing_tool', arguments: {} } });

    assert.equal(response.isError, true);
    assert.equal(response.content[0].text, 'Unknown tool: missing_tool\n\nActive tasks: one');
  });

  it('does not append footer to empty text responses', async () => {
    let { router } = makeRouter();

    let response = await router({ params: { name: 'list_tasks', arguments: {} } });

    assert.equal(response.content[0].text, '');
  });
});
