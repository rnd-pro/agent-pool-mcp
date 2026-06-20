import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { killGroup, trackChild, untrackChild } from './process-manager.js';
import { setTaskPid, updateTaskResult, pushTaskEvent, pushTaskStderr } from '../tools/results.js';
import { loadConfig } from './config.js';
import { createProcessWatchdog } from './timeout-manager.js';
import { createProviderRuntimeEnv } from './provider-config.js';
import { resolvePortalUrl } from './url-resolver.js';

function normalizeCodexEvent(ev) {
  if (ev.type === 'item.completed' && ev.item) {
    let item = ev.item;
    if (item.type === 'agent_message') {
      let content = item.text ?? '';
      if (!content.trim()) return null;
      return { type: 'message', role: 'assistant', content };
    }

    if (item.type === 'command_execution') {
      return [
        {
          type: 'tool_use',
          name: 'shell',
          parameters: { command: item.command ?? '' },
        },
        {
          type: 'tool_result',
          output: item.aggregated_output ?? '',
          status: item.status ?? 'completed',
        },
      ];
    }

    if (item.type === 'file_change') {
      let changes = item.changes ?? [];
      return {
        type: 'tool_use',
        name: 'file_change',
        parameters: { changes },
      };
    }

    if (item.type === 'mcp_tool_call') {
      return [
        {
          type: 'tool_use',
          name: item.name ?? 'mcp_tool',
          parameters: item.arguments ?? item.input ?? {},
        },
        {
          type: 'tool_result',
          output: item.output ?? item.result ?? '',
          status: item.status ?? 'completed',
        },
      ];
    }
  }

  if (ev.type === 'error') {
    return {
      type: 'error',
      message: ev.message ?? ev.error ?? JSON.stringify(ev),
      error: ev.message ?? ev.error ?? JSON.stringify(ev),
    };
  }

  return null;
}

function sandboxMode(approvalMode) {
  if (approvalMode === 'plan') return 'read-only';
  if (approvalMode === 'auto_edit') return 'workspace-write';
  return 'danger-full-access';
}

const CODEX_REASONING_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh']);
const CODEX_CHAT_MCP_SERVER = 'agent-portal-chat';
const CODEX_HEADLESS_APPROVAL_ARGS = ['-a', 'never'];
const CODEX_CHAT_MCP_APPROVED_TOOLS = [
  'workflow_board',
  'get_portal_status',
  'get_orchestrator_status',
  'get_development_map',
  'get_chat_task_result',
  'get_chat_messages',
  'list_chats',
  'block_goal',
  'complete_goal',
];
const CODEX_BOOTSTRAP_IGNORED_EVENT_TYPES = new Set(['session_meta']);
const CODEX_BOOTSTRAP_IGNORED_PAYLOAD_TYPES = new Set(['task_started']);

function normalizeReasoningEffort(value) {
  let normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized || normalized === 'default') return null;
  return CODEX_REASONING_EFFORTS.has(normalized) ? normalized : null;
}

function tomlString(value) {
  return JSON.stringify(String(value));
}

function isBootstrapProgressEvent(event) {
  if (!event || typeof event !== 'object') return false;
  if (CODEX_BOOTSTRAP_IGNORED_EVENT_TYPES.has(event.type)) return false;
  if (event.type === 'event_msg') {
    let payloadType = event.payload?.type;
    return Boolean(payloadType && !CODEX_BOOTSTRAP_IGNORED_PAYLOAD_TYPES.has(payloadType));
  }
  return true;
}

function bootstrapTimeoutMs(config) {
  let seconds = Number(config.limits.bootstrapTimeout ?? 120);
  if (!Number.isFinite(seconds) || seconds <= 0) return 0;
  return seconds * 1000;
}

function isMissingRolloutError(errors) {
  return errors.some(error => /thread\/resume failed: no rollout found|no rollout found for thread id/i.test(String(error)));
}

export function runCodexStreaming({ prompt, cwd, model, reasoningEffort, approvalMode, timeout, sessionId, taskId, chat_id, resumeFallbackAttempted = false }) {
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

    let args = sessionId
      ? [...CODEX_HEADLESS_APPROVAL_ARGS, 'exec', 'resume', '--json']
      : [...CODEX_HEADLESS_APPROVAL_ARGS, 'exec', '--json', '-s', sandboxMode(approvalMode)];

    let effectiveModel = model && model !== 'default' ? model : null;
    if (effectiveModel) {
      args.push('--model', effectiveModel);
    }

    let effectiveReasoningEffort = normalizeReasoningEffort(reasoningEffort);
    if (effectiveReasoningEffort) {
      args.push('-c', `model_reasoning_effort=${JSON.stringify(effectiveReasoningEffort)}`);
    }

    let portalUrl = resolvePortalUrl();
    if (portalUrl && chat_id) {
      portalUrl += (portalUrl.includes('?') ? '&' : '?') + 'chatId=' + encodeURIComponent(chat_id);
      args.push('-c', `mcp_servers.${CODEX_CHAT_MCP_SERVER}={url=${tomlString(portalUrl)}}`);
      args.push('-c', 'tools.network_access=true');
      args.push('-c', 'sandbox_workspace_write.network_access=true');
      for (let toolName of CODEX_CHAT_MCP_APPROVED_TOOLS) {
        args.push('-c', `mcp_servers.${CODEX_CHAT_MCP_SERVER}.tools.${toolName}.approval_mode="approve"`);
      }
    }
    if (sessionId) {
      args.push(sessionId);
    }
    args.push(finalPrompt);

    let config = loadConfig();
    let effectiveTimeout = timeout ?? config.limits.timeout;
    let timeoutMs = effectiveTimeout * 1000;
    let effectiveCwd = cwd ?? process.cwd();

    let currentDepth = parseInt(process.env.AGENT_POOL_DEPTH ?? '0');
    let child = spawn('codex', args, {
      cwd: effectiveCwd,
      env: createProviderRuntimeEnv({
        ...process.env,
        TERM: 'dumb',
        CI: '1',
        AGENT_POOL_DEPTH: String(currentDepth + 1),
        ...(portalUrl ? { PORTAL_MCP_URL: portalUrl } : {}),
      }),
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
    });

    if (taskId) {
      pushTaskEvent(taskId, {
        type: 'message',
        role: 'system',
        content: '[WAIT] Spawning Codex process...',
      });
    }

    trackChild(child.pid, taskId ?? 'streaming', 'codex-local');
    if (taskId) setTaskPid(taskId, child.pid);

    let events = [];
    let stderrData = '';
    let buffer = '';
    let resolved = false;
    let hasReceivedData = false;
    let bootstrapTimer = null;
    let bootstrapStalled = false;

    let watchdog = createProcessWatchdog(timeoutMs, () => {
      resolved = true;
      stopBootstrapWatchdog();
      let responseText = extractResponseText(events);
      resolve({
        sessionId: extractThreadId(events),
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

    function stopBootstrapWatchdog() {
      if (!bootstrapTimer) return;
      clearTimeout(bootstrapTimer);
      bootstrapTimer = null;
    }

    function failBootstrapStall() {
      if (resolved) return;
      resolved = true;
      bootstrapStalled = true;
      if (watchdog) watchdog.stop();
      stopBootstrapWatchdog();

      let seconds = Number(config.limits.bootstrapTimeout ?? 120);
      let stderrTail = stderrData.trim().split('\n').filter(Boolean).slice(-3).join('\n');
      let details = stderrTail ? ` Last stderr:\n${stderrTail}` : '';
      let errMsg = `Codex bootstrap stalled: no substantive JSONL event within ${seconds}s.${details}`;

      killGroup(child.pid);

      if (taskId) {
        pushTaskStderr(taskId, `${errMsg}\n`);
        pushTaskEvent(taskId, {
          type: 'error',
          message: errMsg,
          error: errMsg,
        });
      }

      resolve({
        sessionId: extractThreadId(events),
        response: '',
        stats: extractStats(events),
        toolCalls: extractToolCalls(events),
        toolResults: extractToolResults(events),
        errors: [errMsg].concat(filteredStderrErrors(stderrData)),
        exitCode: -1,
        totalEvents: events.length,
        softTimeout: false,
        bootstrapStalled: true,
        timeoutSeconds: seconds,
      });
    }

    let bootstrapMs = bootstrapTimeoutMs(config);
    if (bootstrapMs > 0) {
      bootstrapTimer = setTimeout(failBootstrapStall, bootstrapMs);
      bootstrapTimer.unref?.();
    }

    child.on('error', (err) => {
      if (resolved) return;
      resolved = true;
      if (watchdog) watchdog.stop();
      stopBootstrapWatchdog();

      let errMsg = `Failed to start codex process: ${err.message}`;
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
          content: '✅ Connected to Codex CLI...',
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
          if (isBootstrapProgressEvent(parsed)) stopBootstrapWatchdog();

          if (taskId) {
            let normalized = normalizeCodexEvent(parsed);
            if (normalized) {
              if (Array.isArray(normalized)) {
                normalized.forEach(n => pushTaskEvent(taskId, n));
              } else {
                pushTaskEvent(taskId, normalized);
              }
            }
          }
        } catch (err) {
          console.error('[codex-runner] Failed to parse JSON:', trimmed, err.message);
        }
      }
    });

    child.stderr.on('data', (chunk) => {
      // Stderr can contain repeated diagnostics while Codex is otherwise stalled.
      // Only JSONL stdout events count as substantive progress for the inactivity watchdog.
      let text = chunk.toString();
      stderrData += text;
      if (taskId) pushTaskStderr(taskId, text);
    });

    child.on('close', (code) => {
      if (watchdog) watchdog.stop();
      stopBootstrapWatchdog();
      untrackChild(child.pid);

      if (buffer.trim()) {
        try {
          events.push(JSON.parse(buffer.trim()));
        } catch (err) {
          console.error('[codex-runner] Failed to parse JSON:', buffer.trim(), err.message);
        }
      }

      let result = {
        sessionId: extractThreadId(events),
        response: extractResponseText(events),
        stats: extractStats(events),
        toolCalls: extractToolCalls(events),
        toolResults: extractToolResults(events),
        errors: extractErrors(events).concat(filteredStderrErrors(stderrData)),
        exitCode: code,
        totalEvents: events.length,
      };

      if (!resolved && sessionId && !resumeFallbackAttempted && result.exitCode !== 0 && isMissingRolloutError(result.errors)) {
        resolved = true;
        if (taskId) {
          pushTaskEvent(taskId, {
            type: 'message',
            role: 'system',
            content: '[RECOVER] Codex resume session was missing; retrying in a fresh Codex thread.',
          });
        }
        runCodexStreaming({
          prompt,
          cwd,
          model,
          reasoningEffort,
          approvalMode,
          timeout,
          sessionId: null,
          taskId,
          chat_id,
          resumeFallbackAttempted: true,
        }).then(resolve);
        return;
      }

      if (resolved) {
        if (taskId && !bootstrapStalled) updateTaskResult(taskId, result);
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
    .filter(e => e.type === 'item.completed' && e.item?.type === 'agent_message')
    .map(e => e.item.text ?? '')
    .filter(text => text && text.trim().length > 0)
    .join('\n');
}

function extractThreadId(events) {
  let threadEvent = events.find(e => e.type === 'thread.started');
  return threadEvent?.thread_id ?? null;
}

function extractStats(events) {
  let completed = events.find(e => e.type === 'turn.completed' && e.usage);
  if (!completed) return null;
  return {
    tokens: {
      input: completed.usage.input_tokens ?? 0,
      cachedInput: completed.usage.cached_input_tokens ?? 0,
      output: completed.usage.output_tokens ?? 0,
      reasoning: completed.usage.reasoning_output_tokens ?? 0,
      total: (completed.usage.input_tokens ?? 0) + (completed.usage.output_tokens ?? 0),
    },
  };
}

function extractToolCalls(events) {
  return events
    .filter(e => e.type === 'item.completed' && ['command_execution', 'mcp_tool_call', 'file_change'].includes(e.item?.type))
    .map(e => {
      let item = e.item;
      if (item.type === 'command_execution') {
        return { name: 'shell', args: { command: item.command ?? '' } };
      }
      if (item.type === 'file_change') {
        return { name: 'file_change', args: { changes: item.changes ?? [] } };
      }
      return { name: item.name ?? 'mcp_tool', args: item.arguments ?? item.input ?? {} };
    });
}

function extractToolResults(events) {
  return events
    .filter(e => e.type === 'item.completed' && ['command_execution', 'mcp_tool_call'].includes(e.item?.type))
    .map(e => ({
      name: e.item.type === 'command_execution' ? 'shell' : e.item.name ?? 'mcp_tool',
      output: (e.item.aggregated_output ?? e.item.output ?? e.item.result ?? '').toString().substring(0, 500),
    }));
}

function extractErrors(events) {
  return events
    .filter(e => e.type === 'error')
    .map(e => e.message ?? e.error ?? JSON.stringify(e));
}

function filteredStderrErrors(stderrData) {
  if (!stderrData) return [];
  let filtered = stderrData
    .split('\n')
    .filter(line => line.trim() !== 'Reading additional input from stdin...')
    .join('\n')
    .trim();
  return filtered ? [filtered] : [];
}
