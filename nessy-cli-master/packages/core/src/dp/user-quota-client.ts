import type { Config } from '../config/config.js';
import { AuthType } from '../core/contentGenerator.js';
import { DEFAULT_NESTOR_QUOTA_URL } from '../core/openaiContentGenerator/constants.js';
import { buildNestorAuthHeaders } from './nestor-auth-header.js';

// [nessy-fork] user-quota-display
const QUOTA_REQUEST_TIMEOUT_MS = 30_000;

export interface UserQuotaDisplay {
  title: string;
  description?: UserQuotaDescriptionPart[];
}

export interface UserQuotaDescriptionPart {
  type: string;
  text: string;
  url?: string;
}

export interface UserQuotaScope {
  type: string;
  values: string[];
}

export interface UserQuotaStatus {
  state: string;
  message: string;
}

export interface UserQuota {
  id: string;
  display: UserQuotaDisplay;
  scope: UserQuotaScope;
  usage: number;
  status: UserQuotaStatus;
  resetAt?: string;
}

export interface UserQuotaSnapshot {
  schemaVersion: string;
  generatedAt: string;
  limits: UserQuota[];
}

export class UserQuotaUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UserQuotaUnavailableError';
  }
}

export async function fetchUserQuota(
  config: Config,
  signal?: AbortSignal,
): Promise<UserQuotaSnapshot> {
  const generationConfig = config.getContentGeneratorConfig();
  if (generationConfig?.authType !== AuthType.DP_AUTH) {
    throw new UserQuotaUnavailableError(
      'User quotas are available only when using DP Auth.',
    );
  }
  if (!generationConfig.apiKey) {
    throw new UserQuotaUnavailableError(
      'DP Auth credentials are not available.',
    );
  }

  const timeoutSignal = AbortSignal.timeout(QUOTA_REQUEST_TIMEOUT_MS);
  const requestSignal = signal
    ? AbortSignal.any([signal, timeoutSignal])
    : timeoutSignal;
  const version = config.getCliVersion() || 'unknown';
  const response = await fetch(DEFAULT_NESTOR_QUOTA_URL, {
    headers: {
      Accept: 'application/json',
      'User-Agent': `NessyCLI/${version} (${process.platform}; ${process.arch})`,
      ...buildNestorAuthHeaders(generationConfig.apiKey),
    },
    signal: requestSignal,
  });

  if (!response.ok) {
    throw new UserQuotaUnavailableError(
      `Quota request failed with HTTP ${response.status}.`,
    );
  }

  return parseUserQuotaSnapshot(await response.json());
}

function parseUserQuotaSnapshot(value: unknown): UserQuotaSnapshot {
  const response = asRecord(value, 'quota response');
  const rawLimits = response['limits'];
  if (!Array.isArray(rawLimits)) {
    throw new UserQuotaUnavailableError(
      'Quota response does not contain a limits array.',
    );
  }

  return {
    schemaVersion: requiredString(response, 'schema_version'),
    generatedAt: requiredString(response, 'generated_at'),
    limits: rawLimits.map(parseUserQuota),
  };
}

function parseUserQuota(value: unknown): UserQuota {
  const quota = asRecord(value, 'quota');
  const display = asRecord(quota['display'], 'quota display');
  const scope = asRecord(quota['scope'], 'quota scope');
  const status = asRecord(quota['status'], 'quota status');
  const rawValues = scope['values'];
  if (
    !Array.isArray(rawValues) ||
    rawValues.some((item) => typeof item !== 'string')
  ) {
    throw new UserQuotaUnavailableError(
      'Quota scope values must be an array of strings.',
    );
  }
  const usage = quota['usage'];
  if (typeof usage !== 'number' || !Number.isFinite(usage)) {
    throw new UserQuotaUnavailableError('Quota usage must be a number.');
  }

  const description = parseUserQuotaDescription(display['description']);
  const resetAt = optionalString(quota, 'reset_at');
  return {
    id: requiredString(quota, 'id'),
    display: {
      title: requiredString(display, 'title'),
      ...(description !== undefined ? { description } : {}),
    },
    scope: {
      type: requiredString(scope, 'type'),
      values: rawValues,
    },
    usage,
    status: {
      state: requiredString(status, 'state'),
      message: requiredString(status, 'message'),
    },
    ...(resetAt !== undefined ? { resetAt } : {}),
  };
}

function parseUserQuotaDescription(
  value: unknown,
): UserQuotaDescriptionPart[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') {
    return [{ type: 'text', text: value }];
  }
  if (!Array.isArray(value)) {
    throw new UserQuotaUnavailableError(
      'Quota field description must be an array.',
    );
  }
  return value.map(parseUserQuotaDescriptionPart);
}

function parseUserQuotaDescriptionPart(
  value: unknown,
): UserQuotaDescriptionPart {
  const part = asRecord(value, 'quota description part');
  const type = requiredString(part, 'type');
  const text = requiredString(part, 'text');
  const url = optionalString(part, 'url');
  if (type.toLowerCase() === 'link' && url === undefined) {
    throw new UserQuotaUnavailableError(
      'Quota field url must be a string for a link description part.',
    );
  }
  return {
    type,
    text,
    ...(url !== undefined ? { url } : {}),
  };
}

function asRecord(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new UserQuotaUnavailableError(`${name} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function requiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== 'string') {
    throw new UserQuotaUnavailableError(`Quota field ${key} must be a string.`);
  }
  return value;
}

function optionalString(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = record[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    throw new UserQuotaUnavailableError(`Quota field ${key} must be a string.`);
  }
  return value;
}
