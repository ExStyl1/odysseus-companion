/**
 * @license
 * Copyright 2025 Nessy CLI Team
 * SPDX-License-Identifier: Apache-2.0
 */

// [nessy-fork] dp-binary-lifecycle

import { createDebugLogger, ensureDpPresence } from '@nestor/nessy-cli-core';

const debugLogger = createDebugLogger('DP_BINARY');

/**
 * Ensure the managed `dp` binary is installed, validated and updated.
 *
 * Runs on every startup regardless of the selected auth type: the bundled dp
 * MCP servers (dpWiki, codeSearch, dpJira, …) spawn the binary directly from
 * `config.initialize()`, so it has to exist by then even when DP auth is not
 * in use. Forced auth cannot cover this — it returns early on cached
 * credentials, which live outside `dp_latest/`.
 *
 * Never throws: a missing binary degrades the dp MCP servers, but must not
 * block CLI startup.
 */
export async function ensureDpBinary(): Promise<void> {
  try {
    await ensureDpPresence();
    debugLogger.debug('DP binary is ready');
  } catch (error) {
    debugLogger.warn('Failed to prepare DP binary:', error);
  }
}
