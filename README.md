# agent-pool-mcp

MCP server for multi-agent task delegation and orchestration via [Gemini CLI](https://github.com/google-gemini/gemini-cli).

Built on [Model Context Protocol](https://modelcontextprotocol.io/) — connects AI coding assistants to Gemini CLI agents for parallel work.

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

### With Antigravity IDE

Add to `~/.gemini/antigravity/mcp_config.json`:

```json
{
  "mcpServers": {
    "agent-pool": {
      "command": "node",
      "args": ["/path/to/agent-pool-mcp/index.js"],
      "env": {},
      "disabled": false
    }
  }
}
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
