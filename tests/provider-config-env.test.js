import { describe, it, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('Provider Config Injector', () => {
  let tmpDirsToCleanup = [];

  afterEach(() => {
    for (let dir of tmpDirsToCleanup) {
      if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    }
    tmpDirsToCleanup = [];
  });

  it('createAntigravityEnv returns portal URL env overrides without writing project config', async () => {
    let { createAntigravityEnv } = await import('../src/runner/provider-config.js');
    
    let { tmpDir, envOverrides } = createAntigravityEnv('http://portal.local/mcp');

    assert.equal(tmpDir, null);
    assert.deepEqual(envOverrides, { PORTAL_MCP_URL: 'http://portal.local/mcp' });
  });

  it('createProviderRuntimeEnv preserves a writable explicit npm cache', async () => {
    let { createProviderRuntimeEnv } = await import('../src/runner/provider-config.js');
    let npmCache = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-pool-npm-cache-test-'));
    tmpDirsToCleanup.push(npmCache);

    let env = createProviderRuntimeEnv({ AGENT_POOL_NPM_CACHE: npmCache });

    assert.equal(env.NPM_CONFIG_CACHE, npmCache);
    assert.equal(env.npm_config_cache, npmCache);
    fs.writeFileSync(path.join(env.NPM_CONFIG_CACHE, 'probe'), 'ok');
  });

  it('createProviderRuntimeEnv replaces non-writable npm cache settings', async () => {
    let { createProviderRuntimeEnv } = await import('../src/runner/provider-config.js');
    let blocked = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-pool-blocked-npm-cache-'));
    tmpDirsToCleanup.push(blocked);
    fs.chmodSync(blocked, 0o555);

    try {
      let env = createProviderRuntimeEnv({
        NPM_CONFIG_CACHE: blocked,
        npm_config_cache: blocked,
      });

      assert.notEqual(env.NPM_CONFIG_CACHE, blocked);
      assert.equal(env.npm_config_cache, env.NPM_CONFIG_CACHE);
      fs.writeFileSync(path.join(env.NPM_CONFIG_CACHE, 'probe'), 'ok');
    } finally {
      fs.chmodSync(blocked, 0o755);
    }
  });

  it('createOpenCodeEnv injects MCP config without isolating OpenCode auth', async () => {
    let { createOpenCodeEnv } = await import('../src/runner/provider-config.js');
    
    let { tmpDir, envOverrides } = createOpenCodeEnv('http://portal.local/mcp');
    tmpDirsToCleanup.push(tmpDir);

    assert.ok(tmpDir.includes('opencode-hub-'), 'Should be an opencode-hub temp dir');
    assert.equal('OPENCODE_HOME' in envOverrides, false);
    assert.equal(typeof envOverrides.OPENCODE_CONFIG, 'string');
    assert.equal(envOverrides.OPENCODE_CONFIG, path.join(tmpDir, 'opencode.json'));

    let config = JSON.parse(fs.readFileSync(envOverrides.OPENCODE_CONFIG, 'utf8'));
    assert.equal(config.$schema, 'https://opencode.ai/config.json');
    assert.ok(config.mcp, 'Should have mcp property');
    assert.ok(config.mcp['agent-portal'], 'Should have agent-portal entry');
    assert.equal(config.mcp['agent-portal'].url, 'http://portal.local/mcp');
    assert.equal(config.mcp['agent-portal'].type, 'remote');
    assert.equal(config.mcp['agent-portal'].enabled, true);
    assert.equal(config.mcp['agent-portal'].oauth, false);
    assert.equal('provider' in config, false);
  });

  it('createOpenCodeEnv can declare one exact process-local provider model without copying credentials', async () => {
    let { createOpenCodeEnv } = await import('../src/runner/provider-config.js');

    let { tmpDir, envOverrides } = createOpenCodeEnv('http://portal.local/mcp', 'secret-abc', {
      model: 'openrouter/stealth/ox-alpha',
      modelCatalogOverride: true,
    });
    tmpDirsToCleanup.push(tmpDir);

    let config = JSON.parse(fs.readFileSync(envOverrides.OPENCODE_CONFIG, 'utf8'));
    assert.deepEqual(config.provider, {
      openrouter: {
        models: {
          'stealth/ox-alpha': { name: 'stealth/ox-alpha' },
        },
      },
    });
    assert.equal(JSON.stringify(config).includes('API_KEY'), false);
    assert.equal(config.mcp['agent-portal'].headers['X-Agent-Portal-Task-Secret'], 'secret-abc');
  });

  it('createOpenCodeEnv embeds the task-secret header when a secret is supplied', async () => {
    let { createOpenCodeEnv } = await import('../src/runner/provider-config.js');

    let { tmpDir, envOverrides } = createOpenCodeEnv('http://portal.local/mcp', 'secret-abc');
    tmpDirsToCleanup.push(tmpDir);

    let config = JSON.parse(fs.readFileSync(envOverrides.OPENCODE_CONFIG, 'utf8'));
    assert.deepEqual(config.mcp['agent-portal'].headers, {
      'X-Agent-Portal-Task-Secret': 'secret-abc',
    });
  });

  it('createOpenCodeEnv omits the headers key when no secret is supplied', async () => {
    let { createOpenCodeEnv } = await import('../src/runner/provider-config.js');

    let { tmpDir, envOverrides } = createOpenCodeEnv('http://portal.local/mcp');
    tmpDirsToCleanup.push(tmpDir);

    let config = JSON.parse(fs.readFileSync(envOverrides.OPENCODE_CONFIG, 'utf8'));
    assert.equal('headers' in config.mcp['agent-portal'], false);
  });

  it('createClaudeMcpConfig embeds the task-secret header when a secret is supplied', async () => {
    let { createClaudeMcpConfig } = await import('../src/runner/provider-config.js');

    let { tmpDir, configPath } = createClaudeMcpConfig('http://portal.local/mcp', 'secret-xyz');
    tmpDirsToCleanup.push(tmpDir);

    let config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    assert.equal(config.mcpServers['agent-portal'].url, 'http://portal.local/mcp');
    assert.equal(config.mcpServers['agent-portal'].type, 'http');
    assert.deepEqual(config.mcpServers['agent-portal'].headers, {
      'X-Agent-Portal-Task-Secret': 'secret-xyz',
    });
  });

  it('createClaudeMcpConfig omits the headers key when no secret is supplied', async () => {
    let { createClaudeMcpConfig } = await import('../src/runner/provider-config.js');

    let { tmpDir, configPath } = createClaudeMcpConfig('http://portal.local/mcp');
    tmpDirsToCleanup.push(tmpDir);

    let config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    assert.equal('headers' in config.mcpServers['agent-portal'], false);
  });

  it('createClaudeDirectEnv removes proxy and API credentials from inherited env', async () => {
    let { createClaudeDirectEnv } = await import('../src/runner/provider-config.js');

    let env = createClaudeDirectEnv({
      ANTHROPIC_BASE_URL: 'http://proxy.local/anthropic',
      ANTHROPIC_AUTH_TOKEN: 'proxy-token',
      ANTHROPIC_API_KEY: 'api-key',
      ANTHROPIC_CUSTOM_HEADERS: 'x-test:1',
      CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: '1',
      CLAUDE_CODE_OAUTH_TOKEN: 'subscription-token',
      KEEP_ME: 'yes',
    });

    assert.equal('ANTHROPIC_BASE_URL' in env, false);
    assert.equal('ANTHROPIC_AUTH_TOKEN' in env, false);
    assert.equal('ANTHROPIC_API_KEY' in env, false);
    assert.equal('ANTHROPIC_CUSTOM_HEADERS' in env, false);
    assert.equal('CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY' in env, false);
    assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, 'subscription-token');
    assert.equal(env.KEEP_ME, 'yes');
  });

  it('cleanupTmpConfig removes the temporary directory', async () => {
    let { cleanupTmpConfig } = await import('../src/runner/provider-config.js');
    
    let tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-hub-'));
    assert.ok(fs.existsSync(tmpDir), 'Temp dir should exist initially');

    cleanupTmpConfig(tmpDir);
    assert.equal(fs.existsSync(tmpDir), false, 'Temp dir should be removed');
  });

  it('cleanupTmpConfig ignores paths without "hub-" safety marker', async () => {
    let { cleanupTmpConfig } = await import('../src/runner/provider-config.js');
    
    let safeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'safe-dir-'));
    tmpDirsToCleanup.push(safeDir); // cleanup at the end of test

    cleanupTmpConfig(safeDir);
    assert.ok(fs.existsSync(safeDir), 'Safe dir should NOT be removed due to missing "hub-" marker');
  });

});
