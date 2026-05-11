# Agent Pool MCP Usage Guide
A comprehensive, LLM-optimized guide to using agent-pool tools effectively for parallel work, pipelines, scheduling, and more.

## Delegation
Delegate tasks to Gemini CLI workers. Use `delegate_task` for code changes, `delegate_task_readonly` for analysis. Both return task_id immediately — poll with `get_task_result`.

**Example:**
delegate_task({ prompt: "Add JSDoc to all functions in src/", cwd: "/project", timeout: 300 })
// Returns: { task_id: "abc-123" }
// Check: get_task_result({ task_id: "abc-123" })

## Pipelines
Create multi-step pipelines with `create_pipeline`. Run them with `run_pipeline`. Steps are executed sequentially.

**Example:**
create_pipeline({ name: "Code Review", steps: [{ name: "Review", prompt: "Review code", skill: "code-reviewer" }] })
run_pipeline({ pipeline_id: "pipe-456" })

## Scheduling
Schedule tasks using cron expressions with `schedule_task`. Results are saved and can be checked with `get_scheduled_results`.

**Example:**
schedule_task({ prompt: "Daily backup", cron: "0 0 * * *", cwd: "/project" })
// Check: get_scheduled_results({ schedule_id: "sch-789" })

## Skills
Skills define the agent's role and rules. Use `list_skills` to see available skills. Activate a skill when delegating a task or creating a pipeline.

**Example:**
list_skills({ cwd: "/project" })
// Returns: ["code-reviewer", "test-writer"]
delegate_task({ prompt: "Review PR", skill: "code-reviewer", cwd: "/project" })

## Peer-Review
Consult a peer agent for architectural or technical consensus using `consult_peer`. Supports iterative rounds of feedback.

**Example:**
consult_peer({ context: "Adding Redis cache", proposal: "Use ioredis library", cwd: "/project" })
// Returns: { task_id: "peer-abc" }
// Check: get_task_result({ task_id: "peer-abc" })

## Sessions
Manage Gemini CLI sessions. Use `list_sessions` to find available sessions to resume with `delegate_task` via `session_id`.

**Example:**
list_sessions({ cwd: "/project" })
delegate_task({ prompt: "Continue refactoring", session_id: "sess-xyz", cwd: "/project" })

## Groups
Create named agent groups with shared config. Groups are reusable presets — define runner, skill, and policy once, then delegate to the group by name. Use `count` to spawn multiple agents in parallel (fractal orchestration).

**Example:**
```
create_group({ name: "backend-team", runner: "remote", skill: "node-dev", policy: "safe-edit", max_agents: 3 })
create_group({ name: "qa-team", policy: "read-only", skill: "test-writer" })

// Spawn 2 agents from backend-team
delegate_to_group({ group: "backend-team", prompt: "Refactor auth module", count: 2 })
// Returns: [task_id_1, task_id_2]

// List groups
list_groups()
```

Groups persist to `.agent-portal/groups.json` and survive IDE restarts.

## Messaging
Send structured data between agents or pipeline steps using `send_message` and `get_messages`. Messages are persisted as JSONL files in `.agent-portal/messages/`.

**Channel conventions:**
- `{run_id}` — broadcast to all steps in a pipeline run
- `{run_id}:{step_name}` — targeted to a specific step
- Any string — ad-hoc channel for custom messaging

**Example:**
```
// Step 1 sends analysis results to step 2
send_message({ channel: "abc123:review", payload: { issues: ["missing error handling", "no tests"] }, from: "analyzer" })

// Step 2 reads the results
get_messages({ channel: "abc123:review" })
// Returns: { messages: [...], count: 1 }

// Read and clear (consume mode)
get_messages({ channel: "abc123:review", clear: true })
```

Messages survive restarts. Concurrent writes are safe (JSONL + appendFile).