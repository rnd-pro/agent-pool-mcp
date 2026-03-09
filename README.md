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
- **`delegate_task`** — Non-blocking task delegation to Gemini CLI (full filesystem access)
- **`delegate_task_readonly`** — Read-only analysis (plan mode, no destructive actions)
- **`get_task_result`** — Poll task status and retrieve results

### 🤝 Cross-Model Peer Review
- **`consult_peer`** — Architectural review with structured verdicts (AGREE / SUGGEST_CHANGES / DISAGREE)
- Supports iterative rounds: propose → get feedback → revise → re-send until consensus
- Cross-model consensus eliminates single-model blind spots

```
┌──────────────────┐     consult_peer      ┌──────────────────┐
│  Claude Opus 4   │ ──── proposal ──────▶ │  Gemini Pro      │
│  (primary agent) │ ◀─── verdict ──────── │  (peer reviewer) │
└──────────────────┘                       └──────────────────┘
```

### 📋 Session & Skill Management
- **`list_sessions`** — Resume previous Gemini CLI conversations
- **`list_skills` / `create_skill` / `delete_skill`** — Manage `.gemini/skills/*.md`

### 🌐 Remote Workers (SSH)
- Run workers on remote servers via SSH — same interface, transparent stdio forwarding
- Remote PID tracking for reliable cleanup on timeout
- Safe shell escaping for all arguments

## MCP Ecosystem

Agent-pool is designed to work alongside other MCP servers. The combination amplifies each tool's capabilities at **both levels** — the primary IDE agent and the delegated Gemini CLI workers.

### Works with [Project Graph MCP](https://github.com/rnd-pro/project-graph-mcp)

| Layer | agent-pool-mcp | project-graph-mcp |
|-------|---------------|-------------------|
| **Primary IDE agent** | Delegates tasks, consults peer | Navigates codebase, runs quality analysis |
| **Gemini CLI workers** | Executes delegated tasks | Available as MCP tool inside Gemini CLI |

**Typical workflow:**

```
1. Primary agent uses project-graph to understand codebase structure
2. Primary agent uses consult_peer to validate architectural proposal
3. Primary agent delegates implementation to Gemini CLI worker
4. Gemini CLI worker uses project-graph to navigate code and verify quality
5. Primary agent checks results with get_task_result
```

Both servers complement each other:
- **project-graph-mcp** provides codebase context (10-50x compressed AST graphs, code quality metrics, test checklists)
- **agent-pool-mcp** provides execution capacity (parallel workers, cross-model review, remote SSH runners)

### Works with [Stitch MCP](https://github.com/nicenathapong/stitch-mcp)

Use agent-pool to delegate Stitch-based UI generation to background workers while the primary agent handles integration.

## Installation

```bash
git clone https://github.com/rnd-pro/agent-pool-mcp.git
cd agent-pool-mcp
npm install
```

## MCP Configuration

### Antigravity IDE

`~/.gemini/antigravity/mcp_config.json`:

```json
{
  "mcpServers": {
    "agent-pool": {
      "command": "node",
      "args": ["/path/to/agent-pool-mcp/index.js"]
    }
  }
}
```

### Cursor / Windsurf

`.cursor/mcp.json` or equivalent:

```json
{
  "mcpServers": {
    "agent-pool": {
      "command": "node",
      "args": ["/path/to/agent-pool-mcp/index.js"]
    }
  }
}
```

### Claude Code

```bash
claude mcp add agent-pool node /path/to/agent-pool-mcp/index.js
```

## Remote Workers

Run Gemini CLI on remote servers via SSH. The remote server needs only `gemini` CLI installed and authenticated.

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

```javascript
delegate_task({
  prompt: 'Run performance benchmarks',
  runner: 'gpu',
});
```

SSH authentication is managed through `~/.ssh/config`. Recommended: enable [ControlMaster](https://man.openbsd.org/ssh_config#ControlMaster) for connection reuse.

Keep remote repos in sync via Git before delegating:
```bash
ssh gpu-server 'cd /home/dev/project && git pull'
```

## Skills

Skills are markdown files with YAML frontmatter that extend Gemini CLI agent behavior:

```javascript
delegate_task({
  prompt: 'Review src/server.js for security issues',
  skill: 'code-reviewer',
});
```

See [`examples/`](examples/) for templates:
- **[parallel-work.md](examples/parallel-work.md)** — Orchestration skill for the calling agent (delegation patterns, `consult_peer` protocol)
- **[code-reviewer.md](examples/code-reviewer.md)** — Code review with structured verdicts
- **[research-analyst.md](examples/research-analyst.md)** — Technical research with findings reports

## Architecture

```
index.js                    ← Entry point (stdio transport)
src/
├── server.js               ← MCP server setup + tool routing
├── tool-definitions.js     ← Tool schemas (JSON Schema)
├── tools/
│   ├── consult.js          ← Peer review via Gemini CLI
│   ├── results.js          ← Task store + result formatting
│   └── skills.js           ← Skill file management
└── runner/
    ├── config.js           ← Runner config loader (local/SSH)
    ├── gemini-runner.js    ← Process spawning (streaming + headless)
    ├── process-manager.js  ← PID tracking, process group kill
    └── ssh.js              ← Shell escaping, remote PID tracking
```

**Process management:** Spawns with `detached: true`, kills entire process group (`kill -TERM -pid`) on timeout. Handles SIGTERM/SIGINT gracefully — all tracked child processes are terminated on server shutdown.

## Requirements

- Node.js >= 20
- [Gemini CLI](https://github.com/google-gemini/gemini-cli) installed and authenticated

## License

MIT
