
import { spawn, execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { trackChild, killGroup, untrackChild } from './process-manager.js';
import { getRunner, loadConfig } from './config.js';
import { buildSshSpawn, parseRemotePid } from './ssh.js';
import { setTaskPid, updateTaskResult, pushTaskEvent, pushTaskStderr } from '../tools/results.js';
import { createProcessWatchdog } from './timeout-manager.js';
import { createGeminiEnv, cleanupTmpConfig } from './provider-config.js';
import { resolvePortalUrl } from './url-resolver.js';

const DEFAULT_APPROVAL_MODE = 'yolo';

export { DEFAULT_APPROVAL_MODE };


export function runGeminiStreaming({ prompt, cwd, model, approvalMode, timeout, sessionId, taskId, runner: runnerId, policy, includeDirs, chat_id }) {
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
      // Ignore if team rules file doesn't exist or isn't readable
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
    let hubTmpDir = null; // track for cleanup

    if (isRemote) {
      let ssh = buildSshSpawn(runner, args, cwd ?? process.cwd(), 'gemini');
      spawnCmd = ssh.command;
      spawnArgs = ssh.args;
      spawnOpts = { stdio: ['pipe', 'pipe', 'pipe'], detached: true };
    } else {
      spawnCmd = 'gemini';
      spawnArgs = args;
      let currentDepth = parseInt(process.env.AGENT_POOL_DEPTH ?? '0');
      let effectiveCwd = cwd ?? process.cwd();

      // Create isolated config dir so sub-agent connects to singleton portal
      let portalUrl = resolvePortalUrl();
      if (portalUrl && chat_id) {
        portalUrl += (portalUrl.includes('?') ? '&' : '?') + 'chatId=' + encodeURIComponent(chat_id);
      }
      let envOverrides = {};
      if (portalUrl) {
        let hub = createGeminiEnv(portalUrl);
        hubTmpDir = hub.tmpDir;
        envOverrides = hub.envOverrides;
      }

      spawnOpts = {
        cwd: effectiveCwd,
        env: {
          ...process.env,
          TERM: 'dumb',
          CI: '1',
          AGENT_POOL_DEPTH: String(currentDepth + 1),
          ...(portalUrl ? { PORTAL_MCP_URL: portalUrl } : {}),
          ...envOverrides,
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
    let remotePid = null;
    let resolved = false;
    let hasReceivedData = false;
    let stepCount = 0;

    let watchdog = createProcessWatchdog(timeoutMs, () => {
      resolved = true;

      let messages = events.filter((e) => e.type === 'message');
      let toolUses = events.filter((e) => e.type === 'tool_use');
      let responseText = messages
        .filter((m) => m.role === 'assistant')
        .map((m) => m.content ?? m.text ?? '')
        .join('\n');

      resolve({
        sessionId: events.find((e) => e.type === 'init')?.session_id || null,
        response: responseText || 
          '[WAIT] Agent is still working (soft inactivity timeout reached). Partial results returned.',
        stats: null,
        toolCalls: toolUses.map((t) => ({
          name: t.name ?? t.tool_name ?? t.toolCall?.name ?? t.tool_call?.name ?? t.function?.name ?? 'unknown',
          args: t.arguments ?? t.parameters ?? t.toolCall?.arguments ?? t.tool_call?.arguments ?? {},
        })),
        toolResults: [],
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

        if (isRemote && !remotePid) {
          let pid = parseRemotePid(trimmed);
          if (pid) {
            remotePid = pid;
            continue;
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

                    if (parsed.type === 'result' || (parsed.type === 'message' && parsed.role === 'assistant')) {
            stepCount++;
            if (stepCount >= config.limits.maxSteps && child.exitCode === null) {
              console.error(`[gemini-runner] MAX STEPS (${config.limits.maxSteps}) reached — killing PID ${child.pid}`);
              killGroup(child.pid);
            }
          }

          if (taskId) pushTaskEvent(taskId, parsed);
        } catch (err) {
          console.error(`[gemini-runner] Failed to parse JSON:`, jsonStr, err.message);
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
      untrackChild(child.pid);

      // Remove isolated config temp dir
      if (hubTmpDir) {
        try { cleanupTmpConfig(hubTmpDir); } catch (e) { /* non-critical */ }
      }

            if (resolved) {
        if (buffer.trim()) {
          try { events.push(JSON.parse(buffer.trim())); } catch (err) { console.error(`[gemini-runner] Failed to parse JSON:`, buffer.trim(), err.message); }
        }
        let messages = events.filter((e) => e.type === 'message');
        let toolUses = events.filter((e) => e.type === 'tool_use');
        let toolResults = events.filter((e) => e.type === 'tool_result');
        let resultEvent = events.find((e) => e.type === 'result');
        let errors = events.filter((e) => e.type === 'error');
        let responseText = messages.filter((m) => m.role === 'assistant').map((m) => m.content ?? m.text ?? '').join('\n');
        if (taskId) {
          updateTaskResult(taskId, {
            sessionId: events.find((e) => e.type === 'init')?.session_id || null,
            response: resultEvent?.response ?? responseText,
            stats: resultEvent?.stats ?? null,
            toolCalls: toolUses.map((t) => ({ name: t.name ?? t.tool_name ?? t.toolCall?.name ?? t.tool_call?.name ?? t.function?.name ?? 'unknown', args: t.arguments ?? t.parameters ?? t.toolCall?.arguments ?? t.tool_call?.arguments ?? {} })),
            toolResults: toolResults.map((t) => ({ name: t.name ?? t.tool_name ?? t.toolCall?.name ?? t.tool_call?.name ?? t.function?.name ?? 'unknown', output: t.output ? (typeof t.output === 'string' ? t.output.substring(0, 500) : JSON.stringify(t.output)?.substring(0, 500)) : t.status ?? '' })),
            errors: errors.map((e) => e.message || JSON.stringify(e)),
            exitCode: code,
            totalEvents: events.length,
          });
        }
        return;
      }

            if (buffer.trim()) {
        try { events.push(JSON.parse(buffer.trim())); } catch (err) { console.error(`[gemini-runner] Failed to parse JSON:`, buffer.trim(), err.message); }
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
        sessionId: initEvent?.session_id || null,
        response: resultEvent?.response ?? responseText,
        stats: resultEvent?.stats ?? null,
        toolCalls: toolUses.map((t) => ({
          name: t.name ?? t.tool_name ?? t.toolCall?.name ?? t.tool_call?.name ?? t.function?.name ?? 'unknown',
          args: t.arguments ?? t.parameters ?? t.toolCall?.arguments ?? t.tool_call?.arguments ?? {},
        })),
        toolResults: toolResults.map((t) => ({
          name: t.name ?? t.tool_name ?? t.toolCall?.name ?? t.tool_call?.name ?? t.function?.name ?? 'unknown',
          output: t.output
            ? (typeof t.output === 'string' ? t.output.substring(0, 500) : JSON.stringify(t.output)?.substring(0, 500))
            : t.status ?? '',
        })),
        errors: errors.map((e) => e.message || JSON.stringify(e)),
        exitCode: code,
        totalEvents: events.length,
      });
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
