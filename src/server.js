/**
 * MCP Server setup — tool registry and call handler.
 * Connects tool definitions to their implementations.
 *
 * @module agent-pool/server
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { randomUUID } from 'node:crypto';

import { runGeminiStreaming, listGeminiSessions, DEFAULT_TIMEOUT_SEC, DEFAULT_APPROVAL_MODE } from './runner/gemini-runner.js';
import { getSystemLoad } from './runner/process-manager.js';
import { createTask, completeTask, failTask, formatTaskResult, getActiveTasks, cancelTask } from './tools/results.js';
import { listSkills, createSkill, deleteSkill, installSkill, provisionSkill } from './tools/skills.js';
import { consultPeer } from './tools/consult.js';
import { addSchedule, listSchedules, removeSchedule, getScheduledResults, getDaemonStatus } from './scheduler/scheduler.js';
import { createPipeline, listPipelines, runPipeline, getRun, listRuns, cancelRun, signalStepComplete, bounceBack } from './scheduler/pipeline.js';

import { TOOL_DEFINITIONS } from './tool-definitions.js';

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const defaultCwd = process.cwd();

// ─── Prerequisite check (cached at startup) ──────────────────

let geminiAvailable = null;

function checkGemini() {
  if (geminiAvailable !== null) return geminiAvailable;
  try {
    execFileSync('which', ['gemini'], { encoding: 'utf-8', timeout: 2000 });
    geminiAvailable = true;
  } catch {
    geminiAvailable = false;
  }
  return geminiAvailable;
}

const GEMINI_REQUIRED_ERROR = {
  content: [{
    type: 'text',
    text: `❌ Gemini CLI is not installed or not in PATH.

**To fix:**
1. Install: \`npm install -g @google/gemini-cli\`
2. Authenticate: run \`gemini\` (opens browser for OAuth)
3. Verify: \`gemini --version\`
4. Restart your IDE to reload the MCP server.

Docs: https://github.com/google-gemini/gemini-cli`
  }],
  isError: true,
};

/** Tools that require Gemini CLI to be installed */
const GEMINI_TOOLS = new Set([
  'delegate_task', 'delegate_task_readonly', 'consult_peer', 'list_sessions',
]);

// ─── Depth tracking (for nested orchestration) ──────────────

const CURRENT_DEPTH = parseInt(process.env.AGENT_POOL_DEPTH ?? '0');
const MAX_DEPTH = process.env.AGENT_POOL_MAX_DEPTH
  ? parseInt(process.env.AGENT_POOL_MAX_DEPTH)
  : null; // null = no limit (disabled by default)

function isDepthExceeded() {
  return MAX_DEPTH !== null && CURRENT_DEPTH >= MAX_DEPTH;
}

const DEPTH_EXCEEDED_ERROR = {
  content: [{
    type: 'text',
    text: `⚠️ Orchestration depth limit reached (depth=${CURRENT_DEPTH}, max=${MAX_DEPTH}).

This agent-pool instance is running inside a nested Gemini CLI worker.
Delegation is disabled at this depth to prevent runaway process spawning.

Execute the task directly instead of delegating it.

To increase the limit, set AGENT_POOL_MAX_DEPTH to a higher value.`
  }],
  isError: true,
};

/**
 * Create and configure the MCP server.
 *
 * @returns {Server}
 */
export function createServer() {
  // Check gemini once at server creation
  checkGemini();

  if (CURRENT_DEPTH > 0) {
    console.error(`[agent-pool] Nested orchestration: depth=${CURRENT_DEPTH}${MAX_DEPTH !== null ? `, max=${MAX_DEPTH}` : ''}`);
  }

  const server = new Server(
    { name: 'agent-pool', version: '1.1.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOL_DEFINITIONS,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    // Guard: tools that need gemini
    if (GEMINI_TOOLS.has(name)) {
      if (!checkGemini()) return GEMINI_REQUIRED_ERROR;
      if (isDepthExceeded()) return DEPTH_EXCEEDED_ERROR;
    }

    let response;
    try {
      switch (name) {
        case 'delegate_task':
          response = handleDelegateTask(args); break;
        case 'delegate_task_readonly':
          response = handleDelegateReadonly(args); break;
        case 'get_task_result':
          response = formatTaskResult(args.task_id); break;
        case 'cancel_task':
          response = cancelTask(args.task_id); break;
        case 'consult_peer':
          response = consultPeer(args, defaultCwd); break;
        case 'list_sessions':
          response = await handleListSessions(args); break;
        case 'list_skills':
          response = handleListSkills(args); break;
        case 'create_skill':
          response = handleCreateSkill(args); break;
        case 'delete_skill':
          response = handleDeleteSkill(args); break;
        case 'install_skill':
          response = handleInstallSkill(args); break;
        case 'schedule_task':
          response = handleScheduleTask(args); break;
        case 'list_schedules':
          response = handleListSchedules(args); break;
        case 'cancel_schedule':
          response = handleCancelSchedule(args); break;
        case 'get_scheduled_results':
          response = handleGetScheduledResults(args); break;
        case 'create_pipeline':
          response = handleCreatePipeline(args); break;
        case 'run_pipeline':
          response = handleRunPipeline(args); break;
        case 'list_pipelines':
          response = handleListPipelines(args); break;
        case 'get_pipeline_status':
          response = handleGetPipelineStatus(args); break;
        case 'cancel_pipeline':
          response = handleCancelPipeline(args); break;
        case 'signal_step_complete':
          response = handleSignalStepComplete(args); break;
        case 'bounce_back':
          response = handleBounceBack(args); break;
        default:
          response = { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
      }
    } catch (error) {
      response = { content: [{ type: 'text', text: `Gemini CLI Error: ${error.message}` }], isError: true };
    }

    // Append active tasks footer to every response
    const footer = getActiveTasks();
    if (footer && response.content?.[0]?.text) {
      response.content[0].text += footer;
    }
    return response;
  });

  return server;
}

// ─── Tool Handlers ──────────────────────────────────────────────────

/**
 * Shared handler for delegate_task and delegate_task_readonly.
 *
 * @param {object} args - Tool arguments
 * @param {object} defaults - Override defaults for the mode
 * @param {string} defaults.approvalMode - Approval mode
 * @param {string} defaults.emoji - Status emoji
 * @param {string} defaults.label - Status label
 * @returns {{content: Array<{type: string, text: string}>}}
 */
function handleDelegate(args, { approvalMode, emoji, label }) {
  const taskId = randomUUID();
  const cwd = args.cwd ?? defaultCwd;
  let prompt = args.prompt;

  // Hybrid skill activation: provision to project, then instruct native activation
  if (args.skill) {
    const provisioned = provisionSkill(cwd, args.skill);
    if (provisioned) {
      prompt = `IMPORTANT: Before starting the task, activate the skill "${provisioned.name}" using the activate_skill tool. Then proceed with the task.\n\n${prompt}`;
    } else {
      prompt = `NOTE: Skill '${args.skill}' was requested but not found in any tier (project, global, built-in). Proceed with the task.\n\n${prompt}`;
    }
  }

  // Resolve policy path (built-in templates or absolute path)
  let policyPath = args.policy ?? null;
  if (policyPath && !path.isAbsolute(policyPath)) {
    const policiesDir = path.resolve(__dirname, '..', 'policies');
    let builtinPolicy = path.resolve(policiesDir, policyPath);
    if (!fs.existsSync(builtinPolicy) && fs.existsSync(builtinPolicy + '.yaml')) {
      builtinPolicy = builtinPolicy + '.yaml';
    }
    // Path traversal protection: ensure resolved path stays within policies/
    if (builtinPolicy.startsWith(policiesDir + path.sep) && fs.existsSync(builtinPolicy)) {
      policyPath = builtinPolicy;
    } else {
      policyPath = null; // Invalid or traversal attempt — ignore
    }
  }

  // Inject role awareness into the agent's prompt
  const roleDescriptions = {
    yolo: 'FULL ACCESS — you can read/write files, run shell commands, and make any changes.',
    auto_edit: 'AUTO-EDIT — you can read files and edit code, but shell commands require approval.',
    plan: 'READ-ONLY — you can only read files and analyze code. You CANNOT write files or run destructive commands.',
  };
  const resolvedMode = args.approval_mode ?? approvalMode;
  const modeNotice = roleDescriptions[resolvedMode] ?? `Mode: ${resolvedMode}`;

  // Build workspace scope awareness — tell the agent its sandbox boundaries upfront
  const workspaceDirs = [cwd];
  if (args.include_dirs?.length > 0) {
    workspaceDirs.push(...args.include_dirs);
  }
  const scopeNotice = `[Workspace Scope] You have access to these directories:\n${workspaceDirs.map((d) => `  - ${d}`).join('\n')}\nIf you need files outside these paths, use shell commands (cat, find, ls) instead of file tools. Do NOT attempt list_directory or read_file on paths outside your workspace — they will be rejected by the sandbox.`;

  prompt = `[Agent Mode: ${resolvedMode.toUpperCase()}] ${modeNotice}\n\n${scopeNotice}\n\n${prompt}`;

  const taskOpts = {
    prompt,
    cwd,
    model: args.model,
    approvalMode: resolvedMode,
    timeout: args.timeout ?? DEFAULT_TIMEOUT_SEC,
    sessionId: args.session_id,
    taskId,
    runner: args.runner,
    policy: policyPath,
    includeDirs: args.include_dirs,
  };

  createTask(taskId, args.prompt, args.on_wait_hint, resolvedMode);

  runGeminiStreaming(taskOpts)
    .then((result) => completeTask(taskId, result))
    .catch((err) => failTask(taskId, err.message));

  const mode = args.approval_mode ?? approvalMode;
  const runnerInfo = args.runner ? `\n- **Runner**: ${args.runner}` : '';
  const skillInfo = args.skill ? `\n- **Skill**: ${args.skill}` : '';
  const policyInfo = policyPath ? `\n- **Policy**: ${policyPath}` : '';

  // System load awareness
  const load = getSystemLoad();
  const loadInfo = load.warning ? `\n\n${load.warning}` : '';

  return {
    content: [{
      type: 'text',
      text: `${emoji} ${label}\n\n- **Task ID**: \`${taskId}\`\n- **Mode**: ${mode}${runnerInfo}${skillInfo}${policyInfo}\n- **Prompt**: ${args.prompt.substring(0, 100)}...${loadInfo}\n\nUse \`get_task_result\` with this task_id to check status.`,
    }],
  };
}

function handleDelegateTask(args) {
  return handleDelegate(args, {
    approvalMode: DEFAULT_APPROVAL_MODE,
    emoji: '🚀',
    label: 'Task delegated.',
  });
}

function handleDelegateReadonly(args) {
  return handleDelegate(args, {
    approvalMode: DEFAULT_APPROVAL_MODE,
    emoji: '🔍',
    label: 'Analysis task delegated (full access).',
  });
}

/**
 * @param {object} args
 */
async function handleListSessions(args) {
  const sessions = await listGeminiSessions(args.cwd ?? defaultCwd);
  if (sessions.length === 0) {
    return { content: [{ type: 'text', text: 'No sessions found for this project.' }] };
  }
  const lines = sessions.map(
    (s) => `- **${s.index}**. ${s.preview} (${s.timeAgo}) \`${s.sessionId}\``,
  );
  return {
    content: [{ type: 'text', text: `## Available Sessions (${sessions.length})\n\n${lines.join('\n')}` }],
  };
}

/** @param {object} args */
function handleListSkills(args) {
  const skills = listSkills(args.cwd ?? defaultCwd);
  if (skills.length === 0) {
    return { content: [{ type: 'text', text: 'No skills found. Use create_skill to create one.' }] };
  }
  const lines = skills.map(
    (s) => `- **${s.name}** — ${s.description} (\`${s.fileName}\`) [${s.tier}]`,
  );
  return {
    content: [{ type: 'text', text: `## Available Skills (${skills.length})\n\n${lines.join('\n')}` }],
  };
}

/** @param {object} args */
function handleCreateSkill(args) {
  const scope = args.scope ?? 'project';
  const filePath = createSkill(args.cwd ?? defaultCwd, args.skill_name, args.description, args.instructions, scope);
  return {
    content: [{
      type: 'text',
      text: `✅ Skill created [${scope}]: \`${args.skill_name}\`\nPath: \`${filePath}\`\n\nUse with delegate_task: \`skill: "${args.skill_name}"\``,
    }],
  };
}

/** @param {object} args */
function handleDeleteSkill(args) {
  const scope = args.scope ?? 'project';
  const deleted = deleteSkill(args.cwd ?? defaultCwd, args.skill_name, scope);
  return {
    content: [{
      type: 'text',
      text: deleted ? `✅ Skill deleted [${scope}]: \`${args.skill_name}\`` : `❌ Skill not found [${scope}]: \`${args.skill_name}\``,
    }],
  };
}

/** @param {object} args */
function handleInstallSkill(args) {
  const result = installSkill(args.cwd ?? defaultCwd, args.skill_name);
  if (!result) {
    return {
      content: [{
        type: 'text',
        text: `❌ Skill \`${args.skill_name}\` not found in global or built-in tiers. Use \`list_skills\` to see available skills.`,
      }],
    };
  }
  return {
    content: [{
      type: 'text',
      text: `✅ Skill installed into project:\n- **From**: \`${result.from}\` [${result.tier}]\n- **To**: \`${result.to}\`\n\nThe skill is now a local copy — you can customize it for this project.`,
    }],
  };
}

// ─── Scheduler Handlers ─────────────────────────────────────────────

/** @param {object} args */
function handleScheduleTask(args) {
  const cwd = args.cwd ?? defaultCwd;
  try {
    const result = addSchedule(cwd, {
      prompt: args.prompt,
      cron: args.cron,
      skill: args.skill,
      approvalMode: args.approval_mode,
      catchup: args.catchup,
      taskCwd: args.cwd,
    });

    return {
      content: [{
        type: 'text',
        text: `⏰ Task scheduled.\n\n- **Schedule ID**: \`${result.scheduleId}\`\n- **Cron**: \`${args.cron}\`\n- **Next run**: ${result.nextRun || 'unknown'}\n- **Prompt**: ${args.prompt.substring(0, 100)}...\n\nDaemon is running in the background. Results will be saved to \`.agent/scheduled-results/\`.\nUse \`list_schedules\` to see all schedules, \`get_scheduled_results\` to read outputs.`,
      }],
    };
  } catch (error) {
    return { content: [{ type: 'text', text: `❌ Failed to schedule: ${error.message}` }], isError: true };
  }
}

/** @param {object} args */
function handleListSchedules(args) {
  const cwd = args.cwd ?? defaultCwd;
  const schedules = listSchedules(cwd);
  const daemon = getDaemonStatus(cwd);

  if (schedules.length === 0) {
    return { content: [{ type: 'text', text: `No scheduled tasks.\n\nDaemon: ${daemon.running ? `running (pid ${daemon.pid})` : 'not running'}` }] };
  }

  const lines = schedules.map((s) =>
    `- **${s.id}** | \`${s.cron}\` | next: ${s.nextRun || '?'} | last: ${s.lastRun || 'never'}\n  ${s.prompt.substring(0, 80)}`,
  );

  return {
    content: [{
      type: 'text',
      text: `## Scheduled Tasks (${schedules.length})\n\nDaemon: ${daemon.running ? `✅ running (pid ${daemon.pid})` : '❌ not running'}\n\n${lines.join('\n')}`,
    }],
  };
}

/** @param {object} args */
function handleCancelSchedule(args) {
  const cwd = args.cwd ?? defaultCwd;
  const removed = removeSchedule(cwd, args.schedule_id);
  return {
    content: [{
      type: 'text',
      text: removed
        ? `✅ Schedule \`${args.schedule_id}\` cancelled. Daemon will auto-exit when no schedules remain.`
        : `❌ Schedule \`${args.schedule_id}\` not found.`,
    }],
  };
}

/** @param {object} args */
function handleGetScheduledResults(args) {
  const cwd = args.cwd ?? defaultCwd;
  const results = getScheduledResults(cwd, args.schedule_id);

  if (results.length === 0) {
    return { content: [{ type: 'text', text: 'No scheduled results yet.' }] };
  }

  const lines = results.map((r) =>
    `### ${r.scheduleId} — ${r.executedAt}\n- Exit: ${r.exitCode}\n- Events: ${r.totalEvents}\n\n\`\`\`\n${(r.response || '').substring(0, 500)}\n\`\`\``,
  );

  return {
    content: [{
      type: 'text',
      text: `## Scheduled Results (${results.length})\n\n${lines.join('\n\n')}`,
    }],
  };
}

// ─── Pipeline Handlers ─────────────────────────────────────────────

/** @param {object} args */
function handleCreatePipeline(args) {
  const cwd = args.cwd ?? defaultCwd;
  const result = createPipeline(cwd, args);
  return {
    content: [{
      type: 'text',
      text: `✅ Pipeline created.\n\n- **Pipeline ID**: \`${result.pipelineId}\`\n- **Steps**: ${args.steps.length}`
    }],
  };
}

/** @param {object} args */
function handleRunPipeline(args) {
  const cwd = args.cwd ?? defaultCwd;
  const result = runPipeline(cwd, args.pipeline_id);
  if (!result) {
    return {
      content: [{ type: 'text', text: `❌ Pipeline \`${args.pipeline_id}\` not found.` }],
      isError: true,
    };
  }
  return {
    content: [{
      type: 'text',
      text: `🚀 Pipeline started.\n\n- **Run ID**: \`${result.runId}\``
    }],
  };
}

/** @param {object} args */
function handleListPipelines(args) {
  const cwd = args.cwd ?? defaultCwd;
  const pipelines = listPipelines(cwd);
  
  if (pipelines.length === 0) {
    return { content: [{ type: 'text', text: 'No pipelines found.' }] };
  }

  const lines = pipelines.map(p => `- **${p.name}** (\`${p.id}\`) — ${p.steps.length} steps`);
  
  return {
    content: [{
      type: 'text',
      text: `## Available Pipelines (${pipelines.length})\n\n${lines.join('\n')}`
    }],
  };
}

/** @param {object} args */
function handleGetPipelineStatus(args) {
  const cwd = args.cwd ?? defaultCwd;
  const run = getRun(cwd, args.run_id);
  
  if (!run) {
    return { content: [{ type: 'text', text: `❌ Pipeline run \`${args.run_id}\` not found.` }], isError: true };
  }

  const emojiMap = {
    success: '✅',
    failed: '❌',
    running: '🔄',
    pending: '⏸️',
    bounce_pending: '↩️',
    waiting_bounce: '⏳',
    skipped: '⏭️',
    cancelled: '🛑',
  };

  const lines = Object.entries(run.steps).map(([name, s]) => {
    const emoji = emojiMap[s.status] || s.status;
    return `- ${emoji} **${name}**: ${s.status}`;
  });

  return {
    content: [{
      type: 'text',
      text: `## Pipeline Status: \`${args.run_id}\`\n**Status**: ${run.status}\n\n${lines.join('\n')}`
    }],
  };
}

/** @param {object} args */
function handleCancelPipeline(args) {
  const cwd = args.cwd ?? defaultCwd;
  const success = cancelRun(cwd, args.run_id);
  return {
    content: [{
      type: 'text',
      text: success ? `✅ Pipeline \`${args.run_id}\` cancelled.` : `❌ Failed to cancel pipeline \`${args.run_id}\` (not found or not running).`
    }],
  };
}

/** @param {object} args */
function handleSignalStepComplete(args) {
  const cwd = args.cwd ?? defaultCwd;
  const result = signalStepComplete(cwd, args.step_name, args.output, args.run_id);
  if (result.success) {
    return {
      content: [{
        type: 'text',
        text: `✅ Step \`${args.step_name}\` marked as complete.`
      }],
    };
  } else {
    return {
      content: [{
        type: 'text',
        text: `❌ Failed to signal step completion. Step might not be running or run not found.`
      }],
      isError: true,
    };
  }
}

/** @param {object} args */
function handleBounceBack(args) {
  const cwd = args.cwd ?? defaultCwd;
  const info = bounceBack(cwd, args.step_name, args.reason, args.run_id);
  if (info.success) {
    return {
      content: [{
        type: 'text',
        text: `↩️ Task bounced back to \`${args.step_name}\`.\nReason: ${args.reason}\nBounces: ${info.bounceCount}/${info.maxBounces}`
      }],
    };
  } else {
    return {
      content: [{
        type: 'text',
        text: `❌ Failed to bounce back. Pipeline might have reached max bounces or step not found.`
      }],
      isError: true,
    };
  }
}

