/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { createDebugLogger } from '../utils/debugLogger.js';
import { getErrorMessage } from '../utils/errors.js';

const debugLogger = createDebugLogger('MCP_RETRY');

const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_BASE_DELAY_MS = 200;

const TRANSIENT_ERROR_CODES = [
  'ECONNRESET',
  'ETIMEDOUT',
  'ENOTFOUND',
  'ECONNREFUSED',
  'EAI_AGAIN',
  'EPIPE',
  'EHOSTUNREACH',
  'ENETUNREACH',
];

const TRANSIENT_HTTP_STATUS_PATTERNS: RegExp[] = [
  /\b(502|503|504)\s+(Bad Gateway|Service Unavailable|Gateway Timeout)/i,
  /\bstatus\s*(?:code)?\s*[:=]?\s*(502|503|504)\b/i,
  /\bHTTP\/\S+\s+(502|503|504)\b/i,
];

export function isTransientNetworkError(error: unknown): boolean {
  if (error == null) {
    return false;
  }

  const code = (error as { code?: unknown } | null)?.code;
  if (code === -32601 || code === -32600 || code === -32602) {
    return false;
  }

  const message = getErrorMessage(error);

  if (message.includes('401') || message.includes('403')) {
    return false;
  }

  for (const transientCode of TRANSIENT_ERROR_CODES) {
    if (message.includes(transientCode)) {
      return true;
    }
  }

  if (TRANSIENT_HTTP_STATUS_PATTERNS.some((pattern) => pattern.test(message))) {
    return true;
  }

  return (
    message.includes('Connection closed') ||
    message.includes('transport error') ||
    message.includes('Streamable HTTP connection')
  );
}

export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  label: string,
  opts?: { maxRetries?: number; baseDelayMs?: number; signal?: AbortSignal },
): Promise<T> {
  const maxRetries = opts?.maxRetries ?? DEFAULT_MAX_RETRIES;
  const baseDelayMs = opts?.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const signal = opts?.signal;

  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      if (!isTransientNetworkError(error) || attempt === maxRetries) {
        throw error;
      }

      const delayMs = baseDelayMs * Math.pow(2, attempt);
      debugLogger.info(
        `Transient error on '${label}' (attempt ${attempt + 1}/${maxRetries + 1}), ` +
          `retrying in ${delayMs}ms: ${getErrorMessage(error)}`,
      );
      await delayWithAbort(delayMs, signal);
    }
  }

  throw lastError;
}

function delayWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('Retry aborted'));
      return;
    }

    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);

    function onAbort() {
      clearTimeout(timer);
      reject(new Error('Retry aborted'));
    }

    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
