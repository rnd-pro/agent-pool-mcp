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

  it('createGeminiEnv creates isolated config and returns env overrides', async () => {
    let { createGeminiEnv } = await import('../src/runner/provider-config.js');
    
    let { tmpDir, envOverrides } = createGeminiEnv('http://portal.local/mcp');
    tmpDirsToCleanup.push(tmpDir);

    assert.ok(tmpDir.includes('gemini-hub-'), 'Should be a gemini-hub temp dir');
    assert.deepEqual(envOverrides, { GEMINI_CLI_HOME: tmpDir }, 'Should return GEMINI_CLI_HOME env var');
    
    let configPath = path.join(tmpDir, '.gemini', 'settings.json');
    assert.ok(fs.existsSync(configPath), 'Should create settings.json');
    
    let config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    assert.ok(config.mcpServers, 'Should have mcpServers');
    assert.ok(config.mcpServers['agent-portal'], 'Should have agent-portal entry');
    assert.equal(config.mcpServers['agent-portal'].url, 'http://portal.local/mcp');
  });

  it('createOpenCodeEnv creates isolated config and returns env overrides', async () => {
    let { createOpenCodeEnv } = await import('../src/runner/provider-config.js');
    
    let { tmpDir, envOverrides } = createOpenCodeEnv('http://portal.local/mcp');
    tmpDirsToCleanup.push(tmpDir);

    assert.ok(tmpDir.includes('opencode-hub-'), 'Should be an opencode-hub temp dir');
    assert.deepEqual(envOverrides, { OPENCODE_HOME: tmpDir }, 'Should return OPENCODE_HOME env var');
    
    let configPath = path.join(tmpDir, 'config.json');
    assert.ok(fs.existsSync(configPath), 'Should create config.json');
    
    let config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    assert.ok(config.mcp, 'Should have mcp property');
    assert.ok(config.mcp.servers, 'Should have mcp.servers');
    assert.ok(config.mcp.servers['agent-portal'], 'Should have agent-portal entry');
    assert.equal(config.mcp.servers['agent-portal'].url, 'http://portal.local/mcp');
    assert.equal(config.mcp.servers['agent-portal'].type, 'sse');
  });

  it('cleanupTmpConfig removes the temporary directory', async () => {
    let { createGeminiEnv, cleanupTmpConfig } = await import('../src/runner/provider-config.js');
    
    let { tmpDir } = createGeminiEnv('http://portal.local/mcp');
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

  it('getClaudeGatewayEnv returns Anthropic env when gateway is enabled', async () => {
    let oldConfigPath = process.env.PORTAL_CONFIG_PATH;
    let oldToken = process.env.ANTHROPIC_GATEWAY_AUTH_TOKEN;
    let configPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'portal-config-')), 'agent-portal.json');
    tmpDirsToCleanup.push(path.dirname(configPath));

    process.env.PORTAL_CONFIG_PATH = configPath;
    process.env.ANTHROPIC_GATEWAY_AUTH_TOKEN = 'env-token';
    fs.writeFileSync(configPath, JSON.stringify({ anthropicGateway: { enabled: true } }));

    try {
      let { getClaudeGatewayEnv } = await import('../src/runner/provider-config.js');
      let env = getClaudeGatewayEnv('http://localhost:1234/mcp');

      assert.equal(env.ANTHROPIC_BASE_URL, 'http://localhost:1234/anthropic');
      assert.equal(env.ANTHROPIC_AUTH_TOKEN, 'env-token');
      assert.equal(env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY, '1');
    } finally {
      if (oldConfigPath === undefined) delete process.env.PORTAL_CONFIG_PATH;
      else process.env.PORTAL_CONFIG_PATH = oldConfigPath;
      if (oldToken === undefined) delete process.env.ANTHROPIC_GATEWAY_AUTH_TOKEN;
      else process.env.ANTHROPIC_GATEWAY_AUTH_TOKEN = oldToken;
    }
  });

  it('getClaudeGatewayEnv can use configured gateway baseUrl without portal URL', async () => {
    let oldConfigPath = process.env.PORTAL_CONFIG_PATH;
    let oldToken = process.env.ANTHROPIC_GATEWAY_AUTH_TOKEN;
    let configPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'portal-config-')), 'agent-portal.json');
    tmpDirsToCleanup.push(path.dirname(configPath));

    process.env.PORTAL_CONFIG_PATH = configPath;
    delete process.env.ANTHROPIC_GATEWAY_AUTH_TOKEN;
    fs.writeFileSync(configPath, JSON.stringify({
      anthropicGateway: {
        enabled: true,
        baseUrl: 'http://127.0.0.1:3456/anthropic',
        authToken: 'configured-token',
      },
    }));

    try {
      let { getClaudeGatewayEnv } = await import('../src/runner/provider-config.js');
      let env = getClaudeGatewayEnv(null);

      assert.equal(env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:3456/anthropic');
      assert.equal(env.ANTHROPIC_AUTH_TOKEN, 'configured-token');
      assert.equal(env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY, '1');
    } finally {
      if (oldConfigPath === undefined) delete process.env.PORTAL_CONFIG_PATH;
      else process.env.PORTAL_CONFIG_PATH = oldConfigPath;
      if (oldToken === undefined) delete process.env.ANTHROPIC_GATEWAY_AUTH_TOKEN;
      else process.env.ANTHROPIC_GATEWAY_AUTH_TOKEN = oldToken;
    }
  });

  it('getClaudeGatewayEnv resolves portal URL when none is passed', async () => {
    let oldConfigPath = process.env.PORTAL_CONFIG_PATH;
    let oldPortalMcpUrl = process.env.PORTAL_MCP_URL;
    let configPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'portal-config-')), 'agent-portal.json');
    tmpDirsToCleanup.push(path.dirname(configPath));

    process.env.PORTAL_CONFIG_PATH = configPath;
    process.env.PORTAL_MCP_URL = 'http://localhost:7890/mcp';
    fs.writeFileSync(configPath, JSON.stringify({
      anthropicGateway: {
        enabled: true,
        authToken: 'resolved-token',
      },
    }));

    try {
      let { getClaudeGatewayEnv } = await import('../src/runner/provider-config.js');
      let env = getClaudeGatewayEnv(null);

      assert.equal(env.ANTHROPIC_BASE_URL, 'http://localhost:7890/anthropic');
      assert.equal(env.ANTHROPIC_AUTH_TOKEN, 'resolved-token');
    } finally {
      if (oldConfigPath === undefined) delete process.env.PORTAL_CONFIG_PATH;
      else process.env.PORTAL_CONFIG_PATH = oldConfigPath;
      if (oldPortalMcpUrl === undefined) delete process.env.PORTAL_MCP_URL;
      else process.env.PORTAL_MCP_URL = oldPortalMcpUrl;
    }
  });
});
