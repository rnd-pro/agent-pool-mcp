import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { trackChild, killGroup, untrackChild } from './process-manager.js';
import { getRunner, loadConfig } from './config.js';
import { buildSshSpawn, parseRemotePid } from './ssh.js';
import { setTaskPid, updateTaskResult, pushTaskEvent, pushTaskStderr } from '../tools/results.js';
import { createProcessWatchdog } from './timeout-manager.js';
import { createAntigravityEnv, cleanupTmpConfig, createProviderRuntimeEnv } from './provider-config.js';
import { resolvePortalUrl } from './url-resolver.js';
import { TASK_SECRET_ENV } from './task-secret-store.js';

const ANTIGRAVITY_BINARY = 'agy';
const DEFAULT_APPROVAL_MODE = 'yolo';

export { DEFAULT_APPROVAL_MODE };

function withGlobalTeamRules(prompt) {
  try {
    let teamRulesPath = join(process.env.PORTAL_CONFIG_DIR || join(homedir(), '.agent-portal'), 'context', 'team', 'team-rules.md');
    if (!existsSync(teamRulesPath)) return prompt;
    let rules = readFileSync(teamRulesPath, 'utf8').trim();
    if (!rules) return prompt;
    return `[GLOBAL TEAM CONTEXT AND RULES]\n${rules}\n[/GLOBAL TEAM CONTEXT AND RULES]\n\nTask:\n${prompt}`;
  } catch {
    return prompt;
  }
}

function withExecutionNotes(prompt, policy, includeDirs) {
  let notes = [];
  if (policy) notes.push(`Policy file requested by orchestrator: ${policy}`);
  if (includeDirs?.length > 0) {
    notes.push(`Additional workspace directories requested by orchestrator:\n${includeDirs.map((dir) => `- ${dir}`).join('\n')}`);
  }
  if (notes.length === 0) return prompt;
  return `[AGENT POOL EXECUTION NOTES]\n${notes.join('\n')}\n[/AGENT POOL EXECUTION NOTES]\n\n${prompt}`;
}

function buildAntigravityArgs({ prompt, cwd, model, approvalMode, sessionId, policy, includeDirs }) {
  let finalPrompt = withExecutionNotes(withGlobalTeamRules(prompt), policy, includeDirs);
  let args = [];
  if (sessionId) args.push('--conversation', sessionId);
  args.push('-p', finalPrompt);
  if (cwd) args.push('--cwd', cwd);

  let effectiveModel = model || loadConfig().defaultModel;
  if (effectiveModel && effectiveModel !== 'default') {
    args.push('--model', effectiveModel);
  }

  if ((approvalMode ?? DEFAULT_APPROVAL_MODE) === 'yolo') {
    args.push('--dangerously-skip-permissions');
  }
  return args;
}

function parseJsonEvent(line) {
  let jsonStr = line.trim();
  let braceIdx = jsonStr.indexOf('{');
  if (braceIdx > 0) jsonStr = jsonStr.substring(braceIdx);
  if (!jsonStr.startsWith('{')) return null;
  try {
    return JSON.parse(jsonStr);
  } catch {
    return null;
  }
}

function extractResponse(events, plainText) {
  let messages = events.filter((e) => e.type === 'message');
  let resultEvent = events.find((e) => e.type === 'result');
  let responseText = messages
    .filter((m) => m.role === 'assistant')
    .map((m) => m.content ?? m.text ?? '')
    .join('\n');
  return resultEvent?.response ?? (responseText || plainText.trim());
}

function extractToolCalls(events) {
  return events
    .filter((e) => e.type === 'tool_use')
    .map((t) => ({
      name: t.name ?? t.tool_name ?? t.toolCall?.name ?? t.tool_call?.name ?? t.function?.name ?? 'unknown',
      args: t.arguments ?? t.parameters ?? t.toolCall?.arguments ?? t.tool_call?.arguments ?? {},
    }));
}

function extractToolResults(events) {
  return events
    .filter((e) => e.type === 'tool_result')
    .map((t) => ({
      name: t.name ?? t.tool_name ?? t.toolCall?.name ?? t.tool_call?.name ?? t.function?.name ?? 'unknown',
      output: t.output
        ? (typeof t.output === 'string' ? t.output.substring(0, 500) : JSON.stringify(t.output)?.substring(0, 500))
        : t.status ?? '',
    }));
}

function buildRunResult({ events, plainText, stderrData, code, sessionId, softTimeout, timeoutSeconds }) {
  let resultEvent = events.find((e) => e.type === 'result');
  let initEvent = events.find((e) => e.type === 'init');
  let errors = events
    .filter((e) => e.type === 'error')
    .map((e) => e.message || JSON.stringify(e));
  if (stderrData && code !== 0) errors.push(stderrData);

  return {
    sessionId: initEvent?.session_id || resultEvent?.session_id || sessionId || null,
    response: extractResponse(events, plainText),
    stats: resultEvent?.stats ?? null,
    toolCalls: extractToolCalls(events),
    toolResults: extractToolResults(events),
    errors,
    exitCode: code,
    totalEvents: events.length,
    softTimeout: Boolean(softTimeout),
    ...(timeoutSeconds ? { timeoutSeconds } : {}),
  };
}

export function runAntigravityStreaming({ prompt, cwd, model, approvalMode, timeout, sessionId, taskId, runner: runnerId, policy, includeDirs, chat_id, taskSecret }) {
  return new Promise((resolve) => {
    let runner = getRunner(runnerId);
    let isRemote = runner.type === 'ssh';
    let effectiveCwd = cwd ?? process.cwd();
    let args = buildAntigravityArgs({ prompt, cwd: isRemote ? null : effectiveCwd, model, approvalMode, sessionId, policy, includeDirs });

    let config = loadConfig();
    let effectiveTimeout = timeout ?? config.limits.timeout;
    let timeoutMs = effectiveTimeout * 1000;

    let spawnCmd;
    let spawnArgs;
    let spawnOpts;
    let hubTmpDir = null;

    if (isRemote) {
      let ssh = buildSshSpawn(runner, args, effectiveCwd, ANTIGRAVITY_BINARY);
      spawnCmd = ssh.command;
      spawnArgs = ssh.args;
      spawnOpts = { stdio: ['pipe', 'pipe', 'pipe'], detached: true };
    } else {
      spawnCmd = ANTIGRAVITY_BINARY;
      spawnArgs = args;
      let currentDepth = parseInt(process.env.AGENT_POOL_DEPTH ?? '0');
      let portalUrl = resolvePortalUrl();
      if (portalUrl && chat_id) {
        portalUrl += (portalUrl.includes('?') ? '&' : '?') + 'chatId=' + encodeURIComponent(chat_id);
      }
      let envOverrides = {};
      if (portalUrl) {
        // Antigravity carries only a URL env var (no MCP config file), so it
        // cannot attach the per-task secret header; its connections resolve to
        // the anonymous read-only principal at the portal.
        let hub = createAntigravityEnv(portalUrl);
        hubTmpDir = hub.tmpDir;
        envOverrides = hub.envOverrides;
      }

      spawnOpts = {
        cwd: effectiveCwd,
        env: createProviderRuntimeEnv({
          ...process.env,
          TERM: 'dumb',
          CI: '1',
          AGENT_POOL_DEPTH: String(currentDepth + 1),
          ...envOverrides,
          // Set last and unconditionally: the freshly minted per-task secret, or
          // undefined to scrub any value inherited from the parent process so a
          // child can never impersonate the parent's verified slug. Local leg
          // only — the SSH leg is a different uid/host outside same-uid scope.
          [TASK_SECRET_ENV]: taskSecret || undefined,
        }),
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: true,
      };
    }

    let child = spawn(spawnCmd, spawnArgs, spawnOpts);

    if (taskId) {
      pushTaskEvent(taskId, {
        type: 'message',
        role: 'system',
        content: `[WAIT] Spawning Antigravity process${isRemote ? ' via SSH' : ''}...`,
      });
    }

    if (child.pid) {
      trackChild(child.pid, taskId ?? 'streaming', `antigravity-${isRemote ? 'ssh' : 'local'}`);
      if (taskId) setTaskPid(taskId, child.pid);
    }

    let events = [];
    let stderrData = '';
    let buffer = '';
    let plainText = '';
    let remotePid = null;
    let resolved = false;
    let hasReceivedData = false;
    let stepCount = 0;

    let watchdog = createProcessWatchdog(timeoutMs, () => {
      resolved = true;
      let result = buildRunResult({
        events,
        plainText,
        stderrData,
        code: null,
        sessionId,
        softTimeout: true,
        timeoutSeconds: effectiveTimeout,
      });
      result.response ||= '[WAIT] Agent is still working (soft inactivity timeout reached). Partial results returned.';
      resolve(result);
    }, config, child);

    child.on('error', (err) => {
      if (resolved) return;
      resolved = true;
      if (watchdog) watchdog.stop();

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
          content: 'Connected to Antigravity CLI output...',
        });
      }

      buffer += chunk.toString();
      let lines = buffer.split('\n');
      buffer = lines.pop();

      for (let line of lines) {
        let trimmed = line.trim();
        if (!trimmed) continue;

        if (isRemote && !remotePid) {
          let pid = parseRemotePid(trimmed);
          if (pid) {
            remotePid = pid;
            continue;
          }
        }

        let parsed = parseJsonEvent(trimmed);
        if (parsed) {
          events.push(parsed);
          if (parsed.type === 'result' || (parsed.type === 'message' && parsed.role === 'assistant')) {
            stepCount++;
            if (stepCount >= config.limits.maxSteps && child.exitCode === null) {
              console.error(`[antigravity-runner] MAX STEPS (${config.limits.maxSteps}) reached — killing PID ${child.pid}`);
              killGroup(child.pid);
            }
          }
          if (taskId) pushTaskEvent(taskId, parsed);
          continue;
        }

        plainText += `${line}\n`;
        if (taskId) {
          pushTaskEvent(taskId, {
            type: 'message',
            role: 'assistant',
            content: line,
          });
        }
      }
    });

    child.stderr.on('data', (chunk) => {
      // Stderr is diagnostic output, not proof of substantive agent progress.
      let msg = chunk.toString();
      stderrData += msg;
      if (taskId) pushTaskStderr(taskId, msg);
    });

    child.on('close', (code) => {
      if (watchdog) watchdog.stop();
      if (child.pid) untrackChild(child.pid);

      if (hubTmpDir) {
        try { cleanupTmpConfig(hubTmpDir); } catch { /* non-critical */ }
      }

      let trimmed = buffer.trim();
      if (trimmed) {
        let parsed = parseJsonEvent(trimmed);
        if (parsed) {
          events.push(parsed);
          if (taskId) pushTaskEvent(taskId, parsed);
        } else {
          plainText += buffer;
          if (taskId) {
            pushTaskEvent(taskId, {
              type: 'message',
              role: 'assistant',
              content: buffer,
            });
          }
        }
      }

      let result = buildRunResult({ events, plainText, stderrData, code, sessionId });
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

export function listAntigravitySessions() {
  return Promise.resolve([]);
}
