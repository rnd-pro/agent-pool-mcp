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
import { homedir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { runGeminiStreaming, runGeminiHeadless, listGeminiSessions, DEFAULT_TIMEOUT_SEC, DEFAULT_APPROVAL_MODE } from './runner/gemini-runner.js';
import { createTask, completeTask, failTask, formatTaskResult } from './tools/results.js';
import { listSkills, createSkill, deleteSkill } from './tools/skills.js';
import { consultPeer } from './tools/consult.js';

import { TOOL_DEFINITIONS } from './tool-definitions.js';

const defaultCwd = path.join(homedir(), 'Documents/GitHub/Mr-Computer');

/**
 * Create and configure the MCP server.
 *
 * @returns {Server}
 */
export function createServer() {
  const server = new Server(
    { name: 'agent-pool', version: '3.0.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOL_DEFINITIONS,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
      switch (name) {
        case 'delegate_task':
          return handleDelegateTask(args);
        case 'delegate_task_readonly':
          return handleDelegateReadonly(args);
        case 'get_task_result':
          return formatTaskResult(args.task_id);
        case 'consult_peer':
          return consultPeer(args, defaultCwd);
        case 'list_sessions':
          return handleListSessions(args);
        case 'list_skills':
          return handleListSkills(args);
        case 'create_skill':
          return handleCreateSkill(args);
        case 'delete_skill':
          return handleDeleteSkill(args);
        default:
          return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
      }
    } catch (error) {
      return { content: [{ type: 'text', text: `Gemini CLI Error: ${error.message}` }], isError: true };
    }
  });

  return server;
}

// ─── Tool Handlers ──────────────────────────────────────────────────

/**
 * @param {object} args
 * @returns {{content: Array<{type: string, text: string}>}}
 */
function handleDelegateTask(args) {
  const taskId = randomUUID();
  let prompt = args.prompt;

  if (args.skill) {
    prompt = `CRITICAL INSTRUCTION: You MUST start your execution by immediately calling the activate_skill tool with the name '${args.skill}'. After activation, proceed with the following task:\n\n${prompt}`;
  }

  const taskOpts = {
    prompt,
    cwd: args.cwd ?? defaultCwd,
    model: args.model,
    approvalMode: args.approval_mode ?? DEFAULT_APPROVAL_MODE,
    timeout: args.timeout ?? DEFAULT_TIMEOUT_SEC,
    sessionId: args.session_id,
    taskId,
  };

  createTask(taskId, args.prompt);

  runGeminiStreaming(taskOpts)
    .then((result) => completeTask(taskId, result))
    .catch((err) => failTask(taskId, err.message));

  return {
    content: [{
      type: 'text',
      text: `🚀 Task delegated.\n\n- **Task ID**: \`${taskId}\`\n- **Mode**: ${args.approval_mode ?? DEFAULT_APPROVAL_MODE}\n- **Prompt**: ${args.prompt.substring(0, 100)}...\n\nUse \`get_task_result\` with this task_id to check status.`,
    }],
  };
}

/**
 * @param {object} args
 * @returns {{content: Array<{type: string, text: string}>}}
 */
function handleDelegateReadonly(args) {
  const taskId = randomUUID();

  const taskOpts = {
    prompt: args.prompt,
    cwd: args.cwd ?? defaultCwd,
    model: args.model,
    approvalMode: 'plan',
    timeout: args.timeout ?? DEFAULT_TIMEOUT_SEC,
    taskId,
  };

  createTask(taskId, args.prompt);

  runGeminiStreaming(taskOpts)
    .then((result) => completeTask(taskId, result))
    .catch((err) => failTask(taskId, err.message));

  return {
    content: [{
      type: 'text',
      text: `🔍 Read-only analysis started.\n\n- **Task ID**: \`${taskId}\`\n- **Prompt**: ${args.prompt.substring(0, 100)}...\n\nUse \`get_task_result\` with this task_id to check status.`,
    }],
  };
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
    (s) => `- **${s.name}** — ${s.description} (\`${s.fileName}\`)`,
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
