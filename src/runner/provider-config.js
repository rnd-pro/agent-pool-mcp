// @ctx provider-config.ctx
//
// Provider Config Manager — pass portal URL without project file pollution.
//
// Some providers support explicit config injection:
//   - OpenCode: OPENCODE_CONFIG -> temp config file
//   - Claude Code: --mcp-config → temp JSON file with config
//
// Pattern: pass process-local config → cleanup temp files when the provider requires files

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Header carrying the per-task secret on the spawned agent's MCP HTTP requests.
// The portal resolves it to a server-verified slug; a body-supplied agent_slug is
// never trusted as identity. Must match the portal handler that reads it.
const TASK_SECRET_HEADER = 'X-Agent-Portal-Task-Secret';

/**
 * Build Antigravity CLI env overrides.
 * Antigravity's documented MCP config locations are global/workspace files, not
 * an isolated env-var home, so the runner passes the resolved portal URL without
 * writing workspace files. Antigravity carries only a URL env var and no MCP
 * config file, so it cannot send the per-task secret header — its connections
 * resolve to the anonymous read-only principal at the portal.
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
 * Create a process-local OpenCode config file with the portal URL.
 * This preserves the user's OpenCode auth store while adding the portal MCP.
 * When a per-task secret is supplied it is attached as a request header so the
 * portal can verify the agent's identity; absent it, no headers are written and
 * the connection resolves to the anonymous read-only principal.
 *
 * @param {string} portalUrl - Portal MCP URL
 * @param {string} [taskSecret] - Per-task secret for verified identity
 * @returns {{ envOverrides: object, tmpDir: string }}
 */
export function createOpenCodeEnv(portalUrl, taskSecret) {
  let tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-hub-'));
  let configPath = path.join(tmpDir, 'opencode.json');
  let config = {
    $schema: 'https://opencode.ai/config.json',
    mcp: {
      'agent-portal': {
        type: 'remote',
        url: portalUrl,
        enabled: true,
        oauth: false,
        ...(taskSecret ? { headers: { [TASK_SECRET_HEADER]: taskSecret } } : {}),
      },
    },
  };

  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

  return {
    tmpDir,
    envOverrides: {
      OPENCODE_CONFIG: configPath,
    },
  };
}

/**
 * Create an isolated Claude Code MCP config with portal URL.
 * Claude Code loads explicit config files with --mcp-config.
 * When a per-task secret is supplied it is attached as a request header so the
 * portal can verify the agent's identity; absent it, no headers are written and
 * the connection resolves to the anonymous read-only principal.
 *
 * @param {string} portalUrl - Portal MCP URL
 * @param {string} [taskSecret] - Per-task secret for verified identity
 * @returns {{ configPath: string, tmpDir: string }}
 */
export function createClaudeMcpConfig(portalUrl, taskSecret) {
  let tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-hub-'));
  let configPath = path.join(tmpDir, 'mcp.json');

  let config = {
    mcpServers: {
      'agent-portal': {
        type: 'http',
        url: portalUrl,
        ...(taskSecret ? { headers: { [TASK_SECRET_HEADER]: taskSecret } } : {}),
      },
    },
  };

  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

  return { configPath, tmpDir };
}

/**
 * Create an isolated Kimi Code home directory with portal MCP injection.
 * Kimi Code reads all runtime data from KIMI_CODE_HOME: config.toml holds
 * permission rules, mcp.json holds MCP server declarations, credentials/
 * holds OAuth login state. The runner points KIMI_CODE_HOME at this directory
 * so worker agents inherit the user's login but not their full config.
 * Sub-agent tools (Agent/AgentSwarm) are denied so pool workers cannot spawn
 * unmanaged nested agents.
 * When a per-task secret is supplied it is attached as a request header so the
 * portal can verify the agent's identity; absent it, no headers are written and
 * the connection resolves to the anonymous read-only principal.
 *
 * @param {string} [portalUrl] - Portal MCP URL; mcp.json is only written when set
 * @param {string} [taskSecret] - Per-task secret for verified identity
 * @param {string} [chatId] - Chat id (reserved for future use)
 * @returns {{ kimiHomeDir: string, tmpDir: string }}
 */
export function createKimiHomeDir(portalUrl, taskSecret, chatId) {
  let tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-hub-'));

  // Base the isolated config on the user's own config.toml (provider/oauth
  // references live there), then append the pool's permission rules.
  let userHome = process.env.KIMI_CODE_HOME || path.join(os.homedir(), '.kimi-code');
  let baseConfig = '';
  try {
    baseConfig = fs.readFileSync(path.join(userHome, 'config.toml'), 'utf8').trimEnd();
  } catch { /* no user config — start empty */ }

  let permissionBlock = [
    '',
    '# Agent Portal pool rules: pool workers must not spawn unmanaged nested agents.',
    '[[permission.rules]]',
    'decision = "deny"',
    'pattern = "Agent"',
    '',
    '[[permission.rules]]',
    'decision = "deny"',
    'pattern = "AgentSwarm"',
    '',
  ].join('\n');

  fs.writeFileSync(path.join(tmpDir, 'config.toml'), (baseConfig ? baseConfig + '\n' : '') + permissionBlock);

  if (portalUrl) {
    let mcpConfig = {
      mcpServers: {
        'agent-portal-chat': {
          url: portalUrl,
          ...(taskSecret ? { headers: { [TASK_SECRET_HEADER]: taskSecret } } : {}),
        },
      },
    };
    fs.writeFileSync(path.join(tmpDir, 'mcp.json'), JSON.stringify(mcpConfig, null, 2));
  }

  // Carry over OAuth login state so the isolated home stays authenticated.
  let credentialsSrc = path.join(userHome, 'credentials');
  if (fs.existsSync(credentialsSrc)) {
    try {
      fs.cpSync(credentialsSrc, path.join(tmpDir, 'credentials'), { recursive: true });
    } catch { /* non-critical — the run falls back to whatever auth remains */ }
  }

  return { kimiHomeDir: tmpDir, tmpDir };
}

const CLAUDE_DIRECT_ENV_KEYS = [
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_CUSTOM_HEADERS',
  'ANTHROPIC_VERTEX_BASE_URL',
  'ANTHROPIC_BEDROCK_BASE_URL',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY',
];

/**
 * @param {object} [baseEnv]
 * @returns {object}
 */
export function createClaudeDirectEnv(baseEnv = process.env) {
  let env = { ...baseEnv };
  for (let key of CLAUDE_DIRECT_ENV_KEYS) {
    delete env[key];
  }
  return env;
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
