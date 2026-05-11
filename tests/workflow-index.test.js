import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { parseFrontmatter, buildTagIndex, searchByTags, toLightList } from '../src/tools/workflow-index.js';

const TEST_DIR = path.join(os.tmpdir(), `agent-pool-workflow-index-${Date.now()}`);

describe('workflow-index', () => {
  before(() => {
    fs.mkdirSync(TEST_DIR, { recursive: true });
    fs.writeFileSync(path.join(TEST_DIR, 'node1.md'), '---\ntags: [debug, first-step]\nname: Node 1\n---\nContent 1');
    fs.writeFileSync(path.join(TEST_DIR, 'node2.md'), '---\ntags: [debug, verify]\nname: Node 2\ndescription: Desc 2\n---\nContent 2');
    fs.writeFileSync(path.join(TEST_DIR, 'ignored.txt'), 'Not markdown');
  });

  after(() => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('parses frontmatter metadata and markdown body', () => {
    const parsed = parseFrontmatter('---\ntags: [a, b]\ntransitions: { success: [next] }\n---\n# Body');

    assert.deepStrictEqual(parsed.meta.tags, ['a', 'b']);
    assert.deepStrictEqual(parsed.meta.transitions, { success: ['next'] });
    assert.strictEqual(parsed.body, '# Body');
  });

  it('builds a tag index and searches with AND semantics', () => {
    const { nodes, tagIndex } = buildTagIndex(TEST_DIR);
    const debugMatches = searchByTags(nodes, tagIndex, ['debug']);
    const firstStepMatches = searchByTags(nodes, tagIndex, ['debug', 'first-step']);

    assert.strictEqual(nodes.size, 2);
    assert.strictEqual(debugMatches.length, 2);
    assert.strictEqual(firstStepMatches.length, 1);
    assert.strictEqual(firstStepMatches[0].id, 'node1');
  });

  it('returns lightweight search results without markdown body content', () => {
    const { nodes, tagIndex } = buildTagIndex(TEST_DIR);
    const lightList = toLightList(searchByTags(nodes, tagIndex, ['verify']));

    assert.deepStrictEqual(lightList, [{ id: 'node2', name: 'Node 2', description: 'Desc 2' }]);
  });
});
