/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../config/config.js';
import { exchangeToken } from './dp-token-exchange-client.js';

describe('dp-token-exchange-client', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends the Nessy CLI User-Agent', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        token: {
          created_at: '2026-01-01T00:00:00Z',
          id: 'token-id',
          expires_at: '2026-01-01T01:00:00Z',
        },
        jwt: 'jwt',
      }),
    });
    vi.stubGlobal('fetch', fetchMock);
    const config = {
      getCliVersion: () => '1.2.3',
    } as Config;

    await exchangeToken('request-id', 'dp-token', undefined, config);

    expect(fetchMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({
          'User-Agent': `NessyCLI/1.2.3 (${process.platform}; ${process.arch})`,
        }),
      }),
    );
  });
});
