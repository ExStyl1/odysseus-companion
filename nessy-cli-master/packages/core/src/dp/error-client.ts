/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { createDebugLogger } from '../utils/debugLogger.js';
import { DEFAULT_NESTOR_ERROR_URL } from '../core/openaiContentGenerator/constants.js';
import { getValidCredentials } from './dp-token-manager.js';
import { buildNestorAuthHeaders } from './nestor-auth-header.js';

// [nessy-fork] error-client
const debugLogger = createDebugLogger('ERROR_CLIENT');

/**
 * Convert metadata values to strings to match backend expectations
 * Backend expects map[string]string, so all values must be strings
 */
function normalizeMetadata(
  metadata?: Record<string, unknown>,
): Record<string, string> | undefined {
  if (!metadata) {
    return undefined;
  }

  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (typeof value === 'string') {
      normalized[key] = value;
    } else if (typeof value === 'number' || typeof value === 'boolean') {
      normalized[key] = String(value);
    } else if (value === null || value === undefined) {
      normalized[key] = String(value);
    } else if (typeof value === 'object') {
      // Stringify objects to JSON
      try {
        normalized[key] = JSON.stringify(value);
      } catch {
        normalized[key] = '[object]';
      }
    } else {
      normalized[key] = String(value);
    }
  }
  return normalized;
}

/**
 * Backend error report format
 * Note: metadata values must be strings because backend expects map[string]string
 */
export interface CLIErrorReport {
  message: string;
  stacktrace?: string;
  cli_version: string;
  model?: string;
  metadata?: Record<string, string>;
}

/**
 * Error report queue item
 */
interface ErrorReportQueueItem {
  error: Error | unknown;
  cliVersion: string;
  model?: string;
  additionalInfo?: Record<string, unknown>;
}

/**
 * ErrorClient - handles async error reporting with queue
 *
 * Features:
 * - Queue-based error reporting (max 2 items)
 * - Fire-and-forget async sending
 * - Non-blocking to avoid affecting main workflow
 */
export class ErrorClient {
  private static instance: ErrorClient;
  private queue: ErrorReportQueueItem[] = [];
  private isProcessing = false;
  private readonly MAX_QUEUE_SIZE = 2;

  private constructor() {}

  /**
   * Get singleton instance
   */
  static getInstance(): ErrorClient {
    if (!ErrorClient.instance) {
      ErrorClient.instance = new ErrorClient();
    }
    return ErrorClient.instance;
  }

  /**
   * Add error to queue for async reporting
   * Non-blocking - returns immediately
   * @param error The error object
   * @param cliVersion CLI version string
   * @param model Optional model identifier
   * @param additionalInfo Optional additional information
   */
  reportError(
    error: Error | unknown,
    cliVersion: string,
    model?: string,
    additionalInfo?: Record<string, unknown>,
  ): void {
    // Drop error if queue is full (oldest errors dropped)
    if (this.queue.length >= this.MAX_QUEUE_SIZE) {
      debugLogger.debug('Error queue full, dropping oldest error');
      this.queue.shift();
    }

    this.queue.push({ error, cliVersion, model, additionalInfo });

    // Process queue asynchronously (fire-and-forget)
    this.processQueue();
  }

  /**
   * Process error queue asynchronously
   * Private method - called automatically when errors are added
   */
  private async processQueue(): Promise<void> {
    // Prevent concurrent processing
    if (this.isProcessing) {
      return;
    }

    this.isProcessing = true;

    try {
      while (this.queue.length > 0) {
        const item = this.queue.shift();
        if (item) {
          // Send each error asynchronously without awaiting
          this.sendErrorReport(item).catch((sendError) => {
            // Silently ignore send errors
            debugLogger.debug('Failed to send error report:', sendError);
          });
        }
      }
    } finally {
      this.isProcessing = false;
    }
  }

  /**
   * Send error report to backend
   * @param item Error report queue item
   */
  private async sendErrorReport(item: ErrorReportQueueItem): Promise<void> {
    try {
      let message: string;
      let stacktrace: string | undefined;

      if (item.error instanceof Error) {
        message = item.error.message;
        stacktrace = item.error.stack || undefined;
      } else if (
        typeof item.error === 'object' &&
        item.error !== null &&
        'message' in item.error
      ) {
        message = String((item.error as { message: unknown }).message);
        stacktrace = undefined;
      } else {
        message = String(item.error);
        stacktrace = undefined;
      }

      const errorReport: CLIErrorReport = {
        message,
        stacktrace,
        cli_version: item.cliVersion,
        model: item.model,
        metadata: normalizeMetadata(item.additionalInfo),
      };

      const credentials = getValidCredentials();
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'User-Agent': `NessyCLI/${item.cliVersion} (${process.platform}; ${process.arch})`,
      };
      if (credentials?.jwt) {
        Object.assign(headers, buildNestorAuthHeaders(credentials.jwt));
      }

      // Fire-and-forget with keepalive
      await fetch(DEFAULT_NESTOR_ERROR_URL, {
        method: 'POST',
        headers,
        body: JSON.stringify(errorReport),
        keepalive: true,
      });

      debugLogger.debug('Error report sent successfully');
    } catch (e) {
      // Silently ignore to avoid disrupting main flow
      debugLogger.debug('Error preparing error report for backend:', e);
    }
  }

  /**
   * Get current queue size (for testing)
   */
  getQueueSize(): number {
    return this.queue.length;
  }

  /**
   * Clear queue (for testing)
   */
  clearQueue(): void {
    this.queue = [];
    this.isProcessing = false;
  }

  /**
   * Reset singleton instance (for testing)
   */
  static resetInstance(): void {
    ErrorClient.instance = null as unknown as ErrorClient;
  }
}
