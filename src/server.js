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

import { TOOL_DEFINITIONS } from './tool-definitions.js';

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const defaultCwd = process.cwd();

/**
 * Create and configure the MCP server.
 *
 * @returns {Server}
 */
export function createServer() {
  const server = new Server(
    { name: 'agent-pool', version: '1.0.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOL_DEFINITIONS,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

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
