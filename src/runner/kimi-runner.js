import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { trackChild, untrackChild } from './process-manager.js';
import { setTaskPid, updateTaskResult, pushTaskEvent, pushTaskStderr } from '../tools/results.js';
import { loadConfig } from './config.js';
import { createProcessWatchdog } from './timeout-manager.js';
import {
  createKimiHomeDir,
  cleanupTmpConfig,
  createProviderRuntimeEnv,
} from './provider-config.js';
import { resolvePortalUrl } from './url-resolver.js';
import { TASK_SECRET_ENV } from './task-secret-store.js';

const KIMI_THINKING_EFFORTS = new Set(['low', 'high', 'max']);

function normalizeKimiThinkingEffort(value) {
  let normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized || normalized === 'default') return null;
  return KIMI_THINKING_EFFORTS.has(normalized) ? normalized : null;
}

function parseToolArguments(rawArgs) {
  if (typeof rawArgs !== 'string') return rawArgs ?? {};
  try {
    return JSON.parse(rawArgs);
  } catch {
    return rawArgs;
  }
}

function normalizeKimiEvent(ev) {
  if (ev.role === 'assistant') {
    let normalized = [];
    if (typeof ev.content === 'string' && ev.content.trim()) {
      normalized.push({ type: 'message', role: 'assistant', content: ev.content });
    }
    if (Array.isArray(ev.tool_calls)) {
      for (let call of ev.tool_calls) {
        normalized.push({
          type: 'tool_use',
          name: call.function?.name ?? 'unknown',
          parameters: parseToolArguments(call.function?.arguments),
        });
      }
    }
    if (normalized.length === 0) return null;
    return normalized.length === 1 ? normalized[0] : normalized;
  }

  if (ev.role === 'tool') {
    return {
      type: 'tool_result',
      output: typeof ev.content === 'string' ? ev.content : JSON.stringify(ev.content ?? ''),
      status: 'success',
    };
  }

  if (ev.role === 'meta') {
    // session.resume_hint carries the resumable session id — captured by
    // extractSessionId, not pushed as a task event.
    return null;
  }

  if (ev.role === 'error' || ev.type === 'error') {
    let message = ev.message ?? ev.error?.message ?? JSON.stringify(ev.error ?? ev);
    return { type: 'error', message, error: message };
  }

  return null;
}

export function runKimiStreaming({
  prompt,
  cwd,
  model,
  thinkingEffort,
  approvalMode,
  timeout,
  sessionId,
  taskId,
  chat_id,
  taskSecret,
}) {
  return new Promise((resolve) => {
    let finalPrompt = prompt;
    try {
      let teamRulesPath = join(process.env.PORTAL_CONFIG_DIR || join(homedir(), '.agent-portal'), 'context', 'team', 'team-rules.md');
      if (existsSync(teamRulesPath)) {
        let rules = readFileSync(teamRulesPath, 'utf8').trim();
        if (rules) {
          finalPrompt = `[GLOBAL TEAM CONTEXT AND RULES]\n${rules}\n[/GLOBAL TEAM CONTEXT AND RULES]\n\nTask:\n${prompt}`;
        }
      }
    } catch {
      // Team rules are optional.
    }

    // Kimi Code 0.27: -p cannot combine with --yolo/--plan/--auto and there is
    // no --permission-mode flag, so approvalMode is accepted for interface
    // parity but not forwarded to the CLI.
    let args = ['-p', finalPrompt, '--output-format', 'stream-json'];

    let effectiveModel = model && model !== 'default' ? model : null;
    if (effectiveModel) args.push('-m', effectiveModel);
    let effectiveThinkingEffort = normalizeKimiThinkingEffort(thinkingEffort);
    if (sessionId) args.push('-S', sessionId);

    let portalUrl = resolvePortalUrl();
    if (portalUrl && chat_id) {
      portalUrl += (portalUrl.includes('?') ? '&' : '?') + 'chatId=' + encodeURIComponent(chat_id);
    }

    // Isolated KIMI_CODE_HOME: carries the pool's permission rules and the
    // portal MCP server declaration without polluting the user's ~/.kimi-code.
    let hub = createKimiHomeDir(portalUrl, taskSecret, chat_id);
    let kimiHomeDir = hub.kimiHomeDir;

    let config = loadConfig();
    let effectiveTimeout = timeout ?? config.limits.timeout;
    let timeoutMs = effectiveTimeout * 1000;
    let currentDepth = parseInt(process.env.AGENT_POOL_DEPTH ?? '0');

    let child = spawn('kimi', args, {
      cwd: cwd ?? process.cwd(),
      env: createProviderRuntimeEnv({
        ...process.env,
        TERM: 'dumb',
        CI: '1',
        KIMI_CODE_HOME: kimiHomeDir,
        // Defense-in-depth: a worker agent must NEVER enforce single-writer ownership of the shared
        // ~/.agent-portal state (that belongs to the long-lived backend only). Scrub PORTAL_BACKEND so a
        // worker that touches getStateGraph() cannot claim the token and crash-loop the real backend.
        PORTAL_BACKEND: undefined,
        AGENT_POOL_DEPTH: String(currentDepth + 1),
        ...(portalUrl ? { PORTAL_MCP_URL: portalUrl } : {}),
        // Unconditional: an explicit effort wins, otherwise scrub any value
        // inherited from the parent so pool runs stay deterministic.
        KIMI_MODEL_THINKING_EFFORT: effectiveThinkingEffort || undefined,
        // Set last and unconditionally: the freshly minted per-task secret, or
        // undefined to scrub any value inherited from the parent process so a
        // child can never impersonate the parent's verified slug.
        [TASK_SECRET_ENV]: taskSecret || undefined,
      }),
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
    });

    if (taskId) {
      pushTaskEvent(taskId, {
        type: 'message',
        role: 'system',
        content: '[WAIT] Spawning Kimi Code process...',
      });
    }

    trackChild(child.pid, taskId ?? 'streaming', 'kimi-local');
    if (taskId) setTaskPid(taskId, child.pid);

    let events = [];
    let stderrData = '';
    let buffer = '';
    let resolved = false;
    let hasReceivedData = false;

    let watchdog = createProcessWatchdog(timeoutMs, () => {
      resolved = true;
      let responseText = extractResponseText(events);
      resolve({
        sessionId: extractSessionId(events),
        response: responseText || '[WAIT] Agent is still working (soft inactivity timeout reached). Partial results returned.',
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
      if (kimiHomeDir) cleanupTmpConfig(kimiHomeDir);

      let errMsg = `Failed to start kimi process: ${err.message}`;
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
          content: '✅ Connected to Kimi Code stream...',
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

          if (taskId) {
            let normalized = normalizeKimiEvent(parsed);
            if (Array.isArray(normalized)) {
              normalized.forEach(n => pushTaskEvent(taskId, n));
            } else if (normalized) {
              pushTaskEvent(taskId, normalized);
            }
          }
        } catch (err) {
          console.error('[kimi-runner] Failed to parse JSON:', trimmed, err.message);
        }
      }
    });

    child.stderr.on('data', (chunk) => {
      // Stderr is diagnostic output, not proof of substantive agent progress.
      let text = chunk.toString();
      stderrData += text;
      if (taskId) pushTaskStderr(taskId, text);
    });

    child.on('close', (code) => {
      if (watchdog) watchdog.stop();
      untrackChild(child.pid);
      if (kimiHomeDir) {
        try { cleanupTmpConfig(kimiHomeDir); } catch { /* non-critical */ }
      }

      if (buffer.trim()) {
        try {
          events.push(JSON.parse(buffer.trim()));
        } catch (err) {
          console.error('[kimi-runner] Failed to parse JSON:', buffer.trim(), err.message);
        }
      }

      let result = {
        sessionId: extractSessionId(events),
        response: extractResponseText(events),
        stats: extractStats(events),
        toolCalls: extractToolCalls(events),
        toolResults: extractToolResults(events),
        errors: extractErrors(events).concat(filteredStderrErrors(stderrData)),
        exitCode: code,
        totalEvents: events.length,
      };

      if (resolved) {
        if (taskId) updateTaskResult(taskId, result);
        return;
      }

      resolved = true;
      resolve(result);
    });

    child.stdin.end();
  });
}

function extractResponseText(events) {
  return events
    .filter(e => e.role === 'assistant' && typeof e.content === 'string' && e.content)
    .map(e => e.content)
    .join('\n');
}

function extractSessionId(events) {
  return events.find(e => e.role === 'meta' && e.type === 'session.resume_hint' && e.session_id)?.session_id
    ?? events.find(e => e.session_id)?.session_id
    ?? null;
}

function extractStats(events) {
  // Kimi Code 0.27 stream-json carries no usage/cost events.
  return null;
}

function extractToolCalls(events) {
  return events
    .filter(e => e.role === 'assistant' && Array.isArray(e.tool_calls))
    .flatMap(e => e.tool_calls)
    .map(call => ({
      name: call.function?.name ?? 'unknown',
      args: parseToolArguments(call.function?.arguments),
    }));
}

function extractToolResults(events) {
  return events
    .filter(e => e.role === 'tool')
    .map(e => ({
      name: e.name ?? 'tool',
      output: (typeof e.content === 'string' ? e.content : JSON.stringify(e.content ?? '')).substring(0, 500),
    }));
}

function extractErrors(events) {
  return events
    .filter(e => e.role === 'error' || e.type === 'error')
    .map(e => e.message ?? e.error?.message ?? JSON.stringify(e.error ?? e));
}

function filteredStderrErrors(stderrData) {
  if (!stderrData) return [];
  let filtered = stderrData
    .split('\n')
    .filter(line => line.trim() && !line.includes('MCP server'))
    .join('\n')
    .trim();
  return filtered ? [filtered] : [];
}
