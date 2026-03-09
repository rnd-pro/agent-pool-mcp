/**
 * SSH utilities — shell escaping and remote command building.
 *
 * @module agent-pool/runner/ssh
 */

/**
 * Escape a string for safe use in a remote shell command.
 * Wraps in single quotes, escaping any embedded single quotes.
 *
 * @param {string} arg - Argument to escape
 * @returns {string} Shell-safe argument
 */
export function escapeShellArg(arg) {
  // Replace single quotes: ' → '\''
  // Then wrap entire string in single quotes
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

/**
 * Build spawn arguments for SSH remote execution.
 * Uses `echo REMOTE_PID:$$` to capture remote PID for cleanup.
 *
 * @param {object} runner - Runner config
 * @param {string} runner.host - SSH host
 * @param {string} [runner.cwd] - Remote working directory
 * @param {string[]} geminiArgs - Gemini CLI arguments
 * @param {string} localCwd - Local cwd (fallback for remote)
 * @returns {{command: string, args: string[]}}
 */
export function buildSshSpawn(runner, geminiArgs, localCwd) {
  const remoteCwd = runner.cwd ?? localCwd;

  // Build safe remote command with PID echo
  const safeArgs = geminiArgs.map(escapeShellArg).join(' ');
  const remoteCmd = `cd ${escapeShellArg(remoteCwd)} && echo "REMOTE_PID:$$" && exec gemini ${safeArgs}`;

  return {
    command: 'ssh',
    args: [runner.host, remoteCmd],
  };
}

/**
 * Parse REMOTE_PID from the first line of stdout.
 *
 * @param {string} line - stdout line
 * @returns {number|null} Remote PID or null
 */
export function parseRemotePid(line) {
  const match = line.match(/^REMOTE_PID:(\d+)$/);
  return match ? parseInt(match[1]) : null;
}

/**
 * Kill a remote process group via SSH.
 *
 * @param {string} host - SSH host
 * @param {number} remotePid - Remote PID to kill
 * @returns {Promise<boolean>} Whether kill was attempted
 */
export function killRemoteProcess(host, remotePid) {
  return new Promise((resolve) => {
    import('node:child_process').then(({ execFile }) => {
      execFile('ssh', [host, `kill -TERM -${remotePid} 2>/dev/null; kill -TERM ${remotePid} 2>/dev/null`], {
        timeout: 5000,
      }, () => {
        resolve(true);
      });
    });
  });
}
