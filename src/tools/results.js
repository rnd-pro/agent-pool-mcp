/**
 * Task result store — tracks task status, PID, and retrieves results.
 * Supports soft timeout (task continues after timeout), cancel, and post-timeout updates.
 *
 * @module agent-pool/tools/results
 */

import {
  killChildrenForTask,
  killGroup,
  getSystemLoad,
  listChildren,
  listChildrenForTask,
} from '../runner/process-manager.js';
import { getBoardStore } from './board-store.js';
import { getSlotLedger } from '../runner/slot-ledger.js';

/** @type {Map<string, {cwd: string, status: string, prompt: string, approvalMode: string, result: object|null, error: string|null, startedAt: number, completedAt: number|null, pollCount: number, waitHint: string|null, pid: number|null, liveEvents: object[], lastEventAt: number|null}>} */
const taskStore = new Map();

// ── Capacity ledger lifecycle (best-effort; the dead-pid sweep is the safety net) ──

// Upgrade a reserved slot to running and record the task's liveness pid.
function _ledgerRedeem(entry, taskId, pid) {
  if (!entry || !entry.admissionId) return;
  try {
    getSlotLedger().redeem({ admissionId: entry.admissionId, taskId, pid }).catch(() => {});
  } catch { /* ledger unavailable — sweep will reclaim by liveness */ }
}

// Release a slot on task terminal (idempotent).
function _ledgerRelease(entry) {
  if (!entry || !entry.admissionId) return;
  try {
    getSlotLedger().release({ admissionId: entry.admissionId }).catch(() => {});
  } catch { /* ledger unavailable — sweep will reclaim by liveness */ }
}

/** Max number of live events to keep per task (ring buffer) */
const MAX_LIVE_EVENTS = 200;

/** TTL for completed tasks in ms (10 minutes) */
const TASK_TTL_MS = 10 * 60 * 1000;

/** @type {((taskId: string, type: string, data?: object) => void)|null} */
let _notifyCallback = null;

function preview(value, limit) {
  return typeof value === 'string' ? value.substring(0, limit) : '';
}

/**
 * Set a callback that fires on task lifecycle events (for WebSocket push).
 * @param {(taskId: string, type: string, data?: object) => void} cb
 */
export function setNotifyCallback(cb) {
  _notifyCallback = cb;
}

/**
 * Build a lightweight metadata snapshot for notification callbacks.
 * The portal uses this to mirror task state into StateGraph.
 *
 * @param {string} taskId
 * @returns {object|null}
 */
function getTaskMeta(taskId) {
  const entry = taskStore.get(taskId);
  if (!entry) return null;
  return {
    status: entry.status,
    prompt: preview(entry.prompt, 200),
    pid: entry.pid,
    approvalMode: entry.approvalMode,
    startedAt: entry.startedAt,
    completedAt: entry.completedAt,
    error: entry.error,
    eventCount: entry.liveEvents?.length ?? 0,
    lastEventAt: entry.lastEventAt,
    chatId: entry.chatId,
    parentId: entry.parentId,
    agentSlug: entry.agentSlug,
    resourceGroup: entry.resourceGroup,
    provider: entry.provider,
    model: entry.model,
    runner: entry.runner,
    skill: entry.skill,
    sessionId: entry.sessionId,
    icon: entry.icon,
    color: entry.color,
    description: entry.description,
  };
}

// ─── Error classification for retry hints ───────────────────

/**
 * Classify error text and return a retry hint for the calling agent.
 * @param {string} errorText
 * @returns {string} Retry instruction
 */
function classifyError(errorText) {
  const lower = errorText.toLowerCase();

  if (lower.includes('bootstrap stalled') || lower.includes('no substantive jsonl event')) {
    return '🔄 **Bootstrap stalled.** Retry the task; if it repeats, inspect Codex CLI auth, stale session state, and the runner stderr.';
  }
  if (lower.includes('429') || lower.includes('too many requests') || lower.includes('rate limit') ||
      lower.includes('quota') || lower.includes('resource_exhausted') || lower.includes('resource exhausted')) {
    return '🔄 **Rate limited.** Wait 30-60 seconds, then retry the same task with `delegate_task`.';
  }
  if (lower.includes('network') || lower.includes('econnrefused') || lower.includes('econnreset') || lower.includes('etimedout') || lower.includes('fetch failed') || lower.includes('socket hang up')) {
    return '🔄 **Network error.** Check connectivity and retry the task. This is usually transient.';
  }
  if (lower.includes('401') || lower.includes('403') || lower.includes('unauthenticated') || lower.includes('permission denied') || lower.includes('not authenticated')) {
    return '🔑 **Authentication error.** Run `agy` in terminal to re-authenticate, then retry.';
  }
  if (lower.includes('enomem') || lower.includes('out of memory') || lower.includes('heap')) {
    return '💾 **Out of memory.** Too many parallel workers. Cancel some tasks with `cancel_task`, then retry.';
  }
  if (lower.includes('spawn') || lower.includes('enoent')) {
    return '⚙️ **Antigravity CLI not found.** Install: `curl -fsSL https://antigravity.google/cli/install.sh | bash`';
  }
  return '🔄 **Unexpected error.** You can retry the task with `delegate_task`. If the error persists, try a simpler prompt or check `npx agent-pool-mcp --check`.';
}

// Coaching hints — nudge the agent to think about delegation
const COACHING_HINTS = [
  'Think: what else can you do in parallel while this task runs? Delegate another task or work on something independent.',
  'This worker is busy — don\'t wait idle. Check your plan: is there another step you can start now?',
  'Pro tip: batch your delegation. Send 2-3 tasks at once, then collect results when all are done.',
  'Instead of polling, make progress on your main task. Come back to check results after a few steps.',
  'While the worker handles this, consider: is there a subtask you can delegate to another worker?',
  'Your time is valuable. Use delegate_task_readonly with resource_group: "review" to validate your next architectural decision while this runs.',
  'Polling too often wastes tokens. Do meaningful work first, then check results.',
  'Is there a code review, analysis, or research task you can delegate right now?',
];

/**
 * Create a new task entry in the store.
 *
 * @param {string} taskId - Task UUID
 * @param {string} prompt - Task prompt
 * @param {string} [waitHint] - Custom coaching hint for polling
 * @param {string} [approvalMode] - Approval mode (yolo, auto_edit, plan)
 * @param {string} [cwd] - Project root
 * @param {string} [agentSlug] - Agent identifier
 * @param {string} [parentId] - Parent task/chat ID for board tree
 * @param {string} [chatId] - Bound chat ID for UI navigation
 * @param {string} [icon] - Material Symbols icon name for board card
 * @param {string} [color] - CSS color for board card
 * @param {string} [resourceGroup] - Resource group used for this task
 * @param {object} [metadata] - Additional routing metadata for inspection/resume
 */
export function createTask(taskId, prompt, waitHint, approvalMode, cwd = process.cwd(), agentSlug = 'unknown', parentId = null, chatId = null, icon = null, color = null, resourceGroup = null, metadata = {}) {
  taskStore.set(taskId, {
    cwd,
    status: 'running',
    prompt,
    approvalMode: approvalMode ?? 'unknown',
    result: null,
    error: null,
    startedAt: Date.now(),
    completedAt: null,
    pollCount: 0,
    waitHint: waitHint ?? null,
    pid: null,
    parentId: parentId ?? null,
    chatId: chatId ?? null,
    agentSlug: agentSlug ?? 'unknown',
    resourceGroup: resourceGroup ?? null,
    admissionId: metadata.admissionId ?? null,
    provider: metadata.provider ?? null,
    model: metadata.model ?? null,
    runner: metadata.runner ?? null,
    skill: metadata.skill ?? null,
    sessionId: metadata.sessionId ?? null,
    icon: icon || 'smart_toy',
    color: color || '#666',
    description: null, // set below after cleaning
    liveEvents: [],
    lastEventAt: null,
    stderr: '',
  });
  
  // Clean up description for board display: strip injected prefixes, truncate
  let boardDesc = prompt || '';
  // Remove [Agent Mode: ...] and [Workspace Scope ...] injected prefixes
  let lastDoubleNewline = boardDesc.lastIndexOf('\n\n');
  if (lastDoubleNewline > 0 && lastDoubleNewline < boardDesc.length - 2) {
    boardDesc = boardDesc.substring(lastDoubleNewline + 2);
  }
  if (boardDesc.length > 120) boardDesc = boardDesc.substring(0, 120) + '…';
  taskStore.get(taskId).description = boardDesc;
  
  getBoardStore(cwd).addNode({
    id: taskId,
    parentId,
    chatId,
    agentSlug,
    icon: icon || 'smart_toy',
    color: color || '#666',
    description: boardDesc,
    status: 'queued',
    createdAt: new Date().toISOString()
  });

  if (_notifyCallback) _notifyCallback(taskId, 'created', { meta: getTaskMeta(taskId) });
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
    entry.lastEventAt = Date.now();
    // Ring buffer: keep only the last MAX_LIVE_EVENTS
    if (entry.liveEvents.length > MAX_LIVE_EVENTS) {
      entry.liveEvents = entry.liveEvents.slice(-MAX_LIVE_EVENTS);
    }
    if (_notifyCallback) _notifyCallback(taskId, 'event', event);
  }
}

/**
 * Append stderr data to a task (for diagnostics).
 *
 * @param {string} taskId
 * @param {string} chunk - stderr chunk
 */
export function pushTaskStderr(taskId, chunk) {
  const entry = taskStore.get(taskId);
  if (entry && entry.status === 'running') {
    entry.stderr += chunk;
    // Keep only last 2KB of stderr
    if (entry.stderr.length > 2048) {
      entry.stderr = entry.stderr.slice(-2048);
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
  if (entry) {
    entry.pid = pid;
    _ledgerRedeem(entry, taskId, pid);
    getBoardStore(entry.cwd).updateNodeStatus(taskId, { status: 'running', startedAt: new Date().toISOString() });
    if (_notifyCallback) _notifyCallback(taskId, 'pid', { pid, meta: getTaskMeta(taskId) });
  }
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
    _ledgerRelease(entry);
    if (result?.sessionId) entry.sessionId = result.sessionId;

    const cost = result?.stats?.cost;
    const tokens = result?.stats?.tokens?.total || result?.stats?.total_tokens;
    getBoardStore(entry.cwd).updateNodeStatus(taskId, { status: 'done', completedAt: new Date().toISOString(), cost, tokens });

    if (_notifyCallback) _notifyCallback(taskId, 'done', { ...result, meta: getTaskMeta(taskId) });
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
  if (!entry) {
    console.error(`[agent-pool] Late task result dropped because task was already cleaned up: ${taskId}`);
    return;
  }

  if (entry && entry.status === 'done' && entry.result?.softTimeout) {
    entry.result = result;
    entry.completedAt = Date.now();
    entry.pid = null;
    if (result?.sessionId) entry.sessionId = result.sessionId;

    const cost = result?.stats?.cost;
    const tokens = result?.stats?.tokens?.total || result?.stats?.total_tokens;
    getBoardStore(entry.cwd).updateNodeStatus(taskId, { status: 'done', completedAt: new Date().toISOString(), cost, tokens });

    if (_notifyCallback) _notifyCallback(taskId, 'done', { ...result, meta: getTaskMeta(taskId) });
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
    entry.completedAt = Date.now();
    entry.pid = null;
    _ledgerRelease(entry);

    getBoardStore(entry.cwd).updateNodeStatus(taskId, { status: 'error', completedAt: new Date().toISOString() });

    if (_notifyCallback) _notifyCallback(taskId, 'error', { error: errorMessage, meta: getTaskMeta(taskId) });
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
  
  // Recursively cancel all child tasks
  for (const [childTaskId, childEntry] of taskStore.entries()) {
    if (childEntry.parentId === taskId && childEntry.status === 'running') {
      cancelTask(childTaskId);
    }
  }
  entry.status = 'cancelled';
  entry.completedAt = Date.now();
  entry.pid = null;
  _ledgerRelease(entry);

  getBoardStore(entry.cwd).updateNodeStatus(taskId, { status: 'cancelled', completedAt: new Date().toISOString() });

  if (_notifyCallback) _notifyCallback(taskId, 'cancelled', { meta: getTaskMeta(taskId) });

  return {
    content: [{
      type: 'text',
      text: `🛑 Task \`${taskId.substring(0, 8)}\` cancelled after ${elapsed}s.${killed ? ' Process killed.' : ''}`,
    }],
  };
}

/**
 * Finish a task lifecycle and clean up any tracked child processes.
 *
 * Running tasks are cancelled by default because closing a running task without
 * stopping its process leaves the agent pool in an ambiguous state.
 *
 * @param {string} taskId
 * @param {object} [options]
 * @returns {{content: Array<{type: string, text: string}>, isError?: boolean}}
 */
export function finishTask(taskId, options = {}) {
  const killProcess = options.kill_process !== false;
  const recursive = options.recursive !== false;
  const removeFromMemory = options.remove_from_memory === true;
  const seen = new Set();
  const summary = [];
  let totalAttempted = 0;
  let totalKilled = 0;
  let totalRemoved = 0;

  function finishOne(currentTaskId) {
    if (seen.has(currentTaskId)) return;
    seen.add(currentTaskId);

    const entry = taskStore.get(currentTaskId);
    if (!entry) {
      if (killProcess) {
        const orphaned = killChildrenForTask(currentTaskId);
        totalAttempted += orphaned.attempted;
        totalKilled += orphaned.killed;
        if (orphaned.attempted > 0) {
          summary.push(`- \`${currentTaskId.substring(0, 8)}\`: cleaned ${orphaned.attempted} orphaned tracked process(es)`);
        }
      }
      return;
    }

    if (recursive) {
      for (const [childTaskId, childEntry] of [...taskStore.entries()]) {
        if (childEntry.parentId === currentTaskId) finishOne(childTaskId);
      }
    }

    const previousStatus = entry.status;
    let attempted = 0;
    let killed = 0;

    if (entry.pid && killProcess) {
      attempted++;
      if (killGroup(entry.pid)) killed++;
    }

    if (killProcess) {
      const tracked = killChildrenForTask(currentTaskId);
      attempted += tracked.attempted;
      killed += tracked.killed;
    }

    if (previousStatus === 'running') {
      if (!killProcess) {
        summary.push(`- \`${currentTaskId.substring(0, 8)}\`: still running; pass kill_process=true to finish it`);
        return;
      }

      totalAttempted += attempted;
      totalKilled += killed;
      entry.pid = null;
      entry.status = 'cancelled';
      entry.completedAt = Date.now();
      getBoardStore(entry.cwd).updateNodeStatus(currentTaskId, { status: 'cancelled', completedAt: new Date().toISOString() });
      if (_notifyCallback) _notifyCallback(currentTaskId, 'cancelled', { meta: getTaskMeta(currentTaskId) });
      summary.push(`- \`${currentTaskId.substring(0, 8)}\`: running -> cancelled, process attempts=${attempted}, killed=${killed}`);
    } else {
      totalAttempted += attempted;
      totalKilled += killed;
      entry.pid = null;
      summary.push(`- \`${currentTaskId.substring(0, 8)}\`: already ${previousStatus}, stale process attempts=${attempted}, killed=${killed}`);
    }

    if (removeFromMemory) {
      taskStore.delete(currentTaskId);
      totalRemoved++;
    }
  }

  finishOne(taskId);

  if (summary.length === 0) {
    return {
      content: [{ type: 'text', text: `❌ Task not found and no tracked processes matched: \`${taskId}\`` }],
      isError: true,
    };
  }

  return {
    content: [{
      type: 'text',
      text: [
        `✅ Finish task cleanup complete for \`${taskId.substring(0, 8)}\`.`,
        `Processes: attempted=${totalAttempted}, killed=${totalKilled}. Removed from memory=${totalRemoved}.`,
        ...summary,
      ].join('\n'),
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
      return `- \`${id.substring(0, 8)}\` (${elapsed}s${pidInfo}) ${preview(entry.prompt, 60)}...`;
    });
  if (active.length === 0) return null;
  return `\n\n---\n📋 **Active tasks (${active.length})**:\n${active.join('\n')}`;
}

/**
 * Get all tasks.
 *
 * @returns {Array} Array of task objects
 */
export function listAllTasks() {
  return buildTaskList().tasks;
}

/**
 * Get task list plus tracked process diagnostics for the list_tasks MCP tool.
 *
 * @returns {{tasks: Array, staleProcesses: Array}} Task state and stale tracked processes
 */
export function listTaskState() {
  const taskList = buildTaskList();
  const runningTaskCount = taskList.tasks.filter((task) => task.status === 'running').length;
  const systemLoad = getSystemLoad({ runningTaskCount });
  return {
    ...taskList,
    systemLoad: {
      ...systemLoad,
      capacity: {
        ...(systemLoad.capacity || {}),
        runningTaskCount,
        staleProcessCount: taskList.staleProcesses.length,
        trackedChildCount: systemLoad.process?.trackedChildren ?? systemLoad.ours ?? 0,
      },
    },
  };
}

function buildTaskList() {
  const trackedChildren = listChildren();
  const taskIds = new Set(taskStore.keys());

  const tasks = [...taskStore.entries()].map(([id, entry]) => {
    const children = listChildrenForTask(id);
    return {
      id,
      status: entry.status,
      prompt: entry.prompt,
      pid: entry.pid,
      chatId: entry.chatId,
      parentId: entry.parentId,
      agentSlug: entry.agentSlug,
      startedAt: entry.startedAt,
      completedAt: entry.completedAt,
      elapsedMs: Date.now() - entry.startedAt,
      eventCount: entry.liveEvents?.length ?? 0,
      lastEventAt: entry.lastEventAt,
      runner: entry.runner,
      skill: entry.skill,
      model: entry.model,
      provider: entry.provider,
      sessionId: entry.sessionId,
      resourceGroup: entry.resourceGroup,
      error: entry.error,
      trackedChildren: children.map((c) => ({
        pid: c.pid,
        startTime: c.startTime,
        label: c.label,
        elapsedMs: Date.now() - c.startTime,
      })),
    };
  });

  const staleProcesses = trackedChildren
    .filter((c) => !taskIds.has(c.taskId))
    .map((c) => ({
      pid: c.pid,
      taskId: c.taskId,
      startTime: c.startTime,
      label: c.label,
      elapsedMs: Date.now() - c.startTime,
    }));

  return { tasks, staleProcesses };
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
    return formatRunningTaskResult(entry);
  }

  if (entry.status === 'cancelled') {
    return {
      content: [{ type: 'text', text: `🛑 Task was cancelled.` }],
    };
  }

  if (entry.status === 'error') {
    const errorText = entry.error ?? 'Unknown error';
    const retryHint = classifyError(errorText);
    return {
      content: [{ type: 'text', text: `❌ Task failed: ${errorText}\n\n${retryHint}` }],
      isError: true,
    };
  }

  return formatCompletedTaskResult(entry);
}

function formatRunningTaskResult(entry) {
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
        // Extract the most meaningful arg — Antigravity uses file_path, path, query, etc.
        const detail = args.file_path ?? args.path ?? args.file ?? args.query ?? args.symbol ?? args.command ?? '';
        let shortDetail = '';
        if (typeof detail === 'string' && detail.length > 0) {
          // Absolute paths: always trim from start — the tail (project/file) matters most
          const display = detail.startsWith('/') && detail.length > 30
            ? '…' + detail.slice(-30)
            : detail.length > 60 ? '…' + detail.slice(-55) : detail;
          shortDetail = ` → ${display}`;
        }

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
            resultInfo = ' [RUN] running...';
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
    progress = '\n\n[WAIT] *Cold start — Antigravity CLI initialization takes ~15-20s*';
  }

  // Time since last event — key diagnostic
  let activityInfo = '';
  if (entry.lastEventAt) {
    const silentSec = ((Date.now() - entry.lastEventAt) / 1000).toFixed(0);
    if (parseInt(silentSec) > 60) {
      activityInfo = `\n⏱️ Last event ${silentSec}s ago — model may be thinking or rate-limited.`;
    }
  }

  // Stderr diagnostics — parse rate limits, extract actionable info
  let stderrInfo = '';
  if (entry.stderr) {
    const raw = entry.stderr;

    // Count rate limit occurrences
    const rateLimitCount = (raw.match(/429|Too Many Requests|RESOURCE[_ ]EXHAUSTED/gi) || []).length;

    // Forward-compatible: extract retry delay if present in stderr.
    // Currently Google SDK does NOT include retryDelayMs in console.error output,
    // but if Antigravity CLI or SDK adds it in the future, this parser will pick it up.
    // Supported formats:
    // retryDelay: '42s'  (Google API RetryInfo)
    // retryDelayMs: 42000  (Antigravity CLI error object)
    // Retry-After: 30  (HTTP header)
    let retrySeconds = null;
    const msMatch = raw.match(/retryDelayMs[:"'\s]*(\d+)/i);
    const secMatch = raw.match(/retryDelay[:"'\s]*'?(\d+)s'?/i);
    const headerMatch = raw.match(/Retry-After[:"'\s]*(\d+)/i);
    if (msMatch) retrySeconds = Math.ceil(parseInt(msMatch[1]) / 1000);
    else if (secMatch) retrySeconds = parseInt(secMatch[1]);
    else if (headerMatch) retrySeconds = parseInt(headerMatch[1]);

    if (rateLimitCount > 0) {
      const parts = [`⚡ Rate limited (429 × ${rateLimitCount})`];
      if (retrySeconds) {
        const resetAt = new Date(Date.now() + retrySeconds * 1000);
        const resetTime = resetAt.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
        parts.push(`resets ~${resetTime} (${retrySeconds}s)`);
      }
      stderrInfo = `\n${parts.join(' — ')}`;
    } else {
      // Show other errors (non-rate-limit)
      const lines = raw.trim().split('\n')
        .filter((l) => !l.includes('IDEClient') && !l.includes('YOLO mode') && !l.includes('Loaded cached') && l.trim())
        .slice(-3);
      if (lines.length > 0) {
        stderrInfo = `\n📋 stderr: ${lines.join(' | ').substring(0, 200)}`;
      }
    }
  }

  // PID alive check
  let pidStatus = '';
  if (entry.pid) {
    try {
      process.kill(entry.pid, 0); // signal 0 = check alive
      pidStatus = ' (alive)';
    } catch {
      pidStatus = ' (dead ⚠️)';
    }
  }

  // System load awareness during polling
  const load = getSystemLoad();
  const loadInfo = load.warning ? `\n\n${load.warning}` : '';

  const modeLabel = entry.approvalMode === 'plan' ? '🔒 read-only' : entry.approvalMode === 'yolo' ? '✏️ full-access' : `⚙️ ${entry.approvalMode}`;

  return {
    content: [
      {
        type: 'text',
        text: `[RUN] Task is still running (${elapsed}s elapsed, ${entry.liveEvents.length} events).\n\n- **Prompt**: ${preview(entry.prompt, 100)}...\n- **Mode**: ${modeLabel}\n- **PID**: ${entry.pid ?? 'unknown'}${pidStatus}${activityInfo}${stderrInfo}${progress}\n\n[INFO] **${hint}**${loadInfo}\n\nCheck again later with \`get_task_result\`.`,
      },
      {
        type: 'text',
        text: `__EVENTS__:${JSON.stringify(entry.liveEvents)}`,
      }
    ],
  };
}

function formatCompletedTaskResult(entry) {
  const result = entry.result;

  const sections = [];

  // Soft timeout indicator
  if (result.softTimeout) {
    sections.push(`> [WAIT] **Soft timeout** reached after ${result.timeoutSeconds}s. Process may still be running — partial result below.`);
  }
  if (result.bootstrapStalled) {
    sections.push(`> [ERR] **Bootstrap stalled** after ${result.timeoutSeconds}s. The runner killed the process because Codex did not emit a substantive JSONL event.`);
  }

  // Agent failed to produce a response (either non-zero exit or caught error)
  const hasErrorExit = result.exitCode && result.exitCode !== 0;
  const hasCaughtErrors = result.errors && result.errors.length > 0;
  
  if ((hasErrorExit || hasCaughtErrors) && !result.response) {
    sections.push(`## [ERR] Agent Failed (exit code ${result.exitCode})\n\nThe agent process terminated without producing a response.`);
    if (result.toolCalls?.length > 0) {
      const lastTools = result.toolCalls.slice(-5).map((t) => `- \`${t.name}\``).join('\n');
      sections.push(`### Last Tool Calls\n\n${lastTools}`);
    }
    if (result.errors?.length > 0) {
      sections.push(`### Errors\n\n${result.errors.join('\n')}`);
    }
    // Include stderr diagnostics (rate limits, etc.)
    if (entry.stderr) {
      const rateLimitCount = (entry.stderr.match(/429|Too Many Requests|RESOURCE[_ ]EXHAUSTED/gi) || []).length;
      if (rateLimitCount > 0) {
        sections.push(`### Cause: Rate Limit\n\n⚡ **${rateLimitCount} rate limit errors (429)** during execution. Task failed because API quota was exhausted.\n\n💡 Wait a few minutes for quota to reset, then retry.`);
      } else {
        const stderrLines = entry.stderr.trim().split('\n')
          .filter((l) => !l.includes('IDEClient') && !l.includes('YOLO mode') && !l.includes('Loaded cached') && l.trim())
          .slice(-5);
        if (stderrLines.length > 0) {
          sections.push(`### Stderr\n\n\`\`\`\n${stderrLines.join('\n')}\n\`\`\``);
        }
      }
    }
    const errorSignal = (result.errors ?? []).join(' ');
    sections.push(`### Recovery\n\n${classifyError(errorSignal || `exit code ${result.exitCode}`)}`);
  }

  if (result.response) {
    sections.push(`## Agent Response\n\n${result.response}`);
  }
  if (result.toolCalls?.length > 0 && result.response) {
    const toolSummary = result.toolCalls.map((t) => `- **${t.name}**`).join('\n');
    sections.push(`## Tools Used (${result.toolCalls.length})\n\n${toolSummary}`);
  }
  if (result.errors?.length > 0 && result.response) {
    sections.push(`## Errors\n\n${result.errors.join('\n')}`);
  }
  const statParts = [];
  if (entry.approvalMode) statParts.push(`- Mode: ${entry.approvalMode}`);
  if (result.sessionId) statParts.push(`- Session ID: \`${result.sessionId}\``);
  if (entry.provider) statParts.push(`- Provider: ${entry.provider}`);
  if (entry.model) statParts.push(`- Model: ${entry.model}`);
  if (entry.resourceGroup) statParts.push(`- Resource group: ${entry.resourceGroup}`);
  if (entry.chatId) statParts.push(`- Chat ID: \`${entry.chatId}\``);
  if (result.stats) {
    const s = result.stats;
    const models = Object.keys(s.models ?? {});
    if (models.length > 0) statParts.push(`- Models: ${models.join(', ')}`);
    if (s.total_tokens) statParts.push(`- Tokens: ${s.total_tokens} total`);
    if (s.tokens) {
      const tks = typeof s.tokens === 'object' ? s.tokens.total : s.tokens;
      statParts.push(`- Tokens: ${tks} total`);
    }
    if (s.cost !== undefined && s.cost !== null) statParts.push(`- Cost: $${Number(s.cost).toFixed(4)}`);
    if (s.duration_ms) statParts.push(`- Duration: ${(s.duration_ms / 1000).toFixed(1)}s`);
  }
  if (result.exitCode !== null && result.exitCode !== undefined) {
    statParts.push(`- Exit code: ${result.exitCode}`);
  }
  sections.push(`## Stats\n\n${statParts.join('\n')}`);

  return {
    content: [
      { type: 'text', text: sections.join('\n\n---\n\n') },
      { type: 'text', text: `__RESULT_JSON__:${JSON.stringify(result)}` }
    ],
  };
}

// TTL auto-cleanup: purge completed tasks that were never polled
setInterval(() => {
  const now = Date.now();
  for (const [taskId, entry] of taskStore) {
    if (entry.result?.softTimeout && entry.pid) continue;
    if (entry.status !== 'running' && entry.completedAt && (now - entry.completedAt) > TASK_TTL_MS) {
      taskStore.delete(taskId);
    }
  }
}, 60_000).unref();
