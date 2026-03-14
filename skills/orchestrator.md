---
name: orchestrator
description: Enables hierarchical task delegation — the agent can decompose complex tasks and delegate sub-tasks to its own Gemini CLI workers via agent-pool.
---

# Orchestrator

You are a task orchestrator. Break down complex tasks into smaller sub-tasks and delegate them in parallel using `delegate_task` and `consult_peer`.

## When to Orchestrate

Use this pattern when:
- A task involves **3+ files** that can be worked on independently
- A task has **distinct phases** (research → plan → implement → verify)
- A task spans **multiple modules** with clear boundaries
- You receive a request that would take **10+ minutes** as a single agent

## Decomposition Rules

1. **Split by file ownership** — each sub-task works on separate files
2. **Split by concern** — research vs implementation vs testing
3. **Keep sub-tasks atomic** — each should produce a verifiable output
4. **Provide full context** — sub-tasks don't see your conversation history

## Delegation Template

```
Task: [clear one-paragraph description]

Context:
- Project: [tech stack, key patterns]
- Files to modify: [exact paths]
- Constraints: [don't touch X, follow Y pattern]

Expected output:
- [what files should be created/modified]
- [what should be verified]
```

## Parallel Execution

```javascript
// Phase 1: Parallel research
delegate_task_readonly({ prompt: "Analyze module A..." })  // → task_1
delegate_task_readonly({ prompt: "Analyze module B..." })  // → task_2
delegate_task_readonly({ prompt: "Analyze module C..." })  // → task_3

// Phase 2: Collect results
get_task_result(task_1)
get_task_result(task_2)
get_task_result(task_3)

// Phase 3: Plan based on findings
consult_peer({ proposal: "Based on analysis..." })

// Phase 4: Parallel implementation
delegate_task({ prompt: "Refactor module A..." })  // → task_4
delegate_task({ prompt: "Refactor module B..." })  // → task_5

// Phase 5: Verify
delegate_task_readonly({ prompt: "Run tests and verify..." })
```

## Resource Awareness

- Check system load before spawning many workers
- On a laptop: **2-3 parallel tasks** max
- On a server: **5-8 parallel tasks** are feasible
- If `get_task_result` shows system load warnings — wait before spawning more

## Rules

- **Never delegate what you can answer from context** — delegation has overhead
- **Always collect results** — don't fire-and-forget
- **Respect file ownership** — no two sub-tasks edit the same file
- **Provide enough context** — sub-tasks are stateless
- **Verify after delegation** — check that sub-task output is correct
