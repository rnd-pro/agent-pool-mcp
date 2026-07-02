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

function withPortalConfig(configPath, fn) {
  const previousMemoryRoot = process.env.AGENT_PORTAL_MEMORY_ROOT;
  const previousSkillsRoot = process.env.AGENT_PORTAL_SKILLS_ROOT;
  const previousConfigPath = process.env.PORTAL_CONFIG_PATH;
  delete process.env.AGENT_PORTAL_MEMORY_ROOT;
  delete process.env.AGENT_PORTAL_SKILLS_ROOT;
  process.env.PORTAL_CONFIG_PATH = configPath;
  try {
    return fn();
  } finally {
    if (previousMemoryRoot === undefined) delete process.env.AGENT_PORTAL_MEMORY_ROOT;
    else process.env.AGENT_PORTAL_MEMORY_ROOT = previousMemoryRoot;
    if (previousSkillsRoot === undefined) delete process.env.AGENT_PORTAL_SKILLS_ROOT;
    else process.env.AGENT_PORTAL_SKILLS_ROOT = previousSkillsRoot;
    if (previousConfigPath === undefined) delete process.env.PORTAL_CONFIG_PATH;
    else process.env.PORTAL_CONFIG_PATH = previousConfigPath;
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

    const meta = withMemoryRoot(path.join(TEST_CWD, '.agent-portal'), () => resolveAgentMetadata(TEST_CWD, 'reviewer'));

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

    const agent = withMemoryRoot(path.join(TEST_CWD, '.agent-portal'), () => resolveAgent(TEST_CWD, 'qa'));

    assert.ok(agent);
    assert.deepStrictEqual(agent.skills, ['qa-skill']);
    assert.match(agent.prompt, /Required QA skill content/);
    assert.match(agent.prompt, /Agent body/);
    assert.match(agent.prompt, /Inline guidance content/);
    assert.ok(agent.prompt.indexOf('Required QA skill content') < agent.prompt.indexOf('Agent body'));
  });

  it('composes agent prompts from configured skills root', () => {
    const memoryRoot = path.join(TEST_CWD, 'configured-memory');
    const agentsDir = path.join(memoryRoot, 'agents');
    const skillsRoot = path.join(TEST_CWD, 'configured-skills');
    const configPath = path.join(TEST_CWD, 'configured-agent-portal.json');
    fs.mkdirSync(agentsDir, { recursive: true });
    fs.mkdirSync(path.join(skillsRoot, 'agents'), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify({
      agentPortal: {
        teamMemoryRoot: memoryRoot,
        skillsRoot,
      },
    }));
    fs.writeFileSync(path.join(skillsRoot, 'agents', 'configured-skill.md'), `---
name: configured-skill
description: Configured skill contract
---
Configured skill content.`);
    fs.writeFileSync(path.join(agentsDir, 'configured.md'), `---
name: configured
skills:
  - configured-skill
---
Agent body`);

    const agent = withPortalConfig(configPath, () => resolveAgent(TEST_CWD, 'configured'));

    assert.ok(agent);
    assert.deepStrictEqual(agent.skills, ['configured-skill']);
    assert.match(agent.prompt, /Configured skill content/);
    assert.match(agent.prompt, /Agent body/);
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

    assert.equal(withMemoryRoot(path.join(TEST_CWD, '.agent-portal'), () => resolveAgent(TEST_CWD, 'broken')), null);
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

    const catalog = withMemoryRoot(path.join(TEST_CWD, '.agent-portal'), () => buildAgentCatalog(TEST_CWD, { excludeSlug: 'orchestrator' }));

    assert.doesNotMatch(catalog, /- \*\*orchestrator\*\*/);
    assert.match(catalog, /backend-engineer/);
  });
});
