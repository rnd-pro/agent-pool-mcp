/**
 * CLI commands — doctor check, config init, version display.
 *
 * Runs in human-readable stdout mode (not MCP stdio).
 *
 * @module agent-pool/cli
 */

import { execFileSync, execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import { loadConfig } from './runner/config.js';

const PACKAGE_JSON = JSON.parse(
  fs.readFileSync(new URL('../package.json', import.meta.url), 'utf-8')
);

const GEMINI_NPM_PACKAGE = '@google/gemini-cli';
const MIN_NODE_VERSION = 20;

// ─── Colors (ANSI) ──────────────────────────────────────────

const color = {
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
};

const ok = (msg) => console.log(`  ${color.green('✅')} ${msg}`);
const fail = (msg) => console.log(`  ${color.red('❌')} ${msg}`);
const warn = (msg) => console.log(`  ${color.yellow('⚠️')}  ${msg}`);

// ─── Check command ──────────────────────────────────────────

/**
 * Run comprehensive diagnostics (doctor mode).
 * Checks prerequisites, runners, and config.
 */
export function runCheck() {
  console.log('');
  console.log(color.bold('🔍 Agent Pool Doctor'));
  console.log(color.dim(`   v${PACKAGE_JSON.version}`));
  console.log('');

  let issues = 0;

  // — Node.js version
  console.log(color.cyan('Prerequisites:'));
  const nodeVersion = parseInt(process.versions.node);
  if (nodeVersion >= MIN_NODE_VERSION) {
    ok(`Node.js v${process.versions.node} ${color.dim(`(>= ${MIN_NODE_VERSION})`)}`);
  } else {
    fail(`Node.js v${process.versions.node} — requires >= ${MIN_NODE_VERSION}`);
    issues++;
  }

  // — Gemini CLI binary
  let geminiPath = null;
  try {
    geminiPath = execFileSync('which', ['gemini'], { encoding: 'utf-8' }).trim();
  } catch {
    // not found
  }

  if (geminiPath) {
    let geminiVersion = 'unknown';
    try {
      geminiVersion = execFileSync('gemini', ['--version'], {
        encoding: 'utf-8',
        timeout: 5000,
      }).trim();
    } catch {
      // version check failed
    }
    ok(`Gemini CLI v${geminiVersion} ${color.dim(geminiPath)}`);
  } else {
    fail(`Gemini CLI — not found in PATH`);
    console.log(color.dim(`     Install: npm install -g ${GEMINI_NPM_PACKAGE}`));
    console.log(color.dim(`     Then run: gemini (to authenticate)`));
    issues++;
  }

  // — Runners
  console.log('');
  console.log(color.cyan('Runners:'));
  const config = loadConfig();
  const configSource = findConfigPath();

  for (const runner of config.runners) {
    if (runner.type === 'local') {
      if (geminiPath) {
        ok(`${color.bold(runner.id)} — local ${runner.id === config.defaultRunner ? color.dim('(default)') : ''}`);
      } else {
        fail(`${color.bold(runner.id)} — local (gemini not found)`);
        issues++;
      }
    } else if (runner.type === 'ssh') {
      const sshResult = testSshRunner(runner);
      if (sshResult.ok) {
        ok(`${color.bold(runner.id)} — ssh:${runner.host} ${color.dim(`gemini v${sshResult.version}`)} ${runner.id === config.defaultRunner ? color.dim('(default)') : ''}`);
      } else {
        fail(`${color.bold(runner.id)} — ssh:${runner.host} — ${sshResult.error}`);
        issues++;
      }
    }
  }

  // — Config source
  console.log('');
  console.log(color.cyan('Config:'));
  if (configSource) {
    ok(configSource);
  } else {
    console.log(`  ${color.dim('  No config file (using defaults)')}`);
    console.log(color.dim(`     Create one with: npx agent-pool-mcp --init`));
  }

  // — MCP config snippet
  console.log('');
  console.log(color.cyan('MCP config snippet (copy to your IDE):'));
  console.log('');
  console.log(color.dim('  {'));
  console.log(color.dim('    "mcpServers": {'));
  console.log(color.dim('      "agent-pool": {'));
  console.log(color.dim('        "command": "npx",'));
  console.log(color.dim('        "args": ["-y", "agent-pool-mcp"]'));
  console.log(color.dim('      }'));
  console.log(color.dim('    }'));
  console.log(color.dim('  }'));

  // — Summary
  console.log('');
  if (issues === 0) {
    console.log(color.green(color.bold('All checks passed! ✨')));
  } else {
    console.log(color.yellow(`${issues} issue(s) found. Fix them and run --check again.`));
  }
  console.log('');

  return issues;
}

// ─── Init command ───────────────────────────────────────────

/**
 * Generate a template agent-pool.config.json in current directory.
 */
export function runInit() {
  const targetPath = path.join(process.cwd(), 'agent-pool.config.json');

  if (fs.existsSync(targetPath)) {
    console.log(color.yellow(`⚠️  ${targetPath} already exists. Not overwriting.`));
    return;
  }

  const template = {
    runners: [
      { id: 'local', type: 'local' },
      { id: 'remote', type: 'ssh', host: 'your-server', cwd: '/home/dev/project' },
    ],
    defaultRunner: 'local',
    defaultModel: 'gemini-3.1-pro-preview',
  };

  fs.writeFileSync(targetPath, JSON.stringify(template, null, 2) + '\n');
  console.log(color.green(`✅ Created ${targetPath}`));
  console.log(color.dim('   Edit the file and update SSH host/cwd for remote runners.'));
  console.log(color.dim('   Remove the "remote" runner if you only need local execution.'));
}

// ─── Version command ────────────────────────────────────────

export function printVersion() {
  console.log(`agent-pool-mcp v${PACKAGE_JSON.version}`);
}

// ─── Startup validation (fast, for MCP mode) ────────────────

/**
 * Quick prerequisite check before MCP server starts.
 * Only checks gemini binary existence (< 50ms).
 * Outputs to stderr (MCP protocol compatibility).
 *
 * @returns {boolean} true if prerequisites met
 */
export function validateStartup() {
  try {
    execFileSync('which', ['gemini'], { encoding: 'utf-8', timeout: 2000 });
    return true;
  } catch {
    console.error('[agent-pool] ❌ Gemini CLI not found in PATH.');
    console.error(`[agent-pool] Install: npm install -g ${GEMINI_NPM_PACKAGE}`);
    console.error('[agent-pool] Then run: gemini (to authenticate)');
    console.error('[agent-pool] Docs: https://github.com/google-gemini/gemini-cli');
    return false;
  }
}

// ─── Helpers ─────────────────────────────────────────────────

/**
 * Test if an SSH runner can connect and run gemini.
 */
function testSshRunner(runner) {
  try {
    const output = execSync(
      `ssh -o ConnectTimeout=5 -o BatchMode=yes ${runner.host} 'gemini --version' 2>/dev/null`,
      { encoding: 'utf-8', timeout: 10000 }
    ).trim();
    return { ok: true, version: output || 'unknown' };
  } catch (err) {
    const msg = err.message || '';
    if (msg.includes('timed out') || msg.includes('ETIMEDOUT')) {
      return { ok: false, error: 'connection timeout' };
    }
    if (msg.includes('Permission denied') || msg.includes('publickey')) {
      return { ok: false, error: 'auth failed (check SSH keys)' };
    }
    if (msg.includes('Could not resolve')) {
      return { ok: false, error: 'host not found' };
    }
    return { ok: false, error: 'connection failed' };
  }
}

/**
 * Find which config file is actually loaded.
 */
function findConfigPath() {
  const candidates = [
    path.join(process.cwd(), 'agent-pool.config.json'),
    path.join(homedir(), '.config', 'agent-pool', 'config.json'),
  ];
  return candidates.find((f) => fs.existsSync(f)) ?? null;
}

// ─── CLI Router ──────────────────────────────────────────────

/**
 * Parse argv and run CLI command.
 * Returns true if a CLI command was handled (don't start MCP server).
 */
export function handleCli(argv) {
  const args = argv.slice(2);

  if (args.includes('--version') || args.includes('-v')) {
    printVersion();
    return true;
  }

  if (args.includes('--check') || args.includes('--doctor')) {
    const issues = runCheck();
    process.exit(issues > 0 ? 1 : 0);
    return true;
  }

  if (args.includes('--init')) {
    runInit();
    return true;
  }

  if (args.includes('--help') || args.includes('-h')) {
    printHelp();
    return true;
  }

  return false;
}

function printHelp() {
  console.log(`
${color.bold('agent-pool-mcp')} v${PACKAGE_JSON.version}
${color.dim('MCP server for multi-agent orchestration via Gemini CLI')}

${color.cyan('Usage:')}
  agent-pool-mcp              Start MCP server (stdio transport)
  agent-pool-mcp --check      Run diagnostics (doctor mode)
  agent-pool-mcp --init       Create template config file
  agent-pool-mcp --version    Show version
  agent-pool-mcp --help       Show this help

${color.cyan('MCP config (paste into your IDE):')}
  {
    "mcpServers": {
      "agent-pool": {
        "command": "npx",
        "args": ["-y", "agent-pool-mcp"]
      }
    }
  }

${color.cyan('Docs:')} https://github.com/rnd-pro/agent-pool-mcp
`);
}
