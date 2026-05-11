import { describe, it, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { trackFiles, untrackFiles, getTrackedFiles } from '../src/tools/file-tracker.js';

const TEST_CWD = path.join(os.tmpdir(), `agent-pool-file-tracker-${Date.now()}`);

describe('file-tracker', () => {
  beforeEach(() => {
    fs.rmSync(TEST_CWD, { recursive: true, force: true });
    fs.mkdirSync(TEST_CWD, { recursive: true });
  });

  after(() => {
    fs.rmSync(TEST_CWD, { recursive: true, force: true });
  });

  it('returns an empty list when no context file exists', () => {
    assert.deepStrictEqual(getTrackedFiles(TEST_CWD), []);
  });

  it('tracks files, persists them, and deduplicates entries', () => {
    trackFiles(TEST_CWD, ['src/index.js']);
    const tracked = trackFiles(TEST_CWD, ['src/index.js', 'src/server.js']);

    assert.deepStrictEqual(tracked, ['src/index.js', 'src/server.js']);
    assert.deepStrictEqual(getTrackedFiles(TEST_CWD), ['src/index.js', 'src/server.js']);
  });

  it('untracks selected files and clears all files with an empty list', () => {
    trackFiles(TEST_CWD, ['src/index.js', 'src/server.js']);

    assert.deepStrictEqual(untrackFiles(TEST_CWD, ['src/index.js']), ['src/server.js']);
    assert.deepStrictEqual(untrackFiles(TEST_CWD, []), []);
    assert.deepStrictEqual(getTrackedFiles(TEST_CWD), []);
  });
});
