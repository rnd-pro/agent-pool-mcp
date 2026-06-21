import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { getSlotLedger } from '../src/runner/slot-ledger.js';
import { createToolRouter } from '../src/tools/toolRouter.js';

// AGENT_POOL_LEDGER_DIR is isolated by tests/_ledger-setup.js (--import).

let n = 0;
function uniq(p) { return `${p}-${process.pid}-${++n}`; }

describe('release_slot ledger contract', () => {
  it('releases a reserved slot once, then is idempotent', async () => {
    let ledger = getSlotLedger();
    let admissionId = uniq('adm');
    let group = uniq('rg');

    await ledger.acquire({ admissionId, groupKey: group, limit: 1 });
    assert.equal(await ledger.activeCount({ groupKey: group }), 1);

    let first = await ledger.release({ admissionId });
    assert.equal(first.released, true);
    assert.equal(await ledger.activeCount({ groupKey: group }), 0);

    // Releasing again is a no-op — released:false, never throws.
    let second = await ledger.release({ admissionId });
    assert.equal(second.released, false);
  });

  it('releasing an unknown admission is a no-op', async () => {
    let ledger = getSlotLedger();
    let result = await ledger.release({ admissionId: uniq('never-reserved') });
    assert.equal(result.released, false);
  });
});

describe('release_slot tool wiring', () => {
  function makeRouter(overrides = {}) {
    let calls = [];
    let handlers = {
      handleReleaseSlot: async (args) => {
        calls.push(args);
        return { content: [{ type: 'text', text: JSON.stringify({ ok: true, released: true }) }] };
      },
      ...overrides.handlers,
    };
    return {
      calls,
      router: createToolRouter({
        handlers,
        guardToolCall: () => null,
        getActiveTasks: () => '',
      }),
    };
  }

  it('routes release_slot to its handler with the admission_id', async () => {
    let { router, calls } = makeRouter();

    let response = await router({
      params: { name: 'release_slot', arguments: { admission_id: 'adm-1' } },
    });

    assert.deepEqual(calls, [{ admission_id: 'adm-1' }]);
    assert.equal(response.isError, undefined);
    assert.deepEqual(JSON.parse(response.content[0].text), { ok: true, released: true });
  });

  it('release_slot is not gated by the provider guard', async () => {
    // The provider guard only blocks PROVIDER_TOOLS; release_slot must pass through.
    let guarded = [];
    let { router } = makeRouter();
    let gatedRouter = createToolRouter({
      handlers: {
        handleReleaseSlot: async () => ({ content: [{ type: 'text', text: JSON.stringify({ ok: true, released: false }) }] }),
      },
      guardToolCall: (name) => {
        guarded.push(name);
        return null; // release_slot is not a provider tool → no guard response
      },
      getActiveTasks: () => '',
    });
    void router;

    let response = await gatedRouter({
      params: { name: 'release_slot', arguments: { admission_id: 'adm-2' } },
    });
    assert.equal(response.isError, undefined);
    assert.deepEqual(JSON.parse(response.content[0].text), { ok: true, released: false });
  });
});
