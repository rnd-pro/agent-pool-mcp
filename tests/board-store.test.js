import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { getBoardStore } from '../src/tools/board-store.js';
import { getProjectStatePath, getProjectStateDir, ensureDirFor } from '../src/runtime/paths.js';

const TEST_CWD = path.join(os.tmpdir(), `agent-pool-board-${Date.now()}`);

describe('board store', () => {
  after(() => {
    fs.rmSync(TEST_CWD, { recursive: true, force: true });
    fs.rmSync(getProjectStateDir(TEST_CWD), { recursive: true, force: true });
  });

  it('loads persisted board state before the first snapshot', () => {
    // Board state is project-state (single source: ~/.agent-portal/projects/<key>/), not a per-project
    // .agent-portal checkout — write where BoardStore reads.
    let file = getProjectStatePath(TEST_CWD, 'board-state.json');
    ensureDirFor(file);
    fs.writeFileSync(file, JSON.stringify({
      nodes: [{ id: 'task-1', status: 'done' }],
      edges: [{ id: 'edge-1', from: 'parent', to: 'task-1' }],
    }));

    let snapshot = getBoardStore(TEST_CWD).getSnapshot();

    assert.equal(snapshot.nodes.length, 1);
    assert.equal(snapshot.nodes[0].id, 'task-1');
    assert.equal(snapshot.edges.length, 1);
    assert.equal(snapshot.edges[0].to, 'task-1');
  });
});
