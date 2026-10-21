/**
 * DP token exchange client.
 * Exchanges a DP token for a JWT via POST /api/v2/token.
 * Ported from assistant's clients/authClient.ts.
 */

import { createDebugLogger } from '../utils/debugLogger.js';
import { DpAuthError, DpAuthServiceError } from './dp-errors.js';
import { NESTOR_SERVER_URL } from '../core/openaiContentGenerator/constants.js';
import type { Config } from '../config/config.js';

const logger = createDebugLogger('DP');

// [nessy-fork] dp-auth
const TOKEN_EXCHANGE_PATH = '/api/v2/token';
const DEFAULT_TIMEOUT = 30_000;

export interface TokenResponse {
  token: {
    created_at: string;
    id: string;
    expires_at: string;
  };
  jwt: string;
}

export async function exchangeToken(
  requestId: string,
  dpToken: string,
  serverUrl?: string,
  config?: Config,
): Promise<TokenResponse> {
  const origin = serverUrl || NESTOR_SERVER_URL;
  const url = `${origin}${TOKEN_EXCHANGE_PATH}`;
  const version = config?.getCliVersion() || 'unknown';

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT);

  logger.info('Exchanging DP token for JWT at:', url);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': `NessyCLI/${version} (${process.platform}; ${process.arch})`,
        'X-Request-Id': requestId,
        Authorization: `Bearer ${dpToken}`,
      },
      body: JSON.stringify({}),
      signal: controller.signal,
    });

    if (!response.ok) {
      let body = '';
      try {
        body = await response.text();
      } catch {
        // ignore
      }
      logger.error(
        `Token exchange failed: ${response.status} ${response.statusText}`,
        body,
      );
      if (response.status === 401) {
        throw new DpAuthServiceError(
          DpAuthError.TokenExchangeFailed,
          new Error(`Unauthorized (401) for ${TOKEN_EXCHANGE_PATH}`),
        );
      }
      throw new DpAuthServiceError(
        DpAuthError.TokenExchangeFailed,
        new Error(
          `HTTP ${response.status} for ${TOKEN_EXCHANGE_PATH}${body ? `: ${body}` : ''}`,
        ),
      );
    }

    const data = (await response.json()) as TokenResponse;
    logger.info('Token exchange succeeded');
    return data;
  } catch (error) {
    if (error instanceof DpAuthServiceError) throw error;
    logger.error('Token exchange error:', error);
    throw new DpAuthServiceError(DpAuthError.TokenExchangeFailed, error);
  } finally {
    clearTimeout(timer);
  }
}
