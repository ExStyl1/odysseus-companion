import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { DpCredentials } from './dp-token-manager.js';

vi.mock('./dp-token-manager.js', () => ({
  setTransientCredentialsInMemory: vi.fn(),
}));

import { setTransientCredentialsInMemory } from './dp-token-manager.js';
import { tryAuthFromEnv } from './dp-delegated-token.js';

const mockSetTransient = vi.mocked(setTransientCredentialsInMemory);

function encodeBase64Url(input: string): string {
  return Buffer.from(input, 'utf-8').toString('base64url');
}

function makeJwt(payload: Record<string, unknown>): string {
  const header = encodeBase64Url(JSON.stringify({ alg: 'none', typ: 'JWT' }));
  const body = encodeBase64Url(JSON.stringify(payload));
  return `${header}.${body}.sig`;
}

// [nessy-fork] dp-auth-runtime-model-catalog
describe('tryAuthFromEnv', () => {
  const originalToken = process.env['NESSY_CLI_DP_AUTH_TOKEN'];

  beforeEach(() => {
    mockSetTransient.mockReset();
    delete process.env['NESSY_CLI_DP_AUTH_TOKEN'];
  });

  afterEach(() => {
    if (originalToken === undefined) {
      delete process.env['NESSY_CLI_DP_AUTH_TOKEN'];
    } else {
      process.env['NESSY_CLI_DP_AUTH_TOKEN'] = originalToken;
    }
  });

  it('returns null and does nothing when NESSY_CLI_DP_AUTH_TOKEN is absent', async () => {
    const result = await tryAuthFromEnv();

    expect(result).toBeNull();
    expect(mockSetTransient).not.toHaveBeenCalled();
  });

  it('builds credentials from a valid JWT without fetching models', async () => {
    const expSec = Math.floor(Date.now() / 1000) + 3600;
    process.env['NESSY_CLI_DP_AUTH_TOKEN'] = makeJwt({
      exp: expSec,
      sub: 'user-123',
      preferred_username: 'alice',
    });
    const result = (await tryAuthFromEnv()) as DpCredentials;

    expect(result).not.toBeNull();
    expect(result.jwt).toBe(process.env['NESSY_CLI_DP_AUTH_TOKEN']);
    expect(result.expiresAt).toBe(expSec * 1000);
    expect(result.username).toBe('alice');
    expect(result.userId).toBe('user-123');
    expect(mockSetTransient).toHaveBeenCalledWith(result);
  });

  it('throws with "NESSY_CLI_DP_AUTH_TOKEN is invalid:" prefix when JWT is malformed', async () => {
    process.env['NESSY_CLI_DP_AUTH_TOKEN'] = 'not-a-jwt';

    await expect(tryAuthFromEnv()).rejects.toThrow(
      /^NESSY_CLI_DP_AUTH_TOKEN is invalid: /,
    );
    expect(mockSetTransient).not.toHaveBeenCalled();
  });

  it('throws "NESSY_CLI_DP_AUTH_TOKEN is expired" when exp is in the past', async () => {
    process.env['NESSY_CLI_DP_AUTH_TOKEN'] = makeJwt({
      exp: Math.floor(Date.now() / 1000) - 60,
      sub: 'user-123',
    });

    await expect(tryAuthFromEnv()).rejects.toThrow(
      /^NESSY_CLI_DP_AUTH_TOKEN is expired$/,
    );
    expect(mockSetTransient).not.toHaveBeenCalled();
  });
});
