/**
 * Inter-agent messaging — file-based JSONL mailboxes.
 *
 * Provides send_message / get_messages tools for agents
 * to pass structured data between pipeline steps or tasks.
 *
 * Uses JSONL format (one JSON object per line) with appendFileSync()
 * to avoid read-modify-write race conditions on concurrent writes.
 *
 * Channel addressing:
 *   - {run_id}           → broadcast to all steps in a pipeline run
 *   - {run_id}:{step}    → targeted to a specific step
 *   - {custom_channel}   → any string for ad-hoc messaging
 *
 * @module agent-pool/tools/messaging
 */

import { appendFileSync, readFileSync, existsSync, mkdirSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { getProjectStatePath } from '../runtime/paths.js';

const MESSAGES_DIR = 'messages';

/**
 * Sanitize channel name for use as filename.
 * @param {string} channel
 * @returns {string}
 */
function sanitizeChannel(channel) {
  return channel.replace(/[^a-zA-Z0-9_:-]/g, '_');
}

/**
 * Send a message to a channel.
 * Uses appendFileSync for atomic writes (no read-modify-write).
 * @param {string} cwd
 * @param {object} opts
 * @param {string} opts.channel - Target channel (e.g., "run_id:step_name")
 * @param {*} opts.payload - Message payload (any JSON-serializable value)
 * @param {string} [opts.from] - Sender identifier
 * @returns {{ success: boolean, channel: string }}
 */
export function sendMessage(cwd, { channel, payload, from }) {
  if (!channel) return { success: false, error: 'channel is required' };

  const dir = getProjectStatePath(cwd, MESSAGES_DIR);
  mkdirSync(dir, { recursive: true });

  const filePath = join(dir, `${sanitizeChannel(channel)}.jsonl`);
  const message = {
    timestamp: new Date().toISOString(),
    from: from || 'unknown',
    payload,
  };

  // JSONL: one JSON object per line, appended atomically
  appendFileSync(filePath, JSON.stringify(message) + '\n');

  return { success: true, channel };
}

/**
 * Get messages from a channel.
 * @param {string} cwd
 * @param {object} opts
 * @param {string} opts.channel - Channel to read from
 * @param {boolean} [opts.clear] - If true, clear the channel after reading
 * @returns {{ messages: Array<{ timestamp: string, from: string, payload: any }>, count: number }}
 */
export function getMessages(cwd, { channel, clear }) {
  if (!channel) return { messages: [], count: 0, error: 'channel is required' };

  const filePath = getProjectStatePath(cwd, MESSAGES_DIR, `${sanitizeChannel(channel)}.jsonl`);
  if (!existsSync(filePath)) return { messages: [], count: 0 };

  let content;
  if (clear) {
    // Atomic consume: rename file first, then read. Any new messages
    // appended after rename go to a NEW file (no data loss).
    const tmpPath = filePath + '.consuming';
    try {
      renameSync(filePath, tmpPath);
      content = readFileSync(tmpPath, 'utf-8').trim();
      unlinkSync(tmpPath);
    } catch {
      // File was deleted or renamed between check and read
      return { messages: [], count: 0 };
    }
  } else {
    try {
      content = readFileSync(filePath, 'utf-8').trim();
    } catch {
      return { messages: [], count: 0 };
    }
  }

  if (!content) return { messages: [], count: 0 };

  const messages = content.split('\n').map(line => {
    try { return JSON.parse(line); }
    catch { return null; }
  }).filter(Boolean);

  return { messages, count: messages.length };
}
