/**
 * Rate-limit survival for the Nestor cloud backend (F9, F18, F27).
 *
 * The backend signals "too fast" on two completely different channels and the
 * client must answer each in its own shape:
 *
 * 1. **Transport 429** — the user-limit middleware rejects the POST before the
 *    A2A handler runs (`service/nestor/internal/httpserver/userlimit_middleware.go:54-71`),
 *    so nothing has streamed and the ORIGINAL request is still the correct one
 *    to repeat verbatim.
 * 2. **In-band `-32029`** — a `retryable_error` DATA PART inside a live stream
 *    (`pkg/agentcore/a2a/extensions/retryable_error_extension.go:55-62`); the
 *    backend then ends the stream `INPUT_REQUIRED`
 *    (`.../vibe/agent/a2a_environment.go:157-165`). The task is frozen mid-turn,
 *    so the retry is a NEW send carrying {@link RETRY_MARKER_PART} on the
 *    `contextId` alone.
 *
 * The budget mirrors the connector's (`nessy-acp-agent/src/adapter/a2a/a2a-retry-manager.ts:4-11`)
 * so a Nestor user sees the same patience from both clients.
 */

import type { A2APart } from './types.ts';

/** `a2a-retry-manager.ts:4-9` — the connector's `RETRY_CONFIG`, verbatim. */
export const RATE_LIMIT_MAX_RETRIES = 10;
export const RATE_LIMIT_INITIAL_DELAY_MS = 5_000;
export const RATE_LIMIT_MAX_DELAY_MS = 60_000;
export const SERVER_ERROR_MAX_RETRIES = 1;

/**
 * `a2a-retry-manager.ts:11`. The two codes that mean "come back later"; every
 * other code from the SAME extension is persistent — `-32000` (inference error /
 * aborted task) and `-32603` (internal agent error), `retryable_error_extension.go:55-72`
 * — and is surfaced to the user instead of retried.
 */
export const RATE_LIMIT_ERROR_CODES: ReadonlySet<number> = new Set([429, -32029]);

export function isRetryableStreamErrorCode(code: unknown): boolean {
  return typeof code === 'number' && RATE_LIMIT_ERROR_CODES.has(code);
}

/**
 * The client→agent retry request, `retryable_error_schema.json` → `retrySchema`:
 * `{ retry: {} }`, required.
 *
 * v2 shape: parts are a flattened oneof discriminated by key presence
 * (`a2a/core.go:672-716`), so there is NO `kind` — the connector's 0.3 spelling
 * (`nessy-acp-agent/src/adapter/a2a/utils.ts:62-65`) still carries `kind:'data'`
 * and would be decoded as an unknown part here.
 */
export const RETRY_MARKER_PART: A2APart = Object.freeze({ data: { retry: {} } });

/** How much of a backend error body is worth showing (and logging). */
export const NESTOR_ERROR_MESSAGE_MAX_CHARS = 300;

/**
 * A transport-level failure that may be repeated with the ORIGINAL arguments.
 *
 * Thrown only from the pre-stream status check, which is what licenses the
 * verbatim resend: no SSE frame has been read, so no text, tool call or task
 * state has been observed yet.
 */
export class NestorCloudRetryableTransportError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    /** 429 → the rate-limit budget with backoff; 5xx → the one-shot server-error budget. */
    public readonly rateLimited: boolean,
  ) {
    super(message);
    this.name = 'NestorCloudRetryableTransportError';
  }
}

/**
 * Reads the human message out of a backend error body.
 *
 * The quota limiter answers echo's default envelope
 * (`{"message":"суточный лимит токенов исчерпан, лимит обновится в 00:00"}` /
 * `{"message":"too many requests"}` — `userlimit_middleware.go:15-20`, no custom
 * `HTTPErrorHandler` is registered); the generic per-identity limiter answers
 * plain text (`middleware.go:171-175`); the agent-overload flag answers a nested
 * `{"error":{"message":…}}` (`llm_proxy_handler.go:143-150`).
 *
 * The envelope is unwrapped BEFORE redaction on purpose: `redactNestorSecrets`
 * replaces any `{…}` run wholesale, so redacting the raw JSON would throw the
 * message away instead of the secret.
 */
export function readNestorErrorBodyMessage(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    const message = readMessageField(parsed);
    if (message) return message;
    // A JSON object with no message field is a PAYLOAD, not prose. Handing the
    // raw body back would put it through `redactNestorSecrets`, whose `{…}` rule
    // replaces the whole brace run — the user would read "[redacted-payload]",
    // where the caller's fallback (`Nestor rate limit: <status>`) at least says
    // what happened.
    if (typeof parsed === 'object' && parsed !== null) return undefined;
  } catch {
    // Not JSON — the plain-text deny path.
  }
  return trimmed;
}

function readMessageField(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.message === 'string' && record.message.trim()) return record.message.trim();
  const nested = record.error;
  if (typeof nested === 'string' && nested.trim()) return nested.trim();
  return readMessageField(nested);
}

export function capNestorErrorMessage(message: string): string {
  return message.length > NESTOR_ERROR_MESSAGE_MAX_CHARS
    ? `${message.slice(0, NESTOR_ERROR_MESSAGE_MAX_CHARS)}…`
    : message;
}

/**
 * One turn's retry budget. Two independent counters, exactly as the connector
 * keeps them: a rate-limit budget with exponential backoff, and a one-shot
 * server-error budget with no delay at all.
 */
export class NestorCloudRetryPolicy {
  private rateLimitRetries = 0;
  private rateLimitDelayMs = 0;
  private serverErrorRetries = 0;

  /** How many rate-limit retries have been handed out — for the status line. */
  get rateLimitAttempt(): number {
    return this.rateLimitRetries;
  }

  /**
   * The next backoff, or `undefined` once the budget is spent (the caller then
   * surfaces the backend's own message — `a2a-retry-manager.ts:36-56`).
   */
  nextRateLimitDelayMs(): number | undefined {
    this.rateLimitDelayMs = this.rateLimitRetries === 0
      ? RATE_LIMIT_INITIAL_DELAY_MS
      : Math.min(this.rateLimitDelayMs * 2, RATE_LIMIT_MAX_DELAY_MS);
    this.rateLimitRetries++;
    if (this.rateLimitRetries > RATE_LIMIT_MAX_RETRIES) return undefined;
    return this.rateLimitDelayMs;
  }

  /** `a2a-retry-manager.ts:58-61` — one immediate retry, then the error stands. */
  allowServerErrorRetry(): boolean {
    this.serverErrorRetries++;
    return this.serverErrorRetries <= SERVER_ERROR_MAX_RETRIES;
  }
}

/**
 * Sleep that the turn's abort signal cuts short. Resolves `true` when the delay
 * elapsed, `false` when the turn was aborted — a 60s backoff must never outlive
 * a Stop, and the caller must be able to tell the two apart (it ends the turn
 * on the second).
 */
export function sleepUnlessAborted(ms: number, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false);
  return new Promise<boolean>((resolve) => {
    const onAbort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve(true);
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
