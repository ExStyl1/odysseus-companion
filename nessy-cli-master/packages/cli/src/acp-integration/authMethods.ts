/**
 * @license
 * Copyright 2025 Nessy Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { AuthType } from '@nestor/nessy-cli-core';
import type { AuthMethod } from '@agentclientprotocol/sdk';

export function buildAuthMethods(): AuthMethod[] {
  return [
    {
      id: AuthType.USE_OPENAI,
      name: 'Use OpenAI API key',
      description: 'Requires setting the `OPENAI_API_KEY` environment variable',
      _meta: {
        type: 'terminal',
        args: ['--auth-type=openai'],
      },
    },
    // [nessy-fork] dp-auth
    {
      id: AuthType.DP_AUTH,
      name: 'DP Authentication',
      description: 'Authenticate via DP CLI (shared with IDE plugins)',
      _meta: {
        type: 'terminal',
        args: ['--auth-type=dp-auth'],
      },
    },
  ];
}

export function pickAuthMethodsForAuthRequired(
  selectedType?: AuthType | string,
): AuthMethod[] {
  const authMethods = buildAuthMethods();
  if (selectedType) {
    const matched = authMethods.filter((method) => method.id === selectedType);
    return matched.length ? matched : authMethods;
  }

  return authMethods;
}
