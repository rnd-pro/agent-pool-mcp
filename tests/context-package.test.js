import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { buildResolvedContextPackage, resolveContext } from '../context.js';
import { getSkillContent } from '../src/tools/skills.js';
import { handleGetWorkflowContent } from '../src/tools/workflow-tools.js';

let tempDirs = [];
let savedMemoryRoot;

function makeProject() {
  let cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-context-package-'));
  tempDirs.push(cwd);
  process.env.AGENT_PORTAL_MEMORY_ROOT = path.join(cwd, '.agent-portal');
  fs.writeFileSync(path.join(cwd, 'package.json'), '{}');

  let portal = path.join(cwd, '.agent-portal');
  fs.mkdirSync(path.join(portal, 'contexts', 'global'), { recursive: true });
  fs.writeFileSync(path.join(portal, 'contexts', 'global', 'core.md'), `---
id: global-core
scope: global
related_skills:
  - skills/code/context-discipline.md
related_workflows:
  - workflows/code/review.md
---
# Core`);

  fs.mkdirSync(path.join(portal, 'skills', 'code'), { recursive: true });
  fs.writeFileSync(path.join(portal, 'skills', 'code', 'context-discipline.md'), `---
name: context-discipline
description: Use metadata first for server implementation routing.
category: code
tags: [server, context]
token_cost: low
---
FULL MARKDOWN BODY MUST NOT APPEAR`);

  fs.mkdirSync(path.join(portal, 'workflows', 'code'), { recursive: true });
  fs.writeFileSync(path.join(portal, 'workflows', 'code', 'review.md'), `---
name: review
description: Review implementation with metadata-first context.
tags: [server]
---
# Review`);

  let workspaceRoot = path.join(portal, 'workspace', 'demo');
  fs.mkdirSync(path.join(workspaceRoot, 'skills'), { recursive: true });
  fs.writeFileSync(path.join(workspaceRoot, 'context.md'), `---
id: demo
scope: project
activation:
  anyFiles:
    - src/demo.js
related_skills:
  - workspace/demo/skills/demo-skill.md
related_workflows:
  - workspace/demo/workflows/demo-flow.md
---
# Demo`);
  fs.writeFileSync(path.join(workspaceRoot, 'skills', 'demo-skill.md'), `---
name: demo-skill
description: Demo workspace implementation invariant.
category: workspace
tags: [server]
token_cost: low
---
DEMO FULL BODY MUST NOT APPEAR`);
  fs.mkdirSync(path.join(workspaceRoot, 'workflows'), { recursive: true });
  fs.writeFileSync(path.join(workspaceRoot, 'workflows', 'demo-flow.md'), `---
name: demo-flow
description: Demo workspace workflow.
tags: [server]
---
DEMO WORKFLOW BODY`);

  return cwd;
}

describe('resolved context package', () => {
  beforeEach(() => {
    savedMemoryRoot = process.env.AGENT_PORTAL_MEMORY_ROOT;
  });

  afterEach(() => {
    for (let dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
    if (savedMemoryRoot === undefined) delete process.env.AGENT_PORTAL_MEMORY_ROOT;
    else process.env.AGENT_PORTAL_MEMORY_ROOT = savedMemoryRoot;
  });

  it('exports the same resolver shape through the package-level API', () => {
    let cwd = makeProject();
    let result = resolveContext({ cwd, task: 'fix server route', files: ['src/server.js'] });

    assert.ok(Array.isArray(result.contexts));
    assert.ok(Array.isArray(result.skills));
    assert.ok(result.contextPolicy.scanContextMetadataFrom.includes('.agent-portal/workspace/*/context.md'));
  });

  it('formats compact metadata without markdown bodies and respects max size', () => {
    let cwd = makeProject();
    let { text, plan } = buildResolvedContextPackage({
      cwd,
      task: 'fix server route',
      files: ['src/server.js'],
      max_chars: 1200,
    });

    assert.ok(text.length <= 1200);
    assert.match(text, /^\[Resolved Context Package\]/);
    assert.match(text, /Precedence:/);
    assert.match(text, /global-core/);
    assert.match(text, /context-discipline/);
    assert.match(text, /review/);
    assert.doesNotMatch(text, /FULL MARKDOWN BODY MUST NOT APPEAR/);
    assert.equal(plan.contexts.some(context => context.id === 'global-core'), true);
  });

  it('keeps the context package under the 6000 character hard cap', () => {
    let cwd = makeProject();
    let skillDir = path.join(cwd, '.agent-portal', 'skills', 'code');
    for (let i = 0; i < 80; i++) {
      fs.writeFileSync(path.join(skillDir, `bulk-${i}.md`), `---
name: bulk-${i}
description: ${'Long server metadata description. '.repeat(20)}
category: code
tags: [server]
token_cost: low
---
Body ${i}`);
    }

    let { text } = buildResolvedContextPackage({
      cwd,
      task: 'fix server routing',
      files: ['src/server.js'],
      max_skills: 200,
      max_chars: 10000,
    });

    assert.ok(text.length <= 6000);
  });

  it('uses files[] to activate workspace contexts and focus files', () => {
    let cwd = makeProject();
    let { text, plan } = buildResolvedContextPackage({
      cwd,
      task: 'debug demo server behavior',
      files: ['src/demo.js'],
    });

    assert.ok(plan.contexts.some(context => context.workspace === 'demo'));
    assert.ok(plan.skills.some(skill => skill.name === 'demo-skill'));
    assert.ok(plan.workflows.some(workflow => workflow.id === 'demo/demo-flow'));
    assert.match(text, /workspace=demo/);
    assert.match(text, /Focus files:\n- src\/demo\.js/);
    assert.doesNotMatch(text, /DEMO FULL BODY MUST NOT APPEAR/);
  });

  it('keeps files[] in atomic load handles for file-activated workspace items', () => {
    let cwd = makeProject();
    let result = resolveContext({
      cwd,
      task: 'debug demo server behavior',
      files: ['src/demo.js'],
      mode: 'items',
    });

    let skillItem = result.items.find(item => item.type === 'skill' && item.title === 'demo-skill');
    let workflowItem = result.items.find(item => item.type === 'workflow' && item.id === 'workflow:demo/demo-flow');

    assert.deepEqual(skillItem.args.files, ['src/demo.js']);
    assert.deepEqual(workflowItem.args.files, ['src/demo.js']);
    assert.equal(getSkillContent(cwd, 'demo-skill', { files: skillItem.args.files }).name, 'demo-skill');

    let workflow = handleGetWorkflowContent({
      cwd,
      nodeId: 'demo/demo-flow',
      files: workflowItem.args.files,
    });
    assert.equal(workflow.isError, undefined);
    assert.match(workflow.content[0].text, /DEMO WORKFLOW BODY/);
  });

  it('formats compact project graph focus context when provided by the portal', () => {
    let cwd = makeProject();
    let { text } = buildResolvedContextPackage({
      cwd,
      task: 'update route orchestration',
      files: ['src/demo.js'],
      focus_graph: {
        files: ['src/demo.js'],
        symbols: [{
          id: 'DR',
          name: 'DemoRoute',
          type: 'C',
          file: 'src/demo.js',
          line: 12,
          methods: ['h'],
        }],
        imports: [{
          file: 'src/demo.js',
          sources: ['node:path', './service.js'],
        }],
        web: [{
          symbol: 'DR',
          tag: 'demo-route',
          file: 'src/demo.js',
          template: 'src/demo.tpl.js',
          style: 'src/demo.css.js',
          children: ['child-card'],
          events: ['click'],
          dispatches: ['route-ready'],
          subscriptions: ['route/items'],
          bindings: ['onclick:onRouteClick'],
          tokens: ['--sn-text'],
        }],
        dependencies: [{
          symbol: 'DR',
          imports: ['node:path'],
          usedBy: ['App'],
          calls: ['Svc.handle'],
          files: ['src/demo.tpl.js', 'src/demo.css.js'],
          elements: ['CC'],
        }],
      },
    });

    assert.match(text, /Focus files:\n- src\/demo\.js/);
    assert.match(text, /Focus graph:/);
    assert.match(text, /DR \(DemoRoute\) type=C file=src\/demo\.js:12 methods=1/);
    assert.match(text, /src\/demo\.js <- node:path, \.\/service\.js/);
    assert.match(text, /DR tag=demo-route file=src\/demo\.js template=src\/demo\.tpl\.js style=src\/demo\.css\.js/);
    assert.match(text, /children=child-card events=click dispatches=route-ready subscriptions=route\/items bindings=onclick:onRouteClick tokens=--sn-text/);
    assert.match(text, /DR imports=node:path usedBy=App calls=Svc\.handle files=src\/demo\.tpl\.js,src\/demo\.css\.js elements=CC/);
  });

  it('does not read legacy project context, workspace skill, or workspace workflow directories', () => {
    let cwd = makeProject();
    let portal = path.join(cwd, '.agent-portal');
    fs.mkdirSync(path.join(portal, 'contexts', 'projects'), { recursive: true });
    fs.writeFileSync(path.join(portal, 'contexts', 'projects', 'legacy.md'), `---
id: legacy-project
scope: project
activation:
  anyFiles:
    - src/legacy.js
related_skills:
  - skills/workspace/legacy-skill.md
related_workflows:
  - workflows/workspace/legacy-workflow.md
---
# Legacy`);
    fs.mkdirSync(path.join(portal, 'skills', 'workspace'), { recursive: true });
    fs.writeFileSync(path.join(portal, 'skills', 'workspace', 'legacy-skill.md'), `---
name: legacy-skill
description: Legacy skill must not load.
category: workspace
tags: [server]
---
Legacy skill`);
    fs.mkdirSync(path.join(portal, 'workflows', 'workspace'), { recursive: true });
    fs.writeFileSync(path.join(portal, 'workflows', 'workspace', 'legacy-workflow.md'), `---
name: legacy-workflow
description: Legacy workflow must not load.
tags: [server]
---
Legacy workflow`);

    let { text, plan } = buildResolvedContextPackage({
      cwd,
      task: 'debug legacy server behavior',
      files: ['src/legacy.js'],
    });

    assert.equal(plan.contexts.some(context => context.id === 'legacy-project'), false);
    assert.equal(plan.skills.some(skill => skill.name === 'legacy-skill'), false);
    assert.equal(plan.workflows.some(workflow => workflow.id.includes('legacy-workflow')), false);
    assert.doesNotMatch(text, /legacy-project|legacy-skill|legacy-workflow/);
  });
});
