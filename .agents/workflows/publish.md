---
description: Pre-publish checklist for agent-pool-mcp npm releases
---

# Publish Workflow

## Pre-publish Checks

1. **Verify all tests pass**
   ```bash
   node -e "import { createServer } from './src/server.js'; createServer(); console.log('OK');"
   ```

2. **Check version consistency** — version must match in ALL files:
   - `package.json` → `version` field
   - `src/server.js` → `{ name: 'agent-pool', version: '...' }`
   - `index.js` → `console.error('[agent-pool] MCP server v... started')`
   
   ```bash
   grep -n "version" package.json | head -1
   grep -n "version:" src/server.js
   grep -n "MCP server v" index.js
   ```

3. **Check README is up to date** — verify all exported tools are documented:
   ```bash
   # List all tool names from definitions
   grep "name:" src/tool-definitions.js | grep -v "//\|type\|description"
   # Compare with README
   grep -c "delegate_task\|consult_peer\|create_pipeline\|schedule_task\|signal_step_complete\|bounce_back" README.md
   ```

4. **Verify no .agents/ artifacts in git**:
   ```bash
   git ls-files .agents/
   ```
   Should return empty. If not — `git rm --cached` and add to `.gitignore`.

5. **Check for uncommitted changes**:
   ```bash
   git status --short
   ```

6. **Architecture tree in README matches actual files**:
   ```bash
   find src/ -name "*.js" | sort
   ```
   Compare with Architecture section in README.

## Publish

// turbo
7. **Run npm publish**:
   ```bash
   npm publish
   ```

8. **Verify on npm**:
   ```bash
   npm info agent-pool-mcp version
   ```

9. **Tag release in git**:
   ```bash
   git tag v$(node -p "require('./package.json').version")
   git push --tags
   ```
