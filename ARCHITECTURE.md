## Architecture

```
index.js                    ← Entry point (stdio transport)
policies/                   ← Tool restriction policies (YAML)
├── read-only.yaml
└── safe-edit.yaml
skills/                     ← Built-in Gemini CLI skills (Markdown)
├── code-reviewer.md
├── doc-fixer.md
├── orchestrator.md
└── test-writer.md
src/
├── cli.js                  ← CLI commands (--check, --init, --help)
├── server.js               ← MCP server setup + tool routing
├── tool-definitions.js     ← Tool schemas (JSON Schema)
├── tools/
│   ├── consult.js          ← Peer review via Gemini CLI
│   ├── results.js          ← Task store + result formatting (TTL cleanup, ring buffer)
│   └── skills.js           ← 3-tier skill management (project/global/built-in)
├── runner/
│   ├── config.js           ← Runner config loader (local/SSH)
│   ├── gemini-runner.js    ← Process spawning (streaming JSON, depth tracking)
│   ├── process-manager.js  ← PID tracking, system load awareness, group kill
│   └── ssh.js              ← Shell escaping, remote PID tracking
└── scheduler/
    ├── cron.js             ← Minimal cron expression parser (zero-dependency)
    ├── daemon.js           ← Detached daemon: schedule ticks + pipeline lifecycle
    ├── pipeline.js         ← Pipeline CRUD, run state, signals, bounce-back
    └── scheduler.js        ← Schedule management + daemon spawning
```

### Process Management
- **Detached Spawn**: Workers are spawned in their own process groups.
- **TTL Cleanup**: Completed task results are purged from memory after 10 minutes.
- **Live Events**: Progress polling uses a ring buffer to show the latest activity without overwhelming context.
- **Depth Tracking**: Nested orchestration support with optional `AGENT_POOL_MAX_DEPTH` limit.
- **Adaptive Polling**: Pipeline daemon uses 3s intervals when active, 30s when idle.
- **File-Based Communication**: Pipeline agents communicate through `.agent-portal/runs/` JSON files — each Gemini process has its own MCP server instance but shares state via filesystem.
