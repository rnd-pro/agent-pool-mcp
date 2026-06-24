import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { trackChild, untrackChild } from './process-manager.js';
import { setTaskPid, updateTaskResult, pushTaskEvent, pushTaskStderr } from '../tools/results.js';
import { loadConfig } from './config.js';
import { createProcessWatchdog } from './timeout-manager.js';
import {
  createClaudeMcpConfig,
  cleanupTmpConfig,
  createClaudeDirectEnv,
  createProviderRuntimeEnv,
} from './provider-config.js';
import { resolvePortalUrl } from './url-resolver.js';
import { TASK_SECRET_ENV } from './task-secret-store.js';

function permissionMode(approvalMode) {
  if (approvalMode === 'plan') return 'plan';
  if (approvalMode === 'auto_edit') return 'acceptEdits';
  return 'bypassPermissions';
}

const CLAUDE_REASONING_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

function normalizeClaudeReasoningEffort(value) {
  let normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized || normalized === 'default') return null;
  return CLAUDE_REASONING_EFFORTS.has(normalized) ? normalized : null;
}

function normalizeClaudeEvent(ev) {
  if (ev.type === 'assistant' && ev.message?.content) {
    let normalized = [];
    for (let block of ev.message.content) {
      if (block.type === 'text' && block.text?.trim()) {
        normalized.push({ type: 'message', role: 'assistant', content: block.text });
      } else if (block.type === 'tool_use') {
        normalized.push({
          type: 'tool_use',
          name: block.name ?? 'unknown',
          parameters: block.input ?? {},
        });
      }
    }
    return normalized.length === 1 ? normalized[0] : normalized;
  }

  if (ev.type === 'tool_result' || ev.type === 'result_tool_use') {
    return {
      type: 'tool_result',
      output: extractToolResultText(ev),
      status: ev.is_error ? 'error' : 'success',
    };
  }

  if (ev.type === 'error') {
    return {
      type: 'error',
      message: ev.error?.message ?? ev.message ?? JSON.stringify(ev.error ?? ev),
      error: ev.error?.message ?? ev.message ?? JSON.stringify(ev.error ?? ev),
    };
  }

  return null;
}

export function runClaudeStreaming({
  prompt,
  cwd,
  model,
  reasoningEffort,
  approvalMode,
  timeout,
  sessionId,
  taskId,
  includeDirs,
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

    let args = ['-p', finalPrompt, '--output-format', 'stream-json', '--verbose', '--permission-mode', permissionMode(approvalMode)];

    let effectiveModel = model && model !== 'default' ? model : null;
    if (effectiveModel) args.push('--model', effectiveModel);
    let effectiveReasoningEffort = normalizeClaudeReasoningEffort(reasoningEffort);
    if (effectiveReasoningEffort) args.push('--effort', effectiveReasoningEffort);
    if (sessionId) args.push('--resume', sessionId);
    if (includeDirs?.length > 0) {
      for (let dir of includeDirs) args.push('--add-dir', dir);
    }

    let portalUrl = resolvePortalUrl();
    if (portalUrl && chat_id) {
      portalUrl += (portalUrl.includes('?') ? '&' : '?') + 'chatId=' + encodeURIComponent(chat_id);
    }

    let hubTmpDir = null;
    if (portalUrl) {
      let hub = createClaudeMcpConfig(portalUrl, taskSecret);
      hubTmpDir = hub.tmpDir;
      args.push('--mcp-config', hub.configPath);
    }

    let config = loadConfig();
    let effectiveTimeout = timeout ?? config.limits.timeout;
    let timeoutMs = effectiveTimeout * 1000;
    let currentDepth = parseInt(process.env.AGENT_POOL_DEPTH ?? '0');

    let child = spawn('claude', args, {
      cwd: cwd ?? process.cwd(),
      env: createProviderRuntimeEnv(createClaudeDirectEnv({
        ...process.env,
        TERM: 'dumb',
        CI: '1',
        // Defense-in-depth: a worker agent must NEVER enforce single-writer ownership of the shared
        // ~/.agent-portal state (that belongs to the long-lived backend only). Scrub PORTAL_BACKEND so a
        // worker that touches getStateGraph() cannot claim the token and crash-loop the real backend.
        PORTAL_BACKEND: undefined,
        AGENT_POOL_DEPTH: String(currentDepth + 1),
        ...(portalUrl ? { PORTAL_MCP_URL: portalUrl } : {}),
        ...(effectiveModel ? { ANTHROPIC_SMALL_FAST_MODEL: effectiveModel } : {}),
        // Set last and unconditionally: the freshly minted per-task secret, or
        // undefined to scrub any value inherited from the parent process so a
        // child can never impersonate the parent's verified slug.
        [TASK_SECRET_ENV]: taskSecret || undefined,
      })),
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
    });

    if (taskId) {
      pushTaskEvent(taskId, {
        type: 'message',
        role: 'system',
        content: '[WAIT] Spawning Claude Code process...',
      });
    }

    trackChild(child.pid, taskId ?? 'streaming', 'claude-local');
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
      if (hubTmpDir) cleanupTmpConfig(hubTmpDir);

      let errMsg = `Failed to start claude process: ${err.message}`;
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
          content: '✅ Connected to Claude Code stream...',
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
            let normalized = normalizeClaudeEvent(parsed);
            if (Array.isArray(normalized)) {
              normalized.forEach(n => pushTaskEvent(taskId, n));
            } else if (normalized) {
              pushTaskEvent(taskId, normalized);
            }
          }
        } catch (err) {
          console.error('[claude-runner] Failed to parse JSON:', trimmed, err.message);
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
      if (hubTmpDir) {
        try { cleanupTmpConfig(hubTmpDir); } catch { /* non-critical */ }
      }

      if (buffer.trim()) {
        try {
          events.push(JSON.parse(buffer.trim()));
        } catch (err) {
          console.error('[claude-runner] Failed to parse JSON:', buffer.trim(), err.message);
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
  let resultEvent = events.find(e => e.type === 'result' && typeof e.result === 'string');
  if (resultEvent?.result) return resultEvent.result;

  return events
    .filter(e => e.type === 'assistant' && e.message?.content)
    .flatMap(e => e.message.content)
    .filter(block => block.type === 'text' && block.text)
    .map(block => block.text)
    .join('\n');
}

function extractSessionId(events) {
  return events.find(e => e.session_id)?.session_id
    ?? events.find(e => e.message?.id)?.message?.id
    ?? null;
}

function extractStats(events) {
  let result = events.find(e => e.type === 'result');
  if (!result) return null;
  return {
    costUsd: result.total_cost_usd ?? result.cost_usd ?? null,
    durationMs: result.duration_ms ?? null,
    turns: result.num_turns ?? null,
    usage: result.usage ?? null,
  };
}

function extractToolCalls(events) {
  return events
    .filter(e => e.type === 'assistant' && e.message?.content)
    .flatMap(e => e.message.content)
    .filter(block => block.type === 'tool_use')
    .map(block => ({
      name: block.name ?? 'unknown',
      args: block.input ?? {},
    }));
}

function extractToolResultText(ev) {
  if (typeof ev.content === 'string') return ev.content;
  if (Array.isArray(ev.content)) {
    return ev.content.map(c => c.text ?? c.content ?? JSON.stringify(c)).join('');
  }
  return ev.output ?? ev.result ?? '';
}

function extractToolResults(events) {
  return events
    .filter(e => e.type === 'tool_result' || e.type === 'result_tool_use')
    .map(e => ({
      name: e.name ?? 'tool',
      output: extractToolResultText(e).toString().substring(0, 500),
    }));
}

function extractErrors(events) {
  return events
    .filter(e => e.type === 'error')
    .map(e => e.error?.message ?? e.message ?? JSON.stringify(e.error ?? e));
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
