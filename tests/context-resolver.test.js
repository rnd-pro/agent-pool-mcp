import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

const PORTAL_ROOT = path.resolve('../..');

describe('context resolver', () => {
  it('classifies UI tasks without escalating to orchestrator profile', async () => {
    let { resolveContext } = await import('../src/tools/context-resolver.js');

    let result = resolveContext({
      cwd: PORTAL_ROOT,
      task: 'Fix AgentChat UI model selector in browser',
      agent_slug: 'ui-engineer',
      files: ['web/panels/AgentChat/AgentChat.js'],
      max_skills: 4,
    });

    assert.ok(result.zones.includes('ui'));
    assert.equal(result.toolProfile, 'implementation');
    assert.ok(result.skills.some(skill => skill.name === 'symbiote-components'));
  });

  it('classifies review tasks as read-only context', async () => {
    let { resolveContext } = await import('../src/tools/context-resolver.js');

    let result = resolveContext({
      cwd: PORTAL_ROOT,
      task: 'Review anthropic gateway DeepSeek provider routing',
      agent_slug: 'code-reviewer',
      files: ['src/node/server/anthropic-gateway.js'],
    });

    assert.ok(result.zones.includes('gateway'));
    assert.equal(result.toolProfile, 'review');
    assert.ok(result.skills.some(skill => skill.name === 'testing-discipline'));
  });

  it('does not treat fixed agent definitions as dynamic context', async () => {
    let { resolveContext } = await import('../src/tools/context-resolver.js');

    let result = resolveContext({
      cwd: PORTAL_ROOT,
      task: 'Update agent metadata defaults for approval mode',
      agent_slug: 'orchestrator',
      files: ['.agent-portal/agents/orchestrator.md'],
    });

    assert.ok(result.zones.includes('config'));
    assert.ok(!result.zones.includes('agent-system'));
    assert.ok(!result.tags.includes('agents'));
    assert.ok(!result.tags.includes('code-analysis-tools'));

    let itemsResult = resolveContext({
      cwd: PORTAL_ROOT,
      task: 'Update agent metadata defaults for approval mode',
      agent_slug: 'orchestrator',
      files: ['.agent-portal/agents/orchestrator.md'],
      mode: 'items',
    });
    assert.ok(!itemsResult.items.some(item => item.type === 'file-context' && item.title.startsWith('.agent-portal/agents/')));
  });

  it('classifies skill and workflow metadata without loading agent skills', async () => {
    let { resolveContext } = await import('../src/tools/context-resolver.js');

    let result = resolveContext({
      cwd: PORTAL_ROOT,
      task: 'Add skill tags and workflow resolver for dynamic context',
      agent_slug: 'backend-engineer',
      files: ['packages/agent-pool-mcp/src/tools/context-resolver.js', '.agent-portal/skills/code/error-handling.md'],
      max_skills: 6,
    });

    assert.ok(result.zones.includes('context-system'));
    assert.ok(result.zones.includes('workflow-system'));
    assert.equal(result.toolProfile, 'workflow');
    assert.ok(!result.tags.includes('async-patterns'));
    assert.ok(!result.skills.some(skill => skill.category === 'agents'));
  });

  it('returns atomic enrichment items without loading markdown content', async () => {
    let { resolveContext } = await import('../src/tools/context-resolver.js');

    let result = resolveContext({
      cwd: PORTAL_ROOT,
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

    let result = resolveContext({
      cwd: PORTAL_ROOT,
      task: 'Audit how Agent Portal uses Symbiote provider skills',
      agent_slug: 'code-reviewer',
      files: ['packages/symbiote-node/tree/TreeView/TreeView.js'],
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

    let skill = getSkillContent(PORTAL_ROOT, 'error-handling');

    assert.equal(skill.name, 'error-handling');
    assert.equal(skill.category, 'code');
    assert.match(skill.content, /No harmful fallbacks/);
  });
});
