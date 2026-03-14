# agent-pool-mcp

**MCP server for multi-agent orchestration** — parallel task delegation and cross-model peer review via [Gemini CLI](https://github.com/google-gemini/gemini-cli).

> Developed by [RND-PRO](https://rnd-pro.com)

Compatible with [Antigravity](https://antigravity.dev), Cursor, Windsurf, Claude Code, and any MCP-enabled coding agent.

## Why?

AI coding assistants are powerful, but they work **sequentially** — one task at a time. Agent-pool turns your single Gemini subscription into a **parallel agent workforce**: your primary IDE agent delegates background tasks to Gemini CLI workers, all sharing the same authentication.

When the primary agent and Gemini workers are **different foundation models** (e.g. Claude + Gemini), `consult_peer` becomes a **cross-model reasoning amplifier** — two independent architectures reviewing each other eliminate systematic blind spots that plague single-model workflows.

## How It Works

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

## Features

### 🚀 Task Delegation
- **`delegate_task`** — Non-blocking task delegation to Gemini CLI (full filesystem access).
- **`delegate_task_readonly`** — Read-only analysis (plan mode). Supports `session_id` to resume previous analyses.
- **`get_task_result`** — Poll task status, retrieve results, and see live progress (last 200 tool/message events).
- **`cancel_task`** — Kill a running task and its entire process group immediately.

### 📋 3-Tier Skill System
Skills are Markdown files with YAML frontmatter that extend agent behavior. Agent-pool manages skills in three tiers:
1.  **Project**: `.gemini/skills/` (local to repo, takes precedence).
2.  **Global**: `~/.gemini/skills/` (available across all projects).
3.  **Built-in**: Shipped with agent-pool (e.g., `code-reviewer`, `test-writer`, `doc-fixer`).

**Skill Tools:**
- **`list_skills`** — See all available skills and their tiers.
- **`install_skill`** — Copy a global or built-in skill to the project tier for local customization.
- **`create_skill` / `delete_skill`** — Manage skill files in project or global scope.

*Note: When delegating with a skill, agent-pool uses "hybrid activation" — it ensures the skill is available in the project and instructs Gemini CLI to activate it natively.*

### 🛡️ Per-Task Policies
Restrict tool usage for specific tasks using YAML policies. Use built-in templates or custom paths:
- `policy: "read-only"` — Disables all file-writing and destructive shell tools.
- `policy: "safe-edit"` — Allows file modifications but blocks arbitrary shell execution.
- `policy: "/path/to/my-policy.yaml"` — Use a custom security policy.

### 🤝 Cross-Model Peer Review
- **`consult_peer`** — Architectural review with structured verdicts (AGREE / SUGGEST_CHANGES / DISAGREE).
- Supports iterative rounds: propose → get feedback → revise → re-send until consensus.

### 📊 System Awareness & Management
- **System Load Detection**: Automatically detects other running Gemini processes on the system and warns if the worker pool is saturated.
- **Session Management**: `list_sessions` allows resuming previous Gemini CLI conversations by UUID.

## Remote Workers (SSH)

Run workers on remote servers via SSH — same interface, transparent stdio forwarding.
Create `agent-pool.config.json` in your project root or `~/.config/agent-pool/config.json`:

```json
{
  "runners": [
    { "id": "local", "type": "local" },
    { "id": "gpu", "type": "ssh", "host": "gpu-server", "cwd": "/home/dev/project" }
  ],
  "defaultRunner": "local"
}
```

## Prerequisites

- **Node.js >= 20** — [Download](https://nodejs.org)
- **[Gemini CLI](https://github.com/google-gemini/gemini-cli)** — installed and authenticated:

```bash
npm install -g @google/gemini-cli
gemini    # First run: opens browser for OAuth
```

## Installation

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
<summary>📍 Where is my MCP config file?</summary>

| IDE | Config path |
|-----|------------|
| Antigravity | `~/.gemini/antigravity/mcp_config.json` |
| Cursor | `.cursor/mcp.json` |
| Windsurf | `.windsurf/mcp.json` |
| Claude Code | Run: `claude mcp add agent-pool npx -y agent-pool-mcp` |

</details>

<details>
<summary>📦 Alternative: global install</summary>

```bash
npm install -g agent-pool-mcp
```

Then use `"command": "agent-pool-mcp"` in your MCP config (no npx needed).

</details>

### Verify

```bash
npx agent-pool-mcp --check
```

This runs diagnostics: checks Node.js, Gemini CLI, authentication, and remote runner connectivity.

### CLI Commands

```bash
npx agent-pool-mcp --check      # Doctor mode: diagnose prerequisites
npx agent-pool-mcp --init       # Create template config (for SSH runners)
npx agent-pool-mcp --version    # Show version
npx agent-pool-mcp --help       # Full help
```

## MCP Ecosystem

Agent-pool works alongside other MCP servers:

| Layer | agent-pool-mcp | [project-graph-mcp](https://github.com/rnd-pro/project-graph-mcp) |
|-------|---------------|-------------------|
| **Primary IDE agent** | Delegates tasks, consults peer | Navigates codebase, runs analysis |
| **Gemini CLI workers** | Executes delegated tasks | Available as MCP tool inside Gemini CLI |

## Security

- **Path Traversal Protection**: All skill and policy operations are sanitized to prevent access outside designated directories.
- **Process Isolation**: Tasks run as detached processes; `cancel_task` and server shutdown ensure no zombie processes remain by killing entire process groups.
- **Credential Safety**: Uses your local Gemini CLI authentication; no keys are stored or transmitted by this server.

## Architecture

```
index.js                    ← Entry point (stdio transport)
policies/                   ← Tool restriction policies (YAML)
├── read-only.yaml
└── safe-edit.yaml
skills/                     ← Built-in Gemini CLI skills (Markdown)
├── code-reviewer.md
├── doc-fixer.md
└── test-writer.md
src/
├── server.js               ← MCP server setup + tool routing
├── tool-definitions.js     ← Tool schemas (JSON Schema)
├── tools/
│   ├── consult.js          ← Peer review via Gemini CLI
│   ├── results.js          ← Task store + result formatting (TTL cleanup, ring buffer)
│   └── skills.js           ← 3-tier skill management (project/global/built-in)
└── runner/
    ├── config.js           ← Runner config loader (local/SSH)
    ├── gemini-runner.js    ← Process spawning (streaming JSON)
    ├── process-manager.js  ← PID tracking, system load awareness, group kill
    └── ssh.js              ← Shell escaping, remote PID tracking
├── cli.js                  ← CLI commands (--check, --init, --help)
```

**Process management:**
- **Detached Spawn**: Workers are spawned in their own process groups.
- **TTL Cleanup**: Completed task results are purged from memory after 10 minutes.
- **Live Events**: Progress polling uses a ring buffer to show the latest activity without overwhelming context.
- **Startup Validation**: Quick prerequisite check before MCP server starts; exits with clear error if Gemini CLI is missing.

## License

MIT
