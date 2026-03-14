/**
 * Gemini CLI runner — spawns Gemini CLI processes with streaming JSON output.
 *
 * Uses process-manager for PID tracking and group kill on timeout.
 *
 * @module agent-pool/runner/gemini-runner
 */

import { spawn, execFile } from 'node:child_process';
import { trackChild, killGroup, untrackChild } from './process-manager.js';
import { getRunner, loadConfig } from './config.js';
import { buildSshSpawn, parseRemotePid } from './ssh.js';
import { setTaskPid, updateTaskResult, pushTaskEvent } from '../tools/results.js';

const DEFAULT_TIMEOUT_SEC = 600;
const DEFAULT_APPROVAL_MODE = 'yolo';

export { DEFAULT_TIMEOUT_SEC, DEFAULT_APPROVAL_MODE };


/**
 * Run Gemini CLI with stream-json format and collect events.
 * Spawns with detached=true for proper group kill on timeout.
 *
 * @param {object} options
 * @param {string} options.prompt - Task prompt
 * @param {string} [options.cwd] - Working directory
 * @param {string} [options.model] - Model ID
 * @param {string} [options.approvalMode] - Approval mode
 * @param {number} [options.timeout] - Timeout in seconds
 * @param {string} [options.sessionId] - Session to resume
 * @param {string} [options.taskId] - Task ID for tracking
 * @returns {Promise<object>} Collected events and final response
 */
export function runGeminiStreaming({ prompt, cwd, model, approvalMode, timeout, sessionId, taskId, runner: runnerId, policy, includeDirs }) {
  return new Promise((resolve, reject) => {
    const runner = getRunner(runnerId);
    const isRemote = runner.type === 'ssh';
    const args = [];

    if (sessionId) {
      args.push('--resume', sessionId);
    }
    args.push('-p', prompt);
    args.push(
      '--output-format', 'stream-json',
      '--approval-mode', approvalMode ?? DEFAULT_APPROVAL_MODE,
    );
    const effectiveModel = model || loadConfig().defaultModel;
    if (effectiveModel) {
      args.push('--model', effectiveModel);
    }
    if (policy) {
      args.push('--policy', policy);
    }
    if (includeDirs?.length > 0) {
      for (const dir of includeDirs) {
        args.push('--include-directories', dir);
      }
    }

    const timeoutMs = (timeout ?? DEFAULT_TIMEOUT_SEC) * 1000;

    let spawnCmd, spawnArgs, spawnOpts;

    if (isRemote) {
      const ssh = buildSshSpawn(runner, args, cwd ?? process.cwd());
      spawnCmd = ssh.command;
      spawnArgs = ssh.args;
      spawnOpts = { stdio: ['pipe', 'pipe', 'pipe'], detached: true };
    } else {
      spawnCmd = 'gemini';
      spawnArgs = args;
      const currentDepth = parseInt(process.env.AGENT_POOL_DEPTH ?? '0');
      spawnOpts = {
        cwd: cwd ?? process.cwd(),
        env: {
          ...process.env,
          TERM: 'dumb',
          CI: '1',
          AGENT_POOL_DEPTH: String(currentDepth + 1),
        },
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: true,
      };
    }

    const child = spawn(spawnCmd, spawnArgs, spawnOpts);

    trackChild(child.pid, taskId ?? 'streaming', `gemini-${isRemote ? 'ssh' : 'local'}`);
    if (taskId) setTaskPid(taskId, child.pid);

    const events = [];
    let stderrData = '';
    let buffer = '';
    let timeoutHandle;
    let remotePid = null;
    let resolved = false;

    if (timeoutMs > 0) {
      timeoutHandle = setTimeout(() => {
        // Soft timeout: resolve with partial data, let process continue in background
        clearTimeout(timeoutHandle);
        timeoutHandle = null;
        resolved = true;

        const messages = events.filter((e) => e.type === 'message');
        const toolUses = events.filter((e) => e.type === 'tool_use');
        const responseText = messages
          .filter((m) => m.role === 'assistant')
          .map((m) => m.content ?? m.text ?? '')
          .join('\n');

        resolve({
          sessionId: events.find((e) => e.type === 'init')?.session_id ?? null,
          response: responseText || '⏳ Agent is still working (soft timeout reached). Partial results returned.',
          stats: null,
          toolCalls: toolUses.map((t) => ({
            name: t.tool_name ?? t.name ?? 'unknown',
            args: t.parameters ?? t.arguments,
          })),
          toolResults: [],
          errors: [],
          exitCode: null,
          totalEvents: events.length,
          softTimeout: true,
          timeoutSeconds: timeout ?? DEFAULT_TIMEOUT_SEC,
        });
        // Process continues running — will be cleaned up on natural exit
      }, timeoutMs);
    }

    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop();

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        // Parse remote PID from SSH wrapper
        if (isRemote && !remotePid) {
          const pid = parseRemotePid(trimmed);
          if (pid) {
            remotePid = pid;
            continue; // Don't parse PID line as JSON
          }
        }

        try {
          const parsed = JSON.parse(trimmed);
          events.push(parsed);
          if (taskId) pushTaskEvent(taskId, parsed);
        } catch {
          // Skip non-JSON lines
        }
      }
    });

    child.stderr.on('data', (chunk) => {
      stderrData += chunk.toString();
    });

    child.on('close', (code) => {
      clearTimeout(timeoutHandle);
      untrackChild(child.pid);

      // If already resolved via soft timeout, update with final complete result
      if (resolved) {
        if (buffer.trim()) {
          try { events.push(JSON.parse(buffer.trim())); } catch { /* ignore */ }
        }
        const messages = events.filter((e) => e.type === 'message');
        const toolUses = events.filter((e) => e.type === 'tool_use');
        const toolResults = events.filter((e) => e.type === 'tool_result');
        const resultEvent = events.find((e) => e.type === 'result');
        const errors = events.filter((e) => e.type === 'error');
        const responseText = messages.filter((m) => m.role === 'assistant').map((m) => m.content ?? m.text ?? '').join('\n');
        if (taskId) {
          updateTaskResult(taskId, {
            sessionId: events.find((e) => e.type === 'init')?.session_id ?? null,
            response: resultEvent?.response ?? responseText,
            stats: resultEvent?.stats ?? null,
            toolCalls: toolUses.map((t) => ({ name: t.tool_name ?? t.name ?? 'unknown', args: t.parameters ?? t.arguments })),
            toolResults: toolResults.map((t) => ({ name: t.tool_name ?? t.tool_id ?? t.name ?? 'unknown', output: t.output ? (typeof t.output === 'string' ? t.output.substring(0, 500) : JSON.stringify(t.output)?.substring(0, 500)) : t.status ?? '' })),
            errors: errors.map((e) => e.message ?? e.error ?? JSON.stringify(e)),
            exitCode: code,
            totalEvents: events.length,
          });
        }
        return;
      }

      // Process remaining buffer
      if (buffer.trim()) {
        try { events.push(JSON.parse(buffer.trim())); } catch { /* ignore */ }
      }

      const messages = events.filter((e) => e.type === 'message');
      const toolUses = events.filter((e) => e.type === 'tool_use');
      const toolResults = events.filter((e) => e.type === 'tool_result');
      const resultEvent = events.find((e) => e.type === 'result');
      const errors = events.filter((e) => e.type === 'error');

      const responseText = messages
        .filter((m) => m.role === 'assistant')
        .map((m) => m.content ?? m.text ?? '')
        .join('\n');

      const initEvent = events.find((e) => e.type === 'init');

      resolve({
        sessionId: initEvent?.session_id ?? initEvent?.sessionId ?? null,
        response: resultEvent?.response ?? responseText,
        stats: resultEvent?.stats ?? null,
        toolCalls: toolUses.map((t) => ({
          name: t.tool_name ?? t.name ?? 'unknown',
          args: t.parameters ?? t.arguments,
        })),
        toolResults: toolResults.map((t) => ({
          name: t.tool_name ?? t.tool_id ?? t.name ?? 'unknown',
          output: t.output
            ? (typeof t.output === 'string' ? t.output.substring(0, 500) : JSON.stringify(t.output)?.substring(0, 500))
            : t.status ?? '',
        })),
        errors: errors.map((e) => e.message ?? e.error ?? JSON.stringify(e)),
        exitCode: code,
        totalEvents: events.length,
      });
    });

    child.on('error', (err) => {
      clearTimeout(timeoutHandle);
      untrackChild(child.pid);
      if (resolved) return;
      reject(new Error(`Failed to spawn gemini: ${err.message}`));
    });

    child.stdin.end();
  });
}

/**
 * List available Gemini CLI sessions for a project directory.
 *
 * @param {string} cwd - Working directory
 * @returns {Promise<Array<{index: number, preview: string, timeAgo: string, sessionId: string}>>}
 */
export function listGeminiSessions(cwd) {
  return new Promise((resolve) => {
    execFile('gemini', ['--list-sessions'], {
      cwd,
      timeout: 10000,
      env: { ...process.env, TERM: 'dumb', CI: '1' },
    }, (error, stdout) => {
      if (error) return resolve([]);
      const sessions = [];
      for (const line of stdout.split('\n')) {
        const match = line.match(/^\s*(\d+)\.\s+(.+?)\s+\((.+?)\)\s+\[([a-f0-9-]+)\]/);
        if (match) {
          sessions.push({
            index: parseInt(match[1]),
            preview: match[2].trim(),
            timeAgo: match[3],
            sessionId: match[4],
          });
        }
      }
      resolve(sessions);
    });
  });
}
