/**
 * Task result store — tracks task status and retrieves results.
 * Includes coaching hints to encourage parallel work during polling.
 *
 * @module agent-pool/tools/results
 */

/** @type {Map<string, {status: string, prompt: string, result: object|null, error: string|null, startedAt: number, pollCount: number, waitHint: string|null}>} */
const taskStore = new Map();

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
    pollCount: 0,
    waitHint: waitHint ?? null,
  });
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
  }
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

    return {
      content: [{
        type: 'text',
        text: `⏳ Task is still running (${elapsed}s elapsed).\n\n- **Prompt**: ${entry.prompt.substring(0, 100)}...\n\n💡 **${hint}**\n\nCheck again later with \`get_task_result\`.`,
      }],
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
  removeTask(taskId);

  const sections = [];
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
  statParts.push(`- Exit code: ${result.exitCode}`);
  sections.push(`## Stats\n\n${statParts.join('\n')}`);

  return {
    content: [{ type: 'text', text: sections.join('\n\n---\n\n') }],
  };
}
