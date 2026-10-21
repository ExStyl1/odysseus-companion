/**
 * dp token → Nestor JWT exchange (POST /api/v2/token).
 *
 * The exchange origin is the gateway HOST ROOT, NOT the `/api/v1/cli` chat
 * prefix (00-context) — the constant lives here and must not be derived from
 * the chat-prefix constant. Tokens never enter logs or error messages.
 */

import { randomUUID } from 'node:crypto';
import { DpAuthError, DpAuthServiceError } from './errors.ts';
import { combineAbort, isAbortError } from './internal.ts';

export const NESSY_TOKEN_EXCHANGE_URL =
  'https://code-completion-nestor.tcsbank.ru/api/v2/token';

const EXCHANGE_TIMEOUT_MS = 30_000;

export interface ExchangeOptions {
  signal?: AbortSignal;
  /** Override endpoint — dependency-injection seam for tests only. */
  url?: string;
  /** Override timeout — dependency-injection seam for tests only. */
  timeoutMs?: number;
}

/**
 * Exchange a dp access token for a long-lived Nestor JWT.
 * 401 → ExchangeFailed ("dp token rejected"); other non-2xx → ExchangeFailed
 * with the status (body truncated to 200 chars, token never included).
 */
export async function exchangeDpToken(
  dpToken: string,
  opts: ExchangeOptions = {},
): Promise<{ jwt: string }> {
  const url = opts.url ?? NESSY_TOKEN_EXCHANGE_URL;
  const { signal, timeout } = combineAbort(
    opts.signal,
    opts.timeoutMs ?? EXCHANGE_TIMEOUT_MS,
  );

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Request-Id': randomUUID(),
        Authorization: `Bearer ${dpToken}`,
      },
      body: JSON.stringify({}),
      signal,
    });
  } catch (err) {
    if (isAbortError(err)) {
      throw timeout.aborted
        ? new DpAuthServiceError(DpAuthError.Timeout, 'token exchange timed out')
        : new DpAuthServiceError(DpAuthError.Cancelled, 'token exchange cancelled');
    }
    throw new DpAuthServiceError(DpAuthError.ExchangeFailed, 'token exchange request failed');
  }

  if (!response.ok) {
    if (response.status === 401) {
      throw new DpAuthServiceError(DpAuthError.ExchangeFailed, 'dp token rejected');
    }
    let body = '';
    try {
      body = (await response.text()).slice(0, 200);
    } catch {
      // ignore — body is best-effort context only
    }
    throw new DpAuthServiceError(
      DpAuthError.ExchangeFailed,
      `token exchange HTTP ${response.status}${body ? `: ${body}` : ''}`,
    );
  }

  let data: { jwt?: unknown };
  try {
    data = (await response.json()) as { jwt?: unknown };
  } catch {
    throw new DpAuthServiceError(DpAuthError.ExchangeFailed, 'token exchange returned invalid JSON');
  }
  if (typeof data.jwt !== 'string' || data.jwt.length === 0) {
    throw new DpAuthServiceError(DpAuthError.ExchangeFailed, 'token exchange response missing jwt');
  }
  return { jwt: data.jwt };
}
