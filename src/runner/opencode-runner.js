/**
 * OpenCode CLI runner — spawns OpenCode CLI processes with JSON output.
 *
 * Uses process-manager for PID tracking and group kill on timeout.
 * OpenCode JSON format differs from Gemini:
 *   - step_start / text / tool_call / tool_result / step_finish
 *   - Session ID in every event's `sessionID` field
 *   - Model specified as `-m provider/model`
 *
 * @module agent-pool/runner/opencode-runner
 */

import { spawn } from 'node:child_process';
import { trackChild, killGroup, untrackChild } from './process-manager.js';
import { setTaskPid, updateTaskResult, pushTaskEvent, pushTaskStderr } from '../tools/results.js';
import { loadConfig } from './config.js';

/**
 * Normalize an OpenCode JSON event into the unified format
 * that the portal UI understands (same shape as Gemini events).
 *
 * @param {object} ev - raw OpenCode event
 * @returns {object|null} normalized event or null to skip
 */
function normalizeEvent(ev) {
  switch (ev.type) {
    case 'text':
      return {
        type: 'message',
        role: 'assistant',
        content: ev.part?.text ?? '',
      };

    case 'tool_call':
      return {
        type: 'tool_use',
        name: ev.part?.name ?? ev.part?.toolName ?? 'unknown',
        tool_name: ev.part?.name ?? ev.part?.toolName ?? 'unknown',
        parameters: ev.part?.input ?? ev.part?.parameters ?? {},
      };

    case 'tool_result':
      return {
        type: 'tool_result',
        output: ev.part?.output ?? ev.part?.result ?? '',
        status: ev.part?.status ?? 'success',
      };

    case 'error':
      return {
        type: 'error',
        message: ev.error?.data?.message ?? ev.error?.message ?? JSON.stringify(ev.error),
        error: ev.error?.data?.message ?? ev.error?.message ?? JSON.stringify(ev.error),
      };

    case 'step_start':
    case 'step_finish':
      // These are structural — not forwarded to UI but tracked
      return null;

    default:
      return null;
  }
}

/**
 * Run OpenCode CLI with JSON format and collect events.
 * Spawns with detached=true for proper group kill on timeout.
 *
 * @param {object} options
 * @param {string} options.prompt - Task prompt
 * @param {string} [options.cwd] - Working directory
 * @param {string} [options.model] - Model ID (e.g. "opencode/gpt-5-nano")
 * @param {number} [options.timeout] - Timeout in seconds
 * @param {string} [options.sessionId] - Session to resume
 * @param {string} [options.taskId] - Task ID for tracking
 * @returns {Promise<object>} Collected events and final response
 */
export function runOpencodeStreaming({ prompt, cwd, model, timeout, sessionId, taskId }) {
  return new Promise((resolve, reject) => {
    const args = ['run', '--format', 'json'];

    if (model) {
      args.push('-m', model);
    }

    if (sessionId) {
      args.push('--session', sessionId);
    }

    args.push(prompt);

    const config = loadConfig();
    const effectiveTimeout = timeout ?? config.limits.timeout;
    const timeoutMs = effectiveTimeout * 1000;

    const spawnOpts = {
      cwd: cwd ?? process.cwd(),
      env: {
        ...process.env,
        TERM: 'dumb',
        CI: '1',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
    };

    const child = spawn('opencode', args, spawnOpts);

    if (taskId) {
      pushTaskEvent(taskId, {
        type: 'message',
        role: 'system',
        content: '⏳ Spawning OpenCode process...'
      });
    }

    trackChild(child.pid, taskId ?? 'streaming', 'opencode-local');
    if (taskId) setTaskPid(taskId, child.pid);

    const events = [];
    let stderrData = '';
    let buffer = '';
    let timeoutHandle;
    let hardTimeoutHandle;
    let resolved = false;
    let detectedSessionId = null;
    let hasReceivedData = false;
    let stepCount = 0;

    if (timeoutMs > 0) {
      timeoutHandle = setTimeout(() => {
        clearTimeout(timeoutHandle);
        timeoutHandle = null;
        resolved = true;

        const responseText = extractResponseText(events);

        resolve({
          sessionId: detectedSessionId,
          response: responseText || '⏳ Agent is still working (soft timeout reached). Partial results returned.',
          stats: extractStats(events),
          toolCalls: extractToolCalls(events),
          toolResults: extractToolResults(events),
          errors: [],
          exitCode: null,
          totalEvents: events.length,
          softTimeout: true,
          timeoutSeconds: effectiveTimeout,
        });
      }, timeoutMs);

      // Hard timeout safety net — kill process group to prevent infinite zombies
      const hardTimeoutMs = Math.min(
        timeoutMs * config.limits.hardTimeoutMultiplier,
        config.limits.hardTimeoutMax * 1000,
      );
      hardTimeoutHandle = setTimeout(() => {
        if (child.exitCode === null) {
          console.error(`[opencode-runner] HARD TIMEOUT: killing PID ${child.pid} after ${hardTimeoutMs / 1000}s`);
          killGroup(child.pid);
        }
      }, hardTimeoutMs);
    }

    child.on('error', (err) => {
      if (resolved) return;
      resolved = true;
      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (hardTimeoutHandle) clearTimeout(hardTimeoutHandle);

      const errMsg = `Failed to start opencode process: ${err.message}`;
      if (taskId) pushTaskStderr(taskId, errMsg);

      resolve({
        sessionId: null,
        response: '',
        stats: null,
        toolCalls: [],
        toolResults: [],
        errors: [errMsg],
        exitCode: -1,
        totalEvents: 0,
        softTimeout: false,
      });
    });

    child.stdout.on('data', (chunk) => {
      if (!hasReceivedData && taskId) {
        hasReceivedData = true;
        pushTaskEvent(taskId, {
          type: 'message',
          role: 'system',
          content: '✅ Connected to OpenCode CLI...'
        });
      }
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop();

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        try {
          const parsed = JSON.parse(trimmed);
          events.push(parsed);

          // Capture session ID from first event
          if (!detectedSessionId && parsed.sessionID) {
            detectedSessionId = parsed.sessionID;
          }

          // Max steps safety — kill runaway agents
          if (parsed.type === 'step_finish') {
            stepCount++;
            if (stepCount >= config.limits.maxSteps && child.exitCode === null) {
              console.error(`[opencode-runner] MAX STEPS (${config.limits.maxSteps}) reached — killing PID ${child.pid}`);
              killGroup(child.pid);
            }
          }

          // Normalize and push to task tracker for live streaming
          if (taskId) {
            const normalized = normalizeEvent(parsed);
            if (normalized) {
              pushTaskEvent(taskId, normalized);
            }
          }
        } catch {
          // Skip non-JSON lines (opencode logs go to stderr, but just in case)
        }
      }
    });

    child.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      // Filter out opencode INFO lines — they're noisy and not errors
      if (!text.startsWith('INFO ')) {
        stderrData += text;
        if (taskId) pushTaskStderr(taskId, text);
      }
    });

    child.on('close', (code) => {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (hardTimeoutHandle) clearTimeout(hardTimeoutHandle);
      untrackChild(child.pid);

      // Process remaining buffer
      if (buffer.trim()) {
        try {
          const parsed = JSON.parse(buffer.trim());
          events.push(parsed);
          if (!detectedSessionId && parsed.sessionID) {
            detectedSessionId = parsed.sessionID;
          }
        } catch { /* ignore */ }
      }

      const result = {
        sessionId: detectedSessionId,
        response: extractResponseText(events),
        stats: extractStats(events),
        toolCalls: extractToolCalls(events),
        toolResults: extractToolResults(events),
        errors: extractErrors(events),
        exitCode: code,
        totalEvents: events.length,
      };

      if (resolved) {
        // Was already resolved via soft timeout — update final result
        if (taskId) updateTaskResult(taskId, result);
        return;
      }

      resolved = true;
      resolve(result);
    });

    child.stdin.end();
  });
}

/**
 * Extract final response text from OpenCode events.
 * @param {Array} events
 * @returns {string}
 */
function extractResponseText(events) {
  return events
    .filter(e => e.type === 'text')
    .map(e => e.part?.text ?? '')
    .join('\n');
}

/**
 * Extract tool calls from events.
 * @param {Array} events
 * @returns {Array}
 */
function extractToolCalls(events) {
  return events
    .filter(e => e.type === 'tool_call')
    .map(e => ({
      name: e.part?.name ?? e.part?.toolName ?? 'unknown',
      args: e.part?.input ?? e.part?.parameters ?? {},
    }));
}

/**
 * Extract tool results from events.
 * @param {Array} events
 * @returns {Array}
 */
function extractToolResults(events) {
  return events
    .filter(e => e.type === 'tool_result')
    .map(e => ({
      name: e.part?.name ?? e.part?.toolName ?? 'unknown',
      output: (e.part?.output ?? e.part?.result ?? '').toString().substring(0, 500),
    }));
}

/**
 * Extract stats from step_finish events.
 * @param {Array} events
 * @returns {object|null}
 */
function extractStats(events) {
  const finishes = events.filter(e => e.type === 'step_finish');
  if (finishes.length === 0) return null;
  const last = finishes[finishes.length - 1];
  return {
    cost: last.part?.cost ?? 0,
    tokens: last.part?.tokens ?? null,
  };
}

/**
 * Extract error messages from events.
 * @param {Array} events
 * @returns {Array<string>}
 */
function extractErrors(events) {
  return events
    .filter(e => e.type === 'error')
    .map(e => e.error?.data?.message ?? e.error?.message ?? JSON.stringify(e.error));
}
