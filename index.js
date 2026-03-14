#!/usr/bin/env node

/**
 * Agent Pool MCP Server — Entry Point
 *
 * Multi-agent task delegation and orchestration via Gemini CLI.
 *
 * @module agent-pool
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from './src/server.js';

// Import process-manager to register SIGTERM/SIGINT handlers
import './src/runner/process-manager.js';

async function main() {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[agent-pool] MCP server v3.1.0 started');
}

main().catch((err) => {
  console.error('[agent-pool] Fatal error:', err);
  process.exit(1);
});
