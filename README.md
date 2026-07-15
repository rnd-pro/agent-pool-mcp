[![npm version](https://img.shields.io/npm/v/agent-pool-mcp)](https://www.npmjs.com/package/agent-pool-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D20-339933?logo=node.js&logoColor=white)](https://nodejs.org)

# agent-pool-mcp

Multi-agent orchestration via CLI providers (Codex, Antigravity, OpenCode, and Claude Code) — parallel task delegation, sequential pipelines, cron scheduling, and cross-model peer review.

Compatible with [Antigravity](https://antigravity.google), Cursor, Windsurf, Claude Code, and any MCP-enabled coding agent.

Your primary IDE agent delegates background tasks to local CLI workers in parallel — each provider uses its own installed CLI authentication.

When the primary agent and Antigravity workers are **different foundation models** (e.g. Claude + Gemini), `consult_peer` gives you cross-model review — two models check each other's reasoning independently.

```
┌─────────────────────────────────┐
│  Primary IDE Agent              │  ← Claude, GPT, Gemini, etc.
│  (Antigravity / Cursor / ...)   │
└────────────┬────────────────────┘
             │ MCP (stdio)
┌────────────▼────────────────────┐
│  agent-pool-mcp                 │  ← This server
│  (task router + process mgmt)  │
└──┬─────────┬─────────┬─────────┘
   │         │         │
   ▼         ▼         ▼
  codex     agy       claude       ← CLI workers
  (task1)   (task2)   (review)       (same auth, parallel)
```

> [!TIP]
> A Google AI Pro or Ultra subscription can power parallel Antigravity workers — no additional API keys required.

### Task Delegation

Non-blocking task delegation to CLI workers. The primary agent fires off a task and continues working — polling for results when ready. Workers get full filesystem access (`delegate_task`) or read-only mode (`delegate_task_readonly`). Cancel anytime with `cancel_task`.

Codex tasks can pass model-specific `reasoningEffort` and `serviceTier` values.
The same canonical fields are supported by resource-group profiles, scheduled
tasks, and pipeline steps and are validated by the installed Codex CLI.

### Pipelines — Sequential Task Chains

Multi-step workflows with automatic handoff between steps:

```javascript
create_pipeline({
  name: "article-workflow",
  steps: [
    { name: "research", prompt: "Research the topic and write notes to research.md" },
    { name: "draft", prompt: "Read research.md and write article draft" },
    { name: "review", prompt: "Review the draft for accuracy and style" }
  ]
})
run_pipeline({ pipeline_id: "article-workflow" })
```

Steps support triggers: `on_complete` (chain after one step), `on_complete_all` (fan-in after several), and `on_file` (start when a file appears). Agents can `bounce_back` to a previous step with feedback if data is incomplete.

### Cron Scheduler

Schedule agents on a cron expression — a detached daemon survives IDE/CLI restarts. Uses atomic file locks to prevent duplicate execution.

```
"0 9 * * MON-FRI"    — 9am weekdays
"*/30 * * * *"       — every 30 minutes
"0 */2 * * *"        — every 2 hours
```

Results are saved to `.agent-portal/scheduled-results/` and retrievable via `get_scheduled_results`.

```javascript
schedule_task({
  prompt: "Review open changes",
  cron: "0 9 * * MON-FRI",
  provider: "codex",
  model: "default",
  reasoningEffort: "high",
  serviceTier: "priority"
})
```

### Team Memory Skill System

Skills are Markdown files with YAML frontmatter that extend agent behavior:

- **Global** — `.agent-portal/skills/` inside the team-memory submodule.
- **Workspace** — `.agent-portal/workspace/<project>/skills/` when the project context activates.
- Skills are loaded recursively and re-read by agent-pool on each run.
- Use `create_skill`, edit files directly, or manage shared skills through the Agent Portal UI.

### Per-Task Policies

Restrict tool usage for specific tasks using YAML policies:
- `"read-only"` — disables all file-writing and destructive shell tools
- `"safe-edit"` — allows file modifications but blocks arbitrary shell execution
- Custom path — `"/path/to/my-policy.yaml"`

### Cross-Model Peer Review

`consult_peer` sends architectural proposals to an Antigravity worker for structured review. The worker responds with a verdict: **AGREE**, **SUGGEST_CHANGES**, or **DISAGREE**. Supports iterative rounds until consensus.

### Security

- **Path Traversal Protection** — all skill and policy operations are sanitized to prevent access outside designated directories
- **Process Isolation** — tasks run as detached processes; `cancel_task` and server shutdown kill entire process groups
- **Credential Safety** — uses your local CLI authentication; no keys are stored or transmitted

## Quick Start

**Prerequisites:** Node.js >= 20 and at least one supported CLI installed and authenticated.

```bash
curl -fsSL https://antigravity.google/cli/install.sh | bash
agy       # First run: opens browser for OAuth
```

Claude Code tasks use `provider: "claude"` and require the `claude` CLI to be installed and authenticated with Claude Code's native auth. Agent Pool removes inherited Anthropic proxy/API env vars before spawning Claude Code so subscription/OAuth auth is not overridden by gateway settings.

OpenCode tasks use `provider: "opencode"`. Install and authenticate OpenCode separately, then connect DeepSeek with `/connect deepseek`. DeepSeek V4 models use OpenCode's native model ids, for example `deepseek/deepseek-v4-pro`.

Add to your IDE's MCP configuration:

```json
{
  "mcpServers": {
    "agent-pool": {
      "command": "npx",
      "args": ["-y", "agent-pool-mcp"]
    }
  }
}
```

Restart your IDE — agent-pool-mcp will be downloaded and started automatically.

<details>
<summary>Where is my MCP config file?</summary>

| IDE | Config path |
|-----|------------|
| Antigravity | `~/.gemini/config/mcp_config.json` |
| Cursor | `.cursor/mcp.json` |
| Windsurf | `.windsurf/mcp.json` |
| Claude Code | Run: `claude mcp add agent-pool npx -y agent-pool-mcp` |

</details>

<details>
<summary>Alternative: global install</summary>

```bash
npm install -g agent-pool-mcp
```

Then use `"command": "agent-pool-mcp"` in your MCP config (no npx needed).

</details>

### Verify

```bash
npx agent-pool-mcp --check
```

Runs diagnostics: checks Node.js, Antigravity CLI, authentication, and remote runner connectivity.

### CLI

```bash
npx agent-pool-mcp --check      # Doctor mode: diagnose prerequisites
npx agent-pool-mcp --init       # Create template config (for SSH runners)
npx agent-pool-mcp --version    # Show version
npx agent-pool-mcp --help       # Full help
```

### Shturman Benchmark

The experimental Phase-0 Shturman benchmark runs solo and chain-guided arms against OpenRouter with
mechanical checks. It reads `OPENROUTER_API_KEY` from the environment and writes raw runs outside the
repo by default:

```bash
npm run bench:shturman -- --config bench/examples/shturman-smoke.config.json
```

## Remote Workers (SSH)

Run workers on remote servers via SSH — same interface, transparent stdio forwarding. Create `agent-pool.config.json` in your project root or `~/.config/agent-pool/config.json`:

```json
{
  "runners": [
    { "id": "local", "type": "local" },
    { "id": "gpu", "type": "ssh", "host": "gpu-server", "cwd": "/workspace/project" }
  ],
  "defaultRunner": "local"
}
```

### Nested Orchestration

Install agent-pool inside Antigravity CLI to enable hierarchical delegation — workers can spawn their own workers.

| Variable | Purpose | Default |
|----------|---------|--------|
| `AGENT_POOL_DEPTH` | Current nesting level (auto-incremented) | `0` |
| `AGENT_POOL_MAX_DEPTH` | Max allowed depth | not set (no limit) |

See [parallel-work guide](examples/parallel-work.md) and built-in `orchestrator` skill for patterns.

## Verification Evidence Registry

The provider-neutral registry avoids repeating expensive checks when their
explicit inputs, configuration, command, runtime, and environment fingerprint
have not changed. Cooperative single-flight ensures that concurrent identical
checks execute once.

### Core Registry Tools

- **`prepare_verification`**: Returns `run`, `wait`, or `reuse` for a valid
  contract. A `run` response includes the lease and an owner-only runtime path
  to which the caller redirects command output.
- **`complete_verification`**: Publishes bounded metadata with the matching
  fingerprint and unexpired lease. Only `success` with exit code `0` becomes
  reusable green evidence.
- **`get_verification_evidence`**: Inspects `wait`, `reusable`, `stale`,
  `expired`, or `missing` state without acquiring a verification lease.

### Key Characteristics

1. **Explicit Input Contract**: The registry requires readable, in-worktree
   `inputs` and rejects an empty, missing, out-of-root, or symlinked scope. A
   contract error is not permission to run without a lease.
2. **Worktree Stability**: Repository identity comes from the Git common
   directory, while input paths remain relative to each worktree root. Matching
   content and commands in linked worktrees therefore share a fingerprint.
3. **No Inference Or Execution**: The registry does **not** infer affected tests
   or execute commands. Calling agents choose the scope, run the command, and
   publish its result.
4. **Freshness Policies**: Every prepare/status query declares
   `max_age_seconds`. `force_fresh` bypasses reuse while retaining
   single-flight; `non_cacheable` also prevents green publication.
5. **Private And Bounded State**: State lives under
   `AGENT_POOL_VERIFICATION_DIR` or `~/.agent-portal/verification-evidence`.
   Directories use `0700`, files use `0600`, each log is byte-bounded, and each
   fingerprint retains bounded history. Only the `run` response exposes the
   absolute local log path needed for redirection; reusable evidence exposes an
   opaque `log_ref` and bounded summary. Raw environment values are never
   accepted or returned.

## MCP Ecosystem

Best used as part of [**mcp-agent-portal**](https://github.com/rnd-pro/mcp-agent-portal) — a unified MCP aggregator that combines all RND-PRO servers behind a single config entry:

```json
{
  "mcpServers": {
    "agent-portal": {
      "command": "npx",
      "args": ["-y", "mcp-agent-portal"]
    }
  }
}
```

> [!TIP]
> The Portal runs a **singleton backend** to prevent resource exhaustion when you open multiple IDE windows. It transparently spawns `agent-pool-mcp` and `project-graph-mcp` as child processes and aggregates their tools.

Also works standalone alongside [**project-graph-mcp**](https://www.npmjs.com/package/project-graph-mcp) — AST-based codebase analysis:

> [!IMPORTANT]
> Each Antigravity CLI worker gets its own MCP server instance but shares pipeline state via filesystem — no coordination overhead.

## Documentation

- [ARCHITECTURE.md](ARCHITECTURE.md) — Source code structure and process management details
- [examples/parallel-work.md](examples/parallel-work.md) — Delegation patterns and best practices

## Related Projects
- [mcp-agent-portal](https://github.com/rnd-pro/mcp-agent-portal) — Unified MCP aggregator + web dashboard + AI agent runtime
- [project-graph-mcp](https://github.com/rnd-pro/project-graph-mcp) — AST-based codebase analysis for AI agents
- [Symbiote.js](https://github.com/symbiotejs/symbiote.js) — Isomorphic Reactive Web Components framework
- [JSDA-Kit](https://github.com/rnd-pro/jsda-kit) — SSG/SSR toolkit for modern web applications

## License

MIT © [RND-PRO.com](https://rnd-pro.com)

---

**Made with ❤️ by the RND-PRO team**
