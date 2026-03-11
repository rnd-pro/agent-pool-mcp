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
import { createTask, completeTask, failTask, formatTaskResult, getActiveTasks, cancelTask } from './tools/results.js';
import { listSkills, createSkill, deleteSkill } from './tools/skills.js';
import { consultPeer } from './tools/consult.js';

import { TOOL_DEFINITIONS } from './tool-definitions.js';

const defaultCwd = process.cwd();

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
          response = await consultPeer(args, defaultCwd); break;
        case 'list_sessions':
          response = await handleListSessions(args); break;
        case 'list_skills':
          response = handleListSkills(args); break;
        case 'create_skill':
          response = handleCreateSkill(args); break;
        case 'delete_skill':
          response = handleDeleteSkill(args); break;
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
  let prompt = args.prompt;

  if (args.skill) {
    prompt = `CRITICAL INSTRUCTION: You MUST start your execution by immediately calling the activate_skill tool with the name '${args.skill}'. After activation, proceed with the following task:\n\n${prompt}`;
  }

  const taskOpts = {
    prompt,
    cwd: args.cwd ?? defaultCwd,
    model: args.model,
    approvalMode: args.approval_mode ?? approvalMode,
    timeout: args.timeout ?? DEFAULT_TIMEOUT_SEC,
    sessionId: args.session_id,
    taskId,
    runner: args.runner,
  };

  createTask(taskId, args.prompt, args.on_wait_hint);

  runGeminiStreaming(taskOpts)
    .then((result) => completeTask(taskId, result))
    .catch((err) => failTask(taskId, err.message));

  const mode = args.approval_mode ?? approvalMode;
  const runnerInfo = args.runner ? `\n- **Runner**: ${args.runner}` : '';

  return {
    content: [{
      type: 'text',
      text: `${emoji} ${label}\n\n- **Task ID**: \`${taskId}\`\n- **Mode**: ${mode}${runnerInfo}\n- **Prompt**: ${args.prompt.substring(0, 100)}...\n\nUse \`get_task_result\` with this task_id to check status.`,
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
    approvalMode: 'plan',
    emoji: '🔍',
    label: 'Read-only analysis started.',
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
