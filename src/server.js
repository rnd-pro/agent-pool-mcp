/**
 * MCP Server setup — tool registry and call handler.
 * Connects tool definitions to their implementations.
 *
 * @module agent-pool/server
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { randomUUID } from 'node:crypto';

import { runGeminiStreaming, listGeminiSessions } from './runner/gemini-runner.js';
import { runOpencodeStreaming } from './runner/opencode-runner.js';
import { runCodexStreaming } from './runner/codex-runner.js';
import { runClaudeStreaming } from './runner/claude-runner.js';
import { loadConfig } from './runner/config.js';
import { runHistoryCleanup } from './runner/history-cleanup.js';
import { getSystemLoad } from './runner/process-manager.js';
import { createTask, completeTask, failTask, formatTaskResult, getActiveTasks, listAllTasks, cancelTask, setNotifyCallback } from './tools/results.js';
import { listSkills, createSkill, deleteSkill, provisionSkill } from './tools/skills.js';
import { consultPeer } from './tools/consult.js';
import { addSchedule, listSchedules, removeSchedule, getScheduledResults, getDaemonStatus } from './scheduler/scheduler.js';
import { createPipeline, listPipelines, runPipeline, getRun, listRuns, cancelRun, signalStepComplete, bounceBack } from './scheduler/pipeline.js';
import { createGroup, listGroups, getGroup, getGroupNextProfile } from './tools/groups.js';
import { sendMessage, getMessages } from './tools/messaging.js';
import { saveScript, listScripts } from './tools/scripts.js';
import { getBoardStore } from './tools/board-store.js';
import { resolveAgent, buildAgentCatalog } from './agents/agent-resolver.js';
import { trackFiles, untrackFiles } from './tools/file-tracker.js';
import { handleGetTrackedFiles, handleListWorkflows, handleSearchByTags, handleGetWorkflowContent } from './tools/workflow-tools.js';

import { getToolDefinitions } from './tool-definitions.js';

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync, execFile } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const defaultCwd = process.cwd();
const DEFAULT_PROVIDER = 'codex';

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function preview(value, limit) {
  return typeof value === 'string' ? value.substring(0, limit) : '';
}

// ─── Prerequisite check (cached at startup) ──────────────────

let geminiAvailable = null;
let opencodeAvailable = null;
let codexAvailable = null;
let claudeAvailable = null;

function checkGemini() {
  if (geminiAvailable !== null) return geminiAvailable;
  try {
    execFileSync('which', ['gemini'], { encoding: 'utf-8', timeout: 2000 });
    geminiAvailable = true;
  } catch (e) {
    geminiAvailable = false;
  }
  return geminiAvailable;
}

function checkOpencode() {
  if (opencodeAvailable !== null) return opencodeAvailable;
  try {
    execFileSync('which', ['opencode'], { encoding: 'utf-8', timeout: 2000 });
    opencodeAvailable = true;
  } catch (e) {
    opencodeAvailable = false;
  }
  return opencodeAvailable;
}

function checkCodex() {
  if (codexAvailable !== null) return codexAvailable;
  try {
    execFileSync('which', ['codex'], { encoding: 'utf-8', timeout: 2000 });
    codexAvailable = true;
  } catch (e) {
    codexAvailable = false;
  }
  return codexAvailable;
}

function checkClaude() {
  if (claudeAvailable !== null) return claudeAvailable;
  try {
    execFileSync('which', ['claude'], { encoding: 'utf-8', timeout: 2000 });
    claudeAvailable = true;
  } catch (e) {
    claudeAvailable = false;
  }
  return claudeAvailable;
}

// ─── Dynamic model discovery (cached) ────────────────────────

let _cachedModels = [];

/**
 * Discover available models from OpenCode CLI + user config.
 * Non-blocking, caches results.
 * @returns {Promise<string[]>}
 */
function discoverModels() {
  return new Promise((resolve) => {
    // 1. Try user config first
    try {
      let configPath = path.join(os.homedir(), '.agent-portal', 'agent-portal.json');
      if (fs.existsSync(configPath)) {
        let config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        let userModels = config.providerModels?.opencode;
        if (Array.isArray(userModels) && userModels.length > 0) {
          _cachedModels = userModels;
          resolve(userModels);
          return;
        }
      }
    } catch (e) { /* config may not exist yet — continue to CLI discovery */ }

    // 2. Fallback: discover from OpenCode CLI
    if (!checkOpencode()) {
      resolve([]);
      return;
    }
    execFile('opencode', ['models'], { timeout: 10000 }, (err, stdout) => {
      if (err) {
        resolve([]);
        return;
      }
      let models = stdout.split('\n')
        .map(l => l.trim())
        .filter(l => l && !l.startsWith('INFO') && !l.startsWith('WARN'));
      _cachedModels = models;
      resolve(models);
    });
  });
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

const CLAUDE_REQUIRED_ERROR = {
  content: [{
    type: 'text',
    text: `❌ Claude Code CLI is not installed or not in PATH.

**To fix:**
1. Install Claude Code CLI.
2. Authenticate: run \`claude auth login\`.
3. Verify: \`claude --version\`.
4. Restart your IDE to reload the MCP server.

Docs: https://code.claude.com/docs/en/cli-reference`
  }],
  isError: true,
};

/** Tools that require Gemini CLI to be installed */
const GEMINI_TOOLS = new Set([
  'delegate_task', 'delegate_task_readonly', 'consult_peer', 'list_sessions',
  'delegate_to_group',
]);

// ─── Depth tracking (for nested orchestration) ──────────────

const CURRENT_DEPTH = parseInt(process.env.AGENT_POOL_DEPTH ?? '0');

function isDepthExceeded() {
  const config = loadConfig();
  return CURRENT_DEPTH >= config.limits.maxDepth;
}

function getMaxDepth() {
  return loadConfig().limits.maxDepth;
}


const DEPTH_EXCEEDED_ERROR = {
  content: [{
    type: 'text',
    text: `⚠️ Orchestration depth limit reached (depth=${CURRENT_DEPTH}, max=${getMaxDepth()}).

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
  checkCodex();
  checkClaude();

  // Async model discovery (non-blocking, populates _cachedModels for tools/list)
  discoverModels().then(m => {
    if (m.length > 0) console.error(`[agent-pool] Discovered ${m.length} models for tool schema`);
  }).catch(() => {});

  // Non-blocking history rotation
  runHistoryCleanup().catch(() => {});

  if (CURRENT_DEPTH > 0) {
    console.error(`[agent-pool] Nested orchestration: depth=${CURRENT_DEPTH}, max=${getMaxDepth()}`);
  }

  const server = new Server(
    { name: 'agent-pool', version: '1.7.0' },
    { capabilities: { tools: {}, resources: {} } },
  );

  // Push task lifecycle events as JSON-RPC notifications via stderr.
  // stdout is owned by MCP SDK's StdioServerTransport — writing there
  // causes message interleaving. stderr is our side-channel: the proxy
  // catches these from child.stderr and routes to WS chat clients.
  setNotifyCallback((taskId, type, data) => {
    const line = JSON.stringify({
      jsonrpc: '2.0',
      method: 'notifications/task/event',
      params: { taskId, type, data },
    });
    process.stderr.write(`__TASK_NOTIFY__${line}\n`);
  });

  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [{
      uri: 'agent-pool://guide',
      name: 'Usage Guide',
      description: 'Comprehensive guide for agent-pool',
      mimeType: 'text/markdown',
    }],
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    if (request.params.uri === 'agent-pool://guide') {
      const guidePath = path.resolve(__dirname, '..', 'GUIDE.md');
      const content = fs.readFileSync(guidePath, 'utf-8');
      return {
        contents: [{
          uri: request.params.uri,
          mimeType: 'text/markdown',
          text: content,
        }],
      };
    }
    throw new Error(`Resource not found: ${request.params.uri}`);
  });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: getToolDefinitions({ openCodeModels: _cachedModels }),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params ?? {};

    // Guard: tools that require external CLI providers
    if (GEMINI_TOOLS.has(name)) {
      if (isDepthExceeded()) return DEPTH_EXCEEDED_ERROR;

      const isDelegateTool = ['delegate_task', 'delegate_task_readonly', 'delegate_to_group'].includes(name);
      if (isDelegateTool) {
        const provider = args.provider || null;
        if (provider === 'gemini' && !checkGemini()) return GEMINI_REQUIRED_ERROR;
        if (provider === 'opencode' && !checkOpencode()) {
          return { content: [{ type: 'text', text: '❌ OpenCode CLI is not installed or not in PATH.' }], isError: true };
        }
        if (provider === 'codex' && !checkCodex()) {
          return { content: [{ type: 'text', text: '❌ Codex CLI is not installed or not in PATH.' }], isError: true };
        }
        if (provider === 'claude' && !checkClaude()) return CLAUDE_REQUIRED_ERROR;
      } else {
        if (!checkGemini()) return GEMINI_REQUIRED_ERROR;
      }
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
        case 'list_tasks':
          response = { content: [{ type: 'text', text: JSON.stringify(listAllTasks(), null, 2) }] }; break;
        case 'get_board_state':
          response = { content: [{ type: 'text', text: JSON.stringify(getBoardStore(args.cwd || defaultCwd).getSnapshot(), null, 2) }] }; break;
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
        case 'get_usage_guide':
          response = handleGetUsageGuide(args); break;
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
        case 'get_usage_guide':
          response = handleGetUsageGuide(args); break;
        case 'create_group':
          response = handleCreateGroup(args); break;
        case 'list_groups':
          response = handleListGroups(args); break;
        case 'delegate_to_group':
          response = handleDelegateToGroup(args); break;
        case 'send_message':
          response = handleSendMessage(args); break;
        case 'get_messages':
          response = handleGetMessages(args); break;
        case 'save_script':
          response = { content: [{ type: 'text', text: `Script saved at ${saveScript(args.cwd || defaultCwd, args.name, args.code, args.ext)}` }] }; break;
        case 'list_scripts':
          response = { content: [{ type: 'text', text: JSON.stringify(listScripts(args.cwd || defaultCwd), null, 2) }] }; break;
        case 'track_files':
          response = { content: [{ type: 'text', text: `Tracked files: \n- ${trackFiles(args.cwd || defaultCwd, args.files).join('\n- ')}` }] }; break;
        case 'untrack_files':
          response = { content: [{ type: 'text', text: `Tracked files: \n- ${untrackFiles(args.cwd || defaultCwd, args.files).join('\n- ')}` }] }; break;
        case 'get_tracked_files':
          response = handleGetTrackedFiles(args, defaultCwd); break;
        case 'list_workflows':
          response = handleListWorkflows(args, defaultCwd); break;
        case 'search_by_tags':
          response = handleSearchByTags(args, defaultCwd); break;
        case 'get_workflow_content':
          response = handleGetWorkflowContent(args, defaultCwd); break;
        default:
          response = { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
      }
    } catch (error) {
      response = { content: [{ type: 'text', text: `CLI provider error: ${error.message}` }], isError: true };
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
function handleDelegate(args = {}, { approvalMode, emoji, label }) {
  const config = loadConfig();
  const taskId = randomUUID();
  const cwd = args.cwd ?? defaultCwd;

  if (!isNonEmptyString(args.prompt)) {
    return {
      content: [{ type: 'text', text: '❌ Missing required `prompt` argument for delegate_task.' }],
      isError: true,
    };
  }

  // CWD safety — reject nonsensical workspaces
  if (config.safety.badCwdList.some(bad => cwd === bad || cwd.startsWith(bad + '/'))) {
    return {
      content: [{ type: 'text', text: `❌ Refusing to delegate: cwd="${cwd}" looks like a system directory, not a project workspace. Please provide an explicit cwd pointing to your project.` }],
      isError: true,
    };
  }

  // Concurrency limit
  const activeCount = listAllTasks().filter(t => t.status === 'running').length;
  if (activeCount >= config.limits.maxConcurrent) {
    return {
      content: [{ type: 'text', text: `⚠️ Concurrency limit reached (${activeCount}/${config.limits.maxConcurrent} active tasks). Wait for existing tasks to complete or cancel them first.` }],
      isError: true,
    };
  }

  let prompt = args.prompt;

  // ── Agent context resolution ──────────────────────────────
  // Priority: explicit system_prompt > agent_slug resolution > skill (legacy)
  let agentDef = null;
  let agentContext = '';

  if (args.system_prompt) {
    // Portal-level injection: pre-resolved agent prompt
    agentContext = args.system_prompt;
  } else if (args.agent_slug) {
    // Resolve agent from .agent-portal/agents/{slug}.md
    agentDef = resolveAgent(cwd, args.agent_slug);
    if (agentDef) {
      agentContext = agentDef.prompt;
      console.error(`[agent-pool] Resolved agent '${args.agent_slug}': ${agentDef.skills.length} skills, policy=${agentDef.policy}`);
    } else {
      console.error(`[agent-pool] Agent '${args.agent_slug}' not found in ${cwd}/.agent-portal/agents/`);
    }
  }

  // For orchestrator role: inject available agent catalog into context
  if (agentDef?.role === 'orchestrator') {
    const catalog = buildAgentCatalog(cwd);
    if (catalog) {
      agentContext += `\n\n${catalog}`;
    }
  }

  const resourceGroupName = args.resource_group || args.resourceGroup || agentDef?.resourceGroup || null;
  const resourceGroup = resourceGroupName ? getGroup(cwd, resourceGroupName) : null;
  const resourceProfile = resourceGroupName && resourceGroup
    ? getGroupNextProfile(cwd, resourceGroupName, resourceGroup)
    : { provider: null, model: null, profile: null };

  if (resourceGroupName && !resourceGroup) {
    console.error(`[agent-pool] Resource group '${resourceGroupName}' not found in ${cwd}/.agent-portal/groups.json`);
  }

  if (resourceGroup?.max_agents) {
    const groupActiveCount = listAllTasks().filter((t) => t.status === 'running' && t.resourceGroup === resourceGroupName).length;
    if (groupActiveCount >= resourceGroup.max_agents) {
      return {
        content: [{ type: 'text', text: `⚠️ Resource group \`${resourceGroupName}\` is at capacity (${groupActiveCount}/${resourceGroup.max_agents} active tasks). Wait for an existing task in this group to complete or choose another group.` }],
        isError: true,
      };
    }
  }

  // Legacy skill activation (fallback when no agent_slug)
  if (!agentContext && args.skill) {
    const provisioned = provisionSkill(cwd, args.skill);
    if (provisioned) {
      prompt = `IMPORTANT: Before starting the task, activate the skill "${provisioned.name}" using the activate_skill tool. Then proceed with the task.\n\n${prompt}`;
    } else {
      prompt = `NOTE: Skill '${args.skill}' was requested but not found in project skills. Proceed with the task.\n\n${prompt}`;
    }
  }

  // Resolve policy path (built-in templates or absolute path)
  // Agent policy as default if no explicit policy
  let policyPath = args.policy
    ?? (resourceGroup?.policy || null)
    ?? (agentDef?.policy && agentDef.policy !== 'read-write' ? agentDef.policy : null);
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

  // Assemble final prompt: mode → scope → agent context → user task
  let promptParts = [`[Agent Mode: ${resolvedMode.toUpperCase()}] ${modeNotice}`, scopeNotice];
  if (agentContext) {
    promptParts.push(`[Agent Context]\n${agentContext}\n[/Agent Context]`);
  }
  promptParts.push(prompt);
  prompt = promptParts.join('\n\n');

  const taskOpts = {
    prompt,
    cwd,
    model: args.model ?? resourceProfile.model ?? resourceGroup?.model ?? agentDef?.model ?? agentDef?.models?.[0],
    approvalMode: resolvedMode,
    timeout: args.timeout ?? config.limits.timeout,
    sessionId: args.session_id,
    taskId,
    runner: args.runner,
    policy: policyPath,
    includeDirs: args.include_dirs,
    groupConfig: args.groupConfig || (resourceGroup ? { name: resourceGroupName, ...resourceGroup } : undefined),
    skill: args.skill,
    chat_id: args.chat_id,
  };

  createTask(taskId, args.prompt, args.on_wait_hint, resolvedMode, cwd,
    agentDef?.slug ?? args.agent_slug ?? 'unknown',
    args.parent_chat_id, args.chat_id,
    agentDef?.icon, agentDef?.color,
    resourceGroupName
  );

  // Route to the correct runner based on provider
  const provider = args.provider || resourceProfile.provider || resourceGroup?.provider || agentDef?.provider || DEFAULT_PROVIDER;
  if (provider === 'gemini' && !checkGemini()) return GEMINI_REQUIRED_ERROR;
  if (provider === 'opencode' && !checkOpencode()) {
    return { content: [{ type: 'text', text: '❌ OpenCode CLI is not installed or not in PATH.' }], isError: true };
  }
  if (provider === 'codex' && !checkCodex()) {
    return { content: [{ type: 'text', text: '❌ Codex CLI is not installed or not in PATH.' }], isError: true };
  }
  if (provider === 'claude' && !checkClaude()) return CLAUDE_REQUIRED_ERROR;
  let runFn;
  if (provider === 'mock') {
    runFn = async (opts) => {
      // Simulate a small delay and a streaming event for the integration test
      await new Promise(r => setTimeout(r, 100));
      process.stderr.write(`__TASK_NOTIFY__${JSON.stringify({
        jsonrpc: '2.0',
        method: 'notifications/task/event',
        params: { taskId, type: 'event', data: { type: 'message', role: 'assistant', content: 'Integration Test Success' } }
      })}\n`);
      return { exitCode: 0, response: 'Mock final response' };
    };
  } else {
    if (provider === 'opencode') {
      runFn = runOpencodeStreaming;
    } else if (provider === 'codex') {
      runFn = runCodexStreaming;
    } else if (provider === 'claude') {
      runFn = runClaudeStreaming;
    } else {
      runFn = runGeminiStreaming;
    }
  }

  runFn(taskOpts)
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
      text: `${emoji} ${label}\n\n- **Task ID**: \`${taskId}\`\n- **Mode**: ${mode}${runnerInfo}${skillInfo}${policyInfo}\n- **Prompt**: ${preview(args.prompt, 100)}...${loadInfo}\n\nUse \`get_task_result\` with this task_id to check status.`,
    }],
  };
}

function handleDelegateTask(args) {
  return handleDelegate(args, {
    approvalMode: loadConfig().safety.defaultApprovalMode,
    emoji: '🚀',
    label: 'Task delegated.',
  });
}

function handleDelegateReadonly(args) {
  return handleDelegate(args, {
    approvalMode: 'plan',
    emoji: '🔍',
    label: 'Analysis task delegated (read-only access).',
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
  if (args.json) { return { content: [{ type: "text", text: JSON.stringify(skills) }] }; }
  
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
  const filePath = createSkill(args.cwd ?? defaultCwd, args.skill_name, args.description, args.instructions);
  return {
    content: [{
      type: 'text',
      text: `✅ Skill created: \`${args.skill_name}\`\nPath: \`${filePath}\`\n\nUse with delegate_task: \`skill: "${args.skill_name}"\``,
    }],
  };
}

/** @param {object} args */
function handleDeleteSkill(args) {
  const deleted = deleteSkill(args.cwd ?? defaultCwd, args.skill_name);
  return {
    content: [{
      type: 'text',
      text: deleted ? `✅ Skill deleted: \`${args.skill_name}\`` : `❌ Skill not found: \`${args.skill_name}\``,
    }],
  };
}

/** @param {object} args */
function handleInstallSkill(args) {
  // Install from Open Memory will be handled by the portal API in the future.
  // For now, this tool is a no-op since there are no external tiers.
  return {
    content: [{
      type: 'text',
      text: `ℹ️ Skill installation from external sources is now managed via the Agent Portal UI.\nUse \`create_skill\` to create skills directly, or install from Open Memory through the portal.`,
    }],
  };
}

// ─── Scheduler Handlers ─────────────────────────────────────────────

/** @param {object} args */
function handleScheduleTask(args = {}) {
  if (!isNonEmptyString(args.prompt)) {
    return {
      content: [{ type: 'text', text: '❌ Missing required `prompt` argument for schedule_task.' }],
      isError: true,
    };
  }
  if (!isNonEmptyString(args.cron)) {
    return {
      content: [{ type: 'text', text: '❌ Missing required `cron` argument for schedule_task.' }],
      isError: true,
    };
  }

  const cwd = args.cwd ?? defaultCwd;
  try {
    const result = addSchedule(cwd, {
      prompt: args.prompt,
      cron: args.cron,
      provider: args.provider || DEFAULT_PROVIDER,
      model: args.model,
      skill: args.skill,
      approvalMode: args.approval_mode,
      catchup: args.catchup,
      taskCwd: args.cwd,
    });

    return {
      content: [{
        type: 'text',
        text: `⏰ Task scheduled.\n\n- **Schedule ID**: \`${result.scheduleId}\`\n- **Cron**: \`${args.cron}\`\n- **Next run**: ${result.nextRun || 'unknown'}\n- **Prompt**: ${preview(args.prompt, 100)}...\n\nDaemon is running in the background. Results will be saved to \`.agent-portal/scheduled-results/\`.\nUse \`list_schedules\` to see all schedules, \`get_scheduled_results\` to read outputs.`,
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
    `- **${s.id}** | \`${s.cron}\` | next: ${s.nextRun || '?'} | last: ${s.lastRun || 'never'}\n  ${preview(s.prompt, 80)}`,
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
  const runs = listRuns(cwd);
  if (args.json) { return { content: [{ type: "text", text: JSON.stringify(pipelines) }] }; }
  
  const parts = [];

  if (pipelines.length > 0) {
    const lines = pipelines.map(p => `- **${p.name}** (\`${p.id}\`) — ${p.steps.length} steps`);
    parts.push(`## Pipelines (${pipelines.length})\n\n${lines.join('\n')}`);
  }

  const activeRuns = runs.filter(r => r.status === 'running');
  const recentRuns = runs.filter(r => r.status !== 'running').slice(0, 5);

  if (activeRuns.length > 0) {
    const emojiMap = { success: '[OK]', failed: '[ERR]', running: '[RUN]', pending: '[PAUSE]', bounce_pending: '[BOUNCE]', waiting_bounce: '[WAIT]', skipped: '[SKIP]', cancelled: '[STOP]' };
    const lines = activeRuns.map(r => {
      const stepsSummary = Object.entries(r.steps).map(([n, s]) => `${emojiMap[s.status] || '[?]'} ${n}`).join(' → ');
      return `- \`${r.id}\` (${r.pipelineName}) ${stepsSummary}`;
    });
    parts.push(`## Active Runs (${activeRuns.length})\n\n${lines.join('\n')}`);
  }

  if (recentRuns.length > 0) {
    const lines = recentRuns.map(r => `- \`${r.id}\` ${r.status === 'success' ? '[OK]' : '[ERR]'} ${r.pipelineName} (${r.completedAt || ''})`);
    parts.push(`## Recent Runs\n\n${lines.join('\n')}`);
  }

  if (parts.length === 0) {
    return { content: [{ type: 'text', text: 'No pipelines found.' }] };
  }

  return {
    content: [{ type: 'text', text: parts.join('\n\n') }],
  };
}

/** @param {object} args */
function handleGetPipelineStatus(args) {
  const cwd = args.cwd ?? defaultCwd;
  const run = getRun(cwd, args.run_id);
  
  if (!run) {
    return { content: [{ type: 'text', text: `[ERR] Pipeline run \`${args.run_id}\` not found.` }], isError: true };
  }

  const emojiMap = {
    success: '[OK]',
    failed: '[ERR]',
    running: '[RUN]',
    pending: '[PAUSE]',
    bounce_pending: '[BOUNCE]',
    waiting_bounce: '[WAIT]',
    skipped: '[SKIP]',
    cancelled: '[STOP]',
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

/** @param {object} args */
function handleGetUsageGuide(args) {
  const guidePath = path.resolve(__dirname, '..', 'GUIDE.md');
  if (!fs.existsSync(guidePath)) {
    return { content: [{ type: 'text', text: 'Guide not found.' }], isError: true };
  }
  
  const fullContent = fs.readFileSync(guidePath, 'utf-8');
  
  if (!args.topic) {
    return { content: [{ type: 'text', text: fullContent }] };
  }
  
  const topicLower = args.topic.toLowerCase();
  const lines = fullContent.split('\n');
  let inTopic = false;
  let topicContent = [];
  
  for (const line of lines) {
    if (line.toLowerCase().startsWith(`## ${topicLower}`)) {
      inTopic = true;
      topicContent.push(line);
      continue;
    }
    
    if (inTopic && line.startsWith('## ')) {
      break; // End of section
    }
    
    if (inTopic) {
      topicContent.push(line);
    }
  }
  
  if (topicContent.length === 0) {
    return { content: [{ type: 'text', text: `Topic '${args.topic}' not found in the guide.\n\nAvailable topics: delegation, pipelines, scheduling, skills, peer-review, sessions.` }] };
  }
  
  return { content: [{ type: 'text', text: topicContent.join('\n').trim() }] };
}

// ─── Group Handlers ─────────────────────────────────────────────

/** @param {object} args */
function handleCreateGroup(args) {
  const cwd = args.cwd ?? defaultCwd;
  const result = createGroup(cwd, {
    name: args.name,
    provider: args.provider,
    model: args.model,
    profiles: args.profiles,
    runner: args.runner,
    skill: args.skill,
    policy: args.policy,
    max_agents: args.max_agents,
    include_dirs: args.include_dirs,
    fallback_profiles: args.fallback_profiles,
    rotation_mode: args.rotation_mode,
    model_tier: args.model_tier,
  });

  const configParts = [];
  if (args.provider) configParts.push(`provider: ${args.provider}`);
  if (args.model) configParts.push(`model: ${args.model}`);
  if (args.profiles?.length) configParts.push(`profiles: ${args.profiles.length}`);
  if (args.runner) configParts.push(`runner: ${args.runner}`);
  if (args.skill) configParts.push(`skill: ${args.skill}`);
  if (args.policy) configParts.push(`policy: ${args.policy}`);
  if (args.max_agents) configParts.push(`max: ${args.max_agents}`);

  return {
    content: [{
      type: 'text',
      text: `✅ Group ${result.created ? 'created' : 'updated'}: \`${args.name}\`${configParts.length > 0 ? `\n- ${configParts.join('\n- ')}` : ''}\n\nUse \`delegate_to_group\` to send tasks to this group.`,
    }],
  };
}

/** @param {object} args */
function handleListGroups(args) {
  const cwd = args.cwd ?? defaultCwd;
  const groups = listGroups(cwd);
  if (args.json) { return { content: [{ type: "text", text: JSON.stringify(groups) }] }; }

  if (groups.length === 0) {
    return { content: [{ type: 'text', text: 'No groups defined. Use `create_group` to create one.' }] };
  }

  const lines = groups.map((g) => {
    const parts = [];
    if (g.provider) parts.push(`provider: ${g.provider}`);
    if (g.model) parts.push(`model: ${g.model}`);
    if (g.profiles?.length) parts.push(`profiles: ${g.profiles.length}`);
    if (g.runner) parts.push(`runner: ${g.runner}`);
    if (g.skill) parts.push(`skill: ${g.skill}`);
    if (g.policy) parts.push(`policy: ${g.policy}`);
    if (g.max_agents) parts.push(`max: ${g.max_agents}`);
    return `- **${g.name}** — ${parts.join(', ') || 'no config'}`;
  });

  return {
    content: [{ type: 'text', text: `## Agent Groups (${groups.length})\n\n${lines.join('\n')}` }],
  };
}

/** @param {object} args */
function handleDelegateToGroup(args) {
  const cwd = args.cwd ?? defaultCwd;
  const group = getGroup(cwd, args.group);

  if (!group) {
    return {
      content: [{ type: 'text', text: `❌ Group \`${args.group}\` not found. Use \`list_groups\` to see available groups.` }],
      isError: true,
    };
  }

  const count = args.count ?? 1;

  // Check max_agents limit
  if (group.max_agents && count > group.max_agents) {
    return {
      content: [{
        type: 'text',
        text: `❌ Requested ${count} agents but group \`${args.group}\` allows max ${group.max_agents}.`,
      }],
      isError: true,
    };
  }

  const taskIds = [];

  for (let i = 0; i < count; i++) {
    const profile = getGroupNextProfile(cwd, args.group, group);
    const delegateArgs = {
      prompt: count > 1 ? `[Agent ${i + 1}/${count} in group "${args.group}"]\n\n${args.prompt}` : args.prompt,
      cwd,
      provider: args.provider || profile.provider || group.provider || DEFAULT_PROVIDER,
      model: args.model || profile.model || group.model || undefined,
      runner: group.runner || undefined,
      skill: group.skill || undefined,
      policy: group.policy || undefined,
      include_dirs: group.include_dirs || undefined,
      timeout: args.timeout,
      groupConfig: { name: args.group, ...group },
      resource_group: args.group,
    };

    const result = handleDelegate(delegateArgs, {
      approvalMode: loadConfig().safety.defaultApprovalMode,
      emoji: '👥',
      label: `Group task (${args.group} #${i + 1})`,
    });

    // Extract task_id from response text
    const match = result.content[0].text.match(/`([0-9a-f-]{36})`/);
    if (match) taskIds.push(match[1]);
  }

  return {
    content: [{
      type: 'text',
      text: `👥 Delegated to group \`${args.group}\` — ${count} agent(s) spawned.\n\n${taskIds.map((id, i) => `- Agent ${i + 1}: \`${id}\``).join('\n')}\n\nUse \`get_task_result\` to check each agent's status.`,
    }],
  };
}

// ─── Messaging handlers ─────────────────────────────────────

function handleSendMessage(args) {
  const cwd = args.cwd ?? defaultCwd;
  const result = sendMessage(cwd, {
    channel: args.channel,
    payload: args.payload,
    from: args.from,
  });

  if (!result.success) {
    return {
      content: [{ type: 'text', text: `❌ Failed to send message: ${result.error || 'unknown error'}` }],
      isError: true,
    };
  }

  return {
    content: [{ type: 'text', text: `📨 Message sent to channel \`${result.channel}\`.` }],
  };
}

function handleGetMessages(args) {
  const cwd = args.cwd ?? defaultCwd;
  const result = getMessages(cwd, {
    channel: args.channel,
    clear: args.clear,
  });

  if (result.error) {
    return {
      content: [{ type: 'text', text: `❌ ${result.error}` }],
      isError: true,
    };
  }

  if (result.count === 0) {
    return {
      content: [{ type: 'text', text: `📭 No messages on channel \`${args.channel}\`.` }],
    };
  }

  const lines = result.messages.map((m, i) =>
    `**${i + 1}.** [${m.timestamp}] from \`${m.from}\`:\n\`\`\`json\n${JSON.stringify(m.payload, null, 2)}\n\`\`\``
  );

  return {
    content: [{
      type: 'text',
      text: `📬 **${result.count}** message(s) on channel \`${args.channel}\`${args.clear ? ' (cleared)' : ''}:\n\n${lines.join('\n\n')}`,
    }],
  };
}
