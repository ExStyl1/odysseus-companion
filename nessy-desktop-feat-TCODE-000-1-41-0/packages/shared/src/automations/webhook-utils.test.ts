/**
 * Tests for webhook utility functions (expandWebhookAction, etc.)
 */

import { describe, it, expect } from 'bun:test';
import { createServer } from 'node:http';
import { executeWebhookRequest, expandWebhookAction } from './webhook-utils.ts';
import type { WebhookAction } from './types.ts';

const env = {
  NESSY_WH_SESSION_ID: 'sess-123',
  NESSY_WH_EVENT: 'LabelAdd',
  API_TOKEN: 'tok-secret',
};

describe('expandWebhookAction', () => {
  it('expands URL templates', () => {
    const action: WebhookAction = {
      type: 'webhook',
      url: 'https://api.example.com/hook/${NESSY_WH_SESSION_ID}',
    };
    const result = expandWebhookAction(action, env);
    expect(result.url).toBe('https://api.example.com/hook/sess-123');
  });

  it('expands header values', () => {
    const action: WebhookAction = {
      type: 'webhook',
      url: 'https://api.example.com',
      headers: { 'X-Event': '${NESSY_WH_EVENT}', 'X-Static': 'unchanged' },
    };
    const result = expandWebhookAction(action, env);
    expect(result.headers).toEqual({ 'X-Event': 'LabelAdd', 'X-Static': 'unchanged' });
  });

  it('expands string body', () => {
    const action: WebhookAction = {
      type: 'webhook',
      url: 'https://api.example.com',
      body: 'session=${NESSY_WH_SESSION_ID}',
      bodyFormat: 'raw',
    };
    const result = expandWebhookAction(action, env);
    expect(result.body).toBe('session=sess-123');
  });

  it('expands object body (JSON)', () => {
    const action: WebhookAction = {
      type: 'webhook',
      url: 'https://api.example.com',
      body: { id: '${NESSY_WH_SESSION_ID}', event: '${NESSY_WH_EVENT}' },
    };
    const result = expandWebhookAction(action, env);
    expect(result.body).toEqual({ id: 'sess-123', event: 'LabelAdd' });
  });

  it('expands basic auth credentials', () => {
    const action: WebhookAction = {
      type: 'webhook',
      url: 'https://api.example.com',
      auth: { type: 'basic', username: '${NESSY_WH_SESSION_ID}', password: '${API_TOKEN}' },
    };
    const result = expandWebhookAction(action, env);
    expect(result.auth).toEqual({ type: 'basic', username: 'sess-123', password: 'tok-secret' });
  });

  it('expands bearer auth token', () => {
    const action: WebhookAction = {
      type: 'webhook',
      url: 'https://api.example.com',
      auth: { type: 'bearer', token: '${API_TOKEN}' },
    };
    const result = expandWebhookAction(action, env);
    expect(result.auth).toEqual({ type: 'bearer', token: 'tok-secret' });
  });

  it('passes through fields without templates unchanged', () => {
    const action: WebhookAction = {
      type: 'webhook',
      url: 'https://api.example.com/static',
      method: 'PUT',
      bodyFormat: 'json',
      captureResponse: true,
    };
    const result = expandWebhookAction(action, env);
    expect(result.url).toBe('https://api.example.com/static');
    expect(result.method).toBe('PUT');
    expect(result.bodyFormat).toBe('json');
    expect(result.captureResponse).toBe(true);
  });
});

describe('executeWebhookRequest cancellation', () => {
  it('aborts an in-flight local request when its caller signal aborts', async () => {
    let markStarted!: () => void;
    const started = new Promise<void>(resolve => { markStarted = resolve; });
    let markClientClosed!: () => void;
    const clientClosed = new Promise<void>(resolve => { markClientClosed = resolve; });
    const server = createServer((request, response) => {
      markStarted();
      request.once('close', () => {
        markClientClosed();
        response.destroy();
      });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('local test server address unavailable');
    const controller = new AbortController();

    try {
      const pending = executeWebhookRequest({
        type: 'webhook',
        url: `http://127.0.0.1:${address.port}`,
      }, {
        timeoutMs: 2_000,
        signal: controller.signal,
      });
      await started;
      controller.abort();

      await expect(pending).resolves.toMatchObject({
        success: false,
        statusCode: 0,
        error: 'Request aborted by caller',
      });
      await expect(Promise.race([
        clientClosed.then(() => true),
        new Promise(resolve => setTimeout(() => resolve(false), 500)),
      ])).resolves.toBe(true);
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
});
