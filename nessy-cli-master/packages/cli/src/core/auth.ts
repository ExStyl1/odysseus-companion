/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AuthType,
  type Config,
  createDebugLogger,
  decodeJwt,
  getErrorMessage,
  getStatistClient,
  logAuth,
  AuthEvent,
  StatistEventName,
} from '@nestor/nessy-cli-core';

const debugLogger = createDebugLogger('AUTH');

// [nessy-fork] dp-auth-single-startup-auth
function recordAuthStatistics(
  config: Config,
  result: { success: boolean; error?: string },
): void {
  try {
    const authType = config.getModelsConfig().getCurrentAuthType();
    const jwt =
      result.success && authType === AuthType.DP_AUTH
        ? config.getContentGeneratorConfig().apiKey
        : undefined;
    const identity = jwt ? decodeJwt(jwt) : undefined;

    getStatistClient()?.pushEvent(StatistEventName.Auth, {
      success: result.success,
      userId: identity?.sub,
      username: identity?.preferred_username,
      error: result.error,
      cliVersion: config.getCliVersion(),
      authType,
    } as never);
  } catch (error) {
    debugLogger.warn('Failed to record authentication statistics:', error);
  }
}

/**
 * Handles the initial authentication flow.
 * @param config The application config.
 * @param authType The selected auth type.
 * @returns An error message if authentication fails, otherwise null.
 */
export async function performInitialAuth(
  config: Config,
  authType: AuthType | undefined,
): Promise<string | null> {
  if (!authType) {
    return null;
  }

  try {
    await config.refreshAuth(authType, true);
    // The console.log is intentionally left out here.
    // We can add a dedicated startup message later if needed.

    // Log authentication success
    const authEvent = new AuthEvent(authType, 'auto', 'success');
    logAuth(config, authEvent);
    // [nessy-fork] dp-auth-single-startup-auth
    recordAuthStatistics(config, { success: true });
  } catch (e) {
    const errorMessage = `Failed to login. Message: ${getErrorMessage(e)}`;

    // Log authentication failure
    const authEvent = new AuthEvent(authType, 'auto', 'error', errorMessage);
    logAuth(config, authEvent);
    // [nessy-fork] dp-auth-single-startup-auth
    recordAuthStatistics(config, { success: false, error: errorMessage });

    return errorMessage;
  }

  return null;
}
