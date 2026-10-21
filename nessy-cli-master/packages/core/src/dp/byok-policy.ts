import { APIConnectionError } from '@anthropic-ai/sdk';

// [nessy-fork] dp-byok-error-handling
export function isDpByokModel(
  authType: string | undefined,
  model: string | undefined,
): boolean {
  return authType === 'dp-auth' && !!model?.startsWith('byok/');
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : {};
}

function errorDetails(error: unknown) {
  const outer = record(error);
  let payload = record(outer['error']);
  // This SDK version carries SSE error events as JSON in the message.
  if (error instanceof APIConnectionError) {
    try {
      payload = record(JSON.parse(error.message));
    } catch {
      // Network failures have a plain-text message.
    }
  }
  const detail = 'error' in payload ? record(payload['error']) : payload;
  const headers = outer['headers'];
  const source =
    headers instanceof Headers
      ? headers.get('X-Nestor-Error-Source')
      : record(headers)['x-nestor-error-source'];
  return {
    status: Number(outer['status']),
    code: detail['code'] ?? outer['code'],
    message: detail['message'],
    detail,
    source:
      error instanceof APIConnectionError && typeof payload['type'] === 'string'
        ? 'upstream'
        : source,
  };
}

export function isNestorAuthError(error: unknown): boolean {
  const { status, code, source } = errorDetails(error);
  // Provider 401s must never start a DP login or replay a paid request.
  return (
    source !== 'upstream' &&
    (code === 'DP_AUTH_REQUIRED' ||
      (status === 401 && (!code || code === 'EUNAUTHORIZED')))
  );
}

export function byokError(error: unknown): unknown {
  const { message, detail } = errorDetails(error);
  if (typeof message !== 'string' || !message) return error;
  if (error instanceof APIConnectionError) {
    Object.assign(error, { error: detail });
  }
  if (error instanceof Error) {
    error.message = message;
    return error;
  }
  return Object.assign(new Error(message), error, { message });
}
