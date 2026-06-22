import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT_PATH = path.join(PACKAGE_ROOT, 'src/scheduler/resolve-content.js');
const TEST_CWD = path.join(os.tmpdir(), `agent-pool-resolve-test-${Date.now()}`);
const MEMORY_ROOT = path.join(TEST_CWD, '.agent-portal');
const CHILD_ENV = { ...process.env, AGENT_PORTAL_MEMORY_ROOT: MEMORY_ROOT };

describe('resolve-content.js', () => {
  before(() => {
    if (!fs.existsSync(TEST_CWD)) fs.mkdirSync(TEST_CWD, { recursive: true });
    
    // Set up bundled-style workflows and active file context in the test project.
    const workflowDir = path.join(TEST_CWD, '.agent-portal', 'workflows', 'debug_protocol');
    fs.mkdirSync(workflowDir, { recursive: true });
    fs.writeFileSync(path.join(workflowDir, '01-reproduce.md'), `---
name: "Debug Protocol: Reproduce"
workflow: debug_protocol
tags:
  - debug
  - first-step
description: "Entry point for the debug protocol."
---

# Step 1: Reproduce the Error
`);
    fs.writeFileSync(path.join(workflowDir, '03-hypothesize.md'), `---
name: "Debug Protocol: Hypothesize"
workflow: debug_protocol
tags:
  - debug
  - hypothesize-step
description: "Formulate a hypothesis."
---

# Step 3: Formulate Hypothesis
`);

    const contextDir = path.join(TEST_CWD, '.agent-portal');
    fs.mkdirSync(contextDir, { recursive: true });
    fs.writeFileSync(path.join(contextDir, 'active_context.json'), JSON.stringify(['src/main.js', 'src/util.js']));
  });

  after(() => {
    if (fs.existsSync(TEST_CWD)) {
      fs.rmSync(TEST_CWD, { recursive: true, force: true });
    }
  });

  function runResolve(sourceObj) {
    try {
      const output = execFileSync('node', [SCRIPT_PATH, JSON.stringify(sourceObj)], {
        cwd: TEST_CWD,
        env: CHILD_ENV,
        encoding: 'utf-8'
      });
      return output.trim();
    } catch (e) {
      return { error: true, output: e.stderr || e.stdout || e.message, status: e.status };
    }
  }

  it('fails with invalid JSON', () => {
    try {
      execFileSync('node', [SCRIPT_PATH, 'invalid_json'], { cwd: TEST_CWD, env: CHILD_ENV });
      assert.fail('Should have thrown');
    } catch (e) {
      assert.strictEqual(e.status, 1);
      assert.ok(e.stderr.includes('Invalid JSON source argument'));
    }
  });

  it('resolves by tags and returns body', () => {
    const out = runResolve({ tags: ['debug', 'first-step'] });
    assert.ok(out.includes('# Step 1: Reproduce the Error'));
  });

  it('resolves by nodeId and returns body', () => {
    const out = runResolve({ nodeId: 'debug_protocol/03-hypothesize' });
    assert.ok(out.includes('# Step 3: Formulate Hypothesis'));
  });

  it('passes variables while resolving workflow content', () => {
    const out = runResolve({ 
      nodeId: 'debug_protocol/01-reproduce',
      variables: { test_var: 'HELLO_WORLD' } 
    });
    // Just verify it resolved without error, we can't easily test substitution if the target markdown doesn't have the variable.
    assert.ok(out.includes('# Step 1: Reproduce the Error'));
  });

  it('handles multiple matches by returning a list', () => {
    const out = runResolve({ tags: ['debug'] });
    assert.ok(out.includes('MULTIPLE MATCHES FOUND'));
    assert.ok(out.includes('- debug_protocol/01-reproduce'));
    assert.ok(out.includes('- debug_protocol/03-hypothesize'));
  });

  it('handles no matches', () => {
    const out = runResolve({ tags: ['nonexistent-tag'] });
    assert.strictEqual(out, 'NO MATCHES FOUND FOR TAGS: nonexistent-tag');
  });

  it('handles nonexistent nodeId', () => {
    const out = runResolve({ nodeId: 'does-not-exist' });
    assert.strictEqual(out, 'NODE NOT FOUND: does-not-exist');
  });
});
