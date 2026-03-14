---
name: parallel-work
description: Delegation patterns for parallel work between a primary AI agent and Gemini CLI agents via agent-pool MCP. Covers task splitting, sync via shared files, file ownership, timeouts, and consultation protocols.
---

# Parallel Work Skill

Orchestrate work between a **primary agent** (e.g. Antigravity/Claude IDE — browser, UI, artifacts) and **Gemini CLI agents** (filesystem, commands, tests, code analysis) via the **agent-pool MCP server**.

## Agent-Pool Infrastructure

- **Source**: `agent-pool-mcp/` (this repository)
- **Entry**: `index.js` → `src/server.js` → `src/tools/*.js`, `src/runner/*.js`
- **Config**: Add to your IDE's MCP server config (see README)

### Debugging

```bash
# Check running agent processes
ps aux | grep gemini | grep -v grep | grep -v Chrome

# Kill zombie processes manually
pkill -f "gemini.*--output-format"

# Test MCP server directly
node agent-pool-mcp/index.js
```

### Session Lifecycle

- Agents spawn with `detached: true` for process group isolation
- On timeout: `process.kill(-pid, 'SIGTERM')` kills entire tree
- On server SIGTERM/SIGINT: all tracked children are killed
- If timeout fires but process survives — check `process-manager.js`

## Core Principle: File Ownership

> **NEVER let two agents edit the same file simultaneously.**

Before delegating, declare scope in the delegation status file. Each agent owns specific directories/files for the duration of the task.

## Sync Directory

Use `.agent/delegation/` in the project root:

```
.agent/delegation/
├── status.md        — who's doing what, locked files
├── handoff.md       — completed step → next agent picks up
└── findings.md      — research results, audit reports
```

## Delegation Patterns

### Pattern 1: Frontend + Backend Split
Primary agent handles UI components, Gemini handles server code.

### Pattern 2: Code + Verification Split
Primary writes code, Gemini runs tests and verifies.

### Pattern 3: Research + Implementation
Gemini researches (readonly), primary implements based on findings.

### Pattern 4: Multi-File Refactor
Divide files by ownership, each agent refactors its scope.

### Pattern 5: Audit + Fix
Gemini audits (readonly), primary fixes found issues.

### Pattern 6: Peer Consultation
Use `consult_peer` for architectural decisions before implementation.

### Pattern 7: Parallel Analysis
Multiple `delegate_task_readonly` for different aspects simultaneously.

## Critical Rules

### Timeout Rules

> **NEVER set timeout below 300 seconds for research or analysis tasks.**

| Task Type | Minimum Timeout | Recommended |
|-----------|----------------|-------------|
| Code analysis (readonly) | 300s | 300s |
| Web research / exploration | 300s | 600s |
| Code writing (delegate_task) | 300s | 600s |
| Quick check | 120s | 180s |

**On timeout**:
1. **Check findings files FIRST** — agent may have written partial results before timeout
   ```bash
   ls .agent/delegation/findings-*.md   # ALWAYS check regardless of timeout
   ```
2. **Retry with longer timeout** — do NOT skip the delegation
3. If 2 retries fail — investigate why (wrong prompt, network, tool issue)
4. **NEVER substitute agent research with your own** — the delegation exists for a reason
5. **Timeout ≠ wasted work** — agents consume resources; their partial output has value

> **The fact that an agent timed out is NOT permission to bypass the delegation process.**
> Always read what was produced. Always retry if needed.

### No Bypass Rule

> **If you delegated research — you MUST wait for and USE the results before implementing.**

Violations include:
- Delegating research, then doing the same research yourself
- Ignoring agent findings and writing your own analysis
- Starting implementation before agent results are collected
- Using web search as a "backup" to skip agent delegation
- Seeing timeout and assuming "nothing was produced"

**Correct process for Research → Implementation**:
```
0. mkdir -p .agent/delegation/         ← ensure dir exists BEFORE delegating
1. delegate_task_readonly(research, timeout=300)
2. WAIT with get_task_result() — poll every 30-60s
3. On timeout → ls .agent/delegation/  ← check for partial results
4. READ findings from .agent/delegation/findings-*.md
5. consult_peer(proposal)              ← discuss architecture with peer agent
6. ONLY THEN proceed to implementation
```

### Pre-Implementation Consultation (MANDATORY)

> **Before implementing any new component, handler, or architectural feature — run `consult_peer` FIRST.**

This is not optional. Even if you already have a plan, the peer may identify:
- Missing edge cases
- Better patterns from existing codebase
- Conflicts with other components
- Simpler alternatives

```javascript
// REQUIRED before coding ANY new feature:
consult_peer({
  context: 'Adding a new authentication layer to the API',
  proposal: 'JWT-based auth with refresh tokens, middleware pattern...',
})
// Wait for AGREE before proceeding
// If SUGGEST_CHANGES — revise and re-consult
```

**The consultation phase is part of the work, not overhead. Skipping it to "save time" creates rework.**

## Nested Orchestration

Agent-pool can be installed inside Gemini CLI workers, enabling **hierarchical delegation** — workers can delegate their own sub-tasks.

### Setup

Add agent-pool as MCP server in Gemini CLI config (`~/.gemini/settings.json`):

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

### Depth Tracking

Agent-pool automatically tracks nesting depth via environment variables:

| Variable | Purpose | Default |
|----------|---------|---------|
| `AGENT_POOL_DEPTH` | Current nesting level (auto-incremented) | `0` |
| `AGENT_POOL_MAX_DEPTH` | Max allowed depth (optional limit) | not set (no limit) |

To enable depth limit:
```json
{
  "mcpServers": {
    "agent-pool": {
      "command": "npx",
      "args": ["-y", "agent-pool-mcp"],
      "env": { "AGENT_POOL_MAX_DEPTH": "2" }
    }
  }
}
```

When depth limit is reached, delegation tools return an error instructing the agent to execute directly.

### Use Cases

- **Multi-repo refactoring**: top-level delegates per-repo, each repo's worker sub-delegates per-file
- **Architecture decomposition**: research phase → plan phase → parallel implementation per module
- **Deep review pipelines**: security review, performance review, architecture review — each with sub-analysis

### Safety Rules

- Start with `AGENT_POOL_MAX_DEPTH=2` until you understand resource usage
- Each Gemini CLI process uses ~200-500 MB RAM
- Use `orchestrator` skill (`--skill orchestrator`) for workers that should sub-delegate

## Anti-Patterns

❌ Both agents editing the same file  
❌ Vague prompts without scope boundaries  
❌ Forgetting to check `get_task_result` for background tasks  
❌ Delegating without providing file context  
❌ Setting timeout < 300s for research tasks  
❌ Bypassing delegation by doing agent's work yourself  
❌ Starting implementation before agent research completes  
❌ Skipping `consult_peer` for architectural decisions  
❌ Substituting agent research with web search fallback  
❌ Nested delegation without `AGENT_POOL_MAX_DEPTH` on untrusted prompts  
