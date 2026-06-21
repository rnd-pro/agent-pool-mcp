import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { parseFrontmatter as parseSkillFrontmatter } from '../src/tools/markdown-parser.js';
import { parseFrontmatter as parseWorkflowFrontmatter } from '../src/tools/workflow-index.js';
import { listSkills } from '../src/tools/skills.js';
import { buildAgentCatalog, resolveAgent, resolveAgentMetadata } from '../src/agents/agent-resolver.js';

const TEST_CWD = path.join(os.tmpdir(), `agent-pool-frontmatter-${Date.now()}`);

function withMemoryRoot(root, fn) {
  const previous = process.env.AGENT_PORTAL_MEMORY_ROOT;
  process.env.AGENT_PORTAL_MEMORY_ROOT = root;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env.AGENT_PORTAL_MEMORY_ROOT;
    else process.env.AGENT_PORTAL_MEMORY_ROOT = previous;
  }
}

describe('shared frontmatter parser', () => {
  after(() => {
    fs.rmSync(TEST_CWD, { recursive: true, force: true });
  });

  it('parses the same nested metadata through skill and workflow APIs', () => {
    const content = `---
tags:
  - context
  - workflow
transitions:
  success:
    require_tags: [next, verify]
autoload: true
timeout: 300
---
# Body`;

    const skill = parseSkillFrontmatter(content);
    const workflow = parseWorkflowFrontmatter(content);

    assert.deepStrictEqual(skill.frontmatter.tags, ['context', 'workflow']);
    assert.deepStrictEqual(workflow.meta.tags, ['context', 'workflow']);
    assert.deepStrictEqual(skill.frontmatter.transitions, { success: { require_tags: ['next', 'verify'] } });
    assert.deepStrictEqual(workflow.meta.transitions, { success: { require_tags: ['next', 'verify'] } });
    assert.equal(skill.frontmatter.autoload, true);
    assert.equal(workflow.meta.timeout, 300);
  });

  it('uses nested skill metadata when listing skills', () => {
    const skillDir = path.join(TEST_CWD, '.agent-portal', 'skills', 'code');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'nested.md'), `---
name: nested-skill
description: Nested metadata
tags: [context, parser]
applies_to:
  paths:
    - src/node
token_cost: small
autoload: false
---
Skill body`);

    const skill = withMemoryRoot(path.join(TEST_CWD, '.agent-portal'), () =>
      listSkills(TEST_CWD).find(item => item.name === 'nested-skill'));

    assert.ok(skill);
    assert.deepStrictEqual(skill.tags, ['context', 'parser']);
    assert.deepStrictEqual(skill.appliesTo, { paths: ['src/node'] });
    assert.equal(skill.tokenCost, 'small');
    assert.equal(skill.autoload, false);
  });

  it('lists skills from the active workspace context', () => {
    const contextDir = path.join(TEST_CWD, '.agent-portal', 'workspace', 'demo');
    const skillDir = path.join(contextDir, 'skills');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(TEST_CWD, 'package.json'), '{}');
    fs.writeFileSync(path.join(contextDir, 'context.md'), `---
id: demo
scope: project
activation:
  anyFiles:
    - package.json
related_skills:
  - workspace/demo/skills/demo-skill.md
---
# Demo Context`);
    fs.writeFileSync(path.join(skillDir, 'demo-skill.md'), `---
name: demo-skill
description: Demo workspace skill
category: workspace
tags: [demo]
---
Skill body`);

    const skill = withMemoryRoot(path.join(TEST_CWD, '.agent-portal'), () =>
      listSkills(TEST_CWD).find(item => item.name === 'demo-skill'));

    assert.ok(skill);
    assert.equal(skill.tier, 'workspace');
    assert.equal(skill.workspace, 'demo');
  });

  it('uses the shared parser for agent routing metadata', () => {
    const agentsDir = path.join(TEST_CWD, '.agent-portal', 'agents');
    fs.mkdirSync(agentsDir, { recursive: true });
    fs.writeFileSync(path.join(agentsDir, 'reviewer.md'), `---
name: reviewer
role: orchestrator
resource_group: deepseek-pro-audit
models:
  - deepseek/deepseek-v4-pro
context_tags: [review, gateway]
---
Agent body`);

    const meta = resolveAgentMetadata(TEST_CWD, 'reviewer');

    assert.equal(meta.slug, 'reviewer');
    assert.equal(meta.role, 'orchestrator');
    assert.equal(meta.resourceGroup, 'deepseek-pro-audit');
    assert.deepStrictEqual(meta.models, ['deepseek/deepseek-v4-pro']);
    assert.deepStrictEqual(meta.contextTags, ['review', 'gateway']);
    assert.equal('approvalMode' in meta, false);
    assert.equal('policy' in meta, false);
  });

  it('composes agent prompts from frontmatter and inline skills', () => {
    const agentsDir = path.join(TEST_CWD, '.agent-portal', 'agents');
    const skillsDir = path.join(TEST_CWD, '.agent-portal', 'skills', 'process');
    fs.mkdirSync(agentsDir, { recursive: true });
    fs.mkdirSync(skillsDir, { recursive: true });
    fs.writeFileSync(path.join(skillsDir, 'qa-skill.md'), `---
name: qa-skill
description: QA contract
---
Required QA skill content.`);
    fs.writeFileSync(path.join(skillsDir, 'inline-skill.md'), `---
name: inline-skill
description: Inline contract
---
Inline guidance content.`);
    fs.writeFileSync(path.join(agentsDir, 'qa.md'), `---
name: qa
skills:
  - qa-skill
---
Agent body

{{skill:inline-skill}}`);

    const agent = resolveAgent(TEST_CWD, 'qa');

    assert.ok(agent);
    assert.deepStrictEqual(agent.skills, ['qa-skill']);
    assert.match(agent.prompt, /Required QA skill content/);
    assert.match(agent.prompt, /Agent body/);
    assert.match(agent.prompt, /Inline guidance content/);
    assert.ok(agent.prompt.indexOf('Required QA skill content') < agent.prompt.indexOf('Agent body'));
  });

  it('does not resolve agents with missing required skills', () => {
    const agentsDir = path.join(TEST_CWD, '.agent-portal', 'agents');
    fs.mkdirSync(agentsDir, { recursive: true });
    fs.writeFileSync(path.join(agentsDir, 'broken.md'), `---
name: broken
skills:
  - missing-skill
---
Agent body`);

    assert.equal(resolveAgent(TEST_CWD, 'broken'), null);
  });

  it('can exclude the current orchestrator from the injected agent catalog', () => {
    const agentsDir = path.join(TEST_CWD, '.agent-portal', 'agents');
    fs.mkdirSync(agentsDir, { recursive: true });
    fs.writeFileSync(path.join(agentsDir, 'orchestrator.md'), `---
name: orchestrator
role: orchestrator
resource_group: reasoning-heavy
---
Orchestrator body`);
    fs.writeFileSync(path.join(agentsDir, 'backend-engineer.md'), `---
name: backend-engineer
role: executor
resource_group: implementation
description: Implements backend code
---
Backend body`);

    const catalog = buildAgentCatalog(TEST_CWD, { excludeSlug: 'orchestrator' });

    assert.doesNotMatch(catalog, /- \*\*orchestrator\*\*/);
    assert.match(catalog, /backend-engineer/);
  });
});
