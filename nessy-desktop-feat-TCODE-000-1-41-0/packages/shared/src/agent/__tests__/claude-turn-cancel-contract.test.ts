/**
 * L1 — THE CANCELLATION SEAM, measured against the installed SDK rather than
 * asserted.
 *
 * The question L1 had to answer: under one long-lived `query()` per agent,
 * `ClaudeAgent.forceAbort` aborts `this.currentQueryAbortController` — the
 * controller handed to `query({options:{abortController}})`. Is that a TURN
 * cancel or a SESSION kill? And if it is a session kill, does a turn-scoped
 * cancel exist at all?
 *
 * These tests drive the REAL `@anthropic-ai/claude-agent-sdk` `query()` against
 * a fake CLI process installed through the SDK's own public
 * `spawnClaudeCodeProcess` option, so nothing here is a model of the SDK — it
 * is the SDK, with the subprocess replaced. No network, no credentials.
 *
 * What they pin, and why each matters to L2:
 *
 * 1. `abortController.abort()` ends the child's stdin and then kills the child.
 *    Under one query per agent that is SESSION DEATH, so every non-death caller
 *    of `forceAbort` — user Stop above all — must stop using it.
 * 2. `query.interrupt()` is the turn-scoped cancel: the child survives, and a
 *    SECOND turn runs on the SAME process afterwards. That is the discriminating
 *    control — a build where interrupt killed the session would fail it.
 * 3. A STRING prompt is single-turn mode and the SDK closes the child's stdin at
 *    the first `result`; an async-iterable prompt does not. That is the exact
 *    mechanism that made the pre-L2 shape one-shot, and the one L2 changed —
 *    `ClaudeAgent` now passes `ClaudeInputChannel.stream()`. Both arms stay
 *    here: the string arm is the control that keeps the difference visible.
 * 4. The interrupt receipt (`still_queued`) arrives as documented, and it can
 *    only ever name messages we STAMP WITH A UUID — which nothing did when this
 *    was written. L2 added the stamp (`ClaudeAgent.stampTurnMessageUuid`), so
 *    the receipt is now evidence about our own traffic rather than a blank.
 *
 * Absence/presence discipline: every "it died" assertion is paired on the same
 * rig with a turn that worked, and every "it survived" assertion is paired with
 * a second completed turn rather than with the mere lack of an error.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { PassThrough } from 'node:stream';
import { query, type Options, type SDKUserMessage, type SpawnedProcess } from '@anthropic-ai/claude-agent-sdk';

// ---------------------------------------------------------------------------
// A fake CLI that speaks the stream-json control protocol.
// ---------------------------------------------------------------------------

interface FakeCli {
  process: SpawnedProcess;
  /** Every line the SDK wrote to the child's stdin, parsed. */
  written: Array<Record<string, unknown>>;
  /** Every line the fake wrote to its own stdout, parsed — the CHILD's side. */
  emitted: Array<Record<string, unknown>>;
  /** True once the SDK ended the child's stdin (EOF — the CLI's exit signal). */
  stdinEnded: boolean;
  /** Signals the SDK sent to the child, in order. */
  kills: string[];
  /** Turns the fake actually ran (one per `type:'user'` message it saw). */
  turnsRun: number;
  /** Resolves once the SDK has written `count` user messages. */
  waitForUserMessages(count: number): Promise<void>;
}

const liveClis: FakeCli[] = [];

function createFakeCli(
  options: {
    advertiseInterruptReceipt?: boolean;
    stillQueued?: string[];
    /**
     * D1.361 — this child honours `cancel_queued: true`, as a CLI advertising
     * `interrupt_cancel_queued_v1` must: the survivors move from `still_queued`
     * to `cancelled` and the first list is then empty. Off by default, so every
     * arm that does not ask for it keeps the older contract exactly.
     */
    advertiseCancelQueued?: boolean;
  } = {},
): FakeCli {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const exitListeners: Array<(code: number | null, signal: NodeJS.Signals | null) => void> = [];

  const state = {
    written: [] as Array<Record<string, unknown>>,
    emitted: [] as Array<Record<string, unknown>>,
    stdinEnded: false,
    kills: [] as string[],
    turnsRun: 0,
    killed: false,
    exitCode: null as number | null,
    userMessageWaiters: [] as Array<{ count: number; resolve: () => void }>,
    userMessageCount: 0,
    /** Set while a turn is "in flight" so an interrupt has something to cancel. */
    turnInFlight: null as { id: number } | null,
  };

  const emit = (message: unknown) => {
    if (state.killed) return;
    state.emitted.push(message as Record<string, unknown>);
    stdout.write(`${JSON.stringify(message)}\n`);
  };

  const settleTurn = (subtype: 'success' | 'interrupted') => {
    const turn = state.turnInFlight;
    if (!turn) return;
    state.turnInFlight = null;
    state.turnsRun += 1;
    emit({
      type: 'result',
      subtype: 'success',
      // The interrupted turn still arrives on the SUCCESS member with
      // `is_error` set — the shape `claude-result-is-error-baseline.test.ts`
      // pins from the other side.
      is_error: subtype === 'interrupted',
      result: subtype === 'interrupted' ? '' : `turn ${turn.id} done`,
      session_id: 'fake-session',
      duration_ms: 1,
      duration_api_ms: 1,
      num_turns: turn.id,
      total_cost_usd: 0,
      usage: { input_tokens: 1, output_tokens: 1 },
      modelUsage: {},
      uuid: `result-${turn.id}`,
    });
  };

  let lineBuffer = '';
  stdin.on('data', (chunk: Buffer) => {
    lineBuffer += chunk.toString('utf8');
    for (;;) {
      const newline = lineBuffer.indexOf('\n');
      if (newline === -1) break;
      const line = lineBuffer.slice(0, newline);
      lineBuffer = lineBuffer.slice(newline + 1);
      if (!line.trim()) continue;
      const message = JSON.parse(line) as Record<string, unknown>;
      state.written.push(message);

      if (message.type === 'control_request') {
        const request = message.request as { subtype: string };
        const requestId = message.request_id as string;
        if (request.subtype === 'initialize') {
          emit({
            type: 'control_response',
            response: {
              request_id: requestId,
              subtype: 'success',
              response: {
                commands: [],
                ...(options.advertiseInterruptReceipt === false
                  ? {}
                  : {
                      capabilities: options.advertiseCancelQueued
                        ? ['interrupt_receipt_v1', 'interrupt_cancel_queued_v1']
                        : ['interrupt_receipt_v1'],
                    }),
              },
            },
          });
          continue;
        }
        if (request.subtype === 'interrupt') {
          const cancelQueued = (request as { cancel_queued?: boolean }).cancel_queued === true;
          // Documented ordering: "on a clean interrupt it arrives before the
          // interrupted turn's SDKResultMessage"
          // (agent-sdk/typescript.md, § SDKControlInterruptResponse).
          emit({
            type: 'control_response',
            response: {
              request_id: requestId,
              subtype: 'success',
              response: options.advertiseInterruptReceipt === false
                ? {}
                : cancelQueued && options.advertiseCancelQueued
                  // The documented answer to the flag: "still_queued is then
                  // empty" and every survivor is listed under `cancelled`.
                  ? { still_queued: [], cancelled: options.stillQueued ?? [] }
                  : { still_queued: options.stillQueued ?? [] },
            },
          });
          settleTurn('interrupted');
          continue;
        }
        // Any other control request: bare success.
        emit({
          type: 'control_response',
          response: { request_id: requestId, subtype: 'success', response: {} },
        });
        continue;
      }

      if (message.type === 'user') {
        state.userMessageCount += 1;
        for (const waiter of state.userMessageWaiters.splice(0)) {
          if (state.userMessageCount >= waiter.count) waiter.resolve();
          else state.userMessageWaiters.push(waiter);
        }
        state.turnInFlight = { id: state.userMessageCount };
        // Deliberately NOT settled here: the turn stays in flight until either
        // `runTurnToCompletion()` or an interrupt lands on it. That is what makes
        // the interrupt test a real one.
      }
    }
  });
  stdin.on('end', () => { state.stdinEnded = true; });
  stdin.on('finish', () => { state.stdinEnded = true; });

  const process: SpawnedProcess = {
    stdin,
    stdout,
    get killed() { return state.killed; },
    get exitCode() { return state.exitCode; },
    get signalCode() { return null; },
    kill(signal: NodeJS.Signals) {
      state.kills.push(signal);
      state.killed = true;
      state.exitCode = null;
      for (const listener of exitListeners.splice(0)) listener(null, signal);
      stdout.end();
      return true;
    },
    on(event: 'exit' | 'error', listener: never) {
      if (event === 'exit') exitListeners.push(listener as never);
    },
    once(event: 'exit' | 'error', listener: never) {
      if (event === 'exit') exitListeners.push(listener as never);
    },
    off() {},
  } as SpawnedProcess;

  const cli: FakeCli = {
    process,
    get written() { return state.written; },
    get emitted() { return state.emitted; },
    get stdinEnded() { return state.stdinEnded; },
    get kills() { return state.kills; },
    get turnsRun() { return state.turnsRun; },
    waitForUserMessages(count: number) {
      if (state.userMessageCount >= count) return Promise.resolve();
      return new Promise<void>(resolve => { state.userMessageWaiters.push({ count, resolve }); });
    },
  };
  // Exposed for the tests to settle a turn on demand.
  (cli as FakeCli & { settle(): void }).settle = () => settleTurn('success');
  liveClis.push(cli);
  return cli;
}

function baseOptions(cli: FakeCli, abortController: AbortController): Options {
  return {
    abortController,
    spawnClaudeCodeProcess: () => cli.process,
    pathToClaudeCodeExecutable: '/nonexistent/claude',
  } as Options;
}

/** A streaming-input prompt whose channel the test controls. */
function createInputChannel() {
  const pending: SDKUserMessage[] = [];
  let notify: (() => void) | null = null;
  let closed = false;
  return {
    send(text: string, uuid?: string) {
      pending.push({
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text }] },
        parent_tool_use_id: null,
        session_id: '',
        ...(uuid ? { uuid: uuid as never } : {}),
      } as SDKUserMessage);
      notify?.();
    },
    close() { closed = true; notify?.(); },
    async *stream(): AsyncIterable<SDKUserMessage> {
      for (;;) {
        while (pending.length > 0) yield pending.shift()!;
        if (closed) return;
        await new Promise<void>(resolve => { notify = resolve; });
        notify = null;
      }
    },
  };
}

afterEach(() => {
  for (const cli of liveClis.splice(0)) {
    if (!cli.process.killed) cli.process.kill('SIGKILL');
  }
});

describe('the abortController handed to query() is the SESSION, not the turn', () => {
  it('abort() ends the child stdin and kills the child — after the same rig completed a turn', async () => {
    const cli = createFakeCli();
    const settle = (cli as FakeCli & { settle(): void }).settle;
    const channel = createInputChannel();
    const abortController = new AbortController();
    const q = query({ prompt: channel.stream(), options: baseOptions(cli, abortController) });

    // PRESENCE: the rig runs a real turn first, so the death below cannot be
    // "the harness never worked".
    channel.send('turn one');
    await cli.waitForUserMessages(1);
    settle();
    const first = await q.next();
    expect((first.value as { type: string }).type).toBe('result');
    expect(cli.turnsRun).toBe(1);
    expect(cli.stdinEnded).toBe(false);
    expect(cli.kills).toEqual([]);

    // The seam `ClaudeAgent.forceAbort` uses today.
    abortController.abort('user-stop');

    // Immediate half: the input channel is closed. For a real CLI that is EOF,
    // and EOF is how it exits.
    await Bun.sleep(20);
    expect(cli.stdinEnded).toBe(true);

    // Deferred half: the SDK's ~2 s grace, then SIGTERM. There is no code path
    // in the SDK that aborts the controller and leaves the child running.
    await Bun.sleep(2400);
    expect(cli.kills[0]).toBe('SIGTERM');

    await q.return?.(undefined).catch(() => undefined);
  }, 15_000);

  it('interrupt() cancels the TURN and the session survives: a second turn runs on the same child', async () => {
    const cli = createFakeCli();
    const settle = (cli as FakeCli & { settle(): void }).settle;
    const channel = createInputChannel();
    const abortController = new AbortController();
    const q = query({ prompt: channel.stream(), options: baseOptions(cli, abortController) });

    channel.send('turn one');
    await cli.waitForUserMessages(1);

    // Cancel the in-flight turn the SDK's own way.
    const receipt = await q.interrupt();
    const interrupted = await q.next();
    expect((interrupted.value as { type: string; is_error: boolean }).type).toBe('result');
    // The interrupted turn is reported on the SUCCESS member with is_error true —
    // never as a distinct terminal subtype.
    expect((interrupted.value as { subtype: string }).subtype).toBe('success');
    expect((interrupted.value as { is_error: boolean }).is_error).toBe(true);

    // THE DISCRIMINATING PART: neither stdin nor the child was touched, and a
    // SECOND turn goes through the SAME channel to the SAME process.
    expect(cli.stdinEnded).toBe(false);
    expect(cli.kills).toEqual([]);

    channel.send('turn two');
    await cli.waitForUserMessages(2);
    settle();
    const second = await q.next();
    expect((second.value as { type: string; is_error: boolean }).type).toBe('result');
    expect((second.value as { is_error: boolean }).is_error).toBe(false);
    expect(cli.turnsRun).toBe(2);

    // The receipt is the documented one, and on our shape it is empty — we never
    // queue a second message while a turn is in flight.
    expect(receipt).toEqual({ still_queued: [] });

    channel.close();
    await q.return?.(undefined).catch(() => undefined);
  }, 15_000);

  it('the receipt can only ever name a message we stamped with a uuid', async () => {
    // `SDKUserMessage.uuid` is OPTIONAL and `ClaudeAgent.buildSDKUserMessage`
    // does not set it. The SDK's own words: "only uuid-STAMPED messages appear
    // (a message enqueued without a uuid still runs but is never listed, so []
    // does not mean 'nothing will run')". So an L2 that reads the receipt to
    // decide what to resend MUST stamp uuids first.
    const cli = createFakeCli({ stillQueued: ['queued-uuid-1'] });
    const channel = createInputChannel();
    const abortController = new AbortController();
    const q = query({ prompt: channel.stream(), options: baseOptions(cli, abortController) });

    channel.send('turn one', 'queued-uuid-1');
    await cli.waitForUserMessages(1);
    const written = cli.written.find(message => message.type === 'user') as { uuid?: string };
    expect(written.uuid).toBe('queued-uuid-1');

    const receipt = await q.interrupt();
    expect(receipt).toEqual({ still_queued: ['queued-uuid-1'] });

    channel.close();
    await q.return?.(undefined).catch(() => undefined);
  }, 15_000);
});

/**
 * D1.361 — `cancel_queued` IS REAL IN THE BUNDLE AND ABSENT FROM ITS OWN TYPING,
 * and this is the evidence the host's refusal to send it rests on.
 *
 * `sdk.d.ts` at the vendored 0.3.251 declares `interrupt(): Promise<…>` with NO
 * parameter — and so did 0.3.247 — while the wire type `SDKControlInterruptRequest`
 * carries `cancel_queued?: boolean` in both. The shipped `sdk.mjs` disagrees with
 * the declaration: it implements `interrupt(e)` and spreads
 * `...e?.cancelQueued === true && { cancel_queued: true }` into the request.
 * Occurrences of `cancelQueued` in `sdk.mjs` (instrument: `grep -aoF … | wc -l`):
 * 0.3.233 -> 0, 0.3.247 -> 1, 0.3.251 -> 1. So the option arrived in the bundle
 * and the typing has not caught up — AGENTS.md's "the bundle is the denominator
 * for BEHAVIOUR", in the direction where the bundle leads.
 *
 * These two arms are what turn that into something a future reader can re-run,
 * and they are here rather than in the agent because the claim is about the SDK:
 * the cast marks exactly where the typing stops describing the implementation.
 *
 * The product does NOT send it, deliberately — see `ClaudeAgent.noteInterruptSeam`
 * for the whole reason. The second arm is that refusal's control: the call this
 * product makes must put no such field on the wire at all, so "we do not send it"
 * is a measurement rather than a reading of the source.
 */
describe('the interrupt option the typing does not declare', () => {
  it('a child advertising interrupt_cancel_queued_v1 is asked, and answers with `cancelled`', async () => {
    const cli = createFakeCli({ advertiseCancelQueued: true, stillQueued: ['queued-uuid-1'] });
    const channel = createInputChannel();
    const abortController = new AbortController();
    const q = query({ prompt: channel.stream(), options: baseOptions(cli, abortController) });

    channel.send('turn one', 'queued-uuid-1');
    await cli.waitForUserMessages(1);

    // The cast is the point: `Query.interrupt` takes no parameter in the
    // installed `sdk.d.ts`, and the installed `sdk.mjs` reads one.
    const receipt = await (q.interrupt as (arg?: { cancelQueued?: boolean }) => Promise<unknown>)({ cancelQueued: true });

    const sent = cli.written.find(
      message => message.type === 'control_request'
        && (message.request as { subtype?: string }).subtype === 'interrupt',
    );
    expect((sent?.request as { cancel_queued?: boolean }).cancel_queued).toBe(true);
    // Documented: "still_queued is then empty", survivors listed under `cancelled`.
    expect(receipt).toEqual({ still_queued: [], cancelled: ['queued-uuid-1'] });

    channel.close();
    await q.return?.(undefined).catch(() => undefined);
  }, 15_000);

  it('THE CONTROL: the plain interrupt this product sends carries no such field', async () => {
    const cli = createFakeCli({ advertiseCancelQueued: true, stillQueued: ['queued-uuid-1'] });
    const channel = createInputChannel();
    const abortController = new AbortController();
    const q = query({ prompt: channel.stream(), options: baseOptions(cli, abortController) });

    channel.send('turn one', 'queued-uuid-1');
    await cli.waitForUserMessages(1);

    const receipt = await q.interrupt();

    const sent = cli.written.find(
      message => message.type === 'control_request'
        && (message.request as { subtype?: string }).subtype === 'interrupt',
    );
    // Not `false` — ABSENT. The SDK spreads the key in only when asked, and the
    // CLI's own contract is that an older client "behaves as if false".
    expect(Object.keys(sent?.request as object)).toEqual(['subtype']);
    // And the same child, asked the ordinary way, reports the survivor rather
    // than cancelling it — which is what makes the first arm a difference.
    expect(receipt).toEqual({ still_queued: ['queued-uuid-1'] });

    channel.close();
    await q.return?.(undefined).catch(() => undefined);
  }, 15_000);
});

describe('single-turn vs streaming input — why today is one-shot', () => {
  it('a STRING prompt makes the SDK close the child stdin at the first result', async () => {
    // This is the mechanism, in the SDK itself: `query()` sets
    // `isSingleUserTurn: typeof prompt === "string"`, and on the first `result`
    // the reader calls `transport.endInput()`. Every ClaudeAgent turn that is
    // not a binary-attachment turn takes this branch today
    // (claude-agent.ts:2976).
    const cli = createFakeCli();
    const settle = (cli as FakeCli & { settle(): void }).settle;
    const abortController = new AbortController();
    const q = query({ prompt: 'hello', options: baseOptions(cli, abortController) });

    await cli.waitForUserMessages(1);
    expect(cli.stdinEnded).toBe(false);
    settle();
    const first = await q.next();
    expect((first.value as { type: string }).type).toBe('result');

    await Bun.sleep(20);
    expect(cli.stdinEnded).toBe(true);

    await q.return?.(undefined).catch(() => undefined);
  }, 15_000);

  it('an ASYNC-ITERABLE prompt leaves it open — same rig, one line different', async () => {
    const cli = createFakeCli();
    const settle = (cli as FakeCli & { settle(): void }).settle;
    const channel = createInputChannel();
    const abortController = new AbortController();
    const q = query({ prompt: channel.stream(), options: baseOptions(cli, abortController) });

    channel.send('hello');
    await cli.waitForUserMessages(1);
    settle();
    const first = await q.next();
    expect((first.value as { type: string }).type).toBe('result');

    await Bun.sleep(20);
    expect(cli.stdinEnded).toBe(false);

    channel.close();
    await q.return?.(undefined).catch(() => undefined);
  }, 15_000);
});

// ---------------------------------------------------------------------------
// THE OLDER-CLI ARM. P6.853.
//
// `createFakeCli({ advertiseInterruptReceipt: false })` was built with this file
// and never called: three sites read the option — the signature, the initialize
// advertisement, and the interrupt response — and no test drove any of them, so
// the older child was modelled and never exercised. One case per site below.
//
// What "older" means is READ, not assumed. `sdk.d.ts`, on
// `SDKControlInterruptResponse`: "Advertised by the interrupt_receipt_v1
// capability on system/init; older CLIs send an empty success response with no
// still_queued field." And on `Query.interrupt`: "Older CLIs resolve to
// undefined."
//
// One measured limit, stated so the first case is not read as more than it is:
// the SDK takes `capabilities` off the system/init MESSAGE — `capabilities?:
// string[]` sits on `SDKSystemMessage`, and `SDKControlInitializeResponse`
// declares no such field — which is also where `ClaudeAgent` reads it
// (`captureAdvertisedProtocolCapabilities`, whose own end-to-end arm is
// `protocol-capability-channel.test.ts`). So the initialize frame this fake
// carries the advertisement on is the fake's model of the child, and the
// SDK-visible consequence of the older arm is the second case: the receipt is
// gone.
// ---------------------------------------------------------------------------
describe('the older-CLI arm: a child that advertises no interrupt receipt', () => {
  /** Runs one complete turn and returns the payload of the child's FIRST control_response. */
  async function initializeResponsePayload(cli: FakeCli): Promise<Record<string, unknown>> {
    const settle = (cli as FakeCli & { settle(): void }).settle;
    const channel = createInputChannel();
    const q = query({ prompt: channel.stream(), options: baseOptions(cli, new AbortController()) });

    // PRESENCE: the older rig runs a real turn, so anything missing below is the
    // option and not a handshake that never completed.
    channel.send('turn one');
    await cli.waitForUserMessages(1);
    settle();
    const first = await q.next();
    expect((first.value as { type: string }).type).toBe('result');

    channel.close();
    await q.return?.(undefined).catch(() => undefined);

    const frame = cli.emitted.find(message => message.type === 'control_response');
    const payload = (frame?.response as { response?: Record<string, unknown> } | undefined)?.response;
    expect(payload).toBeDefined();
    return payload as Record<string, unknown>;
  }

  it('answers initialize with no capabilities key, where the default arm advertises interrupt_receipt_v1', async () => {
    const older = await initializeResponsePayload(createFakeCli({ advertiseInterruptReceipt: false }));
    // The control that proves this is the INITIALIZE response and not some later
    // control_response: only that one carries `commands`.
    expect(older.commands).toEqual([]);
    expect(older).not.toHaveProperty('capabilities');

    // Same rig, one option different.
    const current = await initializeResponsePayload(createFakeCli());
    expect(current.commands).toEqual([]);
    expect(current.capabilities).toEqual(['interrupt_receipt_v1']);
  }, 20_000);

  it('resolves interrupt() to undefined rather than to a receipt, and the turn is cancelled all the same', async () => {
    const cli = createFakeCli({ advertiseInterruptReceipt: false });
    const channel = createInputChannel();
    const q = query({ prompt: channel.stream(), options: baseOptions(cli, new AbortController()) });

    channel.send('turn one');
    await cli.waitForUserMessages(1);

    // The SDK reads `response.still_queued` and answers `undefined` when it is
    // not an array — there is no error and no throw, so a caller that assumed a
    // receipt reads a blank rather than a failure.
    const receipt = await q.interrupt();
    expect(receipt).toBeUndefined();

    // ABSENCE PAIRED WITH PRESENCE: the cancel itself still happened.
    const interrupted = await q.next();
    expect((interrupted.value as { type: string }).type).toBe('result');
    expect((interrupted.value as { subtype: string }).subtype).toBe('success');
    expect((interrupted.value as { is_error: boolean }).is_error).toBe(true);
    expect(cli.stdinEnded).toBe(false);
    expect(cli.kills).toEqual([]);

    channel.close();
    await q.return?.(undefined).catch(() => undefined);
  }, 20_000);

  it('cannot name a uuid-stamped survivor: we stamped it, no receipt reports it, and the session runs on', async () => {
    // The hazard the receipt exists to remove, in the arm where it is absent.
    // `still_queued` is deliberately requested here and the older child never
    // sends it, so an L2 that read the receipt to decide what to resend would
    // learn nothing on this child — while the message is stamped exactly as the
    // newer arm needs.
    const cli = createFakeCli({ advertiseInterruptReceipt: false, stillQueued: ['queued-uuid-1'] });
    const settle = (cli as FakeCli & { settle(): void }).settle;
    const channel = createInputChannel();
    const q = query({ prompt: channel.stream(), options: baseOptions(cli, new AbortController()) });

    channel.send('turn one', 'queued-uuid-1');
    await cli.waitForUserMessages(1);
    const written = cli.written.find(message => message.type === 'user') as { uuid?: string };
    expect(written.uuid).toBe('queued-uuid-1');

    const receipt = await q.interrupt();
    expect(receipt).toBeUndefined();
    const interrupted = await q.next();
    expect((interrupted.value as { is_error: boolean }).is_error).toBe(true);

    // THE DISCRIMINATING PART: a missing receipt is not a dead session. A second
    // turn runs on the same child, which is what separates "older CLI" from
    // "the interrupt killed it".
    channel.send('turn two');
    await cli.waitForUserMessages(2);
    settle();
    const second = await q.next();
    expect((second.value as { is_error: boolean }).is_error).toBe(false);
    expect(cli.turnsRun).toBe(2);

    channel.close();
    await q.return?.(undefined).catch(() => undefined);
  }, 20_000);
});
