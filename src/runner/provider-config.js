// @ctx provider-config.ctx
//
// Provider Config Manager — inject portal URL via isolated config directories
//
// Instead of polluting project dirs with .gemini/settings.json, we create
// temp config directories and point providers to them via env vars:
//   - Gemini CLI: GEMINI_CLI_HOME → temp dir with settings.json
//   - OpenCode: OPENCODE_HOME → temp dir with config
//
// Pattern: create temp → set env → cleanup temp on exit

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/**
 * Create an isolated Gemini CLI config with portal URL.
 * Returns env vars to set on the spawn — NO project file pollution.
 *
 * @param {string} portalUrl - Portal MCP URL (e.g. "http://portal.local/mcp")
 * @returns {{ envOverrides: object, tmpDir: string }}
 */
export function createGeminiEnv(portalUrl) {
  let tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-hub-'));
  let geminiDir = path.join(tmpDir, '.gemini');
  fs.mkdirSync(geminiDir, { recursive: true });

  let defaultHome = process.env.GEMINI_CLI_HOME ? path.join(process.env.GEMINI_CLI_HOME, '.gemini') : path.join(os.homedir(), '.gemini');
  let existingConfig = {};

  if (fs.existsSync(defaultHome)) {
    let items = fs.readdirSync(defaultHome);
    for (let item of items) {
      if (item === 'settings.json') continue;
      if (item === 'tmp') continue; // Avoid recursive tmp links if any
      let src = path.join(defaultHome, item);
      let dest = path.join(geminiDir, item);
      try { fs.symlinkSync(src, dest); } catch (e) { /* ignore */ }
    }
    
    let defaultSettings = path.join(defaultHome, 'settings.json');
    if (fs.existsSync(defaultSettings)) {
      try { existingConfig = JSON.parse(fs.readFileSync(defaultSettings, 'utf8')); } catch (e) {}
    }
  }

  let config = { ...existingConfig };
  config.mcpServers = config.mcpServers || {};
  config.mcpServers['agent-portal'] = { url: portalUrl };

  fs.writeFileSync(path.join(geminiDir, 'settings.json'), JSON.stringify(config, null, 2));

  return {
    tmpDir,
    envOverrides: {
      GEMINI_CLI_HOME: tmpDir,
    },
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
 * Remove temp config directory.
 * @param {string} tmpDir
 */
export function cleanupTmpConfig(tmpDir) {
  if (!tmpDir || !tmpDir.includes('hub-')) return; // safety guard
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch { /* non-critical */ }
}

// ── Legacy API (kept for backward compat with tests) ─────

/** @deprecated Use createGeminiEnv instead */
export function injectGeminiConfig(cwd, portalUrl) {
  let gemDir = path.join(cwd, '.gemini');
  let configPath = path.join(gemDir, 'settings.json');
  let backupPath = configPath + '.bak';

  let existing = {};
  if (fs.existsSync(configPath)) {
    try { existing = JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch {}
    if (!existing.__portal_injected__ && !fs.existsSync(backupPath)) {
      fs.copyFileSync(configPath, backupPath);
    }
  }

  let injected = { ...existing };
  injected.mcpServers = { 'agent-portal': { url: portalUrl } };
  injected.__portal_injected__ = true;

  fs.mkdirSync(gemDir, { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(injected, null, 2));
}

/** @deprecated Use cleanupTmpConfig instead */
export function cleanupGeminiConfig(cwd) {
  let configPath = path.join(cwd, '.gemini', 'settings.json');
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
