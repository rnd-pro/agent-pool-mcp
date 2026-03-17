/**
 * MCP tool definitions — schema for all available tools.
 * Separated from server.js for clarity.
 *
 * @module agent-pool/tool-definitions
 */

export const TOOL_DEFINITIONS = [
  {
    name: 'delegate_task',
    description: [
      'Delegate a coding task to a Gemini CLI agent running in headless mode.',
      'The agent is sandboxed to `cwd` directory only. Use `include_dirs` to grant access to additional directories.',
      'Use this for parallel work: code review, testing, refactoring, analysis, or any dev task.',
      '',
      'Returns a task_id immediately (non-blocking). Use get_task_result to check status and retrieve the result.',
      '',
      'IMPORTANT: Gemini CLI cold start takes ~15-20s before the agent begins working. Set timeout to at least 60s for simple tasks, 300s+ for complex analysis.',
      'WORKSPACE: The agent can only use file tools within `cwd` and `include_dirs`. For other paths it can use shell commands (cat, find, ls).',
    ].join('\n'),
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'The task description for the Gemini agent. Be specific and detailed.' },
        cwd: { type: 'string', description: 'Working directory for the agent. Defaults to current working directory.' },
        model: { type: 'string', description: 'Model to use. Options: gemini-3.1-pro-preview, gemini-3-flash-preview. Leave empty for Auto mode.' },
        approval_mode: {
          type: 'string',
          enum: ['yolo', 'auto_edit', 'plan'],
          description: 'Approval mode: yolo (auto-approve all), auto_edit (auto-approve edits only), plan (read-only). Default: yolo.',
        },
        timeout: { type: 'number', description: 'Timeout in seconds. Default: 600 (10 minutes).' },
        session_id: { type: 'string', description: 'Resume an existing Gemini CLI session by its UUID. Use list_sessions to see available sessions.' },
        skill: { type: 'string', description: 'Activate a Gemini CLI skill by name before executing the task. Use list_skills to see available skills.' },
        runner: { type: 'string', description: 'Runner ID from agent-pool.config.json. Default: "local". Use SSH runners for remote execution.' },
        policy: { type: 'string', description: 'Policy file for tool restrictions. Use built-in template name (e.g. "read-only", "safe-edit") or absolute path to .yaml policy file.' },
        on_wait_hint: { type: 'string', description: 'Custom coaching message shown when polling for results. Guides the calling agent on what to do while waiting.' },
        include_dirs: { type: 'array', items: { type: 'string' }, description: 'Additional directories to include in the agent workspace scope. By default the agent only has access to cwd. Use this to grant access to other project dirs, config dirs, etc.' },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'delegate_task_readonly',
    description: [
      'Delegate a read-only analysis task to Gemini CLI agent.',
      'The agent is sandboxed to `cwd` directory only. Use `include_dirs` to grant access to additional directories.',
      'It is semantically identical to delegate_task but signals that the task is primarily for analysis.',
      'Use this for code review, architecture analysis, finding bugs, writing reports, etc.',
      '',
      'Returns a task_id immediately (non-blocking). Use get_task_result to check status and retrieve the result.',
      '',
      'IMPORTANT: Gemini CLI cold start takes ~15-20s before the agent begins working. Set timeout to at least 60s for simple tasks, 300s+ for complex analysis.',
      'WORKSPACE: The agent can only use file tools within `cwd` and `include_dirs`. For other paths it can use shell commands (cat, find, ls).',
    ].join('\n'),
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'The analysis task for the Gemini agent.' },
        cwd: { type: 'string', description: 'Working directory. Defaults to current working directory.' },
        model: { type: 'string', description: 'Model to use. Leave empty for Auto.' },
        timeout: { type: 'number', description: 'Timeout in seconds. Default: 600 (10 minutes).' },
        session_id: { type: 'string', description: 'Resume an existing Gemini CLI session by its UUID. Use list_sessions to see available sessions.' },
        runner: { type: 'string', description: 'Runner ID from agent-pool.config.json. Default: "local". Use SSH runners for remote execution.' },
        on_wait_hint: { type: 'string', description: 'Custom coaching message shown when polling for results.' },
        include_dirs: { type: 'array', items: { type: 'string' }, description: 'Additional directories to include in the agent workspace scope. By default the agent only has access to cwd.' },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'consult_peer',
    description: [
      'Consult a Gemini peer agent for architectural/technical consensus.',
      'Use during PLANNING phase to validate proposals before implementation.',
      'Supports iterative rounds: send proposal, get feedback, revise, resend until AGREE.',
      'The peer responds with a structured verdict: AGREE, SUGGEST_CHANGES, or DISAGREE.',
      '',
      'Returns a task_id immediately (non-blocking). Use get_task_result to check the verdict.',
      'The peer runs without a timeout — it will work until done. Progress is visible via get_task_result.',
    ].join('\n'),
    inputSchema: {
      type: 'object',
      properties: {
        context: { type: 'string', description: 'Project context: what are we working on, constraints, requirements.' },
        proposal: { type: 'string', description: 'Your technical proposal or architectural decision to review.' },
        previous_rounds: { type: 'string', description: 'Summary of previous discussion rounds (if iterating toward consensus).' },
        cwd: { type: 'string', description: 'Working directory for file access. Defaults to current working directory.' },
        model: { type: 'string', description: 'Model to use. Default: Auto.' },
      },
      required: ['context', 'proposal'],
    },
  },
  {
    name: 'get_task_result',
    description: 'Check the status and result of a background task started with delegate_task, delegate_task_readonly, or consult_peer. Returns status: running, done, or error.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'Task ID returned by delegate_task, delegate_task_readonly, or consult_peer.' },
      },
      required: ['task_id'],
    },
  },
  {
    name: 'cancel_task',
    description: 'Cancel a running task and kill its process. Use when a task is stuck or no longer needed.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'Task ID to cancel.' },
      },
      required: ['task_id'],
    },
  },
  {
    name: 'list_sessions',
    description: 'List available Gemini CLI sessions for a project directory. Returns session IDs, previews, and age. Use session_id with delegate_task to resume.',
    inputSchema: {
      type: 'object',
      properties: {
        cwd: { type: 'string', description: 'Project directory to list sessions for. Defaults to current working directory.' },
      },
    },
  },
  {
    name: 'list_skills',
    description: 'List available Gemini CLI skills from all tiers: project (.gemini/skills/), user-global (~/.gemini/skills/), and built-in (shipped with agent-pool). Shows tier label for each skill.',
    inputSchema: {
      type: 'object',
      properties: {
        cwd: { type: 'string', description: 'Project directory. Defaults to current working directory.' },
      },
    },
  },
  {
    name: 'create_skill',
    description: 'Create or update a Gemini CLI skill. Writes a .md file with YAML frontmatter. Use scope to control where: "project" (default) or "global" (~/.gemini/skills/).',
    inputSchema: {
      type: 'object',
      properties: {
        skill_name: { type: 'string', description: 'Skill name (used as filename, e.g. "code-reviewer").' },
        description: { type: 'string', description: 'Short description of what the skill does.' },
        instructions: { type: 'string', description: 'Full markdown instructions for the skill. Define the agent role, rules, and output format.' },
        scope: { type: 'string', enum: ['project', 'global'], description: 'Where to save: "project" (default, .gemini/skills/) or "global" (~/.gemini/skills/).' },
        cwd: { type: 'string', description: 'Project directory. Defaults to current working directory.' },
      },
      required: ['skill_name', 'description', 'instructions'],
    },
  },
  {
    name: 'delete_skill',
    description: 'Delete a Gemini CLI skill by name. Specify scope to target project or global tier.',
    inputSchema: {
      type: 'object',
      properties: {
        skill_name: { type: 'string', description: 'Skill name to delete.' },
        scope: { type: 'string', enum: ['project', 'global'], description: 'Tier to delete from: "project" (default) or "global".' },
        cwd: { type: 'string', description: 'Project directory. Defaults to current working directory.' },
      },
      required: ['skill_name'],
    },
  },
  {
    name: 'install_skill',
    description: 'Install a global or built-in skill into the current project. Copies the skill file for local customization. Use list_skills to see available skills from all tiers.',
    inputSchema: {
      type: 'object',
      properties: {
        skill_name: { type: 'string', description: 'Skill name to install (e.g. "code-reviewer").' },
        cwd: { type: 'string', description: 'Project directory. Defaults to current working directory.' },
      },
      required: ['skill_name'],
    },
  },
  // ─── Scheduler Tools ────────────────────────────────────
  {
    name: 'schedule_task',
    description: [
      'Schedule a Gemini CLI agent to run on a cron schedule or as a delayed one-shot.',
      'Spawns a persistent daemon that survives IDE/CLI restarts.',
      'Results are saved to .agent/scheduled-results/ and can be retrieved with get_scheduled_results.',
      '',
      'Cron format: standard 5-field (minute hour day month weekday).',
      'Examples: "*/30 * * * *" (every 30 min), "0 9 * * MON-FRI" (9am weekdays), "0 */2 * * *" (every 2 hours).',
    ].join('\n'),
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Task prompt for the Gemini agent.' },
        cron: { type: 'string', description: 'Cron expression (5-field). E.g. "0 9 * * *" for daily at 9am.' },
        cwd: { type: 'string', description: 'Working directory for the scheduled task. Defaults to current directory.' },
        skill: { type: 'string', description: 'Skill to activate for each run.' },
        approval_mode: {
          type: 'string',
          enum: ['yolo', 'auto_edit', 'plan'],
          description: 'Approval mode for scheduled runs. Default: yolo.',
        },
        catchup: { type: 'boolean', description: 'If true, run missed schedules on daemon restart. Default: false (skip missed).' },
      },
      required: ['prompt', 'cron'],
    },
  },
  {
    name: 'list_schedules',
    description: 'List all scheduled tasks with their cron expressions, next run times, and daemon status.',
    inputSchema: {
      type: 'object',
      properties: {
        cwd: { type: 'string', description: 'Project directory. Defaults to current working directory.' },
      },
    },
  },
  {
    name: 'cancel_schedule',
    description: 'Cancel a scheduled task by ID. Removes it from the schedule. The daemon will auto-exit when no schedules remain.',
    inputSchema: {
      type: 'object',
      properties: {
        schedule_id: { type: 'string', description: 'Schedule ID to cancel.' },
        cwd: { type: 'string', description: 'Project directory. Defaults to current working directory.' },
      },
      required: ['schedule_id'],
    },
  },
  {
    name: 'get_scheduled_results',
    description: 'Get results from scheduled task executions. Returns the last 20 results, newest first.',
    inputSchema: {
      type: 'object',
      properties: {
        schedule_id: { type: 'string', description: 'Filter results by schedule ID. Omit to get all.' },
        cwd: { type: 'string', description: 'Project directory. Defaults to current working directory.' },
      },
    },
  },
];

