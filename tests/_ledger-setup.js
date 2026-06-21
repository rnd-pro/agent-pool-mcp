// Test-suite preload (via `node --import`): isolate the slot ledger so the
// suite never writes to the real ~/.agent-portal and tests do not share
// capacity state with a live install. One dir per test process.
import os from 'node:os';
import path from 'node:path';

if (!process.env.AGENT_POOL_LEDGER_DIR) {
  process.env.AGENT_POOL_LEDGER_DIR = path.join(
    os.tmpdir(),
    `agent-pool-ledger-test-${process.pid}-${Date.now()}`,
  );
}
