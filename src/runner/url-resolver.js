// @ctx url-resolver.ctx
//
// Portal URL Resolver — find the best URL to reach the portal's MCP endpoint
//
// Discovery order:
// 1. PORTAL_MCP_URL env var (explicit override)
// 2. Port files in ~/.local-gateway/backends/ (local gateway)
// 3. Fallback: localhost with known port

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';

const BACKENDS_DIR = path.join(
  process.env.HOME || process.env.USERPROFILE || '/tmp',
  '.local-gateway', 'backends'
);

/**
 * Resolve the best portal MCP URL.
 * Synchronous — reads from env and port files.
 *
 * @returns {string|null} URL like "http://portal.local/mcp" or null if not found
 */
export function resolvePortalUrl() {
  // 1. Explicit env override
  if (process.env.PORTAL_MCP_URL) {
    return process.env.PORTAL_MCP_URL;
  }

  // 2. Scan port files for active portal backend
  let port = findActivePortalPort();
  if (port) {
    return `http://localhost:${port}/mcp`;
  }

  return null;
}

/**
 * Find the port of an active portal backend from port files.
 * @returns {number|null}
 */
export function findActivePortalPort() {
  if (!fs.existsSync(BACKENDS_DIR)) return null;

  try {
    let files = fs.readdirSync(BACKENDS_DIR).filter(f => f.startsWith('portal-') && f.endsWith('.json'));
    let live = [];
    for (let f of files) {
      try {
        let data = JSON.parse(fs.readFileSync(path.join(BACKENDS_DIR, f), 'utf8'));
        // Verify process is alive
        try {
          process.kill(data.pid, 0);
          live.push(data);
        } catch { /* process dead — skip */ }
      } catch { /* corrupt file — skip */ }
    }

    let cwd = path.resolve(process.cwd());
    let current = live.find(entry => path.resolve(entry.project || '') === cwd);
    if (current?.port) return current.port;

    live.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
    return live[0]?.port || null;
  } catch { /* dir read error */ }

  return null;
}

/**
 * Async probe: verify URL is reachable.
 * @param {string} url
 * @param {number} [timeoutMs=2000]
 * @returns {Promise<boolean>}
 */
export function probeUrl(url, timeoutMs = 2000) {
  return new Promise(resolve => {
    try {
      let parsed = new URL(url);
      let req = http.request({
        hostname: parsed.hostname,
        port: parsed.port || 80,
        path: parsed.pathname,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        timeout: timeoutMs,
      }, res => {
        resolve(res.statusCode < 500);
        res.resume(); // drain
      });
      req.on('error', () => resolve(false));
      req.on('timeout', () => { req.destroy(); resolve(false); });
      // Send a ping
      req.write(JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'ping', params: {} }));
      req.end();
    } catch {
      resolve(false);
    }
  });
}
