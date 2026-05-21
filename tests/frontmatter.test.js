import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { parseFrontmatter as parseSkillFrontmatter } from '../src/tools/markdown-parser.js';
import { parseFrontmatter as parseWorkflowFrontmatter } from '../src/tools/workflow-index.js';
import { listSkills } from '../src/tools/skills.js';
import { resolveAgent, resolveAgentMetadata } from '../src/agents/agent-resolver.js';

const TEST_CWD = path.join(os.tmpdir(), `agent-pool-frontmatter-${Date.now()}`);

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

    const skill = listSkills(TEST_CWD).find(item => item.name === 'nested-skill');

    assert.ok(skill);
    assert.deepStrictEqual(skill.tags, ['context', 'parser']);
    assert.deepStrictEqual(skill.appliesTo, { paths: ['src/node'] });
    assert.equal(skill.tokenCost, 'small');
    assert.equal(skill.autoload, false);
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
approval_mode: plan
---
Agent body`);

    const meta = resolveAgentMetadata(TEST_CWD, 'reviewer');

    assert.equal(meta.slug, 'reviewer');
    assert.equal(meta.role, 'orchestrator');
    assert.equal(meta.resourceGroup, 'deepseek-pro-audit');
    assert.deepStrictEqual(meta.models, ['deepseek/deepseek-v4-pro']);
    assert.deepStrictEqual(meta.contextTags, ['review', 'gateway']);
    assert.equal(meta.approvalMode, 'plan');
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
});
