/**
 * P6.58 — the idle abort, and the three ways a test of it passes on the bug.
 *
 *  1. Asserting "it stopped" between two EMPTY outputs. A relay that produced
 *     nothing and a relay that hung both end with no bytes, so every assertion
 *     here first proves the PARTIAL output reached the consumer.
 *  2. Asserting only that it eventually threw. A watchdog wired to fire at zero
 *     also throws, and would kill every healthy slow stream; so the elapsed time
 *     is measured and required to be at least the budget.
 *  3. Asserting only the timeout and never the message. The row is "a stalled
 *     stream hangs the session"; a stall the user cannot see is that defect with
 *     a shorter wait, so the reason is asserted as text.
 *
 * The budget used here is far below the shipped default (300 000 ms) purely so
 * the suite runs — the FLOOR that number was chosen against is pinned
 * separately in `resolveStreamIdleTimeoutMs`, where a below-floor override is
 * clamped rather than obeyed.
 */
import { describe, expect, it } from 'bun:test';
import {
  readWithIdleTimeout,
  resolveStreamIdleTimeoutMs,
  StreamIdleTimeoutError,
  STREAM_IDLE_TIMEOUT_CEILING_MS,
  STREAM_IDLE_TIMEOUT_DEFAULT_MS,
  STREAM_IDLE_TIMEOUT_ENV,
  STREAM_IDLE_TIMEOUT_FLOOR_MS,
} from '../stream-idle.ts';

const encoder = new TextEncoder();

/** A stream that emits `chunks`, waiting `gapMs` between them, then goes SILENT forever. */
function stallingStream(chunks: readonly string[], gapMs: number): {
  stream: ReadableStream<Uint8Array>;
  cancelled: () => boolean;
} {
  let wasCancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      for (const chunk of chunks) {
        await new Promise((resolve) => setTimeout(resolve, gapMs));
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          return; // consumer went away
        }
      }
      // …and never closes. This is the defect's shape: an open socket with
      // nothing on it, which `reader.read()` waits on forever.
    },
    cancel() {
      wasCancelled = true;
    },
  });
  return { stream, cancelled: () => wasCancelled };
}

async function collect(
  stream: ReadableStream<Uint8Array>,
  idleTimeoutMs: number,
): Promise<{ text: string; error: unknown; elapsedMs: number }> {
  const decoder = new TextDecoder();
  const started = Date.now();
  let text = '';
  let error: unknown;
  try {
    for await (const value of readWithIdleTimeout(stream.getReader(), { idleTimeoutMs })) {
      text += decoder.decode(value, { stream: true });
    }
  } catch (caught) {
    error = caught;
  }
  return { text, error, elapsedMs: Date.now() - started };
}

describe('readWithIdleTimeout', () => {
  it('abandons a silent stream after the budget, with the partial answer and a reason', async () => {
    const IDLE_MS = 120;
    const { stream, cancelled } = stallingStream(['alpha ', 'beta'], 10);
    const { text, error, elapsedMs } = await collect(stream, IDLE_MS);

    // (1) NOT two empty outputs: everything the model did say arrived first.
    expect(text).toBe('alpha beta');
    // (2) It waited. A watchdog that fires early is a different bug wearing
    // this one's test — the two chunks alone take ~20 ms, so the floor here is
    // the BUDGET and not merely "some time passed".
    expect(elapsedMs).toBeGreaterThanOrEqual(IDLE_MS);
    // (3) Named, and the number is in the text the user is shown.
    expect(error).toBeInstanceOf(StreamIdleTimeoutError);
    const idle = error as StreamIdleTimeoutError;
    expect(idle.message).toBe(`stream idle: no bytes for ${IDLE_MS}ms`);
    expect(idle.idleMs).toBe(IDLE_MS);
    expect(idle.bytesReceived).toBe('alpha beta'.length);
    // The upstream is released, so a turn nobody is reading stops costing tokens.
    expect(cancelled()).toBe(true);
  });

  it('never interrupts a slow stream that keeps speaking', async () => {
    // The re-arm. Total duration (5 x 40 ms) exceeds the budget several times
    // over; only the SILENCE between chunks is measured. Without a per-chunk
    // re-arm this test fails, which is what makes it a test of the timer and
    // not of the timeout value.
    const chunks = ['one ', 'two ', 'three ', 'four ', 'five'];
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        for (const chunk of chunks) {
          await new Promise((resolve) => setTimeout(resolve, 40));
          controller.enqueue(encoder.encode(chunk));
        }
        controller.close();
      },
    });
    const { text, error, elapsedMs } = await collect(stream, 100);
    expect(error).toBeUndefined();
    expect(text).toBe('one two three four five');
    expect(elapsedMs).toBeGreaterThanOrEqual(200);
  });

  it('lets a stream that closes cleanly close, and a real error stay itself', async () => {
    const clean = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('done'));
        controller.close();
      },
    });
    expect(await collect(clean, 50)).toMatchObject({ text: 'done', error: undefined });

    const boom = new Error('upstream reset');
    // Enqueue and error must be separate PULLS. `controller.error()` in the same
    // synchronous `start` discards the queued chunk, which made the first draft
    // of this test assert an empty output — the exact "two empty outputs" shape
    // the header warns about, caught here rather than in the relay.
    let pulls = 0;
    const broken = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulls++ === 0) {
          controller.enqueue(encoder.encode('partial'));
          return;
        }
        controller.error(boom);
      },
    });
    const result = await collect(broken, 50);
    expect(result.text).toBe('partial');
    // Not swallowed, and NOT relabelled as a stall — the two have different fixes.
    expect(result.error).toBe(boom);
    expect(result.error).not.toBeInstanceOf(StreamIdleTimeoutError);
  });
});

describe('resolveStreamIdleTimeoutMs', () => {
  it('defaults to the deadline the Claude SDK itself waits on an endpoint like ours', () => {
    // Read out of the vendored binary: `lia()` is
    // `Math.max(CLAUDE_STREAM_IDLE_TIMEOUT_MS || 0, 300000)` and `F6b` clamps to
    // [10 000, 1 800 000]. Mirrored so the three runtimes give up at one time
    // rather than three, and so this number is a measurement rather than a guess.
    expect(STREAM_IDLE_TIMEOUT_DEFAULT_MS).toBe(300_000);
    expect(STREAM_IDLE_TIMEOUT_FLOOR_MS).toBe(10_000);
    expect(STREAM_IDLE_TIMEOUT_CEILING_MS).toBe(1_800_000);
    expect(resolveStreamIdleTimeoutMs({})).toBe(STREAM_IDLE_TIMEOUT_DEFAULT_MS);
  });

  it('takes the operator override and clamps it into the SDK-derived range', () => {
    expect(resolveStreamIdleTimeoutMs({ [STREAM_IDLE_TIMEOUT_ENV]: '45000' })).toBe(45_000);
    // BELOW the floor is the trap this exists for: a budget set under the
    // system's resting silence manufactures its own failure, so it is clamped
    // rather than obeyed.
    expect(resolveStreamIdleTimeoutMs({ [STREAM_IDLE_TIMEOUT_ENV]: '1' }))
      .toBe(STREAM_IDLE_TIMEOUT_FLOOR_MS);
    expect(resolveStreamIdleTimeoutMs({ [STREAM_IDLE_TIMEOUT_ENV]: '99999999' }))
      .toBe(STREAM_IDLE_TIMEOUT_CEILING_MS);
  });

  it('falls back to the default for anything that is not a positive integer', () => {
    for (const value of ['', '  ', '0', '-5', 'soon', '30s', '12.5', '4__5', '_45']) {
      expect(resolveStreamIdleTimeoutMs({ [STREAM_IDLE_TIMEOUT_ENV]: value }), value)
        .toBe(STREAM_IDLE_TIMEOUT_DEFAULT_MS);
    }
  });

  it('P6.565 · accepts the general spellings, because the documented counterpart\'s row does', () => {
    // `CLAUDE_STREAM_IDLE_TIMEOUT_MS`'s row in `env-vars.md` notes nothing about
    // plain digits, so `env-vars.md#variables`' general clause reaches this key
    // and `1e5` is a hundred thousand rather than a typo.
    expect(resolveStreamIdleTimeoutMs({ [STREAM_IDLE_TIMEOUT_ENV]: '1e5' })).toBe(100_000);
    expect(resolveStreamIdleTimeoutMs({ [STREAM_IDLE_TIMEOUT_ENV]: '45_000' })).toBe(45_000);
    expect(resolveStreamIdleTimeoutMs({ [STREAM_IDLE_TIMEOUT_ENV]: '4.5e4' })).toBe(45_000);
    // Accepted THEN clamped, which is what separates this from rejection: `1e3`
    // parses to 1000, below the 10 000 floor, and the resolver clamps rather
    // than falling back to the 30-minute default.
    expect(resolveStreamIdleTimeoutMs({ [STREAM_IDLE_TIMEOUT_ENV]: '1e3' }))
      .toBe(STREAM_IDLE_TIMEOUT_FLOOR_MS);
  });
});
