import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../config/config.js';
import { AuthType } from '../core/contentGenerator.js';
import { DEFAULT_NESTOR_QUOTA_URL } from '../core/openaiContentGenerator/constants.js';
import {
  fetchUserQuota,
  UserQuotaUnavailableError,
} from './user-quota-client.js';

const mockFetch = vi.fn();
global.fetch = mockFetch;

function config(authType: AuthType, apiKey = 'jwt'): Config {
  return {
    getCliVersion: () => '1.2.3',
    getContentGeneratorConfig: () => ({ authType, apiKey }),
  } as Config;
}

describe('fetchUserQuota', () => {
  beforeEach(() => mockFetch.mockReset());
  afterEach(() => vi.unstubAllEnvs());

  it('fetches and maps a quota snapshot', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        schema_version: '1.0',
        generated_at: '2026-08-17T12:00:00Z',
        future_field: true,
        limits: [
          {
            id: 'agent-dynamic-budget',
            display: {
              title: 'Dynamic budget',
              description: [
                { type: 'text', text: 'Daily budget. ' },
                {
                  type: 'link',
                  text: 'Quota documentation',
                  url: 'https://example.com/docs/quotas',
                },
                { type: 'future-part', text: ' Future note.' },
              ],
            },
            scope: { type: 'future-scope', values: ['default'] },
            usage: 0.83,
            status: {
              state: 'future-state',
              severity: { future: true },
              message: 'Backend message',
            },
            reset_at: '2026-08-18T08:00:00Z',
            unknown: 'ignored',
          },
        ],
      }),
    });

    const snapshot = await fetchUserQuota(config(AuthType.DP_AUTH));

    expect(mockFetch).toHaveBeenCalledWith(
      DEFAULT_NESTOR_QUOTA_URL,
      expect.objectContaining({
        headers: expect.objectContaining({
          Accept: 'application/json',
          'Nestor-Token': 'jwt',
        }),
      }),
    );
    const headers = mockFetch.mock.calls[0][1].headers as Record<
      string,
      string
    >;
    expect(headers['Accept-Language']).toBeUndefined();
    expect(snapshot.limits[0]).toMatchObject({
      id: 'agent-dynamic-budget',
      display: {
        title: 'Dynamic budget',
        description: [
          { type: 'text', text: 'Daily budget. ' },
          {
            type: 'link',
            text: 'Quota documentation',
            url: 'https://example.com/docs/quotas',
          },
          { type: 'future-part', text: ' Future note.' },
        ],
      },
      usage: 0.83,
      scope: { type: 'future-scope', values: ['default'] },
      status: { state: 'future-state', message: 'Backend message' },
      resetAt: '2026-08-18T08:00:00Z',
    });
    expect(snapshot.limits[0]?.status).toEqual({
      state: 'future-state',
      message: 'Backend message',
    });
  });

  it('accepts a quota without a description', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        schema_version: '1.0',
        generated_at: '2026-08-17T12:00:00Z',
        limits: [],
      }),
    });

    await expect(fetchUserQuota(config(AuthType.DP_AUTH))).resolves.toEqual({
      schemaVersion: '1.0',
      generatedAt: '2026-08-17T12:00:00Z',
      limits: [],
    });
  });

  it('normalizes a legacy string description', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        schema_version: '1.0',
        generated_at: '2026-08-17T12:00:00Z',
        limits: [
          {
            id: 'quota',
            display: { title: 'Quota', description: 'Legacy text' },
            scope: { type: 'account', values: [] },
            usage: 0.5,
            status: { state: 'allowed', message: 'Available' },
          },
        ],
      }),
    });

    const snapshot = await fetchUserQuota(config(AuthType.DP_AUTH));

    expect(snapshot.limits[0]?.display.description).toEqual([
      { type: 'text', text: 'Legacy text' },
    ]);
  });

  it('rejects a link description part without a URL', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        schema_version: '1.0',
        generated_at: '2026-08-17T12:00:00Z',
        limits: [
          {
            id: 'quota',
            display: {
              title: 'Quota',
              description: [{ type: 'link', text: 'Docs' }],
            },
            scope: { type: 'account', values: [] },
            usage: 0.5,
            status: { state: 'allowed', message: 'Available' },
          },
        ],
      }),
    });

    await expect(fetchUserQuota(config(AuthType.DP_AUTH))).rejects.toThrow(
      'url',
    );
  });

  it('uses bearer auth for an env delegated token', async () => {
    vi.stubEnv('NESSY_CLI_DP_AUTH_TOKEN', 'jwt');
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        schema_version: '1.0',
        generated_at: '2026-08-17T12:00:00Z',
        limits: [],
      }),
    });

    await fetchUserQuota(config(AuthType.DP_AUTH));

    const headers = mockFetch.mock.calls[0][1].headers as Record<
      string,
      string
    >;
    expect(headers['Authorization']).toBe('Bearer jwt');
    expect(headers['Nestor-Token']).toBeUndefined();
  });

  it('does not call Nestor for another auth type', async () => {
    await expect(
      fetchUserQuota(config(AuthType.USE_OPENAI)),
    ).rejects.toBeInstanceOf(UserQuotaUnavailableError);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('rejects malformed quota responses', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({}) });
    await expect(fetchUserQuota(config(AuthType.DP_AUTH))).rejects.toThrow(
      'limits array',
    );
  });

  it('reports unsuccessful responses', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });
    await expect(fetchUserQuota(config(AuthType.DP_AUTH))).rejects.toThrow(
      'HTTP 500',
    );
  });
});
