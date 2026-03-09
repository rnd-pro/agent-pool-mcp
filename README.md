# agent-pool-mcp

MCP server for multi-agent task delegation and orchestration via [Gemini CLI](https://github.com/google-gemini/gemini-cli).

Built on [Model Context Protocol](https://modelcontextprotocol.io/) — turns your single Gemini subscription into a parallel agent workforce.

## How It Works

Your AI coding assistant (Antigravity, Cursor, Windsurf, or any MCP-compatible IDE) acts as the **primary agent**. Agent-pool lets it spawn **parallel Gemini CLI workers** that share your existing Gemini authentication — no extra API keys or subscriptions needed.

```
┌─────────────────────────────────┐
│  Primary IDE Agent              │  ← Your coding assistant
│  (Antigravity / Cursor / ...)   │
└────────────┬────────────────────┘
             │ MCP (stdio)
┌────────────▼────────────────────┐
│  agent-pool-mcp                 │  ← This server
│  (tool router + process mgmt)  │
└──┬─────────┬─────────┬─────────┘
   │         │         │
   ▼         ▼         ▼
  gemini    gemini    gemini       ← Gemini CLI workers
  (task1)   (task2)   (review)       (same auth, parallel)
```

The primary agent focuses on interactive work (UI, browser, user communication), while Gemini CLI agents handle background tasks: code analysis, testing, research, refactoring — all running in parallel.

## Cross-Model Peer Review

The most powerful pattern emerges when your primary IDE agent and Gemini CLI workers are **different foundation models** — for example, Claude (Antigravity/Cursor) + Gemini (CLI workers).

When you call `consult_peer`, you get **cross-model architectural consensus**:

```
┌──────────────────┐        consult_peer        ┌──────────────────┐
│  Claude Opus 4   │ ────── proposal ──────────▶ │  Gemini Pro      │
│  (primary agent) │ ◀───── verdict ─────────── │  (peer reviewer) │
│                  │                             │                  │
│  Strengths:      │                             │  Strengths:      │
│  · Deep reasoning│                             │  · Codebase scan │
│  · Nuanced code  │                             │  · Broad context │
│  · UI/UX sense   │                             │  · Pattern match │
└──────────────────┘                             └──────────────────┘
                         ↓
               Cross-model consensus
          (blind spots cancel each other out)
```

**Why this matters:**

- A single model reviewing its own plan has **systematic blind spots** — it tends to agree with itself
- Two different models trained on different data with different architectures catch **complementary issues**
- The structured verdict protocol (AGREE / SUGGEST_CHANGES / DISAGREE) forces explicit reasoning
- Iterative rounds let you refine until both models agree — the final result is stronger than either alone

```javascript
// Claude proposes → Gemini reviews → iterate until AGREE
const verdict = await consult_peer({
  context: 'Extracting auth module from monolith',
  proposal: 'JWT + refresh tokens, middleware pattern...',
});
// verdict: SUGGEST_CHANGES → revise → re-consult
// verdict: AGREE → proceed with confidence
```

This turns `consult_peer` from a simple review tool into a **cross-model reasoning amplifier** — the architectural equivalent of having two independent experts audit the same design.

## Features

- **`delegate_task`** — Fire-and-forget task delegation to Gemini CLI (full filesystem access)
- **`delegate_task_readonly`** — Read-only analysis mode (plan mode, no file modifications)
- **`consult_peer`** — Architectural peer review with structured verdicts (AGREE / SUGGEST_CHANGES / DISAGREE)
- **`get_task_result`** — Poll task status and retrieve results
- **`list_sessions`** — List available Gemini CLI sessions for resumption
- **`list_skills` / `create_skill` / `delete_skill`** — Manage Gemini CLI skills (.gemini/skills/*.md)

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
    ├── gemini-runner.js    ← Gemini CLI process spawning (streaming + headless)
    └── process-manager.js  ← PID tracking, process group kill, SIGTERM cleanup
```

## Process Management

Spawns Gemini CLI with `detached: true` and kills the entire process group on timeout/exit:

```javascript
// On timeout — kills child AND all its subprocesses
process.kill(-child.pid, 'SIGTERM');
```

Handles SIGTERM/SIGINT gracefully — all tracked child processes are terminated on server shutdown.

## Installation

```bash
git clone https://github.com/rnd-pro/agent-pool-mcp.git
cd agent-pool-mcp
npm install
```

## Usage

Add agent-pool to your IDE's MCP configuration. All spawned workers reuse your existing `gemini` CLI authentication — the same account you already use for Gemini CLI.

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

### Standalone

```bash
node index.js
```

The server communicates via stdio (MCP standard transport).

## Skills

Skills are markdown files with YAML frontmatter that define agent behavior. Place them in `.gemini/skills/` of your project:

```markdown
---
name: code-reviewer
description: Reviews code for quality and patterns.
---

# Code Reviewer Skill

You are a senior code reviewer...
```

Then activate with `delegate_task`:

```javascript
delegate_task({
  prompt: 'Review src/server.js',
  skill: 'code-reviewer',
});
```

See [`examples/`](examples/) for complete skill templates:
- **[parallel-work.md](examples/parallel-work.md)** — **Orchestration skill for the calling agent** (timeout rules, delegation patterns, no-bypass policy, `consult_peer` protocol)
- **[code-reviewer.md](examples/code-reviewer.md)** — Code review with structured verdicts
- **[research-analyst.md](examples/research-analyst.md)** — Technical research with findings reports

## Requirements

- Node.js >= 20
- [Gemini CLI](https://github.com/google-gemini/gemini-cli) installed and authenticated

## License

MIT
