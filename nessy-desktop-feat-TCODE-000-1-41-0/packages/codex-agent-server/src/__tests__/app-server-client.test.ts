/**
 * P2.138 — a request on the spawn critical path must not be able to HANG.
 *
 * `AppServerClient.request` settles a pending entry on exactly two events: a
 * matching response, or `close()`. An app-server that IGNORES a method rather
 * than erroring on it therefore leaves the promise pending forever, and the
 * caller most exposed to that is the `configRequirements/read` probe that sits
 * between `initialized` and `thread/start`. Its own contract is "a runtime that
 * cannot answer this optional question must still start" — and a hang breaks
 * that contract in the worse of the two directions, because a throw is visible
 * and a hang is not.
 *
 * The first case here is the POSITIVE CONTROL for the failure mode: without a
 * bound, the silent server really does leave the promise pending. Every later
 * case is only meaningful because that one passes.
 */
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, test } from 'bun:test';
import { AppServerClient } from '../app-server-client.ts';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';

interface FakeChild extends ChildProcessWithoutNullStreams {
  written: string[];
  answer: (line: unknown) => void;
  /** Emit the process-level `exit` a real child emits when it is gone. */
  exit: (code: number | null, signal?: NodeJS.Signals | null) => void;
}

/**
 * A child process that writes nowhere and answers only when told to.
 *
 * P6.269 made this an EventEmitter rather than a plain object literal, and that
 * is not cosmetic: the client now listens for the process-level `exit`, which a
 * real `ChildProcessWithoutNullStreams` emits and a literal cannot. A fake
 * narrower than the type it is cast to reports a green suite for a client that
 * would throw on construction against the real thing — which is exactly what
 * this file did for one commit.
 */
function fakeChild(): FakeChild {
  const proc = new EventEmitter();
  const stdout = new PassThrough();
  const stderr = new EventEmitter();
  const written: string[] = [];
  const stdin = { writable: true, write: (chunk: string) => { written.push(chunk); return true; } };
  return Object.assign(proc, {
    stdout,
    stderr,
    stdin,
    written,
    answer: (line: unknown) => { stdout.write(`${JSON.stringify(line)}\n`); },
    exit: (code: number | null, signal: NodeJS.Signals | null = null) => { proc.emit('exit', code, signal); },
  }) as unknown as FakeChild;
}

/** Has the promise settled yet? Never awaits the promise itself. */
function settlement(promise: Promise<unknown>): { settled: boolean } {
  const state = { settled: false };
  promise.then(() => { state.settled = true; }, () => { state.settled = true; });
  return state;
}

const tick = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Every client is closed after its case. Not tidiness: an open `readline` over a
 * live stream holds the event loop, and a suite that takes forty seconds to say
 * "9 pass" is a suite that stops being run.
 */
const open: AppServerClient[] = [];
function client(child: ChildProcessWithoutNullStreams, handlers?: ConstructorParameters<typeof AppServerClient>[1]): AppServerClient {
  const created = new AppServerClient(child, handlers);
  open.push(created);
  return created;
}
afterEach(() => {
  for (const created of open.splice(0)) created.close();
});

describe('a server that never answers', () => {
  test('POSITIVE CONTROL: without a bound the promise stays pending, and only close() ends it', async () => {
    const child = fakeChild();
    const app = client(child);
    const pending = app.request('configRequirements/read');
    const state = settlement(pending);

    await tick(80);
    // This is the defect the row exists to close: 80 ms is nothing, but the
    // server here will never answer, so this promise would outlive the session.
    expect(state.settled).toBe(false);

    app.close();
    await expect(pending).rejects.toThrow('app-server client closed');
  });

  test('with a bound it rejects, saying which method and how long it waited', async () => {
    const child = fakeChild();
    const app = client(child);
    await expect(app.request('configRequirements/read', undefined, { timeoutMs: 20 }))
      .rejects.toThrow('app-server request configRequirements/read timed out after 20ms');
  });

  test('a timeout carries NO JSON-RPC code, so a caller reads it as transient', async () => {
    const child = fakeChild();
    const app = client(child);
    const error = await app.request('configRequirements/read', undefined, { timeoutMs: 20 })
      .then(() => null, (err: Error & { code?: number }) => err);
    // `codex-config-requirements.ts` classifies a DEFINITIVE refusal off this
    // field. A hung server is not a server that refused, and must not be
    // reported as one.
    expect(error?.code).toBeUndefined();
  });

  test('the timed-out entry is DROPPED, so a late answer resolves nothing', async () => {
    const child = fakeChild();
    const diagnostics: string[] = [];
    const app = client(child, { onDiagnostic: line => diagnostics.push(line) });
    const pending = app.request('configRequirements/read', undefined, { timeoutMs: 20 });
    await expect(pending).rejects.toThrow('timed out');

    // The server wakes up after the deadline. Nothing may resolve a promise the
    // caller has already stopped waiting on, and the entry must not have leaked.
    child.answer({ id: 1, result: { requirements: null } });
    await tick(10);
    expect(diagnostics).toEqual(['response for unknown id 1']);
  });
});

describe('the bound costs nothing when the server does answer', () => {
  test('an answer inside the bound resolves normally, and nothing rejects after it', async () => {
    const child = fakeChild();
    const app = client(child);
    const pending = app.request('configRequirements/read', undefined, { timeoutMs: 40 });
    child.answer({ id: 1, result: { requirements: null } });
    await expect(pending).resolves.toEqual({ requirements: null });
    // Waiting PAST the bound: a settled promise must stay settled. (That the
    // timer is also CLEARED rather than merely harmless is an event-loop
    // property, not an observable one — it is documented on `request`, and this
    // case deliberately does not claim to pin it.)
    await tick(60);
    await expect(pending).resolves.toEqual({ requirements: null });
  });

  test('an error answer inside the bound keeps its code, -32600 included', async () => {
    // -32600 is what the SHIPPED binary returns for an unknown method (measured
    // 2026-08-27 against `codex-app-server` 0.148.0): `Invalid request: unknown
    // variant \`nessyNonexistentMethod/read\``. The client preserves whatever
    // code arrives; the classifier lives in the caller.
    const child = fakeChild();
    const app = client(child);
    const pending = app.request('nessyNonexistentMethod/read', undefined, { timeoutMs: 200 });
    child.answer({ id: 1, error: { code: -32600, message: 'Invalid request: unknown variant' } });
    const error = await pending.then(() => null, (err: Error & { code?: number }) => err);
    expect(error?.code).toBe(-32600);
    expect(error?.message).toBe('Invalid request: unknown variant');
  });

  test('close() after a timeout is a no-op on the abandoned entry', async () => {
    const child = fakeChild();
    const app = client(child);
    const pending = app.request('configRequirements/read', undefined, { timeoutMs: 20 });
    await expect(pending).rejects.toThrow('timed out');
    // A second rejection of the same entry would surface as an unhandled
    // rejection rather than as a test failure, so this asserts the deletion.
    expect(() => app.close()).not.toThrow();
  });
});

describe('the option changes nothing else', () => {
  test('the wire payload is identical with and without a bound', () => {
    const withBound = fakeChild();
    client(withBound).request('thread/start', { cwd: '/repo' }, { timeoutMs: 20 }).catch(() => {});
    const without = fakeChild();
    client(without).request('thread/start', { cwd: '/repo' }).catch(() => {});
    expect(withBound.written).toEqual(without.written);
    expect(withBound.written).toEqual(['{"id":1,"method":"thread/start","params":{"cwd":"/repo"}}\n']);
  });

  test('a non-positive bound arms no timer at all', async () => {
    const child = fakeChild();
    const app = client(child);
    const state = settlement(app.request('configRequirements/read', undefined, { timeoutMs: 0 }).catch(() => {}));
    await tick(40);
    expect(state.settled).toBe(false);
    app.close();
  });
});

/**
 * P3.81 — `configWarning` reaches the diagnostic channel on its way past.
 *
 * The wiring half. What the line SAYS is pinned in `config-warning.test.ts`; what
 * matters here is that the transport reads the notification at all, forwards it
 * untouched, and does so on the one path every product notification takes.
 */
describe('a configWarning notification', () => {
  const RULES_PARAMS = {
    summary: 'Error parsing rules; custom rules not applied.',
    details: 'failed to parse rules file /tmp/h/rules/nessy.rules: error: invalid decision: nonsense',
    path: '/tmp/h/rules/nessy.rules',
  };

  /** KILLS: deleting the branch in `handleLine`. Without it this array stays empty. */
  test('lands on onDiagnostic, naming what stopped being enforced', async () => {
    const child = fakeChild();
    const diagnostics: string[] = [];
    client(child, { onDiagnostic: (m) => diagnostics.push(m) });
    child.answer({ method: 'configWarning', params: RULES_PARAMS });
    await tick(10);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toContain('EXECPOLICY RULES DID NOT LOAD');
  });

  /** KILLS: intercepting instead of observing — the notification must still be forwarded. */
  test('is forwarded to onNotification byte-identically as well', async () => {
    const child = fakeChild();
    const seen: Array<{ method: string; params: unknown }> = [];
    client(child, { onNotification: (method, params) => seen.push({ method, params }) });
    child.answer({ method: 'configWarning', params: RULES_PARAMS });
    await tick(10);
    expect(seen).toEqual([{ method: 'configWarning', params: RULES_PARAMS }]);
  });

  /**
   * The diagnostic is emitted BEFORE the forward, so a handler that throws
   * cannot swallow the one signal that a security floor disappeared.
   */
  test('is recorded even when onNotification throws', async () => {
    const child = fakeChild();
    const diagnostics: string[] = [];
    client(child, {
      onDiagnostic: (m) => diagnostics.push(m),
      onNotification: () => { throw new Error('handler exploded'); },
    });
    expect(() => child.answer({ method: 'configWarning', params: RULES_PARAMS })).toThrow('handler exploded');
    expect(diagnostics).toHaveLength(1);
  });

  /**
   * NEGATIVE CONTROL: every other notification is untouched. Without this the
   * cases above are satisfied by a client that narrates the whole stream, which
   * would bury the warning in the same log it is supposed to stand out in.
   *
   * P2.408 took `warning` OUT of this list, deliberately: it used to sit here as
   * one of the untouched methods, and that was this repo recording — in a
   * passing test — that codex's own "this session is unstable" channel went
   * nowhere. It now has its own case below.
   */
  test('no other notification produces a diagnostic', async () => {
    const child = fakeChild();
    const diagnostics: string[] = [];
    const seen: string[] = [];
    client(child, { onDiagnostic: (m) => diagnostics.push(m), onNotification: (m) => seen.push(m) });
    for (const method of ['turn/started', 'item/completed', 'guardianWarning', 'thread/started']) {
      child.answer({ method, params: { summary: 'Error parsing rules' } });
    }
    await tick(10);
    expect(seen).toHaveLength(4);
    expect(diagnostics).toEqual([]);
  });
});

/**
 * P2.408 — the SIBLING channel. `configWarning` says the config failed to load;
 * the plain `warning` says the config was obeyed and the session that resulted
 * is running something codex calls incomplete. It was consumed in zero files.
 *
 * Payload verbatim off the shipped binary (rust-v0.148.0, darwin-arm64,
 * 2026-08-29); `CODEX_HOME` path shortened. Full measurement in
 * `server-warning.ts`.
 */
describe('a plain warning notification', () => {
  const UNSTABLE_PARAMS = {
    threadId: '01a04ea4-95b8-7180-b5b9-cadd3924f7c8',
    message:
      'Under-development features enabled: executed_tool_call_metadata. Under-development features '
      + 'are incomplete and may behave unpredictably. To suppress this warning, set '
      + '`suppress_unstable_features_warning = true` in /tmp/p2408-home-fINkPw/config.toml.',
  };

  /** KILLS: dropping the `warning` case from `handleLine` — the row's whole defect. */
  test('is classified onto the diagnostic channel', async () => {
    const child = fakeChild();
    const diagnostics: string[] = [];
    client(child, { onDiagnostic: (m) => diagnostics.push(m) });
    child.answer({ method: 'warning', params: UNSTABLE_PARAMS });
    await tick(10);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toContain('UNDER-DEVELOPMENT FEATURES ARE LIVE');
    expect(diagnostics[0]).toContain('executed_tool_call_metadata');
  });

  /** KILLS: intercepting instead of observing — the notification must still be forwarded. */
  test('is forwarded to onNotification byte-identically as well', async () => {
    const child = fakeChild();
    const seen: Array<{ method: string; params: unknown }> = [];
    client(child, { onNotification: (method, params) => seen.push({ method, params }) });
    child.answer({ method: 'warning', params: UNSTABLE_PARAMS });
    await tick(10);
    expect(seen).toEqual([{ method: 'warning', params: UNSTABLE_PARAMS }]);
  });
});

/**
 * P6.269 — the OTHER way a request can outlive its answer: the server dies.
 *
 * `timeoutMs` above covers a server that IGNORES a method, and it is opt-in
 * precisely because this request family carries genuinely long operations. That
 * leaves the second half uncovered: when the child exits, stdout merely ends —
 * readline closes, no line arrives, and every pending entry stays pending
 * forever. Killing the app-server between a user message and its answer left the
 * turn with no status, no error and no `complete`.
 *
 * The cases below are the row's `done_means` plus both of its named controls.
 */
describe('a server that dies before answering', () => {
  test('the pending request rejects, and the message NAMES the exit code', async () => {
    const child = fakeChild();
    const app = client(child);
    const pending = app.request('turn/start', { text: 'hello' });
    const state = settlement(pending);

    await tick(20);
    expect(state.settled).toBe(false); // still waiting, as a live turn should

    child.exit(1);
    await expect(pending).rejects.toThrow('app-server exited with exit code 1 before answering');
  });

  test('a killed server names the SIGNAL instead, because that is a different fact', async () => {
    const child = fakeChild();
    const app = client(child);
    const pending = app.request('turn/start', { text: 'hello' });
    child.exit(null, 'SIGKILL');
    // A non-zero code is the binary refusing something; SIGKILL is usually the
    // machine reclaiming memory. Collapsing the two would cost the user the one
    // fact they can act on.
    await expect(pending).rejects.toThrow('app-server exited with signal SIGKILL before answering');
  });

  test('a clean exit is still a failure for a request it never answered', async () => {
    const child = fakeChild();
    const app = client(child);
    const pending = app.request('turn/start', { text: 'hello' });
    child.exit(0);
    await expect(pending).rejects.toThrow('app-server exited with exit code 0 before answering');
  });

  test('EVERY in-flight request ends, and the diagnostic is emitted ONCE', async () => {
    const child = fakeChild();
    const diagnostics: string[] = [];
    const app = client(child, { onDiagnostic: line => diagnostics.push(line) });
    const first = app.request('turn/start', { text: 'one' });
    const second = app.request('thread/compact/start');
    child.exit(2);
    await expect(first).rejects.toThrow('exit code 2');
    await expect(second).rejects.toThrow('exit code 2');
    // One line per DEATH, not one per pending request: two rejections are two
    // callers being told, but the operator saw a single process go away.
    expect(diagnostics).toEqual(['app-server exited with exit code 2 before answering']);
  });

  test('CONTROL (a): a normally-completing turn is untouched by the exit that follows it', async () => {
    const child = fakeChild();
    const diagnostics: string[] = [];
    const app = client(child, { onDiagnostic: line => diagnostics.push(line) });
    const pending = app.request('turn/start', { text: 'hello' });
    child.answer({ id: 1, result: { ok: true } });
    await expect(pending).resolves.toEqual({ ok: true });

    // The child exits afterwards, as it does on every normal teardown. The
    // pending map is already empty, so nothing rejects and nothing is reported.
    child.exit(0);
    await tick(10);
    await expect(pending).resolves.toEqual({ ok: true });
    expect(diagnostics).toEqual([]);
  });

  test('CONTROL (b): a slow-but-live turn is not ended — only the exit ends it', async () => {
    const child = fakeChild();
    const app = client(child);
    // No `timeoutMs`, deliberately: `turn/start` can legitimately run for
    // minutes, and a blanket ceiling would turn a slow success into a
    // manufactured failure. Liveness, not elapsed time, is the discriminator.
    const pending = app.request('turn/start', { text: 'a long job' });
    const state = settlement(pending);
    await tick(120);
    expect(state.settled).toBe(false);

    child.answer({ id: 1, result: { ok: true } });
    await expect(pending).resolves.toEqual({ ok: true });
  });

  test('after the exit a later write is reported, not thrown, and close() is a no-op', async () => {
    const child = fakeChild();
    const diagnostics: string[] = [];
    const app = client(child, { onDiagnostic: line => diagnostics.push(line) });
    child.exit(1);
    diagnostics.length = 0;

    app.notify('turn/interrupt');
    expect(diagnostics).toEqual(['cannot write: stdin not writable']);
    expect(child.written).toEqual([]);
    // A second round of rejections would surface as an unhandled rejection
    // rather than as a failure here, so this asserts the `closed` latch.
    expect(() => app.close()).not.toThrow();
  });
});

/**
 * P6.459 arm (2) / P6.732 — the per-request W3C trace carrier.
 *
 * Read from the source rather than a page (`rust-v0.148.0`):
 * `codex-rs/protocol/src/protocol.rs:199-207` declares
 * `W3cTraceContext { traceparent, tracestate }` with both fields
 * `#[serde(default, skip_serializing_if = "Option::is_none")]`, so a carrier
 * holding only `traceparent` is what the binary expects to be able to receive;
 * `codex-rs/app-server/src/app_server_tracing.rs:45-52` lifts `request.trace`
 * and `attach_parent_context` (`:129-140`) makes it the PARENT of the span the
 * app-server opens for that request.
 *
 * The negatives are the point of the row, not padding: with tracing off the host
 * has no span, and a `traceparent` minted anyway would name a trace nothing will
 * export — a backend then shows a request whose parent never arrives.
 */
describe('the per-request trace carrier', () => {
  const sent = (child: FakeChild): Record<string, unknown> =>
    JSON.parse(child.written.at(-1) ?? '{}') as Record<string, unknown>;

  test('rides the request when the host has a span open, carrying traceparent alone', async () => {
    const child = fakeChild();
    const traceparent = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';
    const app = client(child, { resolveTraceparent: () => traceparent });

    // The rejection this collects is `afterEach`'s `close()`, not a failure.
    app.request('turn/start', { text: 'hi' }).catch(() => {});

    // `tracestate` is absent rather than `null`: the struct skips it when it is
    // `None`, and we have nothing to put in it.
    expect(sent(child)).toEqual({ id: 1, method: 'turn/start', params: { text: 'hi' }, trace: { traceparent } });
  });

  test('NEGATIVE: with no span open the field is ABSENT — nothing is minted here', async () => {
    const child = fakeChild();
    // Both shapes of "off": no resolver at all (the default every existing call
    // site keeps), and a resolver answering `undefined`, which is what
    // `HostTracer.currentTraceparent` returns outside a turn — and what the
    // tracer itself is when the operator never opted in.
    const noResolver = client(child);
    noResolver.request('turn/start').catch(() => {});
    expect('trace' in sent(child)).toBe(false);

    const other = fakeChild();
    const app = client(other, { resolveTraceparent: () => undefined });
    app.request('turn/start').catch(() => {});
    expect('trace' in sent(other)).toBe(false);
    // An empty string is not a carrier either — it would serialize as a `trace`
    // object codex discards at `app_server_tracing.rs:46`, which is a payload
    // that says "traced" and is not.
    const empty = fakeChild();
    const blank = client(empty, { resolveTraceparent: () => '' });
    blank.request('turn/start').catch(() => {});
    expect('trace' in sent(empty)).toBe(false);
  });

  test('a notification never carries one, and a throwing resolver never costs the turn', async () => {
    // `JSONRPCNotification` has no `trace` member in the pinned schema, so a
    // notification that grew one would be a field the binary does not read.
    const child = fakeChild();
    const app = client(child, { resolveTraceparent: () => '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01' });
    app.notify('turn/interrupt');
    expect(sent(child)).toEqual({ method: 'turn/interrupt' });

    // Telemetry is best-effort everywhere in this tree; a span lookup that
    // raises must not stop the request from being sent.
    const throwing = fakeChild();
    const app2 = client(throwing, { resolveTraceparent: () => { throw new Error('span registry exploded') } });
    const pending = app2.request('turn/start');
    expect(sent(throwing)).toEqual({ id: 1, method: 'turn/start' });
    throwing.answer({ id: 1, result: { ok: true } });
    await expect(pending).resolves.toEqual({ ok: true });
  });
});
