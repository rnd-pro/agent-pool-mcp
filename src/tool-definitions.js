/**
 * MCP tool definitions — schema for all available tools.
 * Separated from server.js for clarity.
 *
 * @module agent-pool/tool-definitions
 */
/**
 * Build model description string for tool schema.
 * @param {string[]} models
 * @returns {string}
 */
function modelDescription(models) {
  if (!models || models.length === 0) {
    return 'Model to use in provider/model format (e.g. openrouter/deepseek/deepseek-v3.2). Leave empty for default.';
  }
  let sample = models.slice(0, 10).join(', ');
  let suffix = models.length > 10 ? ` ... and ${models.length - 10} more` : '';
  return `Model to use. Available: ${sample}${suffix}. Leave empty for default.`;
}

const DELEGATE_CONTEXT_PROPERTIES = {
  context_mode: {
    type: 'string',
    enum: ['auto', 'off'],
    description: 'Context package mode for delegated agents. auto injects the metadata-first resolved context package. off disables injection. Default: auto.',
  },
  files: {
    type: 'array',
    items: { type: 'string' },
    description: 'Known relevant file paths used as structured focus hints for context resolution. May include paths attached in the UI.',
  },
};

const CODEX_REASONING_EFFORT_PROPERTY = {
  reasoningEffort: {
    type: 'string',
    enum: ['default', 'low', 'medium', 'high', 'xhigh'],
    description: 'Codex CLI reasoning effort. Applies only to provider: codex and maps to model_reasoning_effort.',
  },
};

const CONTEXT_FILE_HINT_PROPERTY = {
  files: {
    type: 'array',
    items: { type: 'string' },
    description: 'Known relevant file paths used to activate workspace context when loading this item.',
  },
};

/**
 * Generate tool definitions with dynamic model context.
 * @param {object} [ctx]
 * @returns {Array}
 */
export function getToolDefinitions(ctx = {}) {
  let ocModels = ctx.openCodeModels || [];
  let modelDesc = modelDescription(ocModels);

  return [
  {
    name: 'get_usage_guide',
    description: [
      'Get the comprehensive usage guide for agent-pool with examples and best practices.',
      'Call this FIRST when planning how to use agent-pool tools for parallel work, pipelines, or scheduling.',
      'Returns practical examples for each feature area.',
      '',
      'Available topics: delegation, pipelines, scheduling, skills, peer-review, sessions.',
      'Omit topic to get the full guide.',
    ].join('\n'),
    inputSchema: {
      type: 'object',
      properties: {
        topic: {
          type: 'string',
          description: 'Optional topic filter: delegation, pipelines, scheduling, skills, peer-review, sessions',
        },
      },
    },
  },
  {
    name: 'delegate_task',
    description: [
      'Delegate a coding task to a CLI agent running in headless mode.',
      'The agent is sandboxed to `cwd` directory only. Use `include_dirs` to grant access to additional directories.',
      'Use this for parallel work: code review, testing, refactoring, analysis, or any dev task.',
      '',
      'Returns a task_id immediately (non-blocking). Use get_task_result to check status and retrieve the result.',
      '',
      'IMPORTANT: CLI providers can take ~15-20s before the agent begins working. Set timeout to at least 60s for simple tasks, 300s+ for complex analysis.',
      'WORKSPACE: The agent can only use file tools within `cwd` and `include_dirs`. For other paths it can use shell commands (cat, find, ls).',
    ].join('\n'),
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'The task description for the CLI agent. Be specific and detailed.' },
        provider: { type: 'string', enum: ['codex', 'gemini', 'opencode', 'claude'], description: 'CLI provider to use. codex = Codex CLI, gemini = Gemini CLI, opencode = OpenCode CLI, claude = Claude Code CLI. Default: codex.' },
        cwd: { type: 'string', description: 'Working directory for the agent. Defaults to current working directory.' },
        model: { type: 'string', description: modelDesc },
        ...CODEX_REASONING_EFFORT_PROPERTY,
        approval_mode: {
          type: 'string',
          enum: ['yolo', 'auto_edit', 'plan'],
          description: 'Approval mode: yolo (auto-approve all), auto_edit (auto-approve edits only), plan (read-only). Default: yolo.',
        },
        timeout: { type: 'number', description: 'Timeout in seconds. Default: 600 (10 minutes).' },
        session_id: { type: 'string', description: 'Resume an existing provider session/thread by ID. Supported by Gemini, Codex, OpenCode, and Claude Code where available. Use list_sessions for Gemini sessions.' },
        skill: { type: 'string', description: 'Activate a global or active workspace skill by name before executing the task. Use list_skills to see available skills.' },
        runner: { type: 'string', description: 'Runner ID from agent-pool.config.json. Default: "local". Use SSH runners for remote execution.' },
        policy: { type: 'string', description: 'Policy file for tool restrictions. Use built-in template name (e.g. "read-only", "safe-edit") or absolute path to .yaml policy file.' },
        on_wait_hint: { type: 'string', description: 'Custom coaching message shown when polling for results. Guides the calling agent on what to do while waiting.' },
        include_dirs: { type: 'array', items: { type: 'string' }, description: 'Additional directories to include in the agent workspace scope. By default the agent only has access to cwd. Use this to grant access to other project dirs, config dirs, etc.' },
        agent_slug: { type: 'string', description: 'Agent identity slug (e.g. "backend-engineer"). Auto-resolves prompt from .agent-portal/agents/{slug}.md with composed skills. Takes priority over legacy "skill" parameter.' },
        resource_group: { type: 'string', description: 'Resource group from local portal configuration. Overrides the agent frontmatter resource_group.' },
        system_prompt: { type: 'string', description: 'Pre-resolved system prompt to prepend to the task. Overrides agent_slug resolution. Used by portal for portal-level agent injection.' },
        ...DELEGATE_CONTEXT_PROPERTIES,
        parent_chat_id: { type: 'string', description: 'The parent chat or task ID that initiated this delegation. Used for hierarchy. Optional.' },
        chat_id: { type: 'string', description: 'Chat ID to bind this task to in the UI. Optional.' },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'delegate_task_readonly',
    description: [
      'Delegate a read-only analysis task to a CLI agent.',
      'The agent is sandboxed to `cwd` directory only. Use `include_dirs` to grant access to additional directories.',
      'It is semantically identical to delegate_task but signals that the task is primarily for analysis.',
      'Use this for code review, architecture analysis, finding bugs, writing reports, etc.',
      '',
      'Returns a task_id immediately (non-blocking). Use get_task_result to check status and retrieve the result.',
      '',
      'IMPORTANT: CLI providers can take ~15-20s before the agent begins working. Set timeout to at least 60s for simple tasks, 300s+ for complex analysis.',
      'WORKSPACE: The agent can only use file tools within `cwd` and `include_dirs`. For other paths it can use shell commands (cat, find, ls).',
    ].join('\n'),
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'The analysis task for the CLI agent.' },
        cwd: { type: 'string', description: 'Working directory. Defaults to current working directory.' },
        provider: { type: 'string', enum: ['codex', 'gemini', 'opencode', 'claude'], description: 'CLI provider to use. codex = Codex CLI, gemini = Gemini CLI, opencode = OpenCode CLI, claude = Claude Code CLI. Default: codex.' },
        model: { type: 'string', description: modelDesc },
        ...CODEX_REASONING_EFFORT_PROPERTY,
        timeout: { type: 'number', description: 'Timeout in seconds. Default: 600 (10 minutes).' },
        session_id: { type: 'string', description: 'Resume an existing provider session/thread by ID. Supported by Gemini, Codex, OpenCode, and Claude Code where available. Use list_sessions for Gemini sessions.' },
        runner: { type: 'string', description: 'Runner ID from agent-pool.config.json. Default: "local". Use SSH runners for remote execution.' },
        on_wait_hint: { type: 'string', description: 'Custom coaching message shown when polling for results.' },
        include_dirs: { type: 'array', items: { type: 'string' }, description: 'Additional directories to include in the agent workspace scope. By default the agent only has access to cwd.' },
        agent_slug: { type: 'string', description: 'Agent identity slug (e.g. "code-reviewer"). Auto-resolves prompt from .agent-portal/agents/{slug}.md.' },
        resource_group: { type: 'string', description: 'Resource group from local portal configuration. Overrides the agent frontmatter resource_group.' },
        system_prompt: { type: 'string', description: 'Pre-resolved system prompt to prepend to the task. Overrides agent_slug resolution.' },
        ...DELEGATE_CONTEXT_PROPERTIES,
        parent_chat_id: { type: 'string', description: 'The parent chat or task ID that initiated this delegation. Used for hierarchy. Optional.' },
        chat_id: { type: 'string', description: 'The chat ID created for this task via create_chat. Optional.' },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'consult_peer',
    description: [
      'Legacy Gemini-only peer consultation for architectural/technical consensus.',
      'For Codex orchestration, prefer delegate_task_readonly with resource_group: "review".',
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
    description: 'Check the status and result of a background task started with delegate_task, delegate_task_readonly, or consult_peer. Completed results remain available until TTL cleanup, so multiple callers can retrieve the full report.',
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
    name: 'finish_task',
    description: 'Close a task lifecycle and clean up tracked child processes. Running tasks are cancelled by default; completed tasks keep their result unless remove_from_memory is true.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'Task ID to finish and clean up.' },
        kill_process: { type: 'boolean', description: 'Kill tracked child processes for this task. Defaults to true.' },
        recursive: { type: 'boolean', description: 'Also finish child tasks whose parentId matches this task. Defaults to true.' },
        remove_from_memory: { type: 'boolean', description: 'Delete task entries from in-memory result store after cleanup. Defaults to false so reports remain readable.' },
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
    name: 'list_tasks',
    description: 'List all background tasks currently running or recently completed in the agent pool memory.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'resolve_context',
    description: 'Return a compact dynamic context plan for a task. Classifies zones, recommends tool profile, and returns matching skill/workflow indexes without loading full markdown.',
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'Task or prompt to classify.' },
        prompt: { type: 'string', description: 'Alias for task.' },
        agent_slug: { type: 'string', description: 'Optional agent role slug whose metadata should influence context selection.' },
        files: { type: 'array', items: { type: 'string' }, description: 'Known relevant file paths for higher-confidence zone matching.' },
        cwd: { type: 'string', description: 'Project directory. Defaults to current working directory.' },
        mode: { type: 'string', enum: ['plan', 'items', 'both'], description: 'Return shape. plan = compact plan, items = atomic load list, both = plan plus items. Default: plan.' },
        max_skills: { type: 'number', description: 'Maximum skill index entries to return. Default: 8.' },
        max_workflows: { type: 'number', description: 'Maximum workflow index entries to return. Default: 8.' },
      },
    },
  },
  {
    name: 'list_skills',
    description: 'List global CLI skills plus skills from the active .agent-portal/workspace/<project>/skills directory.',
    inputSchema: {
      type: 'object',
      properties: {
        cwd: { type: 'string', description: 'Project directory. Defaults to current working directory.' },
        ...CONTEXT_FILE_HINT_PROPERTY,
        json: { type: 'boolean', description: 'Return pure JSON string instead of Markdown format.' },
      },
    },
  },
  {
    name: 'get_skill_content',
    description: 'Return one global or active workspace skill with metadata and markdown content. Use after resolve_context returns a skill item that needs atomic loading.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Skill name returned by list_skills or resolve_context items.' },
        skill_name: { type: 'string', description: 'Alias for name.' },
        cwd: { type: 'string', description: 'Project directory. Defaults to current working directory.' },
        ...CONTEXT_FILE_HINT_PROPERTY,
      },
    },
  },
  {
    name: 'create_skill',
    description: 'Create or update an active workspace CLI skill under .agent-portal/workspace/<project>/skills/.',
    inputSchema: {
      type: 'object',
      properties: {
        skill_name: { type: 'string', description: 'Skill name (used as filename, e.g. "code-reviewer").' },
        description: { type: 'string', description: 'Short description of what the skill does.' },
        instructions: { type: 'string', description: 'Full markdown instructions for the skill. Define the agent role, rules, and output format.' },
        scope: { type: 'string', enum: ['project'], description: 'Only "project" is currently supported; skills are saved under the active workspace.' },
        cwd: { type: 'string', description: 'Project directory. Defaults to current working directory.' },
        json: { type: 'boolean', description: 'Return pure JSON string instead of Markdown format.' },
      },
      required: ['skill_name', 'description', 'instructions'],
    },
  },
  {
    name: 'delete_skill',
    description: 'Delete an active workspace CLI skill by name from .agent-portal/workspace/<project>/skills/.',
    inputSchema: {
      type: 'object',
      properties: {
        skill_name: { type: 'string', description: 'Skill name to delete.' },
        scope: { type: 'string', enum: ['project'], description: 'Only "project" is currently supported.' },
        cwd: { type: 'string', description: 'Project directory. Defaults to current working directory.' },
        json: { type: 'boolean', description: 'Return pure JSON string instead of Markdown format.' },
      },
      required: ['skill_name'],
    },
  },
  {
    name: 'install_skill',
    description: 'Reserved for future external skill installation. Workspace skills are managed in .agent-portal/workspace/<project>/skills/ or through the Agent Portal UI.',
    inputSchema: {
      type: 'object',
      properties: {
        skill_name: { type: 'string', description: 'Skill name to install (e.g. "code-reviewer").' },
        cwd: { type: 'string', description: 'Project directory. Defaults to current working directory.' },
        json: { type: 'boolean', description: 'Return pure JSON string instead of Markdown format.' },
      },
      required: ['skill_name'],
    },
  },
  // ─── Scheduler Tools ────────────────────────────────────
  {
    name: 'schedule_task',
    description: [
      'Schedule a CLI agent to run on a cron schedule or as a delayed one-shot. Default provider: Codex CLI.',
      'Spawns a persistent daemon that survives IDE/CLI restarts.',
      'Results are saved in local portal project state and can be retrieved with get_scheduled_results.',
      '',
      'Cron format: standard 5-field (minute hour day month weekday).',
      'Examples: "*/30 * * * *" (every 30 min), "0 9 * * MON-FRI" (9am weekdays), "0 */2 * * *" (every 2 hours).',
    ].join('\n'),
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Task prompt for the CLI agent.' },
        cron: { type: 'string', description: 'Cron expression (5-field). E.g. "0 9 * * *" for daily at 9am.' },
        provider: { type: 'string', enum: ['codex', 'gemini', 'claude'], description: 'CLI provider for scheduled runs. Default: codex.' },
        model: { type: 'string', description: 'Model to use. Leave empty for provider default.' },
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
        json: { type: 'boolean', description: 'Return pure JSON string instead of Markdown format.' },
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
        json: { type: 'boolean', description: 'Return pure JSON string instead of Markdown format.' },
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
        json: { type: 'boolean', description: 'Return pure JSON string instead of Markdown format.' },
      },
    },
  },
  // ─── Pipeline Tools ────────────────────────────────────
  {
    name: 'create_pipeline',
    description: 'Create a pipeline definition with sequential steps.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Pipeline name.' },
        steps: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'Step name.' },
              prompt: { type: 'string', description: 'Step prompt.' },
              provider: { type: 'string', enum: ['codex', 'gemini', 'claude'], description: 'CLI provider for this step. Default: codex.' },
              model: { type: 'string', description: 'Model to use. Leave empty for provider default.' },
              trigger: { type: 'string', description: 'Trigger condition.' },
              skill: { type: 'string', description: 'Skill to use.' },
              approval_mode: { type: 'string', description: 'Approval mode.' },
              timeout: { type: 'number', description: 'Timeout in seconds.' },
              max_bounces: { type: 'number', description: 'Maximum bounces allowed.' },
              expected_output: { type: 'string', description: 'Expected output description.' },
            },
            required: ['name', 'prompt'],
          },
          description: 'Array of pipeline steps.',
        },
        on_error: { type: 'string', enum: ['stop', 'skip'], description: 'What to do on error. Default is stop.' },
        cwd: { type: 'string', description: 'Project directory. Defaults to current working directory.' },
        json: { type: 'boolean', description: 'Return pure JSON string instead of Markdown format.' },
      },
      required: ['name', 'steps'],
    },
  },
  {
    name: 'run_pipeline',
    description: 'Start executing a pipeline.',
    inputSchema: {
      type: 'object',
      properties: {
        pipeline_id: { type: 'string', description: 'Pipeline ID to run.' },
        cwd: { type: 'string', description: 'Project directory. Defaults to current working directory.' },
        json: { type: 'boolean', description: 'Return pure JSON string instead of Markdown format.' },
      },
      required: ['pipeline_id'],
    },
  },
  {
    name: 'list_pipelines',
    description: 'List all pipeline definitions.',
    inputSchema: {
      type: 'object',
      properties: {
        cwd: { type: 'string', description: 'Project directory. Defaults to current working directory.' },
        json: { type: 'boolean', description: 'Return pure JSON string instead of Markdown format.' },
      },
    },
  },
  {
    name: 'get_pipeline_status',
    description: 'Get status of a pipeline run.',
    inputSchema: {
      type: 'object',
      properties: {
        run_id: { type: 'string', description: 'Pipeline run ID.' },
        cwd: { type: 'string', description: 'Project directory. Defaults to current working directory.' },
        json: { type: 'boolean', description: 'Return pure JSON string instead of Markdown format.' },
      },
      required: ['run_id'],
    },
  },
  {
    name: 'cancel_pipeline',
    description: 'Cancel a running pipeline.',
    inputSchema: {
      type: 'object',
      properties: {
        run_id: { type: 'string', description: 'Pipeline run ID to cancel.' },
        cwd: { type: 'string', description: 'Project directory. Defaults to current working directory.' },
        json: { type: 'boolean', description: 'Return pure JSON string instead of Markdown format.' },
      },
      required: ['run_id'],
    },
  },
  {
    name: 'signal_step_complete',
    description: 'Signal that a pipeline step is complete (called BY agents running inside pipeline steps).',
    inputSchema: {
      type: 'object',
      properties: {
        step_name: { type: 'string', description: 'Name of the completed step.' },
        run_id: { type: 'string', description: 'Pipeline run ID for precise targeting. Provided in the task prompt.' },
        output: { type: 'string', description: 'Optional output message or result.' },
        cwd: { type: 'string', description: 'Project directory. Defaults to current working directory.' },
        json: { type: 'boolean', description: 'Return pure JSON string instead of Markdown format.' },
      },
      required: ['step_name'],
    },
  },
  {
    name: 'bounce_back',
    description: 'Return task to a previous pipeline step with feedback about missing/insufficient data.',
    inputSchema: {
      type: 'object',
      properties: {
        step_name: { type: 'string', description: 'Name of the step to return to.' },
        reason: { type: 'string', description: 'Feedback about missing/insufficient data.' },
        run_id: { type: 'string', description: 'Pipeline run ID for precise targeting. Provided in the task prompt.' },
        cwd: { type: 'string', description: 'Project directory. Defaults to current working directory.' },
        json: { type: 'boolean', description: 'Return pure JSON string instead of Markdown format.' },
      },
      required: ['step_name', 'reason'],
    },
  },
  // ─── Group Tools ────────────────────────────────────────
  {
    name: 'create_group',
    description: 'Create a named agent group with shared runtime config. Groups are reusable presets for fractal orchestration.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Group name (e.g. "backend-team", "qa-group").' },
        provider: { type: 'string', enum: ['codex', 'gemini', 'opencode', 'claude'], description: 'Default CLI provider for agents in this group. Default: codex.' },
        model: { type: 'string', description: 'Default model for agents in this group. Use "default" for provider default.' },
        profiles: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              provider: { type: 'string', enum: ['codex', 'gemini', 'opencode', 'claude'] },
              model: { type: 'string' },
              ...CODEX_REASONING_EFFORT_PROPERTY,
            },
          },
          description: 'Ordered provider/model profiles for this resource group. First profile is used by default; round_robin rotates.',
        },
        runner: { type: 'string', description: 'Default runner for agents in this group.' },
        skill: { type: 'string', description: 'Default skill activated for all agents in this group.' },
        policy: { type: 'string', description: 'Default policy restricting agent permissions.' },
        approval_mode: { type: 'string', enum: ['yolo', 'auto_edit', 'plan'], description: 'Default access mode for agents in this group.' },
        max_agents: { type: 'number', description: 'Max concurrent agents allowed in this group.' },
        timeout: { type: 'number', description: 'Default timeout in seconds for tasks in this group.' },
        include_dirs: { type: 'array', items: { type: 'string' }, description: 'Additional directories agents in this group can access.' },
        rotation_mode: { type: 'string', enum: ['error_fallback', 'round_robin'], description: 'Profile rotation strategy. Default: error_fallback.' },
        model_tier: { type: 'string', description: 'Logical tier label for UI/docs, e.g. fast, standard, advanced.' },
        cwd: { type: 'string', description: 'Project directory. Defaults to current working directory.' },
        json: { type: 'boolean', description: 'Return pure JSON string instead of Markdown format.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'list_groups',
    description: 'List all registered agent groups with their config.',
    inputSchema: {
      type: 'object',
      properties: {
        cwd: { type: 'string', description: 'Project directory. Defaults to current working directory.' },
        json: { type: 'boolean', description: 'Return pure JSON string instead of Markdown format.' },
      },
    },
  },
  {
    name: 'delete_group',
    description: 'Delete a named agent resource group.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Group name to delete.' },
        cwd: { type: 'string', description: 'Project directory. Defaults to current working directory.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'delegate_to_group',
    description: [
      'Delegate a task to a named agent group. Spawns agents with the group\'s shared config (runner, skill, policy).',
      'Use `count` to launch multiple agents in parallel (fractal orchestration).',
      '',
      'Returns array of task_ids immediately (non-blocking). Use get_task_result to check each.',
    ].join('\n'),
    inputSchema: {
      type: 'object',
      properties: {
        group: { type: 'string', description: 'Group name to delegate to.' },
        prompt: { type: 'string', description: 'Task description for the agents.' },
        provider: { type: 'string', enum: ['codex', 'gemini', 'opencode', 'claude'], description: 'CLI provider override for this group delegation. Default: group provider or codex.' },
        model: { type: 'string', description: 'Model override for this group delegation. Default: group profile/model.' },
        ...CODEX_REASONING_EFFORT_PROPERTY,
        approval_mode: { type: 'string', enum: ['yolo', 'auto_edit', 'plan'], description: 'Access mode override passed to child tasks.' },
        agent_slug: { type: 'string', description: 'Agent role slug passed to child tasks.' },
        chat_id: { type: 'string', description: 'Existing chat ID to bind child tasks to.' },
        parent_chat_id: { type: 'string', description: 'Parent chat ID used to create/bind child task chats.' },
        session_id: { type: 'string', description: 'Provider session/thread ID passed through for resumed tasks.' },
        include_dirs: { type: 'array', items: { type: 'string' }, description: 'Scope directories override for child tasks. Default: group include_dirs.' },
        ...DELEGATE_CONTEXT_PROPERTIES,
        on_wait_hint: { type: 'string', description: 'Optional wait hint shown while the task runs.' },
        count: { type: 'number', description: 'Number of agents to spawn. Default: 1.' },
        cwd: { type: 'string', description: 'Working directory. Defaults to current working directory.' },
        timeout: { type: 'number', description: 'Timeout in seconds. Overrides group default.' },
      },
      required: ['group', 'prompt'],
    },
  },
  {
    name: 'send_message',
    description: [
      'Send a message to a channel for inter-agent communication.',
      'Use this to pass structured data between pipeline steps or between any agents.',
      '',
      'Channel conventions:',
      '  - {run_id} — broadcast to all steps in a pipeline run',
      '  - {run_id}:{step_name} — targeted to a specific step',
      '  - any string — ad-hoc channel for custom messaging',
      '',
      'Messages are persisted to disk (survives restarts). Uses JSONL format for concurrent-write safety.',
    ].join('\n'),
    inputSchema: {
      type: 'object',
      properties: {
        channel: { type: 'string', description: 'Target channel. Use run_id for broadcast, run_id:step_name for targeted.' },
        payload: { description: 'Message payload (any JSON-serializable value).' },
        from: { type: 'string', description: 'Sender identifier (e.g., step name or task description).' },
        cwd: { type: 'string', description: 'Working directory. Defaults to current working directory.' },
      },
      required: ['channel', 'payload'],
    },
  },
  {
    name: 'get_messages',
    description: [
      'Read messages from a channel. Returns all messages in chronological order.',
      '',
      'Channel conventions:',
      '  - {run_id} — read broadcast messages for a pipeline run',
      '  - {run_id}:{step_name} — read messages targeted to a specific step',
      '',
      'Use clear=true to consume messages (delete after reading).',
    ].join('\n'),
    inputSchema: {
      type: 'object',
      properties: {
        channel: { type: 'string', description: 'Channel to read messages from.' },
        clear: { type: 'boolean', description: 'If true, clear the channel after reading (consume mode). Default: false.' },
        cwd: { type: 'string', description: 'Working directory. Defaults to current working directory.' },
      },
      required: ['channel'],
    },
  },
  {
    name: 'save_script',
    description: 'Save a local automation script to the project database (.agent-portal/scripts/). This is useful for zero-token execution nodes.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Name of the script without extension (e.g. "build-checker").' },
        code: { type: 'string', description: 'The raw script code.' },
        ext: { type: 'string', description: 'File extension. Default: "js".' },
        cwd: { type: 'string', description: 'Working directory. Defaults to current working directory.' },
      },
      required: ['name', 'code'],
    },
  },
  {
    name: 'list_scripts',
    description: 'List all locally saved automation scripts.',
    inputSchema: {
      type: 'object',
      properties: {
        cwd: { type: 'string', description: 'Working directory. Defaults to current working directory.' },
      },
    },
  },
  {
    name: 'track_files',
    description: 'Track active files in local portal project state. Useful to persist file context between pipeline steps.',
    inputSchema: {
      type: 'object',
      properties: {
        files: { type: 'array', items: { type: 'string' }, description: 'Array of file paths to track.' },
        cwd: { type: 'string', description: 'Working directory. Defaults to current working directory.' },
      },
      required: ['files'],
    },
  },
  {
    name: 'untrack_files',
    description: 'Remove files from the active tracking context.',
    inputSchema: {
      type: 'object',
      properties: {
        files: { type: 'array', items: { type: 'string' }, description: 'Array of file paths to untrack. If empty, clears all.' },
        cwd: { type: 'string', description: 'Working directory. Defaults to current working directory.' },
      },
    },
  },
  {
    name: 'get_tracked_files',
    description: 'Return active files tracked in the current project context.',
    inputSchema: {
      type: 'object',
      properties: {
        cwd: { type: 'string', description: 'Working directory. Defaults to current working directory.' },
      },
    },
  },
  {
    name: 'list_workflows',
    description: 'List global workflows plus workflows from the active .agent-portal/workspace/<project>/workflows directory.',
    inputSchema: {
      type: 'object',
      properties: {
        cwd: { type: 'string', description: 'Working directory. Defaults to current working directory.' },
        ...CONTEXT_FILE_HINT_PROPERTY,
      },
    },
  },
  {
    name: 'search_by_tags',
    description: 'Find workflow steps matching all tags. Returns full content for one match and a lightweight list for multiple matches.',
    inputSchema: {
      type: 'object',
      properties: {
        tags: { type: 'array', items: { type: 'string' }, description: 'Tags to match with AND semantics.' },
        cwd: { type: 'string', description: 'Working directory. Defaults to current working directory.' },
        ...CONTEXT_FILE_HINT_PROPERTY,
      },
      required: ['tags'],
    },
  },
  {
    name: 'get_workflow_content',
    description: 'Return markdown content and transition metadata for one workflow step node.',
    inputSchema: {
      type: 'object',
      properties: {
        nodeId: { type: 'string', description: 'Workflow node id, usually a path relative to workflows without .md, optionally prefixed by workspace name.' },
        cwd: { type: 'string', description: 'Working directory. Defaults to current working directory.' },
        ...CONTEXT_FILE_HINT_PROPERTY,
      },
      required: ['nodeId'],
    },
  },
  {
    name: 'get_board_state',
    description: 'Get the current state of the Agent Board (tasks and delegation tree).',
    inputSchema: {
      type: 'object',
      properties: {
        cwd: { type: 'string', description: 'Working directory. Defaults to current working directory.' },
      },
    },
  }
];
}

/** Backward compat: static export using default context */
export const TOOL_DEFINITIONS = getToolDefinitions();
