
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { trackChild, killGroup, untrackChild } from './process-manager.js';
import { setTaskPid, updateTaskResult, pushTaskEvent, pushTaskStderr } from '../tools/results.js';
import { loadConfig } from './config.js';
import { getGroupNextModel } from '../tools/groups.js';
import { createProcessWatchdog } from './timeout-manager.js';

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

export async function runOpencodeStreaming(options) {
  let attempt = 0;
  let fallbacks = options.groupConfig?.fallback_profiles || [];
  let rotationMode = options.groupConfig?.rotation_mode || 'error_fallback';
  
  let currentModel = options.model;
  if (!currentModel) {
    if (rotationMode === 'round_robin' && options.groupConfig?.name) {
      currentModel = getGroupNextModel(options.cwd ?? process.cwd(), options.groupConfig.name);
    } else if (fallbacks.length > 0) {
      currentModel = fallbacks[0];
    }
  }

  while (true) {
    let runOpts = { ...options, model: currentModel };
    
    if (attempt > 0 && options.taskId) {
      pushTaskEvent(options.taskId, {
        type: 'message',
        role: 'system',
        content: `🔄 [Fallback Triggered] Retrying task with model: ${currentModel} (Attempt ${attempt + 1})`
      });
      console.error(`[opencode-runner] Fallback: Retrying with ${currentModel}`);
    }

    let result = await runOpencodeStreamingInternal(runOpts);

    // Check if it failed
    let hasError = result.exitCode !== 0 && result.exitCode !== null;
    let hasStreamError = result.errors && result.errors.length > 0;
    
    if (rotationMode === 'error_fallback' && (hasError || hasStreamError)) {
      // Find index of current model in fallbacks
      let nextIndex = 0;
      if (currentModel) {
        nextIndex = fallbacks.indexOf(currentModel) + 1;
      }
      
      if (nextIndex > 0 && nextIndex < fallbacks.length) {
        // We have a fallback
        currentModel = fallbacks[nextIndex];
        attempt++;
        continue;
      }
    }

    // Return the result (either successful or exhausted fallbacks)
    return result;
  }
}

async function runOpencodeStreamingInternal({ prompt, cwd, model, timeout, sessionId, taskId, skill, groupConfig }) {
  return new Promise((resolve, reject) => {
    let args = ['run', '--format', 'json'];

    if (model) {
      args.push('-m', model);
    }

    if (sessionId) {
      args.push('--session', sessionId);
    }

    // Force OpenCode to use our title instead of generating one using its default Haiku fast-model
    let titleParts = [];
    if (groupConfig?.name) titleParts.push(`[Group:${groupConfig.name}]`);
    if (skill) titleParts.push(`[Skill:${skill}]`);
    
    // We append a generic "Agent Task" if nothing else, or mix them.
    let titleString = titleParts.length > 0 ? `${titleParts.join(' ')} Agent Task` : 'Agent Task';
    args.push('--title', titleString);

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
          }

    args.push(finalPrompt);

    let config = loadConfig();
    let effectiveTimeout = timeout ?? config.limits.timeout;
    let timeoutMs = effectiveTimeout * 1000;

    let spawnOpts = {
      cwd: cwd ?? process.cwd(),
      env: {
        ...process.env,
        TERM: 'dumb',
        CI: '1',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
    };

    let child = spawn('opencode', args, spawnOpts);

    if (taskId) {
      pushTaskEvent(taskId, {
        type: 'message',
        role: 'system',
        content: '[WAIT] Spawning OpenCode process...'
      });
    }

    trackChild(child.pid, taskId ?? 'streaming', 'opencode-local');
    if (taskId) setTaskPid(taskId, child.pid);

    let events = [];
    let stderrData = '';
    let buffer = '';
    let resolved = false;
    let detectedSessionId = null;
    let hasReceivedData = false;
    let stepCount = 0;

    let watchdog = createProcessWatchdog(timeoutMs, () => {
      resolved = true;
      let responseText = extractResponseText(events);
      resolve({
        sessionId: detectedSessionId,
        response: responseText || 
          '[WAIT] Agent is still working (soft inactivity timeout reached). Partial results returned.',
        stats: extractStats(events),
        toolCalls: extractToolCalls(events),
        toolResults: extractToolResults(events),
        errors: [],
        exitCode: null,
        totalEvents: events.length,
        softTimeout: true,
        timeoutSeconds: effectiveTimeout,
      });
    }, config, child);
    

    child.on('error', (err) => {
      if (resolved) return;
      resolved = true;
      if (watchdog) watchdog.stop();

      let errMsg = `Failed to start opencode process: ${err.message}`;
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
          content: '✅ Connected to OpenCode CLI...'
        });
      }
      buffer += chunk.toString();
      let lines = buffer.split('\n');
      buffer = lines.pop();

      for (let line of lines) {
        let trimmed = line.trim();
        if (!trimmed) continue;

        try {
          let parsed = JSON.parse(trimmed);
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
            let normalized = normalizeEvent(parsed);
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
      if (watchdog) watchdog.kick();
      let text = chunk.toString();
      // Filter out opencode INFO lines — they're noisy and not errors
      if (!text.startsWith('INFO ')) {
        stderrData += text;
        if (taskId) pushTaskStderr(taskId, text);
      }
    });

    child.on('close', (code) => {
      if (watchdog) watchdog.stop();
      untrackChild(child.pid);

            if (buffer.trim()) {
        try {
          let parsed = JSON.parse(buffer.trim());
          events.push(parsed);
          if (!detectedSessionId && parsed.sessionID) {
            detectedSessionId = parsed.sessionID;
          }
        } catch { /* ignore */ }
      }

      let result = {
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
  let finishes = events.filter(e => e.type === 'step_finish');
  if (finishes.length === 0) return null;
  let last = finishes[finishes.length - 1];
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
