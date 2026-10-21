import { describe, expect, it } from 'bun:test';
import {
  NESTOR_ERROR_MESSAGE_MAX_CHARS,
  NestorCloudRetryPolicy,
  RATE_LIMIT_ERROR_CODES,
  RATE_LIMIT_INITIAL_DELAY_MS,
  RATE_LIMIT_MAX_DELAY_MS,
  RATE_LIMIT_MAX_RETRIES,
  RETRY_MARKER_PART,
  SERVER_ERROR_MAX_RETRIES,
  capNestorErrorMessage,
  isRetryableStreamErrorCode,
  readNestorErrorBodyMessage,
  sleepUnlessAborted,
} from '../retry.ts';

describe('nestor-cloud retry constants', () => {
  it('mirrors the connector\'s budget', () => {
    // `nessy-acp-agent/src/adapter/a2a/a2a-retry-manager.ts:4-11`.
    expect(RATE_LIMIT_MAX_RETRIES).toBe(10);
    expect(RATE_LIMIT_INITIAL_DELAY_MS).toBe(5_000);
    expect(RATE_LIMIT_MAX_DELAY_MS).toBe(60_000);
    expect(SERVER_ERROR_MAX_RETRIES).toBe(1);
    expect([...RATE_LIMIT_ERROR_CODES].sort((a, b) => a - b)).toEqual([-32029, 429]);
  });

  it('treats only the two rate-limit codes as retryable', () => {
    expect(isRetryableStreamErrorCode(-32029)).toBe(true);
    expect(isRetryableStreamErrorCode(429)).toBe(true);
    // `retryable_error_extension.go:55-72` — the persistent halves of the SAME
    // extension: inference error / aborted task / internal agent error.
    expect(isRetryableStreamErrorCode(-32000)).toBe(false);
    expect(isRetryableStreamErrorCode(-32603)).toBe(false);
    expect(isRetryableStreamErrorCode(undefined)).toBe(false);
  });

  it('carries the v2 retry marker part with no `kind` and no taskId of its own', () => {
    // v2 parts are a flattened oneof discriminated by key presence
    // (`a2a/core.go:672-716`); the connector's 0.3 marker
    // (`src/adapter/a2a/utils.ts:62-65`) still spells `kind: 'data'`.
    expect(RETRY_MARKER_PART).toEqual({ data: { retry: {} } });
    expect(Object.keys(RETRY_MARKER_PART)).toEqual(['data']);
  });
});

describe('NestorCloudRetryPolicy', () => {
  it('doubles from the initial delay, caps at the max, and exhausts after the budget', () => {
    const policy = new NestorCloudRetryPolicy();
    const delays: Array<number | undefined> = [];
    for (let i = 0; i < RATE_LIMIT_MAX_RETRIES + 1; i++) {
      delays.push(policy.nextRateLimitDelayMs());
    }
    expect(delays).toEqual([
      5_000, 10_000, 20_000, 40_000, 60_000,
      60_000, 60_000, 60_000, 60_000, 60_000,
      undefined,
    ]);
    // Once spent it stays spent.
    expect(policy.nextRateLimitDelayMs()).toBeUndefined();
  });

  it('reports the attempt number for the status line', () => {
    const policy = new NestorCloudRetryPolicy();
    expect(policy.rateLimitAttempt).toBe(0);
    policy.nextRateLimitDelayMs();
    expect(policy.rateLimitAttempt).toBe(1);
    policy.nextRateLimitDelayMs();
    expect(policy.rateLimitAttempt).toBe(2);
  });

  it('allows exactly SERVER_ERROR_MAX_RETRIES server-error retries, on its own budget', () => {
    const policy = new NestorCloudRetryPolicy();
    expect(policy.allowServerErrorRetry()).toBe(true);
    expect(policy.allowServerErrorRetry()).toBe(false);
    // The rate-limit budget is untouched by the server-error one.
    expect(policy.nextRateLimitDelayMs()).toBe(RATE_LIMIT_INITIAL_DELAY_MS);
  });
});

describe('readNestorErrorBodyMessage', () => {
  it('reads the echo error envelope the quota limiter emits', () => {
    // `userlimit_middleware.go:15-20` + echo's default serialization.
    expect(readNestorErrorBodyMessage('{"message":"суточный лимит токенов исчерпан, лимит обновится в 00:00"}'))
      .toBe('суточный лимит токенов исчерпан, лимит обновится в 00:00');
    expect(readNestorErrorBodyMessage('{"message":"too many requests"}')).toBe('too many requests');
  });

  it('falls back to the raw body for the plain-text deny, and gives up on an empty one', () => {
    // The generic per-identity limiter answers plain text (`middleware.go:171-175`).
    expect(readNestorErrorBodyMessage('rate limit exceeded')).toBe('rate limit exceeded');
    expect(readNestorErrorBodyMessage('   ')).toBeUndefined();
    expect(readNestorErrorBodyMessage('')).toBeUndefined();
  });

  it('reads the nested error envelope of the agent-overload flag', () => {
    // `llm_proxy_handler.go:143-150` answers `{"error":{"message":…}}` at 429.
    expect(readNestorErrorBodyMessage('{"error":{"message":"агентский режим временно недоступен"}}'))
      .toBe('агентский режим временно недоступен');
  });

  it('gives up on a parsed object that carries no message, rather than handing back the payload', () => {
    // The raw body would go straight into `redactNestorSecrets`, whose `{…}` rule
    // replaces the whole brace run — the user would read "[redacted-payload]"
    // where the caller's own `Nestor rate limit: <status>` says strictly more.
    expect(readNestorErrorBodyMessage('{"code":429,"details":{"retry_after":30}}')).toBeUndefined();
    expect(readNestorErrorBodyMessage('{}')).toBeUndefined();
    expect(readNestorErrorBodyMessage('[{"message":"nested"}]')).toBeUndefined();
  });

  it('caps a runaway body', () => {
    const capped = capNestorErrorMessage('x'.repeat(NESTOR_ERROR_MESSAGE_MAX_CHARS + 200));
    expect(capped.length).toBeLessThanOrEqual(NESTOR_ERROR_MESSAGE_MAX_CHARS + 1);
    expect(capped.endsWith('…')).toBe(true);
    expect(capNestorErrorMessage('short')).toBe('short');
  });
});

describe('sleepUnlessAborted', () => {
  it('resolves true when the delay elapses', async () => {
    expect(await sleepUnlessAborted(1)).toBe(true);
  });

  it('resolves false as soon as the signal aborts, without waiting the delay', async () => {
    const controller = new AbortController();
    const started = Date.now();
    const pending = sleepUnlessAborted(30_000, controller.signal);
    controller.abort();
    expect(await pending).toBe(false);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('resolves false immediately for an already-aborted signal', async () => {
    expect(await sleepUnlessAborted(30_000, AbortSignal.abort())).toBe(false);
  });
});
