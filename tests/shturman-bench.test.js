import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

describe('shturman bench harness', () => {
  it('uses delta and retro nodes until mechanical verification passes', async () => {
    let { runBenchmarkSuite } = await import('../bench/harness.js');
    let calls = [];
    let transport = async request => {
      calls.push(request.metadata);
      if (request.metadata.nodeType === 'attempt' && request.metadata.iteration === 1) {
        return { content: 'not yet', usage: { total_tokens: 3 }, costUsd: 0.001, latencyMs: 10 };
      }
      if (request.metadata.nodeType === 'delta') {
        return {
          content: JSON.stringify({ missing: ['marker'], next_goal: 'include marker' }),
          usage: { total_tokens: 4 },
          costUsd: 0.001,
          latencyMs: 5,
        };
      }
      if (request.metadata.nodeType === 'retro') {
        return {
          content: JSON.stringify({ lacked: ['explicit marker requirement'] }),
          usage: { total_tokens: 4 },
          costUsd: 0.001,
          latencyMs: 5,
        };
      }
      return { content: 'SHTURMAN_OK', usage: { total_tokens: 2 }, costUsd: 0.001, latencyMs: 10 };
    };

    let result = await runBenchmarkSuite({
      repetitions: 1,
      transport,
      arms: [{ id: 'cheap-chain', mode: 'chain', model: 'test-model', maxIterations: 3 }],
      tasks: [
        {
          id: 'marker',
          prompt: 'Return SHTURMAN_OK.',
          checks: [{ type: 'includes', value: 'SHTURMAN_OK' }],
        },
      ],
    });

    assert.equal(result.runs[0].solved, true);
    assert.deepEqual(calls.map(call => call.nodeType), ['attempt', 'delta', 'retro', 'attempt']);
    assert.equal(result.summary[0].solveRate, 1);
    assert.equal(result.summary[0].totalCostUsd, 0.004);
  });

  it('escalates when the same delta repeats', async () => {
    let { runBenchmarkSuite } = await import('../bench/harness.js');
    let transport = async request => {
      if (request.metadata.nodeType === 'attempt') return { content: 'wrong' };
      if (request.metadata.nodeType === 'retro') return { content: '{"lacked":["context"]}' };
      return { content: '{"missing":["marker"],"next_goal":"include marker"}' };
    };

    let result = await runBenchmarkSuite({
      repetitions: 1,
      transport,
      arms: [{ id: 'cheap-chain', mode: 'chain', model: 'test-model', maxIterations: 4 }],
      tasks: [
        {
          id: 'marker',
          prompt: 'Return SHTURMAN_OK.',
          checks: [{ type: 'includes', value: 'SHTURMAN_OK' }],
        },
      ],
    });

    assert.equal(result.runs[0].solved, false);
    assert.equal(result.runs[0].escalated, true);
    assert.equal(result.runs[0].failureReason, 'repeated_delta');
  });

  it('rejects schema-invalid chain answers', async () => {
    let { runBenchmarkSuite } = await import('../bench/harness.js');
    let transport = async request => {
      if (request.metadata.nodeType === 'attempt') return { content: 'wrong' };
      return { content: '{"missing":"not-array"}' };
    };

    await assert.rejects(
      () => runBenchmarkSuite({
        repetitions: 1,
        transport,
        arms: [{ id: 'cheap-chain', mode: 'chain', model: 'test-model', maxIterations: 2 }],
        tasks: [
          {
            id: 'marker',
            prompt: 'Return SHTURMAN_OK.',
            checks: [{ type: 'includes', value: 'SHTURMAN_OK' }],
          },
        ],
      }),
      /delta failed schema validation/,
    );
  });
});

describe('openrouter bench client', () => {
  it('pins provider route and parses a chat completion response', async () => {
    let { createOpenRouterClient } = await import('../bench/openrouter-client.js');
    let captured;
    let client = createOpenRouterClient({
      apiKey: 'test-key',
      baseUrl: 'https://openrouter.test/api/v1',
      appTitle: 'test-app',
      fetchImpl: async (url, options) => {
        captured = { url, options, body: JSON.parse(options.body) };
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({
            model: 'provider/model',
            choices: [{ message: { content: 'ok' } }],
            usage: { total_tokens: 7 },
            openrouter_metadata: { total_cost: 0.002 },
          }),
        };
      },
    });

    let response = await client.complete({
      model: 'provider/model',
      provider: 'provider-slug',
      messages: [{ role: 'user', content: 'hi' }],
    });

    assert.equal(captured.url, 'https://openrouter.test/api/v1/chat/completions');
    assert.equal(captured.options.headers.Authorization, 'Bearer test-key');
    assert.deepEqual(captured.body.provider, {
      order: ['provider-slug'],
      allow_fallbacks: false,
      data_collection: 'deny',
    });
    assert.equal(response.content, 'ok');
    assert.equal(response.costUsd, 0.002);
  });
});
