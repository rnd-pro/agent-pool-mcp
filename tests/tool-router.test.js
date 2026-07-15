import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createToolRouter } from '../src/tools/toolRouter.js';
import { getToolDefinitions } from '../src/tool-definitions.js';

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

  it('routes prepare_verification, complete_verification, and get_verification_evidence', async () => {
    let handlersCalls = [];
    let { router } = makeRouter({
      handlers: {
        handlePrepareVerification: async (args) => {
          handlersCalls.push(['prepare', args]);
          return { content: [{ type: 'text', text: 'prep-done' }] };
        },
        handleCompleteVerification: async (args) => {
          handlersCalls.push(['complete', args]);
          return { content: [{ type: 'text', text: 'comp-done' }] };
        },
        handleGetVerificationEvidence: async (args) => {
          handlersCalls.push(['get', args]);
          return { content: [{ type: 'text', text: 'get-done' }] };
        },
      },
    });

    let resPrep = await router({
      params: {
        name: 'prepare_verification',
        arguments: { check_kind: 'test', command: 'npm test', inputs: ['index.js'] },
      },
    });
    assert.equal(resPrep.content[0].text, 'prep-done\n\nActive tasks: one');

    let resComp = await router({
      params: {
        name: 'complete_verification',
        arguments: { fingerprint: 'fp-1', lease_id: 'l-1', status: 'success', exit_code: 0 },
      },
    });
    assert.equal(resComp.content[0].text, 'comp-done\n\nActive tasks: one');

    let resGet = await router({
      params: {
        name: 'get_verification_evidence',
        arguments: { check_kind: 'test', command: 'npm test', inputs: ['index.js'] },
      },
    });
    assert.equal(resGet.content[0].text, 'get-done\n\nActive tasks: one');

    assert.deepEqual(handlersCalls, [
      ['prepare', { check_kind: 'test', command: 'npm test', inputs: ['index.js'] }],
      ['complete', { fingerprint: 'fp-1', lease_id: 'l-1', status: 'success', exit_code: 0 }],
      ['get', { check_kind: 'test', command: 'npm test', inputs: ['index.js'] }],
    ]);
  });

  it('publishes bounded verification tool contracts', () => {
    let definitions = new Map(getToolDefinitions().map(tool => [tool.name, tool]));
    let prepare = definitions.get('prepare_verification').inputSchema;
    let complete = definitions.get('complete_verification').inputSchema;
    let get = definitions.get('get_verification_evidence').inputSchema;

    assert.deepEqual(prepare.required, ['check_kind', 'command', 'inputs', 'max_age_seconds']);
    assert.equal(prepare.additionalProperties, false);
    assert.equal(prepare.properties.inputs.minItems, 1);
    assert.equal(prepare.properties.lease_ttl.minimum, 1);
    assert.match(prepare.properties.env_fingerprints.additionalProperties.pattern, /64/);
    assert.deepEqual(complete.required, ['fingerprint', 'lease_id', 'status', 'exit_code']);
    assert.equal(complete.properties.exit_code.type, 'integer');
    assert.equal(get.properties.max_age_seconds.minimum, 0);
  });
});
