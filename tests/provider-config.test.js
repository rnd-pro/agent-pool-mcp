import assert from 'node:assert/strict';
import { test } from 'node:test';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

let importCount = 0;

async function importProviderConfig(config) {
  let tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'provider-config-test-'));
  let configPath = path.join(tmpDir, 'agent-portal.json');

  if (config !== null) {
    let content = typeof config === 'string' ? config : JSON.stringify(config);
    await fsp.writeFile(configPath, content);
  }

  let previousConfigPath = process.env.PORTAL_CONFIG_PATH;
  process.env.PORTAL_CONFIG_PATH = configPath;

  let module = await import(`../src/runner/provider-config.js?test=${importCount++}`);
  return { module, tmpDir, previousConfigPath };
}

function restoreConfigPath(previousConfigPath) {
  if (previousConfigPath === undefined) {
    delete process.env.PORTAL_CONFIG_PATH;
  } else {
    process.env.PORTAL_CONFIG_PATH = previousConfigPath;
  }
}

test('getClaudeGatewayEnv reads top-level gateway config', async (t) => {
  let { module, tmpDir, previousConfigPath } = await importProviderConfig({
    anthropicGateway: {
      enabled: true,
      baseUrl: 'http://portal.local/anthropic',
      authToken: 'configured-token',
    },
  });
  t.after(async () => {
    restoreConfigPath(previousConfigPath);
    await fsp.rm(tmpDir, { recursive: true, force: true });
  });

  assert.deepEqual(module.getClaudeGatewayEnv('http://ignored.local/mcp'), {
    ANTHROPIC_BASE_URL: 'http://portal.local/anthropic',
    ANTHROPIC_AUTH_TOKEN: 'configured-token',
    CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: '1',
  });
});

test('getClaudeGatewayEnv derives gateway base URL from portal URL', async (t) => {
  let { module, tmpDir, previousConfigPath } = await importProviderConfig({
    settings: {
      anthropicGateway: {
        enabled: true,
      },
    },
  });
  t.after(async () => {
    restoreConfigPath(previousConfigPath);
    await fsp.rm(tmpDir, { recursive: true, force: true });
  });

  assert.deepEqual(module.getClaudeGatewayEnv('http://portal.local/mcp?chatId=abc'), {
    ANTHROPIC_BASE_URL: 'http://portal.local/anthropic',
    ANTHROPIC_AUTH_TOKEN: 'portal-local',
    CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: '1',
  });
});

test('getClaudeGatewayEnv returns empty overrides for missing or invalid config', async (t) => {
  let missing = await importProviderConfig(null);
  let invalid = await importProviderConfig('{not json');
  t.after(async () => {
    restoreConfigPath(missing.previousConfigPath);
    await fsp.rm(missing.tmpDir, { recursive: true, force: true });
    await fsp.rm(invalid.tmpDir, { recursive: true, force: true });
  });

  assert.deepEqual(missing.module.getClaudeGatewayEnv('http://portal.local/mcp'), {});
  assert.deepEqual(invalid.module.getClaudeGatewayEnv('http://portal.local/mcp'), {});
});

test('getClaudeGatewayEnv rereads config for runtime updates', async (t) => {
  let tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'provider-config-test-'));
  let configPath = path.join(tmpDir, 'agent-portal.json');
  let previousConfigPath = process.env.PORTAL_CONFIG_PATH;
  process.env.PORTAL_CONFIG_PATH = configPath;
  t.after(async () => {
    if (previousConfigPath === undefined) {
      delete process.env.PORTAL_CONFIG_PATH;
    } else {
      process.env.PORTAL_CONFIG_PATH = previousConfigPath;
    }
    await fsp.rm(tmpDir, { recursive: true, force: true });
  });

  let module = await import(`../src/runner/provider-config.js?test=${importCount++}`);
  await fsp.writeFile(configPath, JSON.stringify({
    anthropicGateway: {
      enabled: true,
      baseUrl: 'http://first.local/anthropic',
      authToken: 'first-token',
    },
  }));
  assert.equal(module.getClaudeGatewayEnv(null).ANTHROPIC_AUTH_TOKEN, 'first-token');

  await fsp.writeFile(configPath, JSON.stringify({
    anthropicGateway: {
      enabled: true,
      baseUrl: 'http://second.local/anthropic',
      authToken: 'second-token',
    },
  }));
  assert.equal(module.getClaudeGatewayEnv(null).ANTHROPIC_AUTH_TOKEN, 'second-token');
});
