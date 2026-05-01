/**
 * History rotation — cleans up old OpenCode sessions on startup.
 *
 * Reads retention config from agent-pool.config.json and deletes
 * sessions older than `history.retentionDays`.
 *
 * @module agent-pool/runner/history-cleanup
 */

import { execFile } from 'node:child_process';
import { loadConfig } from './config.js';

/**
 * List all OpenCode sessions as JSON.
 * @returns {Promise<Array<{id: string, title: string, updated: number, created: number, directory: string}>>}
 */
function listSessions() {
  return new Promise((resolve) => {
    execFile('opencode', ['session', 'list', '--format', 'json'], {
      timeout: 15000,
      env: { ...process.env, TERM: 'dumb', CI: '1' },
    }, (error, stdout) => {
      if (error) return resolve([]);
      try {
        resolve(JSON.parse(stdout));
      } catch {
        resolve([]);
      }
    });
  });
}

/**
 * Delete a single OpenCode session by ID.
 * @param {string} sessionId
 * @returns {Promise<boolean>}
 */
function deleteSession(sessionId) {
  return new Promise((resolve) => {
    execFile('opencode', ['session', 'delete', sessionId], {
      timeout: 10000,
      env: { ...process.env, TERM: 'dumb', CI: '1' },
    }, (error) => {
      resolve(!error);
    });
  });
}

/**
 * Run history cleanup — delete sessions older than configured retention period.
 * Non-blocking, logs results to stderr. Safe to call at startup.
 *
 * @returns {Promise<{deleted: number, total: number, errors: number}>}
 */
export async function runHistoryCleanup() {
  const config = loadConfig();
  if (!config.history.autoCleanup) {
    return { deleted: 0, total: 0, errors: 0 };
  }

  const retentionMs = config.history.retentionDays * 24 * 60 * 60 * 1000;
  const cutoff = Date.now() - retentionMs;

  const sessions = await listSessions();
  if (sessions.length === 0) return { deleted: 0, total: 0, errors: 0 };

  const stale = sessions.filter(s => s.updated < cutoff);
  if (stale.length === 0) {
    console.error(`[agent-pool] History cleanup: ${sessions.length} sessions, none older than ${config.history.retentionDays} days`);
    return { deleted: 0, total: sessions.length, errors: 0 };
  }

  console.error(`[agent-pool] History cleanup: ${stale.length}/${sessions.length} sessions older than ${config.history.retentionDays} days — deleting...`);

  let deleted = 0;
  let errors = 0;
  for (const session of stale) {
    const ok = await deleteSession(session.id);
    if (ok) {
      deleted++;
    } else {
      errors++;
      console.error(`[agent-pool] Failed to delete session ${session.id} ("${session.title}")`);
    }
  }

  console.error(`[agent-pool] History cleanup complete: ${deleted} deleted, ${errors} errors`);
  return { deleted, total: sessions.length, errors };
}
