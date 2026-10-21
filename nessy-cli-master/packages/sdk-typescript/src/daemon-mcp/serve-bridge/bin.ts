#!/usr/bin/env node
/**
 * @license
 * Copyright 2026 Nessy CLI Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Standalone stdio entry point for the nessy-serve-bridge MCP server.
 *
 * Usage:
 *   NESSY_DAEMON_URL=http://127.0.0.1:4170 \
 *   NESSY_DAEMON_TOKEN=<token> \
 *   node dist/daemon-mcp/serve-bridge/bin.js
 *
 * Environment variables:
 *   NESSY_DAEMON_URL   - Daemon base URL (default: http://127.0.0.1:4170)
 *   NESSY_DAEMON_TOKEN - Bearer token for auth (optional for loopback)
 *   NESSY_WORKSPACE_CWD - Default workspace path for session creation
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServeBridgeMcpServer } from './createServeBridgeMcpServer.js';

const server = createServeBridgeMcpServer({
  daemonUrl: process.env['NESSY_DAEMON_URL'] ?? 'http://127.0.0.1:4170',
  token: process.env['NESSY_DAEMON_TOKEN'],
  workspaceCwd: process.env['NESSY_WORKSPACE_CWD'],
  allowGlobalScope: process.env['NESSY_BRIDGE_ALLOW_GLOBAL_SCOPE'] === 'true',
});

const transport = new StdioServerTransport();

// Graceful shutdown on signals
async function shutdown() {
  try {
    await server.instance.close();
  } catch (e) {
    process.stderr.write(`[nessy-serve-bridge] close error: ${e}\n`);
  }
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// Prevent silent crashes from unhandled rejections
process.on('unhandledRejection', (err) => {
  const detail =
    err instanceof Error ? (err.stack ?? err.message) : String(err);
  process.stderr.write(`[nessy-serve-bridge] unhandled rejection: ${detail}\n`);
  process.exit(1);
});

// Exit cleanly when stdio pipe closes (parent process gone)
process.stdin.on('close', shutdown);

await server.instance.connect(transport);
