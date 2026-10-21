/**
 * NESSY_CLI_DP_AUTH_TOKEN env-based auth bypass.
 * delegated Spirit IAM token provided in the environment.
 * See: https://devplatform.pages.devplatform.tcsbank.ru/spirit-integration-docs/docs/spirit-iam/how-tos/token-exchange/
 *
 */

import { createDebugLogger } from '../utils/debugLogger.js';
import { decodeJwt, type JwtPayload } from './jwt-decoder.js';
import {
  setTransientCredentialsInMemory,
  type DpCredentials,
} from './dp-token-manager.js';

const NESSY_CLI_DP_AUTH_TOKEN_ENV = 'NESSY_CLI_DP_AUTH_TOKEN';
const logger = createDebugLogger('DP');

/**
 * If NESSY_CLI_DP_AUTH_TOKEN is set in the environment, build DpCredentials from it,
 * populate the in-memory credential cache, and return.
 */
// [nessy-fork] dp-auth-runtime-model-catalog
// [nessy-fork] delegated-token-auth
export async function tryAuthFromEnv(): Promise<DpCredentials | null> {
  const token = process.env[NESSY_CLI_DP_AUTH_TOKEN_ENV];
  if (!token) return null;

  let jwt: JwtPayload;
  try {
    jwt = decodeJwt(token);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`${NESSY_CLI_DP_AUTH_TOKEN_ENV} is invalid: ${reason}`);
  }

  const expiresAt = jwt.exp * 1000;
  if (expiresAt <= Date.now()) {
    throw new Error(`${NESSY_CLI_DP_AUTH_TOKEN_ENV} is expired`);
  }

  const credentials: DpCredentials = {
    jwt: token,
    expiresAt,
    // In Spirit IAM delegated tokens the "preferred_username" claim is not present
    username: jwt.preferred_username || '',
    userId: jwt.sub || '',
  };

  logger.info(
    `Using ${NESSY_CLI_DP_AUTH_TOKEN_ENV} from environment for user: ${credentials.username}`,
  );

  setTransientCredentialsInMemory(credentials);
  return credentials;
}
