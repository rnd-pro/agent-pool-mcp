// @ctx provider-config.ctx
//
// Provider Config Manager — pass portal URL without project file pollution.
//
// Some providers support isolated config directories or explicit config files:
//   - OpenCode: OPENCODE_HOME -> temp dir with config
//   - Claude Code: --mcp-config → temp JSON file with config
//
// Pattern: create temp → set env → cleanup temp on exit

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { resolvePortalUrl } from './url-resolver.js';

/**
 * Build Antigravity CLI env overrides.
 * Antigravity's documented MCP config locations are global/workspace files, not
 * an isolated env-var home, so the runner passes the resolved portal URL without
 * writing workspace files.
 *
 * @param {string} portalUrl - Portal MCP URL (e.g. "http://portal.local/mcp")
 * @returns {{ envOverrides: object, tmpDir: null }}
 */
export function createAntigravityEnv(portalUrl) {
  return {
    tmpDir: null,
    envOverrides: {
      PORTAL_MCP_URL: portalUrl,
    },
  };
}

function isWritableDirectory(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    let probe = path.join(dir, '.agent-pool-write-test');
    fs.writeFileSync(probe, '');
    fs.rmSync(probe, { force: true });
    return true;
  } catch {
    return false;
  }
}

function defaultNpmCacheDir() {
  let userPart = typeof process.getuid === 'function'
    ? `uid-${process.getuid()}`
    : 'user';
  return path.join(os.tmpdir(), 'agent-pool-npm-cache', userPart);
}

/**
 * @param {object} baseEnv
 * @returns {object}
 */
export function createProviderRuntimeEnv(baseEnv = process.env) {
  let candidate = baseEnv.AGENT_POOL_NPM_CACHE
    || baseEnv.NPM_CONFIG_CACHE
    || baseEnv.npm_config_cache
    || null;
  let npmCache = candidate && isWritableDirectory(candidate)
    ? candidate
    : defaultNpmCacheDir();

  if (!isWritableDirectory(npmCache)) {
    return { ...baseEnv };
  }

  return {
    ...baseEnv,
    NPM_CONFIG_CACHE: npmCache,
    npm_config_cache: npmCache,
  };
}

/**
 * Create an isolated OpenCode config with portal URL.
 * Returns env vars to set on the spawn — NO project file pollution.
 *
 * @param {string} portalUrl - Portal MCP URL
 * @returns {{ envOverrides: object, tmpDir: string }}
 */
export function createOpenCodeEnv(portalUrl) {
  let tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-hub-'));
  let configPath = path.join(tmpDir, 'config.json');

  let config = {
    mcp: {
      servers: {
        'agent-portal': { type: 'sse', url: portalUrl },
      },
    },
  };

  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

  return {
    tmpDir,
    envOverrides: {
      OPENCODE_HOME: tmpDir,
    },
  };
}

/**
 * Create an isolated Claude Code MCP config with portal URL.
 * Claude Code loads explicit config files with --mcp-config.
 *
 * @param {string} portalUrl - Portal MCP URL
 * @returns {{ configPath: string, tmpDir: string }}
 */
export function createClaudeMcpConfig(portalUrl) {
  let tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-hub-'));
  let configPath = path.join(tmpDir, 'mcp.json');

  let config = {
    mcpServers: {
      'agent-portal': {
        type: 'http',
        url: portalUrl,
      },
    },
  };

  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

  return { configPath, tmpDir };
}

function toAnthropicBaseUrl(portalUrl) {
  try {
    let url = new URL(portalUrl);
    url.search = '';
    url.hash = '';
    url.pathname = '/anthropic';
    return url.toString().replace(/\/$/, '');
  } catch {
    return null;
  }
}

function readPortalConfig() {
  let configPath = process.env.PORTAL_CONFIG_PATH
    || path.join(os.homedir(), '.agent-portal', 'agent-portal.json');
  if (!fs.existsSync(configPath)) return {};
  try { return JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch { return {}; }
}

/**
 * Build Claude Code gateway env overrides when portal anthropicGateway is enabled.
 * @param {string|null} portalUrl - Portal MCP URL
 * @returns {object}
 */
export function getClaudeGatewayEnv(portalUrl) {
  let portalConfig = readPortalConfig();
  let gateway = portalConfig.anthropicGateway || portalConfig.settings?.anthropicGateway || null;
  if (!gateway?.enabled) return {};

  let resolvedPortalUrl = portalUrl || resolvePortalUrl();
  let baseUrl = gateway.baseUrl || (resolvedPortalUrl ? toAnthropicBaseUrl(resolvedPortalUrl) : null);
  if (!baseUrl) return {};

  return {
    ANTHROPIC_BASE_URL: baseUrl,
    ANTHROPIC_AUTH_TOKEN: gateway.authToken || process.env.ANTHROPIC_GATEWAY_AUTH_TOKEN || 'portal-local',
    CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: '1',
  };
}

/**
 * Remove temp config directory.
 * @param {string} tmpDir
 */
export function cleanupTmpConfig(tmpDir) {
  if (!tmpDir || !tmpDir.includes('hub-')) return; // safety guard
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch { /* non-critical */ }
}

/** @deprecated Use createOpenCodeEnv instead */
export function injectOpenCodeConfig(cwd, portalUrl) {
  let configPath = path.join(cwd, 'opencode.json');
  let backupPath = configPath + '.bak';
  let existing = {};
  if (fs.existsSync(configPath)) {
    try { existing = JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch {}
    if (!existing.__portal_injected__ && !fs.existsSync(backupPath)) {
      fs.copyFileSync(configPath, backupPath);
    }
  }
  let injected = { ...existing };
  injected.mcp = { servers: { 'agent-portal': { type: 'sse', url: portalUrl } } };
  injected.__portal_injected__ = true;
  fs.writeFileSync(configPath, JSON.stringify(injected, null, 2));
}

/** @deprecated Use cleanupTmpConfig instead */
export function cleanupOpenCodeConfig(cwd) {
  let configPath = path.join(cwd, 'opencode.json');
  let backupPath = configPath + '.bak';
  if (fs.existsSync(backupPath)) {
    fs.copyFileSync(backupPath, configPath);
    fs.unlinkSync(backupPath);
  } else if (fs.existsSync(configPath)) {
    try {
      let data = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      if (data.__portal_injected__) fs.unlinkSync(configPath);
    } catch {}
  }
}
