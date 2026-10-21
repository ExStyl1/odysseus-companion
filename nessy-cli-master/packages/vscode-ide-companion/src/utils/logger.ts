/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type * as vscode from 'vscode';

export function createLogger(
  _context: vscode.ExtensionContext,
  logger: vscode.OutputChannel,
) {
  return (message: string) => {
    logger.appendLine(message);
  };
}
