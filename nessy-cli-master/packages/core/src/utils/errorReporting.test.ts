/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { reportError } from './errorReporting.js';
import type { Config } from '../config/config.js';

const debugLoggerSpy = vi.hoisted(() => ({
  error: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
}));

// Mock the debugLogger
vi.mock('./debugLogger.js', () => ({
  createDebugLogger: () => ({
    error: debugLoggerSpy.error,
    warn: debugLoggerSpy.warn,
    info: debugLoggerSpy.info,
    debug: debugLoggerSpy.debug,
  }),
}));

// Mock global fetch
const mockFetch = vi.fn();
global.fetch = mockFetch;

// Mock ErrorClient
const mockErrorClientInstance = {
  reportError: vi.fn(),
  getQueueSize: vi.fn(),
  clearQueue: vi.fn(),
};

vi.mock('../dp/ErrorClient.js', () => ({
  ErrorClient: {
    getInstance: vi.fn(() => mockErrorClientInstance),
    resetInstance: vi.fn(),
  },
}));

describe('reportError', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockFetch.mockReset();
    mockErrorClientInstance.reportError.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should not throw when called with a standard error', async () => {
    const error = new Error('Test error');
    error.stack = 'Test stack';
    const baseMessage = 'An error occurred.';
    const context = { data: 'test context' };
    const type = 'test-type';

    await expect(
      reportError(error, baseMessage, context, type),
    ).resolves.not.toThrow();
    expect(debugLoggerSpy.error).toHaveBeenCalled();
    expect(debugLoggerSpy.error).toHaveBeenCalledWith(
      `${baseMessage} [${type}]`,
      expect.any(String),
    );
  });

  it('should handle errors that are plain objects with a message property', async () => {
    const error = { message: 'Test plain object error' };
    const baseMessage = 'Another error.';
    const type = 'general';

    await expect(
      reportError(error, baseMessage, undefined, type),
    ).resolves.not.toThrow();
    expect(debugLoggerSpy.error).toHaveBeenCalledWith(
      `${baseMessage} [${type}]`,
      expect.any(String),
    );
  });

  it('should handle string errors', async () => {
    const error = 'Just a string error';
    const baseMessage = 'String error occurred.';
    const type = 'general';

    await expect(
      reportError(error, baseMessage, undefined, type),
    ).resolves.not.toThrow();
    expect(debugLoggerSpy.error).toHaveBeenCalledWith(
      `${baseMessage} [${type}]`,
      expect.any(String),
    );
  });

  it('should handle stringification failure of report content (e.g. BigInt in context)', async () => {
    const error = new Error('Main error');
    error.stack = 'Main stack';
    const baseMessage = 'Failed operation with BigInt.';
    const context = { a: BigInt(1) }; // BigInt cannot be stringified by JSON.stringify

    // Simulate JSON.stringify throwing an error for the full report
    const originalJsonStringify = JSON.stringify;
    let callCount = 0;
    vi.spyOn(JSON, 'stringify').mockImplementation((value, replacer, space) => {
      callCount++;
      if (callCount === 1) {
        // First call is for the full report content
        throw new TypeError('Do not know how to serialize a BigInt');
      }
      // Subsequent calls (for minimal report) should succeed
      return originalJsonStringify(value, replacer, space);
    });

    await expect(
      reportError(error, baseMessage, context, 'bigint-fail'),
    ).resolves.not.toThrow();
    expect(debugLoggerSpy.error).toHaveBeenCalledWith(
      `${baseMessage} [bigint-fail] Could not stringify report content (likely due to context):`,
      expect.any(TypeError),
      error,
    );
    expect(debugLoggerSpy.error).toHaveBeenCalledWith(
      `${baseMessage} [bigint-fail]`,
      expect.any(String),
    );
  });

  it('should generate a report without context if context is not provided', async () => {
    const error = new Error('Error without context');
    error.stack = 'No context stack';
    const baseMessage = 'Simple error.';
    const type = 'general';

    await expect(
      reportError(error, baseMessage, undefined, type),
    ).resolves.not.toThrow();
    expect(debugLoggerSpy.error).toHaveBeenCalledWith(
      `${baseMessage} [${type}]`,
      expect.any(String),
    );
  });

  it('should omit stack trace for rate-limit errors (retry scenarios)', async () => {
    const error = new Error(
      '429 "rate limit exceeded: quota tpm limit exceeded"',
    );
    error.stack = 'Rate limit stack trace';
    const baseMessage = 'API rate limit';
    const type = 'retry-test';

    await expect(
      reportError(error, baseMessage, undefined, type),
    ).resolves.not.toThrow();

    const loggedCall = debugLoggerSpy.error.mock.calls.find(
      (call) => call[0] === `${baseMessage} [${type}]`,
    );
    expect(loggedCall).toBeDefined();
    const reportJson = loggedCall![1] as string;
    const report = JSON.parse(reportJson);
    expect(report.error).not.toHaveProperty('stack');
  });

  it('should include stack trace for non-rate-limit errors', async () => {
    const error = new Error('Some other error');
    error.stack = 'This stack should be included';
    const baseMessage = 'Regular error';
    const type = 'regular-test';

    await expect(
      reportError(error, baseMessage, undefined, type),
    ).resolves.not.toThrow();

    const loggedCall = debugLoggerSpy.error.mock.calls.find(
      (call) => call[0] === `${baseMessage} [${type}]`,
    );
    expect(loggedCall).toBeDefined();
    const reportJson = loggedCall![1] as string;
    const report = JSON.parse(reportJson);
    expect(report.error.stack).toBe('This stack should be included');
  });

  it('should NOT send error to backend when config is not provided', async () => {
    const error = new Error('No config error');
    const baseMessage = 'No config test';
    const type = 'no-config-test';

    await reportError(error, baseMessage, undefined, type);

    // ErrorClient should not be called when config is not provided
    expect(mockErrorClientInstance.reportError).not.toHaveBeenCalled();
  });

  it('should NOT send error to backend when error reporting is disabled', async () => {
    const error = new Error('Disabled error');
    const baseMessage = 'Disabled test';
    const type = 'disabled-test';

    const mockConfig = {
      getTelemetryErrorReportEnabled: vi.fn().mockReturnValue(false),
      getCliVersion: vi.fn().mockReturnValue('1.0.0'),
    } as unknown as Config;

    await reportError(error, baseMessage, undefined, type, mockConfig);

    // ErrorClient should not be called when error reporting is disabled
    expect(mockErrorClientInstance.reportError).not.toHaveBeenCalled();
  });

  it('should use ErrorClient to send error to backend', async () => {
    const error = new Error('Backend test error');
    error.stack = 'Backend test stack';
    const baseMessage = 'Backend test';
    const type = 'backend-test';
    const model = 'test-model';

    const mockConfig = {
      getTelemetryErrorReportEnabled: vi.fn().mockReturnValue(true),
      getCliVersion: vi.fn().mockReturnValue('1.0.0'),
    } as unknown as Config;

    await reportError(error, baseMessage, undefined, type, mockConfig, model);

    expect(mockErrorClientInstance.reportError).toHaveBeenCalledWith(
      error,
      '1.0.0',
      'test-model',
      { error_type: 'backend-test' },
    );
  });
});
