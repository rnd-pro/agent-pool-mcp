import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let tempDirs = [];
let savedMemoryRoot;
let savedSkillsRoot;

function writeFixtureFile(cwd, relativePath, content) {
  let filePath = path.join(cwd, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

function makeProject() {
  let cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-context-resolver-'));
  tempDirs.push(cwd);
  process.env.AGENT_PORTAL_MEMORY_ROOT = path.join(cwd, '.agent-portal');
  process.env.AGENT_PORTAL_SKILLS_ROOT = path.join(cwd, '.agent-portal', 'skills');
  fs.writeFileSync(path.join(cwd, 'package.json'), '{}');

  writeFixtureFile(cwd, '.agent-portal/agents/ui-engineer.md', `---
name: ui-engineer
role: executor
context_tags: [ui, symbiote, component]
---
# UI Engineer`);

  writeFixtureFile(cwd, '.agent-portal/agents/code-reviewer.md', `---
name: code-reviewer
role: reviewer
context_tags: [review, gateway, testing]
---
# Code Reviewer`);

  writeFixtureFile(cwd, '.agent-portal/agents/backend-engineer.md', `---
name: backend-engineer
role: executor
context_tags: [server, context, workflow]
---
# Backend Engineer`);

  writeFixtureFile(cwd, '.agent-portal/agents/orchestrator.md', `---
name: orchestrator
role: orchestrator
context_tags: [config]
---
# Orchestrator`);

  writeFixtureFile(cwd, '.agent-portal/contexts/global/core.md', `---
id: global-core
scope: global
related_skills:
  - skills/code/error-handling.md
related_workflows:
  - workflows/code/context-routing.md
---
# Core`);

  writeFixtureFile(cwd, '.agent-portal/contexts/symbiote.md', `---
id: symbiote
scope: provider
activation:
  anyFiles:
    - packages/symbiote-ui
    - packages/symbiote-engine
related_skills:
  - skills/ui/symbiote-components.md
  - skills/ui/symbiote-patterns.md
  - skills/ui/ui-theming.md
---
# Symbiote`);

  writeFixtureFile(cwd, '.agent-portal/contexts/agent-portal-family.md', `---
id: agent-portal-family
scope: project
activation:
  anyFiles:
    - packages/symbiote-ui
    - packages/symbiote-engine
    - packages/agent-pool-mcp
related_workflows:
  - workflows/code/context-routing.md
---
# Agent Portal Family`);

  writeFixtureFile(cwd, '.agent-portal/skills/code/error-handling.md', `---
name: error-handling
description: Keep error handling explicit.
category: code
tags: [server, context]
token_cost: low
---
No harmful fallbacks.`);

  writeFixtureFile(cwd, '.agent-portal/skills/process/testing-discipline.md', `---
name: testing-discipline
description: Verify review and implementation changes.
category: process
tags: [testing, review]
token_cost: low
---
Testing discipline.`);

  writeFixtureFile(cwd, '.agent-portal/skills/ui/symbiote-components.md', `---
name: symbiote-components
description: Build Symbiote UI components.
category: ui
tags: [ui, symbiote, component]
token_cost: low
---
Symbiote component guidance.`);

  writeFixtureFile(cwd, '.agent-portal/skills/ui/symbiote-patterns.md', `---
name: symbiote-patterns
description: Use Symbiote component patterns.
category: ui
tags: [ui, symbiote]
token_cost: low
---
Symbiote patterns.`);

  writeFixtureFile(cwd, '.agent-portal/skills/ui/ui-theming.md', `---
name: ui-theming
description: Apply token cascade and component theming.
category: ui
tags: [ui, symbiote, theming]
token_cost: low
---
UI theming.`);

  writeFixtureFile(cwd, '.agent-portal/workflows/code/context-routing.md', `---
name: context-routing
description: Route dynamic context by metadata.
tags: [context, workflow, tooling, server]
---
# Context Routing`);

  return cwd;
}

describe('context resolver', () => {
  beforeEach(() => {
    savedMemoryRoot = process.env.AGENT_PORTAL_MEMORY_ROOT;
    savedSkillsRoot = process.env.AGENT_PORTAL_SKILLS_ROOT;
  });

  afterEach(() => {
    for (let dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
    if (savedMemoryRoot === undefined) delete process.env.AGENT_PORTAL_MEMORY_ROOT;
    else process.env.AGENT_PORTAL_MEMORY_ROOT = savedMemoryRoot;
    if (savedSkillsRoot === undefined) delete process.env.AGENT_PORTAL_SKILLS_ROOT;
    else process.env.AGENT_PORTAL_SKILLS_ROOT = savedSkillsRoot;
  });

  it('classifies UI tasks without escalating to orchestrator profile', async () => {
    let { resolveContext } = await import('../src/tools/context-resolver.js');
    let cwd = makeProject();

    let result = resolveContext({
      cwd,
      task: 'Fix AgentChat UI model selector in browser',
      agent_slug: 'ui-engineer',
      files: ['web/panels/AgentChat/AgentChat.js'],
      max_skills: 4,
    });

    assert.ok(result.zones.includes('ui'));
    assert.equal(result.toolProfile, 'implementation');
    assert.ok(result.tools.includes('prepare_verification'));
    assert.ok(result.tools.includes('complete_verification'));
    assert.ok(result.tools.includes('get_verification_evidence'));
    assert.ok(result.skills.some(skill => skill.name === 'symbiote-components'));
  });

  it('classifies review tasks as read-only context', async () => {
    let { resolveContext } = await import('../src/tools/context-resolver.js');
    let cwd = makeProject();

    let result = resolveContext({
      cwd,
      task: 'Review anthropic gateway DeepSeek provider routing',
      agent_slug: 'code-reviewer',
      files: ['src/node/server/anthropic-gateway.js'],
    });

    assert.ok(result.zones.includes('gateway'));
    assert.equal(result.toolProfile, 'review');
    assert.ok(result.tools.includes('get_verification_evidence'));
    assert.ok(!result.tools.includes('complete_verification'));
    assert.ok(result.skills.some(skill => skill.name === 'testing-discipline'));
  });

  it('does not treat fixed agent definitions as dynamic context', async () => {
    let { resolveContext } = await import('../src/tools/context-resolver.js');
    let cwd = makeProject();

    let result = resolveContext({
      cwd,
      task: 'Update agent metadata defaults for approval mode',
      agent_slug: 'orchestrator',
      files: ['.agent-portal/agents/orchestrator.md'],
    });

    assert.ok(result.zones.includes('config'));
    assert.ok(!result.zones.includes('agent-system'));
    assert.ok(!result.tags.includes('agents'));
    assert.ok(!result.tags.includes('code-analysis-tools'));

    let itemsResult = resolveContext({
      cwd,
      task: 'Update agent metadata defaults for approval mode',
      agent_slug: 'orchestrator',
      files: ['.agent-portal/agents/orchestrator.md'],
      mode: 'items',
    });
    assert.ok(!itemsResult.items.some(item => item.type === 'file-context' && item.title.startsWith('.agent-portal/agents/')));
  });

  it('classifies skill and workflow metadata without loading agent skills', async () => {
    let { resolveContext } = await import('../src/tools/context-resolver.js');
    let cwd = makeProject();

    let result = resolveContext({
      cwd,
      task: 'Add skill tags and workflow resolver for dynamic context',
      agent_slug: 'backend-engineer',
      files: ['packages/agent-pool-mcp/src/tools/context-resolver.js', '.agent-portal/skills/code/error-handling.md'],
      max_skills: 6,
    });

    assert.ok(result.zones.includes('context-system'));
    assert.ok(result.zones.includes('workflow-system'));
    assert.equal(result.toolProfile, 'workflow');
    assert.ok(result.tools.includes('prepare_verification'));
    assert.ok(!result.tags.includes('async-patterns'));
    assert.ok(!result.skills.some(skill => skill.category === 'agents'));
  });

  it('returns atomic enrichment items without loading markdown content', async () => {
    let { resolveContext } = await import('../src/tools/context-resolver.js');
    let cwd = makeProject();

    let result = resolveContext({
      cwd,
      task: 'Fix MCP context resolver and workflow tag matching',
      agent_slug: 'backend-engineer',
      files: ['packages/agent-pool-mcp/src/tools/context-resolver.js'],
      mode: 'items',
      max_skills: 4,
      max_workflows: 4,
    });

    assert.ok(Array.isArray(result.items));
    assert.ok(result.items.some(item => item.type === 'skill' && item.loadWith === 'get_skill_content'));
    assert.ok(result.items.some(item => item.type === 'workflow' && item.loadWith === 'get_workflow_content'));
    assert.ok(result.items.some(item => item.type === 'file-context' && item.args.recentFiles?.includes('packages/agent-pool-mcp/src/tools/context-resolver.js')));
    assert.ok(!('skills' in result));
    assert.ok(!result.items.some(item => item.content));
  });

  it('applies markdown context metadata before tag-only matching', async () => {
    let { resolveContext } = await import('../src/tools/context-resolver.js');
    let cwd = makeProject();

    let result = resolveContext({
      cwd,
      task: 'Audit how Agent Portal uses Symbiote provider skills',
      agent_slug: 'code-reviewer',
      files: ['packages/symbiote-ui/tree/TreeView/TreeView.js'],
      max_skills: 12,
      max_workflows: 8,
    });

    assert.ok(result.contexts.some(context => context.id === 'global-core'));
    assert.ok(result.contexts.some(context => context.id === 'symbiote'));
    assert.ok(result.contexts.some(context => context.id === 'agent-portal-family'));
    assert.ok(result.skills.some(skill => skill.name === 'symbiote-patterns'));
    assert.ok(result.skills.some(skill => skill.name === 'ui-theming'));
    assert.ok(result.contextPolicy.scanContextMetadataFrom);
  });

  it('loads a single skill content atomically', async () => {
    let { getSkillContent } = await import('../src/tools/skills.js');
    let cwd = makeProject();

    let skill = getSkillContent(cwd, 'error-handling');

    assert.equal(skill.name, 'error-handling');
    assert.equal(skill.category, 'code');
    assert.match(skill.content, /No harmful fallbacks/);
  });
});
