/**
 * Gemini CLI runner — spawns Gemini CLI processes with streaming JSON output.
 *
 * Uses process-manager for PID tracking and group kill on timeout.
 *
 * @module agent-pool/runner/gemini-runner
 */

import { spawn, execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { trackChild, killGroup, untrackChild } from './process-manager.js';
import { getRunner, loadConfig } from './config.js';
import { buildSshSpawn, parseRemotePid } from './ssh.js';
import { setTaskPid, updateTaskResult, pushTaskEvent, pushTaskStderr } from '../tools/results.js';

const DEFAULT_APPROVAL_MODE = 'yolo';

export { DEFAULT_APPROVAL_MODE };


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
    let runner = getRunner(runnerId);
    let isRemote = runner.type === 'ssh';
    let args = [];

    if (sessionId) {
      args.push('--resume', sessionId);
    }
    let finalPrompt = prompt;
    try {
      let teamRulesPath = join(process.env.PORTAL_CONFIG_DIR || join(homedir(), '.agent-portal'), 'context', 'team', 'team-rules.md');
      if (existsSync(teamRulesPath)) {
        let rules = readFileSync(teamRulesPath, 'utf8').trim();
        if (rules) {
          finalPrompt = `[GLOBAL TEAM CONTEXT AND RULES]\n${rules}\n[/GLOBAL TEAM CONTEXT AND RULES]\n\nTask:\n${prompt}`;
        }
      }
    } catch (e) {
      // Ignore read errors
    }

    args.push('-p', finalPrompt);
    args.push(
      '--output-format', 'stream-json',
      '--approval-mode', approvalMode ?? DEFAULT_APPROVAL_MODE,
    );
    let effectiveModel = model || loadConfig().defaultModel;
    if (effectiveModel) {
      args.push('--model', effectiveModel);
    }
    if (policy) {
      args.push('--policy', policy);
    }
    if (includeDirs?.length > 0) {
      for (let dir of includeDirs) {
        args.push('--include-directories', dir);
      }
    }

    let config = loadConfig();
    let effectiveTimeout = timeout ?? config.limits.timeout;
    let timeoutMs = effectiveTimeout * 1000;

    let spawnCmd, spawnArgs, spawnOpts;

    if (isRemote) {
      let ssh = buildSshSpawn(runner, args, cwd ?? process.cwd());
      spawnCmd = ssh.command;
      spawnArgs = ssh.args;
      spawnOpts = { stdio: ['pipe', 'pipe', 'pipe'], detached: true };
    } else {
      spawnCmd = 'gemini';
      spawnArgs = args;
      let currentDepth = parseInt(process.env.AGENT_POOL_DEPTH ?? '0');
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

    let child = spawn(spawnCmd, spawnArgs, spawnOpts);

    if (taskId) {
      pushTaskEvent(taskId, {
        type: 'message',
        role: 'system',
        content: `[WAIT] Spawning Gemini process${isRemote ? ' via SSH' : ''}...`
      });
    }

    trackChild(child.pid, taskId ?? 'streaming', `gemini-${isRemote ? 'ssh' : 'local'}`);
    if (taskId) setTaskPid(taskId, child.pid);

    let events = [];
    let stderrData = '';
    let buffer = '';
    let watchdog = null;
    let hardTimeoutHandle;
    let remotePid = null;
    let resolved = false;
    let hasReceivedData = false;
    let stepCount = 0;

    if (timeoutMs > 0) {
      watchdog = {
        timer: null,
        kick() {
          if (this.timer) clearTimeout(this.timer);
          this.timer = setTimeout(() => {
            // Soft timeout: resolve with partial data
            this.timer = null;
            resolved = true;

            let messages = events.filter((e) => e.type === 'message');
            let toolUses = events.filter((e) => e.type === 'tool_use');
            let responseText = messages
              .filter((m) => m.role === 'assistant')
              .map((m) => m.content ?? m.text ?? '')
              .join('\n');

            resolve({
              sessionId: events.find((e) => e.type === 'init')?.session_id ?? null,
              response: responseText || 
                '[WAIT] Agent is still working (soft inactivity timeout reached). Partial results returned.',
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
              timeoutSeconds: effectiveTimeout,
            });
          }, timeoutMs);
        },
        stop() {
          if (this.timer) clearTimeout(this.timer);
          this.timer = null;
        }
      };
      watchdog.kick();

      // Hard timeout safety net — kill process group to prevent infinite zombies
      let hardTimeoutMs = Math.min(
        timeoutMs * config.limits.hardTimeoutMultiplier,
        config.limits.hardTimeoutMax * 1000,
      );
      hardTimeoutHandle = setTimeout(() => {
        if (child.exitCode === null) {
          console.error(`[gemini-runner] HARD TIMEOUT: killing PID ${child.pid} after ${hardTimeoutMs / 1000}s`);
          killGroup(child.pid);
        }
      }, hardTimeoutMs);
    }

    child.on('error', (err) => {
      if (resolved) return;
      resolved = true;
      if (watchdog) watchdog.stop();
      if (hardTimeoutHandle) clearTimeout(hardTimeoutHandle);
      
      let errMsg = `Failed to start agent process: ${err.message}`;
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
      if (watchdog) watchdog.kick();
      if (!hasReceivedData && taskId) {
        hasReceivedData = true;
        pushTaskEvent(taskId, {
          type: 'message',
          role: 'system',
          content: '✅ Connected to Gemini CLI stream...'
        });
      }
      let text = chunk.toString();
      buffer += text;
      let lines = buffer.split('\n');
      buffer = lines.pop();

      for (let line of lines) {
        let trimmed = line.trim();
        if (!trimmed) continue;

        // Parse remote PID from SSH wrapper
        if (isRemote && !remotePid) {
          let pid = parseRemotePid(trimmed);
          if (pid) {
            remotePid = pid;
            continue; // Don't parse PID line as JSON
          }
        }

        let jsonStr = trimmed;
        let braceIdx = jsonStr.indexOf('{');
        if (braceIdx > 0) {
          jsonStr = jsonStr.substring(braceIdx);
        }
        if (!jsonStr.startsWith('{')) continue;

        try {
          let parsed = JSON.parse(jsonStr);
          events.push(parsed);

          // Max steps safety — kill runaway agents
          if (parsed.type === 'result' || (parsed.type === 'message' && parsed.role === 'assistant')) {
            stepCount++;
            if (stepCount >= config.limits.maxSteps && child.exitCode === null) {
              console.error(`[gemini-runner] MAX STEPS (${config.limits.maxSteps}) reached — killing PID ${child.pid}`);
              killGroup(child.pid);
            }
          }

          if (taskId) pushTaskEvent(taskId, parsed);
        } catch {
          // Skip non-JSON lines
        }
      }
    });

    child.stderr.on('data', (chunk) => {
      if (watchdog) watchdog.kick();
      let msg = chunk.toString();
      stderrData += msg;
      if (taskId) pushTaskStderr(taskId, msg);
    });

    child.on('close', (code) => {
      if (watchdog) watchdog.stop();
      if (hardTimeoutHandle) clearTimeout(hardTimeoutHandle);
      untrackChild(child.pid);

      // If already resolved via soft timeout, update with final complete result
      if (resolved) {
        if (buffer.trim()) {
          try { events.push(JSON.parse(buffer.trim())); } catch { /* ignore */ }
        }
        let messages = events.filter((e) => e.type === 'message');
        let toolUses = events.filter((e) => e.type === 'tool_use');
        let toolResults = events.filter((e) => e.type === 'tool_result');
        let resultEvent = events.find((e) => e.type === 'result');
        let errors = events.filter((e) => e.type === 'error');
        let responseText = messages.filter((m) => m.role === 'assistant').map((m) => m.content ?? m.text ?? '').join('\n');
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

      let messages = events.filter((e) => e.type === 'message');
      let toolUses = events.filter((e) => e.type === 'tool_use');
      let toolResults = events.filter((e) => e.type === 'tool_result');
      let resultEvent = events.find((e) => e.type === 'result');
      let errors = events.filter((e) => e.type === 'error');

      let responseText = messages
        .filter((m) => m.role === 'assistant')
        .map((m) => m.content ?? m.text ?? '')
        .join('\n');

      let initEvent = events.find((e) => e.type === 'init');

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
      let sessions = [];
      for (let line of stdout.split('\n')) {
        let match = line.match(/^\s*(\d+)\.\s+(.+?)\s+\((.+?)\)\s+\[([a-f0-9-]+)\]/);
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
