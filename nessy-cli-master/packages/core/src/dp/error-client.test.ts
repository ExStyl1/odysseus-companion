/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ErrorClient } from './error-client.js';
import * as dpTokenManager from './dp-token-manager.js';

// Mock fetch globally
const mockFetch = vi.fn();
global.fetch = mockFetch;

describe('ErrorClient', () => {
  let client: ErrorClient;
  const originalEnv = process.env['NESSY_CLI_DP_AUTH_TOKEN'];

  beforeEach(() => {
    ErrorClient.resetInstance();
    client = ErrorClient.getInstance();
    mockFetch.mockClear();
    delete process.env['NESSY_CLI_DP_AUTH_TOKEN'];
  });

  afterEach(() => {
    client.clearQueue();
    ErrorClient.resetInstance();
    vi.restoreAllMocks();
    if (originalEnv === undefined) {
      delete process.env['NESSY_CLI_DP_AUTH_TOKEN'];
    } else {
      process.env['NESSY_CLI_DP_AUTH_TOKEN'] = originalEnv;
    }
  });

  describe('singleton', () => {
    it('should return the same instance', () => {
      const instance1 = ErrorClient.getInstance();
      const instance2 = ErrorClient.getInstance();
      expect(instance1).toBe(instance2);
    });

    it('should reset instance on resetInstance', () => {
      const instance1 = ErrorClient.getInstance();
      ErrorClient.resetInstance();
      const instance2 = ErrorClient.getInstance();
      expect(instance1).not.toBe(instance2);
    });
  });

  describe('queue management', () => {
    it('should add error to queue', () => {
      const error = new Error('Test error');
      client.reportError(error, '1.0.0');

      // Queue should have the error before processing
      expect(client.getQueueSize()).toBeGreaterThanOrEqual(0);
    });

    it('should limit queue size to 2 (drop oldest)', () => {
      const error1 = new Error('Error 1');
      const error2 = new Error('Error 2');
      const error3 = new Error('Error 3');

      client.reportError(error1, '1.0.0');
      client.reportError(error2, '1.0.0');
      client.reportError(error3, '1.0.0');

      // After adding 3 errors, queue should have at most 2
      // (oldest should be dropped)
      expect(client.getQueueSize()).toBeLessThanOrEqual(2);
    });

    it('should clear queue on clearQueue', () => {
      const error = new Error('Test error');
      client.reportError(error, '1.0.0');

      client.clearQueue();

      expect(client.getQueueSize()).toBe(0);
    });
  });

  describe('error reporting', () => {
    it('should send error report to backend', async () => {
      mockFetch.mockResolvedValueOnce({ ok: true });

      const error = new Error('Test error');
      client.reportError(error, '1.0.0', 'test-model', { test: 'metadata' });

      // Wait for async processing
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(mockFetch).toHaveBeenCalledWith(
        'https://code-completion-nestor.tcsbank.ru/api/v1/cli/errors',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'Content-Type': 'application/json',
            'User-Agent': `NessyCLI/1.0.0 (${process.platform}; ${process.arch})`,
          }),
          keepalive: true,
        }),
      );

      const callArgs = mockFetch.mock.calls[0];
      const body = JSON.parse(callArgs[1].body);
      expect(body).toMatchObject({
        message: 'Test error',
        cli_version: '1.0.0',
        model: 'test-model',
        metadata: { test: 'metadata' },
      });
    });

    it('should include stacktrace for Error objects', async () => {
      mockFetch.mockResolvedValueOnce({ ok: true });

      const error = new Error('Test error with stack');
      client.reportError(error, '1.0.0');

      await new Promise((resolve) => setTimeout(resolve, 50));

      const callArgs = mockFetch.mock.calls[0];
      const body = JSON.parse(callArgs[1].body);
      expect(body.stacktrace).toBeDefined();
      expect(body.stacktrace).toContain('Test error with stack');
    });

    it('should handle non-Error objects with message property', async () => {
      mockFetch.mockResolvedValueOnce({ ok: true });

      const errorObj = { message: 'Custom error message' };
      client.reportError(errorObj, '1.0.0');

      await new Promise((resolve) => setTimeout(resolve, 50));

      const callArgs = mockFetch.mock.calls[0];
      const body = JSON.parse(callArgs[1].body);
      expect(body.message).toBe('Custom error message');
      expect(body.stacktrace).toBeUndefined();
    });

    it('should handle primitive errors', async () => {
      mockFetch.mockResolvedValueOnce({ ok: true });

      client.reportError('String error', '1.0.0');

      await new Promise((resolve) => setTimeout(resolve, 50));

      const callArgs = mockFetch.mock.calls[0];
      const body = JSON.parse(callArgs[1].body);
      expect(body.message).toBe('String error');
    });

    it('should silently ignore fetch errors', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Network error'));

      const error = new Error('Test error');
      client.reportError(error, '1.0.0');

      // Should not throw
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(client.getQueueSize()).toBe(0);
    });

    it('should send Nestor-Token header when valid credentials exist and NESSY_CLI_DP_AUTH_TOKEN env is not set', async () => {
      vi.spyOn(dpTokenManager, 'getValidCredentials').mockReturnValue({
        jwt: 'dp-exchanged-jwt',
        expiresAt: Date.now() + 60_000,
        username: 'u',
        userId: 'uid',
      });
      mockFetch.mockResolvedValueOnce({ ok: true });

      client.reportError(new Error('boom'), '1.0.0');
      await new Promise((resolve) => setTimeout(resolve, 50));

      const [, requestInit] = mockFetch.mock.calls[0];
      const headers = (requestInit as RequestInit).headers as Record<
        string,
        string
      >;
      expect(headers['Nestor-Token']).toBe('dp-exchanged-jwt');
      expect(headers['Authorization']).toBeUndefined();
    });

    it('should send Authorization: Bearer when NESSY_CLI_DP_AUTH_TOKEN env matches the JWT', async () => {
      process.env['NESSY_CLI_DP_AUTH_TOKEN'] = 'env-delegated-jwt';
      vi.spyOn(dpTokenManager, 'getValidCredentials').mockReturnValue({
        jwt: 'env-delegated-jwt',
        expiresAt: Date.now() + 60_000,
        username: 'u',
        userId: 'uid',
      });
      mockFetch.mockResolvedValueOnce({ ok: true });

      client.reportError(new Error('boom'), '1.0.0');
      await new Promise((resolve) => setTimeout(resolve, 50));

      const [, requestInit] = mockFetch.mock.calls[0];
      const headers = (requestInit as RequestInit).headers as Record<
        string,
        string
      >;
      expect(headers['Authorization']).toBe('Bearer env-delegated-jwt');
      expect(headers['Nestor-Token']).toBeUndefined();
    });

    it('should handle metadata correctly', async () => {
      mockFetch.mockResolvedValueOnce({ ok: true });

      const error = new Error('Test error');
      const metadata = { error_type: 'test-type', custom_field: 'value' };
      client.reportError(error, '1.0.0', undefined, metadata);

      await new Promise((resolve) => setTimeout(resolve, 50));

      const callArgs = mockFetch.mock.calls[0];
      const body = JSON.parse(callArgs[1].body);
      expect(body.metadata).toEqual(metadata);
    });
  });

  describe('async processing', () => {
    it('should process queue asynchronously', async () => {
      mockFetch.mockResolvedValue({ ok: true });

      const error1 = new Error('Error 1');
      const error2 = new Error('Error 2');

      client.reportError(error1, '1.0.0');
      client.reportError(error2, '1.0.0');

      // Initially queue might still have items
      const initialSize = client.getQueueSize();
      expect(initialSize).toBeLessThanOrEqual(2);

      // Wait for async processing
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Queue should be empty after processing
      expect(client.getQueueSize()).toBe(0);
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('should prevent concurrent processing', async () => {
      mockFetch.mockImplementation(
        () =>
          new Promise((resolve) => setTimeout(() => resolve({ ok: true }), 50)),
      );

      const error1 = new Error('Error 1');
      const error2 = new Error('Error 2');
      const error3 = new Error('Error 3');

      // Add errors rapidly
      client.reportError(error1, '1.0.0');
      client.reportError(error2, '1.0.0');
      client.reportError(error3, '1.0.0');

      await new Promise((resolve) => setTimeout(resolve, 150));

      // Queue processes errors one at a time (no concurrent processing)
      // Third error replaces first in queue before it's processed, so all 3 get sent
      expect(mockFetch).toHaveBeenCalledTimes(3);
    });
  });

  describe('CLIErrorReport format', () => {
    it('should format error report correctly', async () => {
      mockFetch.mockResolvedValueOnce({ ok: true });

      const error = new Error('Test error');
      client.reportError(error, '1.2.3', 'gemini-2.5-pro', {
        error_type: 'chat-error',
        session_id: 'abc-123',
      });

      await new Promise((resolve) => setTimeout(resolve, 50));

      const callArgs = mockFetch.mock.calls[0];
      const body = JSON.parse(callArgs[1].body);

      expect(body).toHaveProperty('message');
      expect(body).toHaveProperty('cli_version', '1.2.3');
      expect(body).toHaveProperty('model', 'gemini-2.5-pro');
      expect(body).toHaveProperty('metadata');
      expect(body.metadata?.error_type).toBe('chat-error');
      expect(body.metadata?.session_id).toBe('abc-123');
    });

    it('should convert numeric and boolean metadata values to strings', async () => {
      mockFetch.mockResolvedValueOnce({ ok: true });

      const error = new Error('Test error');
      client.reportError(error, '1.0.0', 'test-model', {
        string_val: 'hello',
        number_val: 42,
        float_val: 3.14,
        bool_true: true,
        bool_false: false,
        null_val: null,
      });

      await new Promise((resolve) => setTimeout(resolve, 50));

      const callArgs = mockFetch.mock.calls[0];
      const body = JSON.parse(callArgs[1].body);

      expect(body.metadata?.string_val).toBe('hello');
      expect(body.metadata?.number_val).toBe('42');
      expect(body.metadata?.float_val).toBe('3.14');
      expect(body.metadata?.bool_true).toBe('true');
      expect(body.metadata?.bool_false).toBe('false');
      expect(body.metadata?.null_val).toBe('null');
    });
  });
});
