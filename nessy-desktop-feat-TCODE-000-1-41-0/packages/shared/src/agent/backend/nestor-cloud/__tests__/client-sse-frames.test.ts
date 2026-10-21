/**
 * P2.204 — one unparseable SSE frame decided the whole turn's outcome, and the
 * message the user got named neither Nestor nor the stream.
 *
 * `consumeSseFrames` parsed each frame with a bare `JSON.parse`. Two measured
 * consequences, one condition (a socket cut):
 *
 *  - cut ON a frame boundary  → the stream just ends, `NestorCloudTurn` flushes
 *    the adapter and the turn KEEPS the partial answer;
 *  - cut MID-frame            → `readSseJsonRpcResults` appends its own `\n\n`
 *    to the residue, `JSON.parse` throws a raw `SyntaxError`, and the turn dies
 *    with "JSON Parse error: Unexpected EOF" — a message that mentions no
 *    subsystem at all.
 *
 * Same condition, two outcomes. These pin the frame-level containment and the
 * NAMING of the one failure that still escapes.
 */
import { describe, expect, it } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NestorCloudClient } from '../client.ts';
import { NestorCloudClientError, NestorCloudTerminalTaskError } from '../types.ts';
import { makeTestJwt } from '../../../../auth/dp/__tests__/test-jwt.ts';

// DA1.50 · `getValidCreds` gates on `isUsableJwt`, so a credential fixture
// must DECODE. `makeTestJwt` is the existing maker; the value is fabricated and
// carries no real token.
const FIXTURE_JWT = makeTestJwt({ preferred_username: 'tester', sub: 'user-42' });

function tempCreds(): string {
  const dir = mkdtempSync(join(tmpdir(), 'nestor-sse-frames-'));
  const path = join(dir, 'dp_auth_creds.json');
  writeFileSync(path, JSON.stringify({
    jwt: FIXTURE_JWT,
    expiresAt: Date.now() + 60_000,
    username: 'user@example.com',
    userId: 'u-123',
  }));
  return path;
}

function frame(result: unknown): string {
  return `data: ${JSON.stringify({ jsonrpc: '2.0', id: 'rpc-1', result })}\n\n`;
}

function clientOver(body: string): NestorCloudClient {
  return new NestorCloudClient({
    credsPath: tempCreds(),
    fetchImpl: (async () => new Response(body, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    })) as unknown as typeof fetch,
  });
}

async function drain(client: NestorCloudClient): Promise<{ events: unknown[]; error?: unknown }> {
  const events: unknown[] = [];
  try {
    for await (const event of client.sendMessageStream({ text: 'ping' })) events.push(event);
  } catch (error) {
    return { events, error };
  }
  return { events };
}

const SUBMITTED = { task: { id: 'task-1', contextId: 'ctx-1', status: { state: 'TASK_STATE_SUBMITTED' } } };
const COMPLETED = { statusUpdate: { taskId: 'task-1', contextId: 'ctx-1', status: { state: 'TASK_STATE_COMPLETED' } } };

describe('P2.204 · an SSE frame the client cannot parse', () => {
  it('keeps every frame that arrived when the stream is cut mid-frame', async () => {
    // The residue is terminated by the `\n\n` READ_SSE appends itself, never by
    // the server: it is a truncated tail, not a protocol violation.
    const { events, error } = await drain(clientOver(
      frame(SUBMITTED) + frame(COMPLETED) + 'data: {"jsonrpc":"2.0","result":{"statusUpd',
    ));

    expect(error).toBeUndefined();
    expect(events).toHaveLength(2);
  });

  it('names an unparseable mid-stream frame on the typed channel, not as a parser message', async () => {
    const { events, error } = await drain(clientOver(
      frame(SUBMITTED) + 'data: NOT-JSON-SECRET-PAYLOAD\n\n' + frame(COMPLETED),
    ));

    // Everything before the bad frame was already delivered to the caller.
    expect(events).toHaveLength(1);
    expect(error).toBeInstanceOf(NestorCloudClientError);
    const failure = error as NestorCloudClientError;
    expect(failure.code).toBe('stream-failed');
    expect(failure.message).toContain('Nestor stream frame');
    // Identity, both directions: the message must say WHAT failed and must not
    // quote the frame — a raw `SyntaxError` did the opposite of both.
    expect(failure.message).not.toContain('NOT-JSON-SECRET-PAYLOAD');
    expect(failure.message).not.toContain('JSON Parse error');
  });

  it('still throws the backend\'s own typed error for a JSON-RPC error frame', async () => {
    const body = `data: ${JSON.stringify({
      jsonrpc: '2.0',
      id: 'rpc-1',
      error: { code: -32004, message: 'task is already in terminal state', data: { error: 'boom' } },
    })}\n\n`;
    const { error } = await drain(clientOver(body));

    expect(error).toBeInstanceOf(NestorCloudTerminalTaskError);
  });

  it('still skips the frames it always skipped: comments, heartbeats and [DONE]', async () => {
    const { events, error } = await drain(clientOver(
      ': keep-alive\n\n' + frame(SUBMITTED) + 'data: [DONE]\n\n',
    ));

    expect(error).toBeUndefined();
    expect(events).toHaveLength(1);
  });
});

/**
 * P6.58 — A REMOTE AGENT THAT STOPS SPEAKING ENDS THE TURN.
 *
 * The defect is the sibling of P2.204's above, and strictly worse: a socket CUT
 * ends the loop (both cases above resolve), while a socket that stays OPEN and
 * silent does not. `await reader.read()` never settles, `readSseJsonRpcResults`
 * has no other exit, and the turn waits forever with no error, no boundary and
 * no event.
 *
 * This relay is the end of the line: unlike the Claude path, whose SDK owns a
 * byte-stream watchdog of its own, nothing downstream of here would ever notice.
 */
describe('P6.58 · a stream that goes silent without closing', () => {
  const IDLE_MS = 120;

  /** SSE frames, then an open socket with nothing on it — forever. */
  function stallingClient(frames: string): NestorCloudClient {
    return new NestorCloudClient({
      credsPath: tempCreds(),
      idleTimeoutMs: IDLE_MS,
      fetchImpl: (async () => new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(frames));
            // …and never closes.
          },
        }),
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      )) as unknown as typeof fetch,
    });
  }

  it('gives up after the budget, keeps what arrived, and names the stall', async () => {
    const started = Date.now();
    const { events, error } = await drain(stallingClient(frame(SUBMITTED)));
    const elapsedMs = Date.now() - started;

    // (1) NOT two empty outputs: the frame that DID arrive was delivered first,
    // so this distinguishes "aborted" from "produced nothing".
    expect(events).toHaveLength(1);
    // (2) It waited the budget — a watchdog firing at zero would also "abort".
    expect(elapsedMs).toBeGreaterThanOrEqual(IDLE_MS);
    // (3) On this file's own typed channel, with the number and the byte count,
    // rather than as a bare `Error` naming no subsystem — the same standard
    // P2.204 set for the unparseable-frame failure above.
    expect(error).toBeInstanceOf(NestorCloudClientError);
    const failure = error as NestorCloudClientError;
    expect(failure.code).toBe('stream-failed');
    expect(failure.message).toContain('Nestor stream stalled');
    expect(failure.message).toContain(`${IDLE_MS}ms`);
  });

  it('leaves a stream that terminates itself completely alone', async () => {
    // The control, on the same rig and the same budget: without it, "the turn
    // ended" proves nothing about WHY it ended.
    const { events, error } = await drain(clientOver(frame(SUBMITTED) + frame(COMPLETED)));
    expect(error).toBeUndefined();
    expect(events).toHaveLength(2);
  });
});
