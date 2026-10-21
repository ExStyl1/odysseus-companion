/**
 * Tests for buildNestorAuthHeaders header-discrimination helper.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildNestorAuthHeaders } from './nestor-auth-header.js';

describe('buildNestorAuthHeaders', () => {
  const originalEnv = process.env['NESSY_CLI_DP_AUTH_TOKEN'];

  beforeEach(() => {
    delete process.env['NESSY_CLI_DP_AUTH_TOKEN'];
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env['NESSY_CLI_DP_AUTH_TOKEN'];
    } else {
      process.env['NESSY_CLI_DP_AUTH_TOKEN'] = originalEnv;
    }
  });

  it('returns Nestor-Token header when NESSY_CLI_DP_AUTH_TOKEN env is not set', () => {
    expect(buildNestorAuthHeaders('jwt-from-dp-exchange')).toEqual({
      'Nestor-Token': 'jwt-from-dp-exchange',
    });
  });

  it('returns Authorization Bearer header when NESSY_CLI_DP_AUTH_TOKEN matches the JWT', () => {
    process.env['NESSY_CLI_DP_AUTH_TOKEN'] = 'env-delegated-jwt';

    expect(buildNestorAuthHeaders('env-delegated-jwt')).toEqual({
      Authorization: 'Bearer env-delegated-jwt',
    });
  });

  it('falls back to Nestor-Token when NESSY_CLI_DP_AUTH_TOKEN env differs from the JWT', () => {
    // Edge case: env happens to be set, but the current credentials came
    // from a different source (e.g. classic dp auth login). We must not
    // mislabel them as a delegated Spirit-IAM token.
    process.env['NESSY_CLI_DP_AUTH_TOKEN'] = 'env-delegated-jwt';

    expect(buildNestorAuthHeaders('different-jwt-from-dp-exchange')).toEqual({
      'Nestor-Token': 'different-jwt-from-dp-exchange',
    });
  });

  it('treats empty NESSY_CLI_DP_AUTH_TOKEN as not-set and uses Nestor-Token header', () => {
    process.env['NESSY_CLI_DP_AUTH_TOKEN'] = '';

    expect(buildNestorAuthHeaders('any-jwt')).toEqual({
      'Nestor-Token': 'any-jwt',
    });
  });
});
