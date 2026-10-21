/**
 * OpenAI-style error envelopes so Codex's Responses client surfaces a real
 * error instead of a socket reset.
 *
 * The `classifyError` / `inferHttpStatusFromAdapterMessage` /
 * `parseRetryAfterFromMessage` / `adapterFailureFromMessage` block below is
 * VENDORED from opencodex (github.com/lidge-jun/opencodex) @ 16bef04, MIT
 * (`src/lib/errors.ts:1-168`).
 * Copyright (c) 2026 opencodex contributors. MIT — see
 * https://github.com/lidge-jun/opencodex/blob/main/LICENSE
 * Local changes: ONE, added by P3.334 and marked at both sites — **403 is split
 * out of the 401 family**, in `classifyError` and in
 * `inferHttpStatusFromAdapterMessage`. Everything else is copied verbatim,
 * because the value of these tables is that they are pinned against live
 * captures. A mid-200-stream error envelope has no HTTP status of its own;
 * callers classify it from its text by passing `status: 0` (or by going through
 * `adapterFailureFromMessage`, which infers one). Nothing here renames a code the
 * codex conformance suite pins; these are all new exports.
 * See docs/superpowers/plans/2026-08-04-claude-sdk-runtime-on-nessy-integrations.md (T3b).
 */
export interface OpenAiErrorEnvelope {
  error: { message: string; type: string; code: string | null };
}

export function openAiError(
  message: string,
  type = 'api_error',
  code: string | null = null,
): OpenAiErrorEnvelope {
  return { error: { message, type, code } };
}

/** A terminal Responses SSE error event (streamed mid-turn failure). */
export function responsesErrorEvent(message: string): string {
  const data = JSON.stringify({ type: 'error', message });
  return `event: error\ndata: ${data}\n\n`;
}

// ---------------------------------------------------------------------------
// Vendored error taxonomy (opencodex @ 16bef04, `src/lib/errors.ts`, MIT).
// ---------------------------------------------------------------------------

/** The classified error payload a terminal `response.failed` carries. */
export interface ClassifiedError {
  message: string;
  type: string;
  code: string | null;
}

/**
 * Upstream status + text → the Responses error taxonomy codex-rs understands.
 *
 * `server_is_overloaded` and `context_length_exceeded` are the two codes codex-rs
 * treats specially (`responses.rs is_server_overloaded_error` applies retry-after
 * backoff to the first; a generic `upstream_server_error` gets none), which is why
 * the keyword tables are copied rather than summarized.
 *
 * Source: opencodex `src/lib/errors.ts:7-86`.
 */
export function classifyError(status: number, type: string, message: string): ClassifiedError {
  const text = message.toLowerCase();
  if (
    text.includes('context_length_exceeded') ||
    text.includes('context window') ||
    text.includes('context length') ||
    text.includes('maximum context') ||
    text.includes('too many tokens')
  ) {
    return { message, type: 'invalid_request_error', code: 'context_length_exceeded' };
  }
  if (
    text.includes('insufficient_quota') ||
    text.includes('exceeded your current quota') ||
    text.includes('quota exhausted') ||
    text.includes('account quota exceeded') ||
    text.includes('monthly quota exceeded') ||
    text.includes('daily quota exceeded')
  ) {
    return { message, type: 'insufficient_quota', code: 'insufficient_quota' };
  }
  if (
    status === 429 ||
    text.includes('rate limit') ||
    text.includes('rate limited') ||
    text.includes('too many requests') ||
    text.includes('resource_exhausted') ||
    text.includes('resource exhausted') ||
    text.includes('throttlingexception') ||
    text.includes('throttling')
  ) {
    return { message, type: 'rate_limit_error', code: 'rate_limit_exceeded' };
  }
  if (type === 'origin_rejected') {
    return { message, type: 'invalid_request_error', code: 'origin_rejected' };
  }
  /**
   * P3.334 — LOCAL DIVERGENCE from the vendored table, and the only one.
   *
   * Upstream lumps 403 in with 401 below and answers `invalid_api_key`. A 403 is
   * authenticated-and-refused: on this gateway it is the guardrail
   * (`403 {"error":"… Security Guardrail Triggered …"}`, measured 2026-08-15),
   * and telling the user their key is invalid sends them to re-enter a working
   * one — the identical finding the claude side records at
   * `shared/src/agent/claude-sdk-error-mapper.ts` ("A 403 IS NOT AN AUTH
   * FAILURE"). `permission_error` is not invented for this: it is what
   * `anthropic/outbound.ts::anthropicErrorType(403)` already answers, so the two
   * routes agree on the name.
   *
   * REACHABILITY, measured at HEAD so the next reader need not re-derive it: the
   * only production caller of `classifyError` is `adapterFailureFromMessage`
   * (from `from-chat-stream.ts`), and it derives the status from
   * `inferHttpStatusFromAdapterMessage` — which could not return 403 until the
   * companion change below. This branch is therefore not decoration: the pair is
   * what makes a mid-stream refusal legible, and either half alone is inert.
   */
  if (status === 403) {
    return { message, type: 'permission_error', code: 'permission_denied' };
  }
  if (
    status === 401 ||
    type === 'authentication_error' ||
    text.includes('authentication failed') ||
    text.includes('access denied') ||
    text.includes('unauthorizedexception') ||
    text.includes('unrecognizedclientexception') ||
    text.includes('unrecognizedclient') ||
    text.includes('expired token') ||
    text.includes('expiredtoken')
  ) {
    return { message, type: 'authentication_error', code: 'invalid_api_key' };
  }
  if (
    status === 503 ||
    text.includes('overloaded') ||
    text.includes('server is busy') ||
    text.includes('temporarily unavailable')
  ) {
    // Codex recognizes "server_is_overloaded" and applies retry-after backoff
    // (responses.rs is_server_overloaded_error); "upstream_server_error" is not recognized.
    return { message, type: 'server_error', code: 'server_is_overloaded' };
  }
  if (
    text.includes('validationexception') ||
    text.includes('invalid request') ||
    text.includes('model unavailable') ||
    text.includes('model not found') ||
    text.includes('unsupported model') ||
    text.includes('profile arn') ||
    text.includes('wrong region') ||
    text.includes('invalid region')
  ) {
    return { message, type: 'invalid_request_error', code: 'invalid_request_error' };
  }
  if (status >= 500) return { message, type: 'server_error', code: 'upstream_server_error' };
  if (status === 400 || type === 'invalid_request_error') {
    return { message, type: 'invalid_request_error', code: 'invalid_request_error' };
  }
  return { message, type, code: type || null };
}

/**
 * Best-effort parse of a retry delay embedded in an upstream error message.
 * Source: opencodex `src/lib/errors.ts:88-103`.
 */
export function parseRetryAfterFromMessage(message: string): number | undefined {
  const patterns = [
    /try again in (\d+(?:\.\d+)?)\s*s(?:ec(?:ond)?s?)?/i,
    /retry after (\d+(?:\.\d+)?)\s*s(?:ec(?:ond)?s?)?/i,
    /retry[- ]after[:\s]+(\d+)/i,
  ];
  for (const pattern of patterns) {
    const match = message.match(pattern);
    if (!match?.[1]) continue;
    const seconds = Number.parseFloat(match[1]);
    if (Number.isFinite(seconds) && seconds > 0) return Math.ceil(seconds);
  }
  return undefined;
}

/**
 * Infer an HTTP status from terminal error text (provider-agnostic keywords), for
 * the mid-stream case where the transport already returned 200.
 * Source: opencodex `src/lib/errors.ts:105-146`.
 */
export function inferHttpStatusFromAdapterMessage(message: string): number {
  const lower = message.toLowerCase();
  if (
    lower.includes('resource_exhausted') ||
    lower.includes('resource exhausted') ||
    lower.includes('rate limit') ||
    lower.includes('too many requests') ||
    lower.includes('throttling')
  ) return 429;
  /**
   * P3.334 — LOCAL DIVERGENCE, the companion to the 403 branch in
   * `classifyError`. Upstream folds these five refusal words into the 401 return
   * below; a refusal is not a credential problem, and the status is what both
   * consumers key on (`anthropic/outbound.ts` turns 403 into `permission_error`
   * and 401 into `authentication_error`; codex-rs runs its `handle_unauthorized`
   * credential-refresh path on a 401 and its policy classification on a 403).
   *
   * The split is by WORD, not by guess: `unauthenticated` / `unauthorized` /
   * `invalid token` / `expired token` / `authentication` stay on 401 because
   * each names the credential; `permission_denied` / `permission denied` /
   * `forbidden` / `access denied` move to 403 because each names a decision
   * taken about an accepted credential.
   */
  if (
    lower.includes('permission_denied') ||
    lower.includes('permission denied') ||
    lower.includes('forbidden') ||
    lower.includes('access denied')
  ) return 403;
  if (
    lower.includes('unauthenticated') ||
    lower.includes('unauthorized') ||
    lower.includes('invalid token') ||
    lower.includes('expired token') ||
    lower.includes('authentication')
  ) return 401;
  if (
    lower.includes('unavailable') ||
    lower.includes('overloaded') ||
    lower.includes('temporarily') ||
    lower.includes('server is busy')
  ) return 503;
  if (
    lower.includes('invalid') ||
    lower.includes('not found') ||
    lower.includes('unsupported') ||
    lower.includes('malformed') ||
    lower.includes('unimplemented')
  ) return 400;
  if (
    lower.includes('timed out') ||
    lower.includes('timeout') ||
    lower.includes('etimedout') ||
    lower.includes('deadline')
  ) return 504;
  return 502;
}

/**
 * Map a terminal upstream error message to an HTTP status + classified payload.
 * Source: opencodex `src/lib/errors.ts:148-168`.
 */
export function adapterFailureFromMessage(message: string): { httpStatus: number; error: ClassifiedError } {
  const httpStatus = inferHttpStatusFromAdapterMessage(message);
  let finalMessage = message;
  const retryAfterSeconds = parseRetryAfterFromMessage(message);
  if (retryAfterSeconds && !/please try again in /i.test(message)) {
    finalMessage = `${message} Please try again in ${retryAfterSeconds}s.`;
  }
  const errorType = httpStatus === 429
    ? 'rate_limit_error'
    : httpStatus === 401
      ? 'authentication_error'
      // P3.334 — the third arm of the split; `classifyError` decides the final
      // shape for 403, but the type handed to it must not say "auth" either.
      : httpStatus === 403
        ? 'permission_error'
        : httpStatus === 503 || httpStatus === 504
          ? 'server_error'
          : httpStatus === 400
            ? 'invalid_request_error'
            : 'upstream_error';
  return { httpStatus, error: classifyError(httpStatus, errorType, finalMessage) };
}
