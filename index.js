/**
 * Agent Pool MCP Server — Entry Point
 *
 * Multi-agent task delegation and orchestration via Gemini CLI.
 * Standalone project extracted from Mr-Computer/tools/gemini-cli-mcp.
 *
 * Local path: /Users/v.matiyasevich/Documents/GitHub/agent-pool-mcp/
 * This is OUR tool — fix bugs immediately during development.
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
  console.error('[agent-pool] MCP server v3.0.0 started');
}

main().catch((err) => {
  console.error('[agent-pool] Fatal error:', err);
  process.exit(1);
});
