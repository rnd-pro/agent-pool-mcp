import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { getSkillsRoot, getTeamMemoryRoot } from '../src/runtime/paths.js';

test('AGENT_PORTAL_MEMORY_ROOT env wins and resolves to absolute', () => {
  assert.equal(
    getTeamMemoryRoot({ AGENT_PORTAL_MEMORY_ROOT: '/tmp/tm-env' }),
    path.resolve('/tmp/tm-env'),
  );
});

test('config agentPortal.teamMemoryRoot is used when env is unset', () => {
  let dir = mkdtempSync(path.join(tmpdir(), 'tm-cfg-'));
  let cfg = path.join(dir, 'agent-portal.json');
  writeFileSync(cfg, JSON.stringify({ agentPortal: { teamMemoryRoot: '/srv/team-memory' } }));
  try {
    assert.equal(getTeamMemoryRoot({ PORTAL_CONFIG_PATH: cfg }), path.resolve('/srv/team-memory'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('returns null when neither env nor config is set (no cwd fallback)', () => {
  let dir = mkdtempSync(path.join(tmpdir(), 'tm-empty-'));
  let cfg = path.join(dir, 'agent-portal.json');
  try {
    assert.equal(getTeamMemoryRoot({ PORTAL_CONFIG_PATH: cfg }), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('config without teamMemoryRoot returns null', () => {
  let dir = mkdtempSync(path.join(tmpdir(), 'tm-partial-'));
  let cfg = path.join(dir, 'agent-portal.json');
  writeFileSync(cfg, JSON.stringify({ agentPortal: { openLibraryPath: '/x' } }));
  try {
    assert.equal(getTeamMemoryRoot({ PORTAL_CONFIG_PATH: cfg }), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('AGENT_PORTAL_SKILLS_ROOT env wins and resolves to absolute', () => {
  assert.equal(
    getSkillsRoot({ AGENT_PORTAL_SKILLS_ROOT: '/tmp/skills-env', AGENT_PORTAL_MEMORY_ROOT: '/tmp/tm-env' }),
    path.resolve('/tmp/skills-env'),
  );
});

test('config agentPortal.skillsRoot is used when env is unset', () => {
  let dir = mkdtempSync(path.join(tmpdir(), 'skills-cfg-'));
  let cfg = path.join(dir, 'agent-portal.json');
  writeFileSync(cfg, JSON.stringify({ agentPortal: { teamMemoryRoot: '/srv/team-memory', skillsRoot: '/srv/skills' } }));
  try {
    assert.equal(getSkillsRoot({ PORTAL_CONFIG_PATH: cfg }), path.resolve('/srv/skills'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('AGENT_PORTAL_MEMORY_ROOT env owns default skills root over config skillsRoot', () => {
  let dir = mkdtempSync(path.join(tmpdir(), 'skills-env-memory-'));
  let cfg = path.join(dir, 'agent-portal.json');
  writeFileSync(cfg, JSON.stringify({ agentPortal: { skillsRoot: '/srv/config-skills' } }));
  try {
    assert.equal(
      getSkillsRoot({ PORTAL_CONFIG_PATH: cfg, AGENT_PORTAL_MEMORY_ROOT: '/srv/env-team-memory' }),
      path.resolve('/srv/env-team-memory/skills'),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('skills root falls back to teamMemoryRoot skills directory', () => {
  let dir = mkdtempSync(path.join(tmpdir(), 'skills-fallback-'));
  let cfg = path.join(dir, 'agent-portal.json');
  writeFileSync(cfg, JSON.stringify({ agentPortal: { teamMemoryRoot: '/srv/team-memory' } }));
  try {
    assert.equal(getSkillsRoot({ PORTAL_CONFIG_PATH: cfg }), path.resolve('/srv/team-memory/skills'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('skills root returns null when no skills or team-memory root is configured', () => {
  let dir = mkdtempSync(path.join(tmpdir(), 'skills-empty-'));
  let cfg = path.join(dir, 'agent-portal.json');
  try {
    assert.equal(getSkillsRoot({ PORTAL_CONFIG_PATH: cfg }), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
