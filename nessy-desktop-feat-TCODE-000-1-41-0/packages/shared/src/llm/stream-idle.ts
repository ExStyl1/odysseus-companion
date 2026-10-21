/**
 * P6.58 — ONE idle abort for every raw SSE byte-relay this repo owns.
 *
 * THE DEFECT. A model stream that goes quiet without closing hangs the session
 * forever: `await reader.read()` never settles, the turn never ends, and there
 * is no error, no boundary and no event. Node's `res`/`req` `'close'` handlers
 * that every relay already installs fire on the CLIENT hanging up — they say
 * nothing about an upstream that stopped speaking while the socket stays open.
 *
 * NATIVE-FIRST, asked before any of this was written. Three of the five stream
 * paths already had an answer and are deliberately NOT touched:
 *
 *  - **Claude runtime — and this bullet SAID THE ARMING CONDITION BACKWARDS
 *    until P6.115.** The bundled SDK does ship a byte-stream watchdog, and it is
 *    **off on every session this product creates**. Read out of the vendored
 *    `claude-agent-sdk-darwin-arm64/claude`, first at `2.1.233` and re-read at
 *    `2.1.247`; the names are minified, are NOT the pin, and are no longer
 *    written down at all. Twice now a set of them has gone stale under this
 *    bullet — three at the first reading, and every one of the replacements at
 *    the `0.3.247` lift — so the transcription spells ROLES and keeps only the
 *    env vars, the statsig gate name and the host list, which a minifier cannot
 *    rewrite. Find it again by the `CLAUDE_ENABLE_BYTE_WATCHDOG` lines inside
 *    it:
 *
 *    ```js
 *    function <watchdogApplies>(e){if(!<watchdogEnabled>())return!1;return <providerOk>(e)&&<providerOk>(<currentProvider>())}
 *    function <watchdogEnabled>(){if(<isFalsy>(process.env.CLAUDE_ENABLE_BYTE_WATCHDOG))return!1;if(<isTruthy>(process.env.CLAUDE_ENABLE_BYTE_WATCHDOG))return!0;return <flag>("tengu_stream_watchdog_default_on",!0)}
 *    function <providerOk>(e){return <firstPartyOrAws>(e)||e==="bedrock"&&<bedrockOptIn>()}
 *    function <firstPartyOrAws>(e){return e==="firstParty"&&<isFirstPartyBaseUrl>()||e==="anthropicAws"&&!process.env.ANTHROPIC_AWS_BASE_URL}
 *    function <isFirstPartyBaseUrl>(){if(V._CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL)return!0;return <baseUrlIsAnthropic>()}
 *    function <baseUrlIsAnthropic>(){let e=process.env.ANTHROPIC_BASE_URL;if(!e)return!0;return <hostIsAnthropic>(e)}
 *    function <hostIsAnthropic>(e){try{let t=new URL(e).host;return["api.anthropic.com"].includes(t)}catch{return!1}}
 *    ```
 *
 *    The provider test is true for `firstParty` only when the first-party test
 *    is — i.e. when the base URL IS `api.anthropic.com`. Every Nessy Claude
 *    session points `ANTHROPIC_BASE_URL` at the loopback adapter and strips
 *    `_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL`, so the first-party test is
 *    false, the arming predicate is false, and `StreamIdleTimeoutError` cannot
 *    be raised here. Setting `CLAUDE_ENABLE_BYTE_WATCHDOG=1` only forces the
 *    enable-gate true while the arming predicate stays
 *    false — measured, not inferred: a real turn against a silent-but-open
 *    upstream with that variable set and `CLAUDE_STREAM_IDLE_TIMEOUT_MS=10000`
 *    was still running 120 s later (P6.114).
 *
 *    **What DOES end such a turn, measured with a run rather than read:
 *    544 907 ms — about nine minutes — with `API Error: The operation timed
 *    out.`** None of `API_TIMEOUT_MS`, `API_FORCE_IDLE_TIMEOUT` or the watchdog
 *    gate shortens it on this route, although `API_TIMEOUT_MS` demonstrably
 *    reaches the child and bounds the phase BEFORE headers (7 attempts in 90 s
 *    against 1 with no lever). So this file's own relays are not the outlier the
 *    bullet used to imply: on the claude route the bound exists, it is nine
 *    minutes, and it is not configurable from here. The claude route is still
 *    deliberately not given a second watchdog — see P6.115's ruling and O6 —
 *    but for the stated bound, not for a watchdog that was never armed.
 *  - **Codex `/v1/responses`, and the Anthropic route sharing its pipeline.**
 *    `from-chat-stream.ts` already carries a heartbeat + stall watchdog
 *    (`DEFAULT_STALL_TIMEOUT_SEC = 90`) that emits
 *    `response.incomplete` / `upstream_stall_timeout` and aborts.
 *
 * What was left is the two relays with nothing behind them: Pi's gateway
 * reasoning proxy, and the nestor-cloud A2A client. Pi's own client cannot
 * rescue either — `@earendil-works/pi-ai` carries an `idleTimeoutMs` ONLY on
 * `api/openai-codex-responses.js`'s WebSocket path (the positive control that
 * this probe reads the package at all), and the chat-completions path we use
 * passes only a caller `AbortSignal` to the `openai` client, whose own
 * `timeout` is cleared in `fetchWithTimeout`'s `finally` as soon as the headers
 * arrive (`openai@6.44.0` `client.js`) and therefore never covers the body.
 *
 * THE NUMBER, and what it was measured against. {@link STREAM_IDLE_TIMEOUT_DEFAULT_MS}
 * is 300 000 ms because that is the deadline the one runtime that DOES have a
 * watchdog waits before calling a stream dead on an endpoint like ours — not a
 * value picked from zero, and not a value picked from how fast a healthy stream
 * happens to be. The clamp is the SDK's own floor and ceiling too, so an
 * operator override cannot be set below a floor at which a thinking model's
 * normal silence would manufacture the failure this guards against.
 *
 * It is deliberately NOT the codex route's 90 s: that route writes a keepalive
 * into the stream every 2 s, so its budget measures silence from a source that
 * is being actively prodded. A raw byte relay forwards silence verbatim, so its
 * budget has to be the one its client would itself have used.
 */

import { parseNumericSetting, reportNumericSettingRejection } from '../config/numeric-setting.ts';

/**
 * Silence after which a raw byte relay abandons the stream.
 *
 * The Claude Agent SDK's non-first-party byte-stream idle deadline, mirrored so
 * the three runtimes answer a stalled stream at the same time rather than at
 * three different times nobody wrote down. (Its own first-party deadline is
 * 180 000 ms; we are never first-party.)
 */
export const STREAM_IDLE_TIMEOUT_DEFAULT_MS = 300_000;

/** Lowest override we accept — the SDK's own floor. */
export const STREAM_IDLE_TIMEOUT_FLOOR_MS = 10_000;

/** Highest override we accept — the SDK's own ceiling. */
export const STREAM_IDLE_TIMEOUT_CEILING_MS = 1_800_000;

/** The operator's knob. Named for what it governs, clamped to the range above. */
export const STREAM_IDLE_TIMEOUT_ENV = 'NESSY_STREAM_IDLE_TIMEOUT_MS';

/**
 * The stall, named. Thrown rather than swallowed so it reaches whatever the
 * caller shows the user: a relay that merely stopped writing is the original
 * defect with a shorter wait.
 *
 * The message deliberately matches the SDK's wording — a user comparing a Pi
 * session against a Claude one should not have to learn two vocabularies for
 * one condition.
 */
export class StreamIdleTimeoutError extends Error {
  override readonly name = 'StreamIdleTimeoutError';
  readonly idleMs: number;
  readonly bytesReceived: number;

  constructor(idleMs: number, bytesReceived: number) {
    super(`stream idle: no bytes for ${idleMs}ms`);
    this.idleMs = idleMs;
    this.bytesReceived = bytesReceived;
  }
}

/**
 * P6.565 · the GENERAL rule, routed by the documented counterpart's page row.
 *
 * `NESSY_STREAM_IDLE_TIMEOUT_MS` is our own name for the deadline
 * `CLAUDE_STREAM_IDLE_TIMEOUT_MS` sets on the vendored binary, and that row —
 * *"Timeout in milliseconds before the event- and byte-level streaming idle
 * watchdogs close a stalled connection…"* — notes nothing about plain digits.
 * `env-vars.md#variables` therefore grants it scientific notation and digit
 * separators, so `6e5` and `600_000` are legal spellings of ten minutes. The
 * `/^\d+$/` this replaced was the house convention applied without reading the
 * row; a resolver that refused `6e5` while the SDK accepted it would be exactly
 * the one-setting-two-meanings divergence this fork keeps finding.
 *
 * Returns `undefined` rather than a fallback so the caller keeps its own
 * default AND its clamp; the rejection is stated by
 * {@link reportNumericSettingRejection} against that same default.
 */
function parsePositiveInteger(value: string | undefined): number | undefined {
  if (value === undefined || value.trim().length === 0) return undefined;
  const parsed = parseNumericSetting(value, { min: 1 });
  if (parsed.ok) return parsed.value;
  reportNumericSettingRejection(
    STREAM_IDLE_TIMEOUT_ENV,
    value,
    parsed.reason,
    STREAM_IDLE_TIMEOUT_DEFAULT_MS,
  );
  return undefined;
}

/**
 * The deadline this process uses. An unparseable or out-of-range override is
 * CLAMPED rather than rejected, matching the SDK's `Math.min(Math.max(...))`:
 * a typo in an operator's env must not silently restore the hang.
 */
export function resolveStreamIdleTimeoutMs(
  env: Readonly<Record<string, string | undefined>> = typeof process === 'undefined' ? {} : process.env,
): number {
  const override = parsePositiveInteger(env[STREAM_IDLE_TIMEOUT_ENV]);
  const chosen = override ?? STREAM_IDLE_TIMEOUT_DEFAULT_MS;
  return Math.min(Math.max(chosen, STREAM_IDLE_TIMEOUT_FLOOR_MS), STREAM_IDLE_TIMEOUT_CEILING_MS);
}

/**
 * What this module actually needs from a reader — declared STRUCTURALLY, and
 * that is not a style choice.
 *
 * Stream and fetch types come from different lib sets in different packages of
 * this monorepo: `packages/shared` loads one, `packages/pi-agent-server`
 * another, and Bun's globals add a third (its reader carries `readMany`, which
 * the DOM's does not). A named global — `ReadableStreamDefaultReader`,
 * `ReadableStreamReadResult` — therefore typechecks green in one package and
 * red in the next, while the RUNTIME behaviour is identical in all three. Two
 * fixes on this branch today (`db76657bb` `HeadersInit`, `836f09007`
 * `Headers.entries()`) were the same trap.
 *
 * So: name what we call, not where it came from. Every reader we are handed —
 * DOM, `node:stream/web`, Bun — satisfies this, and extra members do not hurt.
 */
export interface ByteStreamReader {
  read(): Promise<{ done: boolean; value?: Uint8Array | undefined }>;
  cancel(reason?: unknown): Promise<void>;
}

export interface StreamIdleOptions {
  /** Silence budget. Defaults to {@link resolveStreamIdleTimeoutMs}. */
  idleTimeoutMs?: number;
  /** Injectable clock for tests; defaults to the global timers. */
  setTimeoutImpl?: typeof setTimeout;
  clearTimeoutImpl?: typeof clearTimeout;
}

/**
 * Read a byte stream, abandoning it once it has been silent for the budget.
 *
 * The timer is re-armed per chunk, so it measures SILENCE and not total turn
 * duration — a long answer that keeps producing tokens is never interrupted.
 * On expiry the reader is cancelled (so the upstream stops draining tokens into
 * a turn nobody is reading) and a {@link StreamIdleTimeoutError} is thrown at
 * the consumer, which owns how the user is told.
 */
export async function* readWithIdleTimeout(
  reader: ByteStreamReader,
  options: StreamIdleOptions = {},
): AsyncGenerator<Uint8Array> {
  const idleMs = options.idleTimeoutMs ?? resolveStreamIdleTimeoutMs();
  const arm = options.setTimeoutImpl ?? setTimeout;
  const disarm = options.clearTimeoutImpl ?? clearTimeout;
  let bytesReceived = 0;

  for (;;) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const idle = new Promise<never>((_resolve, reject) => {
      timer = arm(() => reject(new StreamIdleTimeoutError(idleMs, bytesReceived)), idleMs);
      // Never hold the process open for a stream nobody is waiting on.
      (timer as unknown as { unref?: () => void }).unref?.();
    });
    // The idle promise is rejected exactly once and always awaited by the race
    // below, so it can never become an unhandled rejection.
    let chunk: Awaited<ReturnType<ByteStreamReader['read']>>;
    try {
      chunk = await Promise.race([reader.read(), idle]);
    } catch (error) {
      // Best effort: the loser of the race is still pending, and cancelling
      // settles it as well as closing the upstream socket.
      void reader.cancel(error).catch(() => {});
      throw error;
    } finally {
      if (timer !== undefined) disarm(timer);
    }
    if (chunk.done) return;
    if (chunk.value) {
      bytesReceived += chunk.value.byteLength;
      yield chunk.value;
    }
  }
}
