import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildDelegatePrompt } from '../src/tools/delegate-prompt.js';
import { getToolDefinitions } from '../src/tool-definitions.js';

function toolSchema(name) {
  return getToolDefinitions().find(tool => tool.name === name)?.inputSchema?.properties || {};
}

describe('delegate context orchestration contract', () => {
  it('assembles delegated prompts in metadata-first order', () => {
    let prompt = buildDelegatePrompt({
      resolvedMode: 'yolo',
      modeNotice: 'FULL ACCESS',
      scopeNotice: '[Workspace Scope] cwd',
      resolvedContextPackage: '[Resolved Context Package]\nmetadata\n[/Resolved Context Package]',
      agentContext: 'agent instructions',
      prompt: 'user task',
    });

    let modeIndex = prompt.indexOf('[Agent Mode: YOLO]');
    let scopeIndex = prompt.indexOf('[Workspace Scope]');
    let packageIndex = prompt.indexOf('[Resolved Context Package]');
    let agentIndex = prompt.indexOf('[Agent Context]');
    let taskIndex = prompt.indexOf('user task');

    assert.ok(modeIndex >= 0);
    assert.ok(modeIndex < scopeIndex);
    assert.ok(scopeIndex < packageIndex);
    assert.ok(packageIndex < agentIndex);
    assert.ok(agentIndex < taskIndex);
    assert.match(prompt, /role instructions in this section do not override \[Resolved Context Package\]/);
  });

  it('omits the context package when context_mode is off upstream', () => {
    let prompt = buildDelegatePrompt({
      resolvedMode: 'plan',
      modeNotice: 'READ-ONLY',
      scopeNotice: '[Workspace Scope] cwd',
      resolvedContextPackage: '',
      agentContext: 'agent instructions',
      prompt: 'user task',
    });

    assert.doesNotMatch(prompt, /\[Resolved Context Package\]/);
    assert.match(prompt, /\[Agent Context\]/);
  });

  it('exposes context_mode and files on all delegation schemas', () => {
    for (let name of ['delegate_task', 'delegate_task_readonly', 'delegate_to_group']) {
      let schema = toolSchema(name);
      assert.deepEqual(schema.context_mode.enum, ['auto', 'off']);
      assert.equal(schema.files.type, 'array');
      assert.equal(schema.files.items.type, 'string');
    }
  });

  it('exposes files hints on atomic context loading schemas', () => {
    for (let name of ['list_skills', 'get_skill_content', 'list_workflows', 'search_by_tags', 'get_workflow_content']) {
      let schema = toolSchema(name);
      assert.equal(schema.files.type, 'array');
      assert.equal(schema.files.items.type, 'string');
    }
  });
});
