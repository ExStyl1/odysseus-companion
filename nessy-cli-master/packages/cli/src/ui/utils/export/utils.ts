/**
 * @license
 * Copyright 2025 Nessy Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Generates a filename with timestamp for export files.
 */
export function generateExportFilename(extension: string): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `nessy-cli-export-${timestamp}.${extension}`;
}
