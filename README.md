[![npm version](https://img.shields.io/npm/v/agent-pool-mcp)](https://www.npmjs.com/package/agent-pool-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D20-339933?logo=node.js&logoColor=white)](https://nodejs.org)

# agent-pool-mcp

**MCP server for multi-agent orchestration** — parallel task delegation, sequential pipelines, cron scheduling, and cross-model peer review via [Gemini CLI](https://github.com/google-gemini/gemini-cli).

> Developed by [RND-PRO](https://rnd-pro.com)

Compatible with [Antigravity](https://antigravity.dev), Cursor, Windsurf, Claude Code, and any MCP-enabled coding agent.

Your primary IDE agent delegates background tasks to Gemini CLI workers in parallel — all sharing the same authentication from a single Gemini subscription.

When the primary agent and Gemini workers are **different foundation models** (e.g. Claude + Gemini), `consult_peer` gives you cross-model review — two models check each other's reasoning independently.

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
  gemini    gemini    gemini       ← Gemini CLI workers
  (task1)   (task2)   (review)       (same auth, parallel)
```

> [!TIP]
> A single $20/month Google AI Ultra subscription can power dozens of parallel workers — no additional API keys required.

### Task Delegation

Non-blocking task delegation to Gemini CLI workers. The primary agent fires off a task and continues working — polling for results when ready. Workers get full filesystem access (`delegate_task`) or read-only mode (`delegate_task_readonly`). Cancel anytime with `cancel_task`.

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

Results are saved to `.agents/scheduled-results/` and retrievable via `get_scheduled_results`.

### 3-Tier Skill System

Skills are Markdown files with YAML frontmatter that extend agent behavior:

1. **Project** — `.gemini/skills/` (local to repo, takes precedence)
2. **Global** — `~/.gemini/skills/` (available across all projects)
3. **Built-in** — shipped with agent-pool (`code-reviewer`, `test-writer`, `doc-fixer`, `orchestrator`)

Install a built-in or global skill into the project for local customization with `install_skill`.

### Per-Task Policies

Restrict tool usage for specific tasks using YAML policies:
- `"read-only"` — disables all file-writing and destructive shell tools
- `"safe-edit"` — allows file modifications but blocks arbitrary shell execution
- Custom path — `"/path/to/my-policy.yaml"`

### Cross-Model Peer Review

`consult_peer` sends architectural proposals to a Gemini worker for structured review. The worker responds with a verdict: **AGREE**, **SUGGEST_CHANGES**, or **DISAGREE**. Supports iterative rounds until consensus.

### Security

- **Path Traversal Protection** — all skill and policy operations are sanitized to prevent access outside designated directories
- **Process Isolation** — tasks run as detached processes; `cancel_task` and server shutdown kill entire process groups
- **Credential Safety** — uses your local Gemini CLI authentication; no keys are stored or transmitted

## Quick Start

**Prerequisites:** Node.js >= 20, [Gemini CLI](https://github.com/google-gemini/gemini-cli) installed and authenticated.

```bash
npm install -g @google/gemini-cli
gemini    # First run: opens browser for OAuth
```

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
| Antigravity | `~/.gemini/antigravity/mcp_config.json` |
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

Runs diagnostics: checks Node.js, Gemini CLI, authentication, and remote runner connectivity.

### CLI

```bash
npx agent-pool-mcp --check      # Doctor mode: diagnose prerequisites
npx agent-pool-mcp --init       # Create template config (for SSH runners)
npx agent-pool-mcp --version    # Show version
npx agent-pool-mcp --help       # Full help
```

## Remote Workers (SSH)

Run workers on remote servers via SSH — same interface, transparent stdio forwarding. Create `agent-pool.config.json` in your project root or `~/.config/agent-pool/config.json`:

```json
{
  "runners": [
    { "id": "local", "type": "local" },
    { "id": "gpu", "type": "ssh", "host": "gpu-server", "cwd": "/home/dev/project" }
  ],
  "defaultRunner": "local"
}
```

### Nested Orchestration

Install agent-pool inside Gemini CLI to enable hierarchical delegation — workers can spawn their own workers.

| Variable | Purpose | Default |
|----------|---------|--------|
| `AGENT_POOL_DEPTH` | Current nesting level (auto-incremented) | `0` |
| `AGENT_POOL_MAX_DEPTH` | Max allowed depth | not set (no limit) |

See [parallel-work guide](examples/parallel-work.md) and built-in `orchestrator` skill for patterns.

## MCP Ecosystem

Best used together with [**project-graph-mcp**](https://www.npmjs.com/package/project-graph-mcp) — AST-based codebase analysis:

| Layer | agent-pool-mcp | project-graph-mcp |
|-------|---------------|-------------------|
| **Primary IDE agent** | Delegates tasks, consults peer | Navigates codebase, runs analysis |
| **Gemini CLI workers** | Executes delegated tasks | Available as MCP tool inside workers |

```json
{
  "mcpServers": {
    "agent-pool": {
      "command": "npx",
      "args": ["-y", "agent-pool-mcp"]
    },
    "project-graph": {
      "command": "npx",
      "args": ["-y", "project-graph-mcp"]
    }
  }
}
```

> [!IMPORTANT]
> Each Gemini CLI worker gets its own MCP server instance but shares pipeline state via filesystem — no coordination overhead.

## Documentation

- [ARCHITECTURE.md](ARCHITECTURE.md) — Source code structure and process management details
- [examples/parallel-work.md](examples/parallel-work.md) — Delegation patterns and best practices

## Related Projects
- [project-graph-mcp](https://github.com/rnd-pro/project-graph-mcp) — AST-based codebase analysis for AI agents
- [Symbiote.js](https://github.com/symbiotejs/symbiote.js) — Isomorphic Reactive Web Components framework
- [JSDA-Kit](https://github.com/rnd-pro/jsda-kit) — SSG/SSR toolkit for modern web applications

## License

MIT © [RND-PRO.com](https://rnd-pro.com)

---

**Made with ❤️ by the RND-PRO team**
