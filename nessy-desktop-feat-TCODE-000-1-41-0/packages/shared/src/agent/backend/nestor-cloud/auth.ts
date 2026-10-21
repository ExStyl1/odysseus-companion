import { createHash } from 'node:crypto';
import { getValidCreds } from '../../../auth/dp/creds-store.ts';
import { APP_VERSION } from '../../../version/index.ts';
import { NestorCloudClientError } from './types.ts';

export interface NestorCloudAuthHeadersOptions {
  credsPath?: string;
  deviceId?: string;
  userAgent?: string;
}

export interface NestorCloudAuthContext {
  headers: Record<string, string>;
  token: string;
  username?: string;
  userId?: string;
}

function buildDeviceId(userId: string | undefined, username: string | undefined): string {
  const stable = userId || username || 'anonymous';
  return `nessy-${createHash('sha256').update(stable).digest('hex').slice(0, 24)}`;
}

export function buildNestorCloudAuthHeaders(
  options: NestorCloudAuthHeadersOptions = {},
): NestorCloudAuthContext {
  const creds = getValidCreds(options.credsPath);
  if (!creds?.jwt?.trim()) {
    throw new NestorCloudClientError(
      'missing-token',
      'Nestor credentials are missing or expired',
    );
  }

  const deviceId = options.deviceId ?? buildDeviceId(creds.userId, creds.username);
  const userAgent = options.userAgent ?? `NessyDesktop/${APP_VERSION}`;

  return {
    token: creds.jwt,
    username: creds.username,
    userId: creds.userId,
    headers: {
      'Nestor-Token': creds.jwt,
      'Device-Id': deviceId,
      'User-Agent': userAgent,
    },
  };
}
