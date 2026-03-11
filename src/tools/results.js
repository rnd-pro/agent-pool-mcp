/**
 * Task result store — tracks task status, PID, and retrieves results.
 * Supports soft timeout (task continues after timeout), cancel, and post-timeout updates.
 *
 * @module agent-pool/tools/results
 */

import { killGroup } from '../runner/process-manager.js';

/** @type {Map<string, {status: string, prompt: string, result: object|null, error: string|null, startedAt: number, completedAt: number|null, pollCount: number, waitHint: string|null, pid: number|null}>} */
const taskStore = new Map();

/** Max number of live events to keep per task (ring buffer) */
const MAX_LIVE_EVENTS = 200;

/** TTL for completed tasks in ms (10 minutes) */
const TASK_TTL_MS = 10 * 60 * 1000;

// Coaching hints — nudge the agent to think about delegation
const COACHING_HINTS = [
  'Think: what else can you do in parallel while this task runs? Delegate another task or work on something independent.',
  'This worker is busy — don\'t wait idle. Check your plan: is there another step you can start now?',
  'Pro tip: batch your delegation. Send 2-3 tasks at once, then collect results when all are done.',
  'Instead of polling, make progress on your main task. Come back to check results after a few steps.',
  'While the worker handles this, consider: is there a subtask you can delegate to another worker?',
  'Your time is valuable. Use consult_peer to validate your next architectural decision while this runs.',
  'Polling too often wastes tokens. Do meaningful work first, then check results.',
  'Is there a code review, analysis, or research task you can delegate right now?',
];

/**
 * Create a new task entry in the store.
 *
 * @param {string} taskId - Task UUID
 * @param {string} prompt - Task prompt
 * @param {string} [waitHint] - Custom coaching hint for polling
 */
export function createTask(taskId, prompt, waitHint) {
  taskStore.set(taskId, {
    status: 'running',
    prompt,
    result: null,
    error: null,
    startedAt: Date.now(),
    completedAt: null,
    pollCount: 0,
    waitHint: waitHint ?? null,
    pid: null,
    liveEvents: [],
  });
}

/**
 * Push a live event to a running task (for progress tracking).
 *
 * @param {string} taskId
 * @param {object} event - Parsed stream-json event
 */
export function pushTaskEvent(taskId, event) {
  const entry = taskStore.get(taskId);
  if (entry && entry.status === 'running') {
    entry.liveEvents.push(event);
    // Ring buffer: keep only the last MAX_LIVE_EVENTS
    if (entry.liveEvents.length > MAX_LIVE_EVENTS) {
      entry.liveEvents = entry.liveEvents.slice(-MAX_LIVE_EVENTS);
    }
  }
}

/**
 * Associate a PID with a task (called after spawn).
 *
 * @param {string} taskId
 * @param {number} pid
 */
export function setTaskPid(taskId, pid) {
  const entry = taskStore.get(taskId);
  if (entry) entry.pid = pid;
}

/**
 * Mark a task as completed with result.
 *
 * @param {string} taskId
 * @param {object} result
 */
export function completeTask(taskId, result) {
  const entry = taskStore.get(taskId);
  if (entry) {
    entry.status = 'done';
    entry.result = result;
    entry.completedAt = Date.now();
    entry.pid = null;
  }
}

/**
 * Update a task that already resolved via soft timeout with final complete data.
 * Only updates if the task is already 'done' with softTimeout flag.
 *
 * @param {string} taskId
 * @param {object} result - Full result from process completion
 */
export function updateTaskResult(taskId, result) {
  const entry = taskStore.get(taskId);
  if (entry && entry.status === 'done' && entry.result?.softTimeout) {
    entry.result = result;
    entry.pid = null;
  }
}

/**
 * Mark a task as failed with error.
 *
 * @param {string} taskId
 * @param {string} errorMessage
 */
export function failTask(taskId, errorMessage) {
  const entry = taskStore.get(taskId);
  if (entry) {
    entry.status = 'error';
    entry.error = errorMessage;
    entry.pid = null;
  }
}

/**
 * Cancel a running task — kill its process and mark as cancelled.
 *
 * @param {string} taskId
 * @returns {{content: Array<{type: string, text: string}>, isError?: boolean}}
 */
export function cancelTask(taskId) {
  const entry = taskStore.get(taskId);
  if (!entry) {
    return {
      content: [{ type: 'text', text: `❌ Task not found: \`${taskId}\`` }],
      isError: true,
    };
  }

  if (entry.status !== 'running') {
    return {
      content: [{ type: 'text', text: `⚠️ Task \`${taskId.substring(0, 8)}\` is already ${entry.status}, cannot cancel.` }],
    };
  }

  const elapsed = ((Date.now() - entry.startedAt) / 1000).toFixed(0);
  let killed = false;
  if (entry.pid) {
    killed = killGroup(entry.pid);
  }
  entry.status = 'cancelled';
  entry.pid = null;

  return {
    content: [{
      type: 'text',
      text: `🛑 Task \`${taskId.substring(0, 8)}\` cancelled after ${elapsed}s.${killed ? ' Process killed.' : ''}`,
    }],
  };
}

/**
 * Get task entry from store.
 *
 * @param {string} taskId
 * @returns {object|undefined}
 */
export function getTask(taskId) {
  return taskStore.get(taskId);
}

/**
 * Remove task from store.
 *
 * @param {string} taskId
 */
export function removeTask(taskId) {
  taskStore.delete(taskId);
}

/**
 * Get summary of all active tasks for inclusion in tool responses.
 *
 * @returns {string|null} Formatted active tasks string, or null if none
 */
export function getActiveTasks() {
  const active = [...taskStore.entries()]
    .filter(([, entry]) => entry.status === 'running')
    .map(([id, entry]) => {
      const elapsed = ((Date.now() - entry.startedAt) / 1000).toFixed(0);
      const pidInfo = entry.pid ? ` pid:${entry.pid}` : '';
      return `- \`${id.substring(0, 8)}\` (${elapsed}s${pidInfo}) ${entry.prompt.substring(0, 60)}...`;
    });
  if (active.length === 0) return null;
  return `\n\n---\n📋 **Active tasks (${active.length})**:\n${active.join('\n')}`;
}

/**
 * Format task result for MCP response.
 * When task is running, returns coaching hints to encourage parallel work.
 *
 * @param {string} taskId
 * @returns {{content: Array<{type: string, text: string}>, isError?: boolean}}
 */
export function formatTaskResult(taskId) {
  const entry = taskStore.get(taskId);
  if (!entry) {
    return {
      content: [{ type: 'text', text: `❌ Task not found: \`${taskId}\`` }],
      isError: true,
    };
  }

  if (entry.status === 'running') {
    const elapsed = ((Date.now() - entry.startedAt) / 1000).toFixed(0);
    entry.pollCount++;

    // Use custom hint if set, otherwise rotate through coaching hints
    const hint = entry.waitHint
      ? entry.waitHint
      : COACHING_HINTS[(entry.pollCount - 1) % COACHING_HINTS.length];

    // Build progress from live events
    let progress = '';
    if (entry.liveEvents.length > 0) {
      const tools = entry.liveEvents.filter((e) => e.type === 'tool_use');
      const toolResults = entry.liveEvents.filter((e) => e.type === 'tool_result');
      const messages = entry.liveEvents.filter((e) => e.type === 'message' && e.role === 'assistant');
      const parts = [];

      // Show last 3 tool calls with args and results
      if (tools.length > 0) {
        const toolLines = tools.slice(-3).map((t) => {
          const name = t.tool_name ?? t.name ?? '?';
          const args = t.parameters ?? t.arguments ?? {};
          // Extract the most meaningful arg — Gemini uses file_path, path, query, etc.
          const detail = args.file_path ?? args.path ?? args.file ?? args.query ?? args.symbol ?? args.command ?? '';
          const shortDetail = typeof detail === 'string' && detail.length > 0
            ? ` → ${detail.length > 60 ? '…' + detail.slice(-55) : detail}`
            : '';

          // Find matching tool_result by tool_id
          let resultInfo = '';
          if (t.tool_id) {
            const result = toolResults.find((r) => r.tool_id === t.tool_id);
            if (result) {
              // Calculate duration from timestamps
              if (t.timestamp && result.timestamp) {
                const duration = ((new Date(result.timestamp) - new Date(t.timestamp)) / 1000).toFixed(1);
                resultInfo += ` (${duration}s)`;
              }
              // Show brief result output
              const output = result.output ?? '';
              if (output && typeof output === 'string' && output.length > 0) {
                resultInfo += ` ${result.status === 'success' ? '✓' : '✗'} ${output.substring(0, 60)}`;
              }
            } else {
              resultInfo = ' ⏳ running...';
            }
          }
          return `  \`${name}\`${shortDetail}${resultInfo}`;
        });
        parts.push(`🔧 Tools (${tools.length}):\n${toolLines.join('\n')}`);
      }

      // Show last assistant message (agent's thinking/conclusion)
      if (messages.length > 0) {
        const lastMsg = messages[messages.length - 1];
        const text = (lastMsg.content ?? lastMsg.text ?? '').substring(0, 150);
        if (text) parts.push(`💬 ${text}`);
      }

      if (parts.length > 0) {
        progress = `\n\n**Progress:**\n${parts.join('\n')}`;
      }
    } else if (parseInt(elapsed) > 10) {
      progress = '\n\n⏳ *Cold start — Gemini CLI initialization takes ~15-20s*';
    }

    return {
      content: [{
        type: 'text',
        text: `⏳ Task is still running (${elapsed}s elapsed, ${entry.liveEvents.length} events).\n\n- **Prompt**: ${entry.prompt.substring(0, 100)}...${progress}\n\n💡 **${hint}**\n\nCheck again later with \`get_task_result\`.`,
      }],
    };
  }

  if (entry.status === 'cancelled') {
    removeTask(taskId);
    return {
      content: [{ type: 'text', text: `🛑 Task was cancelled.` }],
    };
  }

  if (entry.status === 'error') {
    removeTask(taskId);
    return {
      content: [{ type: 'text', text: `❌ Task failed: ${entry.error}` }],
      isError: true,
    };
  }

  // Done — format result
  const result = entry.result;
  // Don't remove soft-timeout tasks — process is still running, updateTaskResult will update later
  if (!result.softTimeout) {
    removeTask(taskId);
  }

  const sections = [];

  // Soft timeout indicator
  if (result.softTimeout) {
    sections.push(`> ⏳ **Soft timeout** reached after ${result.timeoutSeconds}s. Process may still be running — partial result below.`);
  }

  if (result.response) {
    sections.push(`## Agent Response\n\n${result.response}`);
  }
  if (result.toolCalls?.length > 0) {
    const toolSummary = result.toolCalls.map((t) => `- **${t.name}**`).join('\n');
    sections.push(`## Tools Used (${result.toolCalls.length})\n\n${toolSummary}`);
  }
  if (result.errors?.length > 0) {
    sections.push(`## Errors\n\n${result.errors.join('\n')}`);
  }
  const statParts = [];
  if (result.sessionId) statParts.push(`- Session ID: \`${result.sessionId}\``);
  if (result.stats) {
    const s = result.stats;
    const models = Object.keys(s.models ?? {});
    if (models.length > 0) statParts.push(`- Models: ${models.join(', ')}`);
    if (s.total_tokens) statParts.push(`- Tokens: ${s.total_tokens} total`);
    if (s.duration_ms) statParts.push(`- Duration: ${(s.duration_ms / 1000).toFixed(1)}s`);
  }
  if (result.exitCode !== null && result.exitCode !== undefined) {
    statParts.push(`- Exit code: ${result.exitCode}`);
  }
  sections.push(`## Stats\n\n${statParts.join('\n')}`);

  return {
    content: [{ type: 'text', text: sections.join('\n\n---\n\n') }],
  };
}

// TTL auto-cleanup: purge completed tasks that were never polled
setInterval(() => {
  const now = Date.now();
  for (const [taskId, entry] of taskStore) {
    if (entry.status !== 'running' && entry.completedAt && (now - entry.completedAt) > TASK_TTL_MS) {
      taskStore.delete(taskId);
    }
  }
}, 60_000).unref();
