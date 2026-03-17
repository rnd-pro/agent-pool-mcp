#!/usr/bin/env node

/**
 * Agent Pool MCP Server — Entry Point
 *
 * Multi-agent task delegation and orchestration via Gemini CLI.
 * Supports CLI modes: --check, --init, --version, --help.
 *
 * @module agent-pool
 */

import { handleCli, validateStartup } from './src/cli.js';

// CLI mode: --check, --init, --version, --help
if (handleCli(process.argv)) {
  // CLI command handled, don't start MCP server
} else {
  // MCP server mode
  startServer();
}

async function startServer() {
  // Warn if prerequisites are missing (don't exit — let the agent handle it)
  validateStartup();

  // Import MCP deps only when starting server
  const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
  const { createServer } = await import('./src/server.js');

  // Register SIGTERM/SIGINT handlers for process cleanup
  await import('./src/runner/process-manager.js');

  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[agent-pool] MCP server v1.2.0 started');
}

