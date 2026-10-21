/**
 * P6.118 — two of codex's six unwired hook events are minted host-side.
 *
 * ## What was wrong
 *
 * `runtime-hook-events.ts` marked `PostCompact` and `StopFailure` `unwired` on
 * codex: the OCCURRENCE exists on that runtime — codex announces a compaction
 * and sends `ErrorNotification` for a failed turn — and nothing emitted the
 * event, so a plugin's hook was installed, reported enabled, and did nothing.
 *
 * ## Native-first, asked and answered
 *
 * `postCompact` IS one of codex's eleven `HookEventName` values and `stopFailure`
 * is not (it is our vocabulary). Neither matters for the route: the owner closed
 * the native `[hooks]` path on 2026-08-29 for anything the host did not author,
 * which is what left P3.335 minting the POST tool events from the item stream.
 * Same seam, same reason.
 *
 * ## What these cases pin
 *
 * The payload is Pi's field for field — that is the row's whole promise, so one
 * hook body behaves the same on both runtimes. Beyond that, the two gates that
 * decide whether the event fires at all: a `willRetry` error is a turn still
 * running, and an error naming a DIFFERENT turn on the thread did not fail this
 * one. Both would report a stop that never happened.
 *
 * `PreCompact` has no case here and is deliberately not minted: codex reports
 * compaction only in the past tense, so the only moment to hang it on is our own
 * `/compact` request — which would fire on the manual path and never on the
 * automatic one.
 */
import { describe, expect, it } from 'bun:test';
import type { BackendConfig } from '../backend/types.ts';
import { CodexAgent } from '../codex-agent.ts';

function createConfig(): BackendConfig {
  return {
    provider: 'codex-runtime',
    workspace: {
      id: 'ws-codex-compact-hooks',
      name: 'Codex Compaction Hooks Workspace',
      rootPath: '/tmp/ws-codex-compact-hooks',
      workspaceRootPath: '/tmp/ws-codex-compact-hooks',
      sessionRootPath: '/tmp/nessy-general-agent-test-sessions/ws-codex-compact-hooks',
    } as never,
    session: {
      id: 'session-codex-compact-hooks',
      workspaceRootPath: '/tmp/ws-codex-compact-hooks',
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      workingDirectory: '/tmp/project-root',
    } as never,
    model: 'codex/test-model',
    isHeadless: true,
  } as BackendConfig;
}

interface Emitted { event: string; input: Record<string, unknown> }

function harness() {
  const agent = new CodexAgent(createConfig());
  const emitted: Emitted[] = [];
  const internals = agent as unknown as {
    emitAutomationEvent: (event: string, input: Record<string, unknown>) => Promise<unknown>;
    handleNotification: (method: string, params: unknown) => void;
    emitCodexPostCompactHook: () => void;
    manualCompactionRequestedForTurn: boolean;
    stopFailureHookEmittedForTurn: boolean;
    activeTurnId: string | null;
    debug: (message: string) => void;
  };
  internals.emitAutomationEvent = async (event, input) => { emitted.push({ event, input }); return undefined; };
  internals.debug = () => {};
  return { agent, emitted, internals, destroy: () => agent.destroy() };
}

/** One macrotask, so a detached emission has run. */
const settle = () => new Promise<void>(resolve => setTimeout(resolve, 0));

/** codex's own `ErrorNotification` shape (`{ error: TurnError, willRetry, threadId, turnId }`). */
function errorNotification(options: {
  code?: string | Record<string, unknown>;
  message?: string;
  details?: string | null;
  willRetry?: boolean;
  turnId?: string;
}): Record<string, unknown> {
  return {
    error: {
      message: options.message ?? 'the model call failed',
      codexErrorInfo: options.code ?? null,
      additionalDetails: options.details ?? null,
    },
    willRetry: options.willRetry ?? false,
    threadId: 'thread-1',
    turnId: options.turnId ?? 'turn-1',
  };
}

describe('P6.118 · codex mints StopFailure from its own ErrorNotification', () => {
  it('emits Pi’s four fields, with the documented error projected and the raw code beside it', async () => {
    const h = harness();
    try {
      h.internals.activeTurnId = 'turn-1';
      h.internals.handleNotification('error', errorNotification({
        code: 'usageLimitExceeded',
        message: 'You have hit your usage limit.',
        details: 'resets in 3h',
      }));
      await settle();

      const stopFailure = h.emitted.filter(e => e.event === 'StopFailure');
      expect(stopFailure).toHaveLength(1);
      expect(stopFailure[0]!.input).toEqual({
        hook_event_name: 'StopFailure',
        lifecycle_version: 1,
        // The closed ten-value vocabulary hooks.md binds `error` to…
        error: 'rate_limit',
        // …and codex's own word beside it, which the matcher reads first.
        error_code: 'usageLimitExceeded',
        error_details: 'resets in 3h',
        last_assistant_message: 'You have hit your usage limit.',
      });
    } finally { h.destroy(); }
  });

  it('projects an unmapped codex code to the documented catch-all, never to a neighbour', async () => {
    const h = harness();
    try {
      h.internals.activeTurnId = 'turn-1';
      // An object variant — `{ httpConnectionFailed: { httpStatusCode } }` — so
      // the code reader is exercised on both shapes of `CodexErrorInfo`.
      h.internals.handleNotification('error', errorNotification({
        code: { httpConnectionFailed: { httpStatusCode: 503 } },
      }));
      await settle();

      const stopFailure = h.emitted.find(e => e.event === 'StopFailure');
      expect(stopFailure?.input.error).toBe('unknown');
      expect(stopFailure?.input.error_code).toBe('httpConnectionFailed');
    } finally { h.destroy(); }
  });

  it('says nothing while the error is retrying, and nothing for another turn’s error', async () => {
    const h = harness();
    try {
      h.internals.activeTurnId = 'turn-1';
      h.internals.handleNotification('error', errorNotification({ code: 'serverOverloaded', willRetry: true }));
      h.internals.handleNotification('error', errorNotification({ code: 'serverOverloaded', turnId: 'turn-OTHER' }));
      await settle();
      expect(h.emitted.filter(e => e.event === 'StopFailure')).toHaveLength(0);

      // …and the terminal error for THIS turn still fires, so the two gates
      // above are gates and not an emitter that never runs.
      h.internals.handleNotification('error', errorNotification({ code: 'serverOverloaded' }));
      await settle();
      expect(h.emitted.filter(e => e.event === 'StopFailure')).toHaveLength(1);

      // Once per turn: a second terminal error on the same turn adds nothing.
      h.internals.handleNotification('error', errorNotification({ code: 'unauthorized' }));
      await settle();
      expect(h.emitted.filter(e => e.event === 'StopFailure')).toHaveLength(1);
    } finally { h.destroy(); }
  });
});

describe('P6.118 · codex mints PostCompact from the compaction it already announces', () => {
  it('emits Pi’s fields, with trigger auto and the empty summary codex publishes', async () => {
    const h = harness();
    try {
      // The deprecated `thread/compacted` notification: one of the two channels
      // the adapter funnels through `observedCompaction`.
      h.internals.handleNotification('thread/compacted', { threadId: 'thread-1', turnId: 'turn-1' });
      await settle();

      const postCompact = h.emitted.filter(e => e.event === 'PostCompact');
      expect(postCompact).toHaveLength(1);
      expect(postCompact[0]!.input).toEqual({
        hook_event_name: 'PostCompact',
        trigger: 'auto',
        // Codex publishes no summary on either channel; Pi's own value when its
        // compaction entry carries none, so the field has one type on both.
        compact_summary: '',
        source: 'compact',
      });
    } finally { h.destroy(); }
  });

  it('reports the manual trigger when this turn asked for the compaction', async () => {
    const h = harness();
    try {
      h.internals.manualCompactionRequestedForTurn = true;
      h.internals.handleNotification('thread/compacted', { threadId: 'thread-1', turnId: 'turn-1' });
      await settle();

      expect(h.emitted.find(e => e.event === 'PostCompact')?.input).toMatchObject({
        trigger: 'manual',
        source: 'manual',
      });

      // The manual mark is consumed: the NEXT compaction is automatic again,
      // which is what stops one `/compact` labelling every later compaction.
      h.internals.handleNotification('thread/compacted', { threadId: 'thread-1', turnId: 'turn-1' });
      await settle();
      const all = h.emitted.filter(e => e.event === 'PostCompact');
      expect(all).toHaveLength(2);
      expect(all[1]!.input).toMatchObject({ trigger: 'auto', source: 'compact' });
    } finally { h.destroy(); }
  });

  it('fires once per compaction and not once per notification', async () => {
    const h = harness();
    try {
      h.internals.handleNotification('thread/tokenUsage/updated', { tokenUsage: { last: {} } });
      await settle();
      expect(h.emitted.filter(e => e.event === 'PostCompact')).toHaveLength(0);
    } finally { h.destroy(); }
  });
});

/**
 * F1.1224 — StopFailure's documented `error` for the members `rust-v0.159.3` added: a stream rate
 * limit is `rate_limit` (as `usageLimitExceeded` is), Flex capacity unavailable is `overloaded`, and
 * `tooManyDenials` has no documented word, so it stays on the catch-all with its raw code beside it.
 */
describe('F1.1224 — StopFailure for rateLimitExceeded, flexUnavailable and tooManyDenials', () => {
  it.each([
    ['rateLimitExceeded', 'rate_limit'],
    ['flexUnavailable', 'overloaded'],
    ['tooManyDenials', 'unknown'],
  ])('%s projects to %s, the raw code beside it', async (code, documented) => {
    const h = harness();
    try {
      h.internals.activeTurnId = 'turn-1';
      h.internals.handleNotification('error', errorNotification({ code }));
      await settle();
      const stopFailure = h.emitted.find(e => e.event === 'StopFailure');
      expect(stopFailure?.input.error).toBe(documented);
      expect(stopFailure?.input.error_code).toBe(code);
    } finally { h.destroy(); }
  });
});
