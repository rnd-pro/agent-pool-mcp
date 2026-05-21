import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TEST_CWD = path.join(os.tmpdir(), `agent-pool-scripts-test-${Date.now()}`);

describe('scripts.js', () => {
  let saveScript, listScripts;

  before(async () => {
    const mod = await import('../src/tools/scripts.js');
    saveScript = mod.saveScript;
    listScripts = mod.listScripts;

    if (!fs.existsSync(TEST_CWD)) {
      fs.mkdirSync(TEST_CWD, { recursive: true });
    }
  });

  after(() => {
    if (fs.existsSync(TEST_CWD)) {
      fs.rmSync(TEST_CWD, { recursive: true, force: true });
    }
  });

  it('listScripts returns empty array when no directory exists', () => {
    const scripts = listScripts(TEST_CWD);
    assert.deepStrictEqual(scripts, []);
  });

  it('saveScript creates a file and returns relative path', () => {
    const relPath = saveScript(TEST_CWD, 'test-script', 'console.log("hello");', 'js');
    assert.strictEqual(relPath, path.join('.agent-portal', 'scripts', 'test-script.js'));
    
    const fullPath = path.join(TEST_CWD, relPath);
    assert.ok(fs.existsSync(fullPath));
    assert.strictEqual(fs.readFileSync(fullPath, 'utf-8'), 'console.log("hello");');
  });

  it('listScripts returns saved scripts', () => {
    const scripts = listScripts(TEST_CWD);
    assert.strictEqual(scripts.length, 1);
    assert.strictEqual(scripts[0].name, 'test-script');
    assert.strictEqual(scripts[0].ext, 'js');
    assert.ok(scripts[0].size > 0);
    assert.strictEqual(scripts[0].path, path.join('.agent-portal', 'scripts', 'test-script.js'));
  });
});
