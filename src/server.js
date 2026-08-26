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
import { createHash, randomUUID } from 'node:crypto';

import { runAntigravityStreaming, listAntigravitySessions } from './runner/antigravity-runner.js';
import { runOpencodeStreaming } from './runner/opencode-runner.js';
import { runCodexStreaming } from './runner/codex-runner.js';
import { runClaudeStreaming } from './runner/claude-runner.js';
import { runKimiStreaming } from './runner/kimi-runner.js';
import { loadConfig } from './runner/config.js';
import { runHistoryCleanup } from './runner/history-cleanup.js';
import { getSystemLoad } from './runner/process-manager.js';
import { getSlotLedger } from './runner/slot-ledger.js';
import { getTaskSecretStore } from './runner/task-secret-store.js';
import { createTask, completeTask, failTask, formatTaskResult, getActiveTasks, listAllTasks, listTaskState, cancelTask, finishTask, setNotifyCallback, pushTaskEvent } from './tools/results.js';
import { listSkills, getSkillContent, createSkill, deleteSkill, provisionSkill } from './tools/skills.js';
import { consultPeer } from './tools/consult.js';
import { addSchedule, listSchedules, removeSchedule, getScheduledResults, getDaemonStatus } from './scheduler/scheduler.js';
import { createPipeline, listPipelines, runPipeline, getRun, listRuns, cancelRun, signalStepComplete, bounceBack } from './scheduler/pipeline.js';
import { createGroup, listGroups, getGroup, deleteGroup, getGroupNextProfile } from './tools/groups.js';
import { sendMessage, getMessages } from './tools/messaging.js';
import { saveScript, listScripts } from './tools/scripts.js';
import { getBoardStore } from './tools/board-store.js';
import { resolveAgent, buildAgentCatalog } from './agents/agent-resolver.js';
import { trackFiles, untrackFiles } from './tools/file-tracker.js';
import { handleGetTrackedFiles, handleListWorkflows, handleSearchByTags, handleGetWorkflowContent } from './tools/workflow-tools.js';
import { handleResolveContext } from './tools/context-resolver.js';
import { buildResolvedContextPackage } from './tools/context-package.js';
import { buildDelegatePrompt } from './tools/delegate-prompt.js';
import { createToolRouter } from './tools/toolRouter.js';
import { getGlobalConfigPath } from './runtime/paths.js';

import { getToolDefinitions } from './tool-definitions.js';

import fs from 'node:fs';
import path from 'node:path';
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

function diagnosticLine(value, limit = 500) {
  return typeof value === 'string'
    ? value.replace(/\s+/g, ' ').trim().replaceAll('`', '\\`').substring(0, limit)
    : '';
}

function sha256(value) {
  return createHash('sha256').update(String(value ?? '')).digest('hex');
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function normalizeFileHints(files) {
  if (!Array.isArray(files)) return [];
  return [...new Set(files.map(file => String(file || '').trim()).filter(Boolean))];
}

function isBlockedWorkspacePath(config, dir) {
  let resolved = path.resolve(dir);
  return config.safety.badCwdList.some((bad) => resolved === bad || resolved.startsWith(bad + path.sep));
}

function resolveWorkspaceDirs(config, cwd, includeDirs = []) {
  let resolvedCwd = path.resolve(cwd);
  if (isBlockedWorkspacePath(config, resolvedCwd)) {
    return {
      error: `❌ Refusing to delegate: cwd="${resolvedCwd}" looks like a system directory, not a project workspace. Please provide an explicit cwd pointing to your project.`,
    };
  }

  let dirs = [resolvedCwd];
  for (let dir of includeDirs) {
    if (!isNonEmptyString(dir)) continue;
    let resolved = path.resolve(resolvedCwd, dir);
    if (isBlockedWorkspacePath(config, resolved)) {
      return {
        error: `❌ Refusing to delegate: include_dirs contains "${resolved}", which looks like a system directory.`,
      };
    }
    dirs.push(resolved);
  }

  return { cwd: resolvedCwd, dirs };
}

// ─── Prerequisite check (cached at startup) ──────────────────

let antigravityAvailable = null;
let opencodeAvailable = null;
let codexAvailable = null;
let claudeAvailable = null;

function checkAntigravity() {
  if (antigravityAvailable !== null) return antigravityAvailable;
  try {
    execFileSync('which', ['agy'], { encoding: 'utf-8', timeout: 2000 });
    antigravityAvailable = true;
  } catch (e) {
    antigravityAvailable = false;
  }
  return antigravityAvailable;
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

let kimiAvailable = null;

function checkKimi() {
  if (kimiAvailable !== null) return kimiAvailable;
  try {
    execFileSync('which', ['kimi'], { encoding: 'utf-8', timeout: 2000 });
    kimiAvailable = true;
  } catch (e) {
    kimiAvailable = false;
  }
  return kimiAvailable;
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
      let configPath = getGlobalConfigPath('agent-portal.json');
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

const ANTIGRAVITY_REQUIRED_ERROR = {
  content: [{
    type: 'text',
    text: `❌ Antigravity CLI is not installed or not in PATH.

**To fix:**
1. Install: \`curl -fsSL https://antigravity.google/cli/install.sh | bash\`
2. Authenticate: run \`agy\` (opens browser for OAuth)
3. Verify: \`agy --version\`
4. Restart your IDE to reload the MCP server.

Docs: https://antigravity.google/docs/cli`
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

/** Tools that can require a local CLI provider to be installed */
const PROVIDER_TOOLS = new Set([
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

function resolveDelegateProviderForGuard(toolName, args = {}) {
  if (args.provider) return args.provider;
  if (toolName === 'delegate_to_group' && args.group) {
    let cwd = args.cwd ?? defaultCwd;
    let group = getGroup(cwd, args.group);
    let firstProfile = Array.isArray(group?.profiles) ? group.profiles[0] : null;
    return firstProfile?.provider || group?.provider || DEFAULT_PROVIDER;
  }
  return DEFAULT_PROVIDER;
}

function requiresDepthBlock(toolName, args = {}) {
  if (!isDepthExceeded()) return false;
  let isDelegateTool = ['delegate_task', 'delegate_task_readonly', 'delegate_to_group'].includes(toolName);
  if (!isDelegateTool) return true;
  return resolveDelegateProviderForGuard(toolName, args) === 'antigravity';
}

function guardToolCall(name, args = {}) {
  if (!PROVIDER_TOOLS.has(name)) return null;
  if (requiresDepthBlock(name, args)) return DEPTH_EXCEEDED_ERROR;

  const isDelegateTool = ['delegate_task', 'delegate_task_readonly', 'delegate_to_group'].includes(name);
  if (!isDelegateTool) {
    return checkAntigravity() ? null : ANTIGRAVITY_REQUIRED_ERROR;
  }

  const provider = args.provider || null;
  if (provider === 'antigravity' && !checkAntigravity()) return ANTIGRAVITY_REQUIRED_ERROR;
  if (provider === 'opencode' && !checkOpencode()) {
    return { content: [{ type: 'text', text: '❌ OpenCode CLI is not installed or not in PATH.' }], isError: true };
  }
  if (provider === 'codex' && !checkCodex()) {
    return { content: [{ type: 'text', text: '❌ Codex CLI is not installed or not in PATH.' }], isError: true };
  }
  if (provider === 'claude' && !checkClaude()) return CLAUDE_REQUIRED_ERROR;
  if (provider === 'kimi' && !checkKimi()) {
    return { content: [{ type: 'text', text: '❌ Kimi Code CLI is not installed or not in PATH.' }], isError: true };
  }
  return null;
}

function selectStreamingRunner(provider, taskId) {
  if (provider === 'mock') {
    return async () => {
      await new Promise(r => setTimeout(r, 100));
      process.stderr.write(`__TASK_NOTIFY__${JSON.stringify({
        jsonrpc: '2.0',
        method: 'notifications/task/event',
        params: { taskId, type: 'event', data: { type: 'message', role: 'assistant', content: 'Integration Test Success' } }
      })}\n`);
      return { exitCode: 0, response: 'Mock final response' };
    };
  }
  if (provider === 'opencode') return runOpencodeStreaming;
  if (provider === 'codex') return runCodexStreaming;
  if (provider === 'claude') return runClaudeStreaming;
  if (provider === 'kimi') return runKimiStreaming;
  if (provider === 'antigravity') return runAntigravityStreaming;
  return runCodexStreaming;
}

function providerRequirementError(provider) {
  if (isDepthExceeded() && provider === 'antigravity') return DEPTH_EXCEEDED_ERROR;
  if (provider === 'antigravity' && !checkAntigravity()) return ANTIGRAVITY_REQUIRED_ERROR;
  if (provider === 'opencode' && !checkOpencode()) {
    return { content: [{ type: 'text', text: '❌ OpenCode CLI is not installed or not in PATH.' }], isError: true };
  }
  if (provider === 'codex' && !checkCodex()) {
    return { content: [{ type: 'text', text: '❌ Codex CLI is not installed or not in PATH.' }], isError: true };
  }
  if (provider === 'claude' && !checkClaude()) return CLAUDE_REQUIRED_ERROR;
  if (provider === 'kimi' && !checkKimi()) {
    return { content: [{ type: 'text', text: '❌ Kimi Code CLI is not installed or not in PATH.' }], isError: true };
  }
  return null;
}

function errorResponseText(response) {
  return response?.content?.map((item) => item.text).filter(Boolean).join('\n') || 'Provider is unavailable';
}

function makeProviderFailureResult(reason) {
  return {
    exitCode: -1,
    response: '',
    stats: null,
    toolCalls: [],
    toolResults: [],
    errors: [reason],
    totalEvents: 0,
    softTimeout: false,
  };
}

function isFailedRunResult(result) {
  if (!result) return true;
  if (result.softTimeout) return false;
  if (result.exitCode !== undefined && result.exitCode !== null && result.exitCode !== 0) return true;
  return Array.isArray(result.errors) && result.errors.length > 0;
}

function resultFailureReason(result) {
  let error = Array.isArray(result?.errors) ? result.errors.find(Boolean) : null;
  if (error) return String(error).split('\n')[0].slice(0, 220);
  if (result?.exitCode !== undefined && result.exitCode !== null && result.exitCode !== 0) {
    return `exit code ${result.exitCode}`;
  }
  return 'provider attempt failed';
}

function isUnknownOpenCodeModel(provider, effectiveModel, knownIds) {
  return provider === 'opencode' && effectiveModel
    && effectiveModel !== 'default'
    && !knownIds.includes(effectiveModel);
}

const PROVIDER_REASONING_EFFORTS = {
  claude: new Set(['low', 'medium', 'high', 'xhigh', 'max']),
};
const APPROVAL_MODES = new Set(['yolo', 'auto_edit', 'plan']);

function normalizeReasoningEffort(value, provider = 'codex') {
  if (value !== undefined && value !== null) {
    if (typeof value !== 'string') {
      throw new Error('Invalid reasoningEffort: must be a string');
    }
    if (value.trim() === '') {
      throw new Error('Invalid reasoningEffort: must be a non-empty string');
    }
  }
  let normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized || normalized === 'default') return null;
  if (provider === 'codex') return normalized;
  let supported = PROVIDER_REASONING_EFFORTS[provider] || null;
  if (provider === 'claude' && !supported?.has(normalized)) {
    throw new Error(`Invalid reasoningEffort for Claude: ${normalized}`);
  }
  if (provider === 'claude') return normalized;
  throw new Error(`reasoningEffort is only supported by Codex and Claude, not ${provider}`);
}

function normalizeServiceTier(value, provider = 'codex') {
  if (value !== undefined && value !== null) {
    if (typeof value !== 'string') {
      throw new Error('Invalid serviceTier: must be a string');
    }
    if (value.trim() === '') {
      throw new Error('Invalid serviceTier: must be a non-empty string');
    }
  }
  let normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized || normalized === 'default') return null;
  if (provider === 'codex') return normalized;
  throw new Error(`serviceTier is only supported by Codex, not ${provider}`);
}

function normalizeApprovalMode(value) {
  let normalized = typeof value === 'string' ? value.trim() : '';
  return APPROVAL_MODES.has(normalized) ? normalized : null;
}

function approvalModeFromPolicy(policy) {
  if (policy === 'read-only') return 'plan';
  if (policy === 'read-write') return 'auto_edit';
  if (policy === 'admin') return 'yolo';
  return null;
}

function resourceGroupApprovalMode(resourceGroup) {
  return normalizeApprovalMode(resourceGroup?.approval_mode ?? resourceGroup?.approvalMode)
    ?? approvalModeFromPolicy(resourceGroup?.policy);
}

function profileOption(profile, camelName, snakeName) {
  return profile?.[camelName] ?? profile?.[snakeName] ?? profile?.profile?.[camelName] ?? profile?.profile?.[snakeName] ?? null;
}

function normalizeStringList(value) {
  if (Array.isArray(value)) {
    return value.map(item => typeof item === 'string' ? item.trim() : '').filter(Boolean);
  }
  if (typeof value === 'string') {
    return value.split(',').map(item => item.trim()).filter(Boolean);
  }
  return [];
}

function mergeStringLists(...values) {
  let merged = [];
  for (let value of values) {
    for (let item of normalizeStringList(value)) {
      if (!merged.includes(item)) merged.push(item);
    }
  }
  return merged;
}

function resolveRunProfile(profile, resourceGroup, agentDef) {
  let provider = profile?.provider || resourceGroup?.provider || agentDef?.provider || DEFAULT_PROVIDER;
  let reasoningEffort = normalizeReasoningEffort(
    profileOption(profile, 'reasoningEffort', 'reasoning_effort')
    ?? resourceGroup?.reasoningEffort
    ?? resourceGroup?.reasoning_effort
    ?? agentDef?.reasoningEffort
    ?? agentDef?.reasoning_effort,
    provider
  );
  let serviceTier = normalizeServiceTier(
    profileOption(profile, 'serviceTier', 'service_tier')
    ?? resourceGroup?.serviceTier
    ?? resourceGroup?.service_tier
    ?? agentDef?.serviceTier
    ?? agentDef?.service_tier,
    provider
  );
  return {
    provider,
    model: profile?.model ?? resourceGroup?.model ?? agentDef?.model ?? agentDef?.models?.[0] ?? null,
    reasoningEffort,
    serviceTier,
    allowedTools: mergeStringLists(
      profileOption(profile, 'allowedTools', 'allowed_tools'),
      resourceGroup?.allowedTools,
      resourceGroup?.allowed_tools,
      agentDef?.allowedTools,
      agentDef?.allowed_tools
    ),
    label: profile?.label || null,
  };
}

function buildRuntimeFallbackProfiles(args, resourceGroup, resourceProfile) {
  let profiles = Array.isArray(resourceGroup?.profiles)
    ? resourceGroup.profiles.filter(profile => profile && (profile.provider || profile.model))
    : [];
  let rotationMode = resourceGroup?.rotation_mode || 'error_fallback';
  let usesExplicitTarget = Boolean(args.provider || args.model);
  let reasoningOverride = args.reasoningEffort ?? args.reasoning_effort;
  let serviceTierOverride = args.serviceTier ?? args.service_tier;

  function applyOverrides(profile) {
    return {
      ...profile,
      reasoningEffort: reasoningOverride ?? profile?.reasoningEffort ?? profile?.reasoning_effort,
      serviceTier: serviceTierOverride ?? profile?.serviceTier ?? profile?.service_tier,
    };
  }

  if (!usesExplicitTarget && rotationMode === 'error_fallback' && profiles.length > 1) {
    return profiles.map(applyOverrides);
  }

  return [applyOverrides({
    provider: args.provider || resourceProfile.provider || resourceGroup?.provider || null,
    model: args.model ?? resourceProfile.model ?? resourceGroup?.model ?? null,
    reasoningEffort: resourceProfile.profile?.reasoningEffort ?? resourceProfile.profile?.reasoning_effort ?? null,
    serviceTier: resourceProfile.profile?.serviceTier ?? resourceProfile.profile?.service_tier ?? null,
    profile: resourceProfile.profile || null,
  })];
}


const DEPTH_EXCEEDED_ERROR = {
  content: [{
    type: 'text',
    text: `⚠️ Orchestration depth limit reached (depth=${CURRENT_DEPTH}, max=${getMaxDepth()}).

This agent-pool instance is running inside a nested Antigravity CLI worker.
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
  // Check Antigravity once at server creation.
  checkAntigravity();
  checkCodex();
  checkClaude();

  // Async model discovery (non-blocking, populates _cachedModels for tools/list)
  discoverModels().then(m => {
    if (m.length > 0) console.error(`[agent-pool] Discovered ${m.length} models for tool schema`);
  }).catch((err) => {
    console.error(`[agent-pool] Model discovery failed: ${err.message}`);
    _cachedModels = [];
  });

  // Non-blocking history rotation
  runHistoryCleanup().catch((err) => {
    console.error(`[agent-pool] History cleanup failed: ${err.message}`);
  });

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

  server.setRequestHandler(CallToolRequestSchema, createToolRouter({
    guardToolCall,
    getActiveTasks,
    handlers: {
      handleDelegateTask,
      handleDelegateReadonly,
      handleGetTaskResult,
      handleCancelTask,
      handleFinishTask,
      handleReleaseSlot,
      handleListTasks,
      handleGetBoardState,
      handleConsultPeer,
      handleListSessions,
      handleListSkills,
      handleGetSkillContent,
      handleResolveContext: (args) => handleResolveContext(args, defaultCwd),
      handleCreateSkill,
      handleDeleteSkill,
      handleInstallSkill,
      handleScheduleTask,
      handleListSchedules,
      handleCancelSchedule,
      handleGetScheduledResults,
      handleGetUsageGuide,
      handleCreatePipeline,
      handleRunPipeline,
      handleListPipelines,
      handleGetPipelineStatus,
      handleCancelPipeline,
      handleSignalStepComplete,
      handleBounceBack,
      handleCreateGroup,
      handleListGroups,
      handleDeleteGroup,
      handleDelegateToGroup,
      handleSendMessage,
      handleGetMessages,
      handleSaveScript,
      handleListScripts,
      handleTrackFiles,
      handleUntrackFiles,
      handleGetTrackedFiles: (args) => handleGetTrackedFiles(args, defaultCwd),
      handleListWorkflows: (args) => handleListWorkflows(args, defaultCwd),
      handleSearchByTags: (args) => handleSearchByTags(args, defaultCwd),
      handleGetWorkflowContent: (args) => handleGetWorkflowContent(args, defaultCwd),
    },
  }));

  return server;
}

// ─── Tool Handlers ──────────────────────────────────────────────────

function handleGetTaskResult(args) {
  return formatTaskResult(args.task_id);
}

function handleCancelTask(args) {
  return cancelTask(args.task_id);
}

function handleFinishTask(args) {
  return finishTask(args.task_id, args);
}

async function handleReleaseSlot(args = {}) {
  const admissionId = args.admission_id;
  if (!isNonEmptyString(admissionId)) {
    return {
      content: [{ type: 'text', text: '❌ Missing required `admission_id` argument for release_slot.' }],
      isError: true,
    };
  }
  let released = false;
  try {
    const result = await getSlotLedger().release({ admissionId });
    released = Boolean(result?.released);
  } catch {
    // Lock contention or an unavailable ledger is non-fatal: the dead-pid sweep
    // is the safety net. Report idempotent success so the best-effort caller
    // never has to retry or fail over a transient.
    released = false;
  }
  return {
    content: [{ type: 'text', text: JSON.stringify({ ok: true, released }) }],
  };
}

function handleListTasks() {
  return { content: [{ type: 'text', text: JSON.stringify(listTaskState(), null, 2) }] };
}

function handleGetBoardState(args) {
  return {
    content: [{
      type: 'text',
      text: JSON.stringify(getBoardStore(args.cwd || defaultCwd).getSnapshot(), null, 2),
    }],
  };
}

function handleConsultPeer(args) {
  return consultPeer(args, defaultCwd);
}

function handleSaveScript(args) {
  return {
    content: [{
      type: 'text',
      text: `Script saved at ${saveScript(args.cwd || defaultCwd, args.name, args.code, args.ext)}`,
    }],
  };
}

function handleListScripts(args) {
  return {
    content: [{
      type: 'text',
      text: JSON.stringify(listScripts(args.cwd || defaultCwd), null, 2),
    }],
  };
}

function handleTrackFiles(args) {
  return {
    content: [{
      type: 'text',
      text: `Tracked files: \n- ${trackFiles(args.cwd || defaultCwd, args.files).join('\n- ')}`,
    }],
  };
}

function handleUntrackFiles(args) {
  return {
    content: [{
      type: 'text',
      text: `Tracked files: \n- ${untrackFiles(args.cwd || defaultCwd, args.files).join('\n- ')}`,
    }],
  };
}

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
async function handleDelegate(args = {}, { approvalMode, emoji, label }) {
  const config = loadConfig();
  const taskId = randomUUID();
  const scope = resolveWorkspaceDirs(config, args.cwd ?? defaultCwd, args.include_dirs);
  if (scope.error) {
    return {
      content: [{ type: 'text', text: scope.error }],
      isError: true,
    };
  }
  const cwd = scope.cwd;

  if (!isNonEmptyString(args.prompt)) {
    return {
      content: [{ type: 'text', text: '❌ Missing required `prompt` argument for delegate_task.' }],
      isError: true,
    };
  }

  // Concurrency limit
  const activeCount = listAllTasks().filter(t => t.status === 'running').length;
  if (config.limits.maxConcurrent > 0 && activeCount >= config.limits.maxConcurrent) {
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
    // Resolve agent from the team-memory `agents/{slug}.md` (single source of truth).
    agentDef = resolveAgent(cwd, args.agent_slug);
    if (agentDef) {
      agentContext = agentDef.prompt;
      let groupInfo = agentDef.resourceGroup ? `, group=${agentDef.resourceGroup}` : '';
      console.error(`[agent-pool] Resolved agent '${args.agent_slug}': ${agentDef.skills.length} skills${groupInfo}`);
    } else {
      console.error(`[agent-pool] Agent '${args.agent_slug}' not found in team-memory agents/`);
      return {
        content: [{ type: 'text', text: `❌ Agent '${args.agent_slug}' could not be resolved. Check team-memory \`agents/${args.agent_slug}.md\` (and that team memory is configured) plus its skill references.` }],
        isError: true,
      };
    }
  }

  // For orchestrator role: inject available agent catalog into context
  if (agentDef?.role === 'orchestrator') {
    const catalog = buildAgentCatalog(cwd, { excludeSlug: agentDef.slug });
    if (catalog) {
      agentContext += `\n\n${catalog}`;
    }
  }

  const hasExplicitRuntimeRoute = Boolean(args.provider || args.model);
  const resourceGroupName = args.resource_group
    || args.resourceGroup
    || (hasExplicitRuntimeRoute ? null : agentDef?.resourceGroup)
    || null;
  const resourceGroup = resourceGroupName ? getGroup(cwd, resourceGroupName) : null;
  const resourceProfile = resourceGroupName && resourceGroup
    ? getGroupNextProfile(cwd, resourceGroupName, resourceGroup)
    : { provider: null, model: null, profile: null };

  if (resourceGroupName && !resourceGroup) {
    console.error(`[agent-pool] Resource group '${resourceGroupName}' not found in local portal resource groups`);
    let summary = buildAvailableGroupsSummary(cwd, { requestedCount: 1 });
    let text = `❌ Resource group \`${resourceGroupName}\` not found.${summary}`;
    return {
      content: [{ type: 'text', text }],
      isError: true,
    };
  }

  // Capacity: the slot ledger is the single authority. Reserve a slot under the
  // cross-process lock BEFORE spawning (admission); a board-minted admission_id
  // makes this idempotent and lets the board dedup/echo across a crash.
  let ledgerAdmissionId = null;
  if (resourceGroup?.max_agents) {
    let admissionId = args.admission_id || taskId;
    let acq;
    try {
      acq = await getSlotLedger().acquire({
        admissionId,
        groupKey: resourceGroupName,
        limit: resourceGroup.max_agents,
      });
    } catch (err) {
      // Lock contention is transient — surface as at-capacity so the caller
      // retries rather than failing hard.
      acq = { granted: false, reason: err?.code === 'LEDGER_LOCK_TIMEOUT' ? 'ledger_busy' : 'ledger_error' };
    }
    if (!acq.granted) {
      let groupActiveCount = getGroupActiveCount(resourceGroupName);
      let summary = buildAvailableGroupsSummary(cwd, {
        excludeName: resourceGroupName,
        requestedCount: 1,
      });
      let text = [
        `⚠️ Resource group \`${resourceGroupName}\` is at capacity`,
        `(${groupActiveCount}/${resourceGroup.max_agents} active tasks).`,
        `Wait for an existing task in this group to complete,`,
        `or use an available alternative.${summary}`,
      ].join(' ');
      return {
        content: [{ type: 'text', text }],
        isError: true,
      };
    }
    ledgerAdmissionId = admissionId;
  }

  // Direct skill activation when no agent_slug is provided.
  if (!agentContext && args.skill) {
    const provisioned = provisionSkill(cwd, args.skill);
    if (provisioned) {
      prompt = `IMPORTANT: Before starting the task, activate the skill "${provisioned.name}" using the activate_skill tool. Then proceed with the task.\n\n${prompt}`;
    } else {
      prompt = `NOTE: Skill '${args.skill}' was requested but not found in global or active workspace skills. Proceed with the task.\n\n${prompt}`;
    }
  }

  // Resolve policy path (built-in templates or absolute path).
  let policyPath = args.policy
    ?? (resourceGroup?.policy || null);
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
  const forcedMode = normalizeApprovalMode(approvalMode);
  const resolvedMode = normalizeApprovalMode(args.approval_mode)
    ?? (approvalMode === 'plan' ? forcedMode : null)
    ?? resourceGroupApprovalMode(resourceGroup)
    ?? forcedMode
    ?? 'yolo';
  const modeNotice = roleDescriptions[resolvedMode] ?? `Mode: ${resolvedMode}`;
  const minTimeout = resolvedMode === 'plan' ? 300 : 60;
  const timeout = Math.max(args.timeout ?? resourceGroup?.timeout ?? config.limits.timeout, minTimeout);

  // Build workspace scope awareness — tell the agent its sandbox boundaries upfront
  const workspaceDirs = scope.dirs;
  const scopeNotice = `[Workspace Scope] You have access to these directories:\n${workspaceDirs.map((d) => `  - ${d}`).join('\n')}\nIf you need files outside these paths, use shell commands (cat, find, ls) instead of file tools. Do NOT attempt list_directory or read_file on paths outside your workspace — they will be rejected by the sandbox.`;

  const contextMode = args.context_mode === 'off' ? 'off' : 'auto';
  const fileHints = normalizeFileHints(args.files);
  let resolvedContextPackage = '';
  if (contextMode === 'auto') {
    try {
      resolvedContextPackage = buildResolvedContextPackage({
        cwd,
        task: args.prompt,
        prompt: args.prompt,
        agent_slug: args.agent_slug || agentDef?.slug || null,
        files: fileHints,
        focus_graph: args.focus_graph || args.focusGraph || null,
      }, defaultCwd).text;
    } catch (err) {
      resolvedContextPackage = [
        '[Resolved Context Package]',
        'Source: Agent Portal metadata resolver',
        'Mode: orchestration',
        'Status: unavailable',
        `Error: ${err.message || 'context resolver failed'}`,
        'Instruction: report missing context and call resolve_context or `mcp-agent-portal context resolve` when available. Shell inspection is emergency-only and must inspect frontmatter only.',
        '[/Resolved Context Package]',
      ].join('\n');
    }
  }

  prompt = buildDelegatePrompt({
    resolvedMode,
    modeNotice,
    scopeNotice,
    resolvedContextPackage,
    agentContext,
    prompt,
  });

  // Route to the correct runner based on provider
  const provider = args.provider || resourceProfile.provider || resourceGroup?.provider || agentDef?.provider || DEFAULT_PROVIDER;

  const runtimeProfiles = buildRuntimeFallbackProfiles(args, resourceGroup, resourceProfile);
  if (_cachedModels.length > 0) {
    const knownIds = _cachedModels
      .map(model => typeof model === 'string' ? model : model?.id)
      .filter(Boolean);
    const unknownProfile = runtimeProfiles
      .map(profile => resolveRunProfile(profile, resourceGroup, agentDef))
      .find(profile => isUnknownOpenCodeModel(profile.provider, profile.model, knownIds));

    if (unknownProfile) {
      if (ledgerAdmissionId) {
        try {
          await getSlotLedger().release({ admissionId: ledgerAdmissionId });
        } catch {
          // A stale reserved slot is swept by the ledger TTL. The task still fails closed.
        }
      }
      const sample = knownIds.slice(0, 15).join('\n  - ');
      const suffix = knownIds.length > 15 ? `\n  ... and ${knownIds.length - 15} more` : '';
      console.error(`[agent-pool] Unknown OpenCode model "${unknownProfile.model}", refusing default fallback`);
      return {
        content: [{
          type: 'text',
          text: `❌ Unknown OpenCode model: "${unknownProfile.model}". Execution was not started; explicit model selections never fall back to the provider default.\n\nAvailable models:\n  - ${sample}${suffix}`,
        }],
        isError: true,
      };
    }
  }

  // Per-task secret → verified-slug correlation (D2.1). Mint a secret bound to
  // the server-verified slug — the `verified_slug` the parent passed, falling
  // back to the slug agent-pool resolved — and inject it into the spawned
  // process so the agent's MCP identity can be verified by the secret rather
  // than self-claimed in the payload. The plaintext secret is never logged.
  const serverAssignedSlug = isNonEmptyString(args.verified_slug)
    ? args.verified_slug
    : (agentDef?.slug ?? (isNonEmptyString(args.agent_slug) ? args.agent_slug : null));
  let taskSecret = null;
  try {
    taskSecret = getTaskSecretStore().mint({
      taskId,
      admissionId: ledgerAdmissionId,
      serverAssignedSlug,
    }).secret;
  } catch {
    // Secret store unavailable — the connection stays unverified, which the
    // portal treats as least-privilege. Never fail the spawn over this.
    taskSecret = null;
  }

  const taskOpts = {
    prompt,
    cwd,
    taskSecret,
    model: args.model ?? resourceProfile.model ?? resourceGroup?.model ?? agentDef?.model ?? agentDef?.models?.[0],
    reasoningEffort: normalizeReasoningEffort(
      args.reasoningEffort
      ?? args.reasoning_effort
      ?? resourceProfile.profile?.reasoningEffort
      ?? resourceProfile.profile?.reasoning_effort,
      provider
    ),
    serviceTier: normalizeServiceTier(
      args.serviceTier
      ?? args.service_tier
      ?? resourceProfile.profile?.serviceTier
      ?? resourceProfile.profile?.service_tier,
      provider
    ),
    approvalMode: resolvedMode,
    timeout,
    sessionId: args.session_id,
    taskId,
    runner: args.runner,
    policy: policyPath,
    includeDirs: args.include_dirs,
    allowedTools: mergeStringLists(args.allowedTools, args.allowed_tools, resourceGroup?.allowedTools, resourceGroup?.allowed_tools),
    groupConfig: args.groupConfig || (resourceGroup ? { name: resourceGroupName, ...resourceGroup } : undefined),
    skill: args.skill,
    chat_id: args.chat_id,
  };

  const hasRuntimeFallback = runtimeProfiles.length > 1;
  let providerError = providerRequirementError(provider);
  if (providerError && !hasRuntimeFallback) return providerError;

  const executionConfig = {
    resourceGroup: resourceGroupName,
    group: resourceGroup,
    runtimeProfiles,
    provider,
    model: taskOpts.model ?? null,
    approvalMode: resolvedMode,
    timeout,
    policy: policyPath,
    contextMode,
  };

  createTask(taskId, args.prompt, args.on_wait_hint, resolvedMode, cwd,
    agentDef?.slug ?? args.agent_slug ?? 'unknown',
    args.parent_chat_id, args.chat_id,
    agentDef?.icon, agentDef?.color,
    resourceGroupName,
    {
      provider,
      model: taskOpts.model ?? null,
      reasoningEffort: taskOpts.reasoningEffort ?? null,
      serviceTier: taskOpts.serviceTier ?? null,
      runner: args.runner ?? null,
      skill: args.skill ?? null,
      contextMode,
      files: fileHints,
      sessionId: args.session_id ?? null,
      admissionId: ledgerAdmissionId,
      promptSha256: sha256(prompt),
      promptBytes: Buffer.byteLength(prompt, 'utf8'),
      modelSha256: sha256(taskOpts.model ?? ''),
      resourceConfigSha256: sha256(stableJson(executionConfig)),
    }
  );

  async function runWithProfileFallback() {
    let lastResult = null;
    for (let index = 0; index < runtimeProfiles.length; index++) {
      let profile = resolveRunProfile(runtimeProfiles[index], resourceGroup, agentDef);
      let requirementError = providerRequirementError(profile.provider);
      let result;

      if (requirementError) {
        result = makeProviderFailureResult(errorResponseText(requirementError));
      } else {
        let runFn = selectStreamingRunner(profile.provider, taskId);
        let attemptOpts = {
          ...taskOpts,
          model: profile.model,
          reasoningEffort: profile.reasoningEffort,
          serviceTier: profile.serviceTier,
          allowedTools: mergeStringLists(args.allowedTools, args.allowed_tools, profile.allowedTools, taskOpts.allowedTools),
          sessionId: index > 0 && profile.provider !== provider ? undefined : taskOpts.sessionId,
        };
        try {
          result = await runFn(attemptOpts);
        } catch (err) {
          if (index >= runtimeProfiles.length - 1) throw err;
          result = makeProviderFailureResult(err.message || 'provider runner failed');
        }
      }

      lastResult = result;
      if (!isFailedRunResult(result) || index >= runtimeProfiles.length - 1) {
        return result;
      }

      let nextProfile = resolveRunProfile(runtimeProfiles[index + 1], resourceGroup, agentDef);
      pushTaskEvent(taskId, {
        type: 'provider_fallback',
        resourceGroup: resourceGroupName,
        from: profile,
        to: nextProfile,
        reason: resultFailureReason(result),
        attempt: index + 2,
        total: runtimeProfiles.length,
      });
      console.error(`[agent-pool] Provider fallback for task ${taskId}: ${profile.provider}/${profile.model || 'default'} -> ${nextProfile.provider}/${nextProfile.model || 'default'}`);
    }
    return lastResult;
  }

  runWithProfileFallback()
    .then((result) => {
      if (isFailedRunResult(result)) {
        failTask(taskId, resultFailureReason(result), result);
        return;
      }
      completeTask(taskId, result);
    })
    .catch((err) => failTask(taskId, err.message));

  const mode = resolvedMode;
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
 * @returns {Promise<object>}
 */
async function handleListSessions(args) {
  const sessions = await listAntigravitySessions(args.cwd ?? defaultCwd);
  if (sessions.length === 0) {
    return { content: [{ type: 'text', text: 'No Antigravity conversations found, or this CLI version does not expose conversation enumeration.' }] };
  }
  const lines = sessions.map(
    (s) => `- **${s.index}**. ${s.preview} (${s.timeAgo}) \`${s.sessionId}\``,
  );
  return {
    content: [{ type: 'text', text: `## Available Sessions (${sessions.length})\n\n${lines.join('\n')}` }],
  };
}

/**
 * @param {object} args
 * @returns {object}
 */
function handleListSkills(args) {
  const skills = listSkills(args.cwd ?? defaultCwd, { files: args.files || [] });
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

/**
 * @param {object} args
 * @returns {object}
 */
function handleGetSkillContent(args) {
  const skillName = args.name || args.skill_name || args.skill;
  if (!skillName) {
    return { content: [{ type: 'text', text: 'Missing skill name. Use `name`.' }], isError: true };
  }

  const skill = getSkillContent(args.cwd ?? defaultCwd, skillName, { files: args.files || [] });
  if (!skill) {
    return { content: [{ type: 'text', text: `Skill not found: ${skillName}` }], isError: true };
  }

  return { content: [{ type: 'text', text: JSON.stringify(skill, null, 2) }] };
}

/**
 * @param {object} args
 * @returns {object}
 */
function handleCreateSkill(args) {
  const filePath = createSkill(args.cwd ?? defaultCwd, args.skill_name, args.description, args.instructions);
  return {
    content: [{
      type: 'text',
      text: `✅ Skill created: \`${args.skill_name}\`\nPath: \`${filePath}\`\n\nUse with delegate_task: \`skill: "${args.skill_name}"\``,
    }],
  };
}

/**
 * @param {object} args
 * @returns {object}
 */
function handleDeleteSkill(args) {
  const deleted = deleteSkill(args.cwd ?? defaultCwd, args.skill_name);
  return {
    content: [{
      type: 'text',
      text: deleted ? `✅ Skill deleted: \`${args.skill_name}\`` : `❌ Skill not found: \`${args.skill_name}\``,
    }],
  };
}

/**
 * @param {object} args
 * @returns {object}
 */
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

/**
 * @param {object} args
 * @returns {object}
 */
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
    let provider = args.provider || DEFAULT_PROVIDER;
    const result = addSchedule(cwd, {
      prompt: args.prompt,
      cron: args.cron,
      provider,
      model: args.model,
      reasoningEffort: normalizeReasoningEffort(args.reasoningEffort ?? args.reasoning_effort, provider),
      serviceTier: normalizeServiceTier(args.serviceTier ?? args.service_tier, provider),
      skill: args.skill,
      approvalMode: args.approval_mode,
      catchup: args.catchup,
      taskCwd: args.cwd,
    });

    return {
      content: [{
        type: 'text',
        text: `⏰ Task scheduled.\n\n- **Schedule ID**: \`${result.scheduleId}\`\n- **Cron**: \`${args.cron}\`\n- **Next run**: ${result.nextRun || 'unknown'}\n- **Prompt**: ${preview(args.prompt, 100)}...\n\nDaemon is running in the background. Results are saved in local portal project state.\nUse \`list_schedules\` to see all schedules, \`get_scheduled_results\` to read outputs.`,
      }],
    };
  } catch (error) {
    return { content: [{ type: 'text', text: `❌ Failed to schedule: ${error.message}` }], isError: true };
  }
}

/**
 * @param {object} args
 * @returns {object}
 */
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

/**
 * @param {object} args
 * @returns {object}
 */
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

/**
 * @param {object} args
 * @returns {object}
 */
function handleGetScheduledResults(args) {
  const cwd = args.cwd ?? defaultCwd;
  const results = getScheduledResults(cwd, args.schedule_id);

  if (results.length === 0) {
    return { content: [{ type: 'text', text: 'No scheduled results yet.' }] };
  }

  const lines = results.map((r) => {
    let error = diagnosticLine(r.error);
    return `### ${r.scheduleId} — ${r.executedAt}\n- Exit: ${r.exitCode}\n- Events: ${r.totalEvents}${error ? `\n- Error: ${error}` : ''}\n\n\`\`\`\n${(r.response || '').substring(0, 500)}\n\`\`\``;
  });

  return {
    content: [{
      type: 'text',
      text: `## Scheduled Results (${results.length})\n\n${lines.join('\n\n')}`,
    }],
  };
}

// ─── Pipeline Handlers ─────────────────────────────────────────────

/**
 * @param {object} args
 * @returns {object}
 */
function handleCreatePipeline(args) {
  const cwd = args.cwd ?? defaultCwd;
  let steps = args.steps.map(step => {
    let provider = step.provider || DEFAULT_PROVIDER;
    return {
      ...step,
      reasoningEffort: normalizeReasoningEffort(step.reasoningEffort ?? step.reasoning_effort, provider),
      serviceTier: normalizeServiceTier(step.serviceTier ?? step.service_tier, provider),
    };
  });
  const result = createPipeline(cwd, { ...args, steps });
  return {
    content: [{
      type: 'text',
      text: `✅ Pipeline created.\n\n- **Pipeline ID**: \`${result.pipelineId}\`\n- **Steps**: ${args.steps.length}`
    }],
  };
}

/**
 * @param {object} args
 * @returns {object}
 */
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

/**
 * @param {object} args
 * @returns {object}
 */
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

/**
 * @param {object} args
 * @returns {object}
 */
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
    let details = [];
    if (s.exitCode !== undefined && s.exitCode !== null) details.push(`exit ${s.exitCode}`);
    let error = diagnosticLine(s.error);
    if (error) details.push(error);
    return `- ${emoji} **${name}**: ${s.status}${details.length ? ` — ${details.join(' — ')}` : ''}`;
  });

  return {
    content: [{
      type: 'text',
      text: `## Pipeline Status: \`${args.run_id}\`\n**Status**: ${run.status}\n\n${lines.join('\n')}`
    }],
  };
}

/**
 * @param {object} args
 * @returns {object}
 */
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

/**
 * @param {object} args
 * @returns {object}
 */
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

/**
 * @param {object} args
 * @returns {object}
 */
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

/**
 * @param {object} args
 * @returns {object}
 */
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

// ─── Group Helpers ──────────────────────────────────────────────

/**
 * @param {string} cwd
 * @param {{ excludeName?: string, requestedCount?: number }} [options]
 * @returns {string}
 */
function buildAvailableGroupsSummary(cwd, options = {}) {
  let requestedCount = Math.max(1, Number(options.requestedCount) || 1);
  let groups = [];
  try {
    groups = listGroups(cwd);
  } catch {
    return '';
  }
  if (options.excludeName) {
    groups = groups.filter(g => g.name !== options.excludeName);
  }
  if (groups.length === 0) {
    return options.excludeName
      ? '\n\nNo other resource groups are available in this workspace.'
      : '\n\nNo resource groups are defined in this workspace. Use `create_group` to create one.';
  }

  let availableGroups = groups.filter((group) => groupHasCapacity(group, requestedCount));
  if (availableGroups.length === 0) {
    return options.excludeName
      ? '\n\nNo other resource groups currently have capacity in this workspace.'
      : '\n\nNo resource groups currently have capacity in this workspace.';
  }

  let lines = availableGroups.map((group) => {
    let details = formatGroupFallbackDetails(group);
    return details ? `  - \`${group.name}\` (${details})` : `  - \`${group.name}\``;
  });
  return `\n\nAvailable resource groups (${availableGroups.length}):\n${lines.join('\n')}`;
}

/**
 * @param {object} group
 * @param {number} requestedCount
 * @returns {boolean}
 */
function groupHasCapacity(group, requestedCount) {
  if (!group.max_agents) return true;
  return getGroupActiveCount(group.name) + requestedCount <= group.max_agents;
}

/**
 * @param {string} name
 * @returns {number}
 */
function getGroupActiveCount(name) {
  // Single capacity authority: a best-effort lock-free read of the slot ledger
  // (the authoritative gate is `acquire` under the lock in handleDelegate).
  try {
    return getSlotLedger().activeCountSync(name);
  } catch {
    return 0;
  }
}

/**
 * @param {object} group
 * @returns {string}
 */
function formatGroupFallbackDetails(group) {
  let parts = [];
  if (group.provider) parts.push(`provider: ${group.provider}`);
  if (group.model) parts.push(`model: ${group.model}`);
  if (Array.isArray(group.profiles) && group.profiles.length > 0) {
    let profiles = group.profiles
      .map((profile) => formatProfileFallback(profile, group))
      .filter(Boolean);
    if (profiles.length > 0) {
      parts.push(`fallback: ${profiles.join(' -> ')}`);
    }
  }
  if (group.max_agents) {
    parts.push(`capacity: ${getGroupActiveCount(group.name)}/${group.max_agents}`);
  }
  return parts.join(', ');
}

/**
 * @param {object} profile
 * @param {object} group
 * @returns {string}
 */
function formatProfileFallback(profile, group) {
  let provider = profile.provider || group.provider || DEFAULT_PROVIDER;
  let model = profile.model || group.model || 'default';
  return `${provider}/${model}`;
}

// ─── Group Handlers ─────────────────────────────────────────────

/**
 * @param {object} args
 * @returns {object}
 */
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
    approval_mode: args.approval_mode,
    max_agents: args.max_agents,
    timeout: args.timeout,
    include_dirs: args.include_dirs,
    allowed_tools: args.allowed_tools || args.allowedTools,
    rotation_mode: args.rotation_mode,
    model_tier: args.model_tier,
    opencode_catalog_override: args.opencode_catalog_override,
  });

  const configParts = [];
  if (args.provider) configParts.push(`provider: ${args.provider}`);
  if (args.model) configParts.push(`model: ${args.model}`);
  if (args.profiles?.length) configParts.push(`profiles: ${args.profiles.length}`);
  if (args.runner) configParts.push(`runner: ${args.runner}`);
  if (args.skill) configParts.push(`skill: ${args.skill}`);
  if (args.policy) configParts.push(`policy: ${args.policy}`);
  if (args.approval_mode) configParts.push(`approval: ${args.approval_mode}`);
  if (args.max_agents) configParts.push(`max: ${args.max_agents}`);
  if (args.timeout) configParts.push(`timeout: ${args.timeout}s`);
  if (args.opencode_catalog_override === true) configParts.push('OpenCode catalog override: enabled');

  return {
    content: [{
      type: 'text',
      text: `✅ Group ${result.created ? 'created' : 'updated'}: \`${args.name}\`${configParts.length > 0 ? `\n- ${configParts.join('\n- ')}` : ''}\n\nUse \`delegate_to_group\` to send tasks to this group.`,
    }],
  };
}

/**
 * @param {object} args
 * @returns {object}
 */
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
    if (g.approval_mode) parts.push(`approval: ${g.approval_mode}`);
    if (g.max_agents) parts.push(`max: ${g.max_agents}`);
    if (g.timeout) parts.push(`timeout: ${g.timeout}s`);
    return `- **${g.name}** — ${parts.join(', ') || 'no config'}`;
  });

  return {
    content: [{ type: 'text', text: `## Agent Groups (${groups.length})\n\n${lines.join('\n')}` }],
  };
}

/**
 * @param {object} args
 * @returns {object}
 */
function handleDeleteGroup(args) {
  const cwd = args.cwd ?? defaultCwd;
  if (!args.name) {
    return {
      content: [{ type: 'text', text: '❌ Missing required `name` argument for delete_group.' }],
      isError: true,
    };
  }
  const deleted = deleteGroup(cwd, args.name);
  if (!deleted) {
    return {
      content: [{ type: 'text', text: `❌ Group \`${args.name}\` not found. Use \`list_groups\` to see available groups.` }],
      isError: true,
    };
  }
  return {
    content: [{ type: 'text', text: `🗑️ Group deleted: \`${args.name}\`` }],
  };
}

/**
 * @param {object} args
 * @returns {object}
 */
async function handleDelegateToGroup(args) {
  const cwd = args.cwd ?? defaultCwd;
  const group = getGroup(cwd, args.group);

  if (!group) {
    let summary = buildAvailableGroupsSummary(cwd, { requestedCount: args.count ?? 1 });
    let text = `❌ Group \`${args.group}\` not found.${summary}`;
    return {
      content: [{ type: 'text', text }],
      isError: true,
    };
  }

  const count = args.count ?? 1;

  // Check max_agents limit
  if (group.max_agents && count > group.max_agents) {
    let summary = buildAvailableGroupsSummary(cwd, {
      excludeName: args.group,
      requestedCount: count,
    });
    let text = [
      `❌ Requested ${count} agents but group \`${args.group}\` allows max`,
      `${group.max_agents}.${summary}`,
    ].join(' ');
    return {
      content: [{
        type: 'text',
        text,
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
      reasoningEffort: args.reasoningEffort ?? args.reasoning_effort ?? profile.profile?.reasoningEffort ?? profile.profile?.reasoning_effort,
      serviceTier: args.serviceTier ?? args.service_tier ?? profile.profile?.serviceTier ?? profile.profile?.service_tier,
      approval_mode: args.approval_mode || group.approval_mode || undefined,
      agent_slug: args.agent_slug,
      system_prompt: args.system_prompt,
      context_mode: args.context_mode,
      files: args.files,
      chat_id: args.chat_id,
      parent_chat_id: args.parent_chat_id,
      session_id: args.session_id,
      on_wait_hint: args.on_wait_hint,
      runner: group.runner || undefined,
      skill: group.skill || undefined,
      policy: group.policy || undefined,
      include_dirs: args.include_dirs || group.include_dirs || undefined,
      allowed_tools: args.allowed_tools || args.allowedTools || group.allowed_tools || group.allowedTools || undefined,
      timeout: args.timeout ?? group.timeout ?? undefined,
      groupConfig: { name: args.group, ...group },
      resource_group: args.group,
    };

    const result = await handleDelegate(delegateArgs, {
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
