/**
 * @license
 * Copyright 2025 Nessy CLI Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { AuthType } from '@nestor/nessy-cli-core';
import {
  buildAuthMethods,
  pickAuthMethodsForAuthRequired,
} from './authMethods.js';

describe('ACP auth methods', () => {
  it('advertises the supported auth methods', () => {
    const authMethods = buildAuthMethods();

    expect(authMethods.map((method) => method.id)).toEqual([
      AuthType.USE_OPENAI,
      AuthType.DP_AUTH,
    ]);
  });

  it('narrows to the stored selection when it is a known method', () => {
    const authMethods = pickAuthMethodsForAuthRequired(AuthType.DP_AUTH);

    expect(authMethods.map((method) => method.id)).toEqual([AuthType.DP_AUTH]);
  });

  it('falls back to all known methods for an unknown stored selection', () => {
    const authMethods = pickAuthMethodsForAuthRequired('unknown-auth-type');

    expect(authMethods.map((method) => method.id)).toEqual([
      AuthType.USE_OPENAI,
      AuthType.DP_AUTH,
    ]);
  });
});
