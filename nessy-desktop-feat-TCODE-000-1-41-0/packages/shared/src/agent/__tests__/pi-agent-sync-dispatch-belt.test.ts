import { describe, expect, it } from 'bun:test';
import { createInterface } from 'node:readline';
import { Readable } from 'node:stream';
import { PiAgent } from '../pi-agent.ts';
import type { BackendConfig } from '../backend/types.ts';
import type { AgentEvent } from '@nessy-agent/core/types';

/**
 * P2.33 — the two SYNC subprocess dispatches answer instead of escaping.
 *
 * `handlePreToolUseRequest` (P2.20), `handlePostToolUseRequest` and
 * `handlePreCompactRequest` are `async`, so a throw inside them becomes a
 * rejection: bad, but confined to one request. `handleAskUserRequest` and
 * `handleOutsideRootRequest` are sync `void`, and `handleLine` wraps only the
 * `JSON.parse` — so their throws travel out of the readline `'line'` listener,
 * and THAT drops the remaining lines of the same stdout chunk. Measured on this
 * rig for both runtimes (`bun` 1.3.14, `node` v24.4.1): pushing `A\nB\nC\nD`
 * through `createInterface` with a listener that throws on `B` delivers
 * `["A","B"]` — `C` and `D` are gone, silently. Electron's
 * `process.on('uncaughtException')` logs without exiting and a packaged build
 * logs nothing outside debug mode, so the whole event is invisible.
 *
 * Hence each test below asserts BOTH halves: the request itself is answered
 * fail-closed, AND the next message in the SAME chunk still processes. The
 * second half is the one that matters — an unanswered request is one stuck tool
 * call, a dropped chunk tail is arbitrary unrelated subprocess traffic.
 *
 * P2.41 adds the notification half of the same surface (`event`,
 * `ask_user_cancel`, `session_tool_completed`, `mini_completion_result`) — see
 * the second `describe` block — and pays P2.33's measurement debt about how an
 * escape is DETECTED here.
 *
 * HOW AN ESCAPE IS DETECTED (re-measured for P2.41 on bun 1.3.14, with a bare
 * readline rig outside this file): NOT by a user `uncaughtException` listener.
 * bun intercepts the exception before any such listener runs — pushing
 * `A\nB\nC\nD` with a listener that throws on `B` yields `seen=["A","B"]` and
 * `escapes.length === 0` in the same run, i.e. the tail was genuinely lost while
 * the listener saw nothing. The `expect(rig.escapes).toEqual([])` this file used
 * to carry was therefore vacuous, and it is deleted rather than kept as
 * decoration. The two real detectors are:
 *   1. the TAIL assertion in every test — the message queued BEHIND the thrower
 *      in the same chunk is delivered only if nothing escaped; and
 *   2. bun's own unhandled-error report, which fails the test the throw escapes
 *      from (measured: `error: PROBE ESCAPE`, `(fail)`).
 * Both fire on the pre-belt tree: each test below was run RED first.
 */

function createConfig(overrides: Partial<BackendConfig> = {}): BackendConfig {
  return {
    provider: 'pi',
    workspace: {
      id: 'ws-belt',
      name: 'Belt Workspace',
      rootPath: '/tmp/nessy-general-agent-belt',
      workspaceRootPath: '/tmp/nessy-general-agent-belt',
      sessionRootPath: '/tmp/nessy-general-agent-belt-sessions/ws-belt',
    } as any,
    session: {
      id: 'session-belt',
      workspaceRootPath: '/tmp/nessy-general-agent-belt',
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
    } as any,
    isHeadless: true,
    skipConfigWatcher: true,
    ...overrides,
  };
}

interface Rig {
  agent: PiAgent;
  sent: Array<Record<string, unknown>>;
  published: Array<Record<string, unknown>>;
  diagnostics: string[];
  /** Everything the agent put on the turn's own event queue. */
  queued: AgentEvent[];
  /** Deliver messages as ONE stdout chunk through a real readline interface. */
  pushChunk: (...messages: Array<Record<string, unknown>>) => Promise<void>;
  dispose: () => void;
}

function setupRig(configOverrides: Partial<BackendConfig> = {}): Rig {
  const agent = new PiAgent(createConfig(configOverrides));
  const sent: Array<Record<string, unknown>> = [];
  const published: Array<Record<string, unknown>> = [];
  const diagnostics: string[] = [];
  const queued: AgentEvent[] = [];
  (agent as any).send = (message: Record<string, unknown>) => { sent.push(message); };
  (agent as any).debug = (message: string) => { diagnostics.push(message); };
  (agent as any).subprocess = {};
  (agent as any).emitAutomationEvent = async () => {};
  agent.onPermissionRequest = (request: any) => { published.push(request); };
  // Record what reaches the turn's generator without replacing the queue: the
  // `event` belt's visibility half is an `error` event on this exact channel.
  const eventQueue = (agent as any).eventQueue;
  const enqueue = eventQueue.enqueue.bind(eventQueue);
  eventQueue.enqueue = (event: AgentEvent) => { queued.push(event); enqueue(event); };

  // The production wiring, verbatim (`pi-agent.ts` `startSubprocess`): one
  // `createInterface` over the child's stdout, `handleLine` as the sole `'line'`
  // listener, nothing between them to catch a throw. Reproducing it — rather
  // than calling `handleLine` once per message — is the only way the chunk-tail
  // loss is observable at all.
  const input = new Readable({ read() {} });
  const readline = createInterface({ input, crlfDelay: Infinity });
  readline.on('line', (line: string) => { (agent as any).handleLine(line); });

  return {
    agent,
    sent,
    published,
    diagnostics,
    queued,
    pushChunk: async (...messages) => {
      input.push(messages.map(message => JSON.stringify(message)).join('\n') + '\n');
      await new Promise(resolve => setTimeout(resolve, 0));
    },
    dispose: () => {
      readline.removeAllListeners();
      readline.close();
      input.push(null);
      (agent as any).subprocess = null;
      agent.destroy();
    },
  };
}

describe('PiAgent sync permission dispatches — answered, never escaped (P2.33)', () => {
  it('a throwing host publish still denies the outside-root request, and the next line survives', async () => {
    // `onPermissionRequest` is HOST-supplied and called synchronously by
    // `handleOutsideRootRequest` — the real throw source this row exists for,
    // no stubbing needed.
    const rig = setupRig();
    rig.agent.onPermissionRequest = (request: any) => {
      if (request.requestId === 'belt-outside-1') throw new Error('host publish exploded');
      (rig.published as any[]).push(request);
    };
    try {
      await rig.pushChunk(
        { type: 'outside_root_request', requestId: 'belt-outside-1', canonicalTarget: '/etc/passwd', access: 'read' },
        { type: 'outside_root_request', requestId: 'belt-outside-2', canonicalTarget: '/etc/hosts', access: 'read' },
      );

      // The half that matters: the message BEHIND the thrower in the same chunk
      // still reached the agent. Before the belt this line was never delivered —
      // and nothing about `belt-outside-2` is related to the failed request.
      expect(rig.published.map(request => request.requestId)).toEqual(['belt-outside-2']);
      // The other half: answered, fail-closed. `root: null` IS the refusal on
      // this wire (`pi-agent-server` `InboundMessage`: `root: SessionFilesystemScopeRoot | null`,
      // and the subprocess resolves its pending scope request with `msg.root ?? null`),
      // so the suspended tool call gets no scope outside the session root.
      expect(rig.sent).toContainEqual({
        type: 'outside_root_response',
        requestId: 'belt-outside-1',
        root: null,
      });
      // The half-built pending entry is dropped: it was already registered when
      // the publish threw, and a stale `outside_root` entry is one the user
      // could still approve — granting a session-lifetime root host-side for a
      // request the subprocess has already been told was denied.
      expect((rig.agent as any).pendingPermissions.has('belt-outside-1')).toBe(false);
      expect(rig.diagnostics.some(line => line.includes('host publish exploded'))).toBe(true);
    } finally {
      rig.dispose();
    }
  });

  it('a throwing ask-user handler still answers the subprocess, and the next line survives', async () => {
    // The handler's own promise chain already has a `.catch`, so its remaining
    // throw surface is the synchronous prologue — narrow today, and exactly the
    // kind of thing a later edit widens without noticing. The belt is the
    // guarantee, so it is tested the way P2.20 tested its own: by making the
    // handler throw.
    const rig = setupRig();
    (rig.agent as any).handleAskUserRequest = () => { throw new Error('ask handler exploded'); };
    try {
      await rig.pushChunk(
        { type: 'ask_user_request', requestId: 'belt-ask-1', question: 'Continue?', options: ['Yes', 'No'], allowFreeText: false },
        { type: 'outside_root_request', requestId: 'belt-ask-2', canonicalTarget: '/etc/hosts', access: 'read' },
      );

      // The half that matters: the following message in the same chunk was
      // still delivered.
      expect(rig.published.map(request => request.requestId)).toEqual(['belt-ask-2']);
      // The other half: answered fail-closed. The refusal on THIS wire is an
      // `error` string, not an answer — `handleAskUserResponse` rejects the
      // subprocess's pending `ask_user` promise with it, so the tool call fails
      // visibly. Answering with a fabricated `answer` would put words in the
      // user's mouth.
      const answer = rig.sent.find(message => message.type === 'ask_user_response');
      expect(answer).toMatchObject({ type: 'ask_user_response', requestId: 'belt-ask-1' });
      expect(String(answer?.error)).toContain('ask handler exploded');
      expect(answer).not.toHaveProperty('answer');
      expect(rig.diagnostics.some(line => line.includes('ask handler exploded'))).toBe(true);
    } finally {
      rig.dispose();
    }
  });

  it('the belts are inert when nothing throws', async () => {
    // The boundary pair: both dispatches publish a permission request and send
    // NOTHING on the wire, exactly as before. A belt that answered eagerly would
    // deny every outside-root request and error every question.
    const rig = setupRig();
    try {
      await rig.pushChunk(
        { type: 'outside_root_request', requestId: 'quiet-outside', canonicalTarget: '/etc/hosts', access: 'write' },
        { type: 'ask_user_request', requestId: 'quiet-ask', question: 'Continue?', options: ['Yes', 'No'], allowFreeText: false },
      );

      expect(rig.published).toHaveLength(2);
      expect(rig.published[0]).toMatchObject({
        type: 'outside_root',
        toolName: 'Write',
        requestId: 'quiet-outside',
      });
      // The local ask-user fallback (no `askUserPort` on this config) mints its
      // own `pi-ask-…` permission id and keys the subprocess id off the pending
      // entry, so only the shape is stable here.
      expect(rig.published[1]).toMatchObject({ type: 'ask_user', toolName: 'ask_user' });
      expect(String(rig.published[1]?.requestId)).toStartWith('pi-ask-');
      expect(rig.sent).toEqual([]);
      // …and the real answer path still resolves the outside-root request.
      rig.agent.respondToPermission('quiet-outside', false);
      expect(rig.sent).toContainEqual({ type: 'outside_root_response', requestId: 'quiet-outside', root: null });
    } finally {
      rig.dispose();
    }
  });
});

/**
 * P2.41 — the NOTIFICATION half of the same escape surface.
 *
 * These four dispatches are not request/response wires: nothing on the far side
 * is blocked waiting for an answer, so "fail closed" cannot mean "answer". What
 * it means per handler, and why:
 *
 * - `event` — drop the ONE event, keep the stream. This is the highest-volume
 *   message on the wire; a belt that only swallowed would hide a real
 *   programming error behind a slightly-wrong transcript. So the failure is also
 *   SURFACED as an `error` AgentEvent on the turn's own queue (a visible error
 *   row — `SessionManager`'s `case 'error'` appends one and does NOT complete
 *   the turn), deduplicated so a CONSECUTIVELY repeating fault cannot flood the
 *   session (the third row below pins what that bound is and is not).
 * - `ask_user_cancel` — nothing to answer (the subprocess has already abandoned
 *   the question), so the belt keeps the stream alive and completes the LOCAL
 *   teardown. This paragraph used to say the teardown "is guaranteed … so no
 *   card and no promise is stranded", which was false on the live path: the
 *   ask-user request and its cancel both branch exclusively on `askUserPort`,
 *   the throw source lives on the host branch, and `pendingPermissions` is
 *   populated only on the OTHER one. The two rows below drive the two branches
 *   separately and record what each actually gets.
 * - `session_tool_completed` — log and continue; the callbacks it reports were
 *   already fired by `executeSessionTool`, so there is no state to unwind.
 * - `mini_completion_result` — settle the correlation entry with `null`, the
 *   same value the timeout and no-subprocess paths already give
 *   `runMiniCompletion`, instead of making the caller wait out the full timeout
 *   for a result that already arrived.
 */
describe('PiAgent sync notification dispatches — logged, never escaped (P2.41)', () => {
  it('a throwing continuation-boundary callback cannot eat the rest of the stdout chunk', async () => {
    // `onPiContinuationBoundary` is HOST-supplied and called synchronously from
    // `handleSubprocessEvent` on `compaction_start` — a real throw source on the
    // busiest wire, no stubbing needed.
    const rig = setupRig({
      onPiContinuationBoundary: () => { throw new Error('boundary exploded'); },
    });
    try {
      await rig.pushChunk(
        { type: 'event', event: { type: 'compaction_start' } },
        { type: 'outside_root_request', requestId: 'belt-event-tail', canonicalTarget: '/etc/hosts', access: 'read' },
      );

      // The half that matters: the line BEHIND the throwing event still ran.
      expect(rig.published.map(request => request.requestId)).toEqual(['belt-event-tail']);
      expect(rig.diagnostics.some(line => line.includes('boundary exploded'))).toBe(true);
      // …and the fault is visible without debug logging: one error row, not a
      // silent gap in the transcript.
      const surfaced = rig.queued.filter(event => event.type === 'error');
      expect(surfaced).toHaveLength(1);
      expect(String((surfaced[0] as { message?: unknown }).message)).toContain('boundary exploded');
      // A notification has nothing to answer — the belt must not invent a reply.
      expect(rig.sent).toEqual([]);
    } finally {
      rig.dispose();
    }
  });

  it('an identical repeating event fault is surfaced a bounded number of times', async () => {
    // The dedup is the reason surfacing is safe on this wire at all: `event` is
    // the highest-volume message, and a fault that repeats per event would
    // otherwise fill the session with identical error rows.
    const rig = setupRig({
      onPiContinuationBoundary: () => { throw new Error('boundary exploded'); },
    });
    try {
      for (let index = 0; index < 6; index++) {
        (rig.agent as any).continuationBoundaryOpen = false;
        await rig.pushChunk({ type: 'event', event: { type: 'compaction_start' } });
      }

      expect(rig.queued.filter(event => event.type === 'error')).toHaveLength(3);
      // Every occurrence is still on the debug channel — the cap suppresses the
      // duplicate ROWS, not the record.
      expect(rig.diagnostics.filter(line => line.includes('boundary exploded'))).toHaveLength(6);
    } finally {
      rig.dispose();
    }
  });

  it('the event-fault bound is PER SIGNATURE — a different fault cannot refill an allowance', async () => {
    // REWRITTEN BY P2.66, and the previous version was correct when it was
    // written: the bound was a single last-signature slot, so this same sequence
    // gave 3 + 1 + 3 rows — a different fault in between RESET the count, and an
    // alternating pair was therefore never suppressed at all (P2.66 measured 20
    // rows for 20 alternating faults). The counts are per signature now, so an
    // allowance is spent once and only its own signature can spend it. The
    // sequence is kept identical to the old row so the two numbers are directly
    // comparable.
    let fault = 'fault X';
    const rig = setupRig({
      onPiContinuationBoundary: () => { throw new Error(fault); },
    });
    const errorRows = () => rig.queued.filter(event => event.type === 'error').length;
    const pushFault = async () => {
      (rig.agent as any).continuationBoundaryOpen = false;
      await rig.pushChunk({ type: 'event', event: { type: 'compaction_start' } });
    };
    try {
      for (let index = 0; index < 5; index++) await pushFault();
      expect(errorRows()).toBe(3);

      // One different fault: surfaced, because it is new and has its own
      // allowance — the visibility half is unchanged.
      fault = 'fault Y';
      await pushFault();
      expect(errorRows()).toBe(4);

      // …and fault X is still capped. The last-signature slot gave it a fresh
      // allowance of three here (7 rows); the per-signature map does not.
      fault = 'fault X';
      for (let index = 0; index < 5; index++) await pushFault();
      expect(errorRows()).toBe(4);

      // Suppressing the row is not suppressing the record: all eleven
      // occurrences are on the debug channel.
      expect(rig.diagnostics.filter(line => line.includes('fault X'))).toHaveLength(10);
      expect(rig.diagnostics.filter(line => line.includes('fault Y'))).toHaveLength(1);
    } finally {
      rig.dispose();
    }
  });

  it('a throwing host cancel port cannot eat the chunk — and the local recovery cannot reach it', async () => {
    // The LIVE branch, and the row's point is as much what does NOT happen.
    //
    // Real throw source, no stub of our own code: in the app `askUserPort` is
    // `createPiInteractionPorts`' port, whose `cancel` runs
    // `assertPiInteractionSessionKey` first — a SYNCHRONOUS
    // `Error('pi-interaction-session-mismatch')` when the session id has drifted
    // from the key the port was bound to. Synchronous is what matters: the
    // handler's `.catch` covers only a returned rejection.
    //
    // The open question is built through the REAL path rather than hand-placed,
    // because the previous version of this row hand-placed a state that cannot
    // occur (a host request id AND a matching `pendingPermissions` entry) and so
    // proved the recovery against an impossible input. `hostPort.request`
    // returning a never-settling promise is exactly an open card: the `finally`
    // that would clear the id has not run.
    const rig = setupRig();
    let hostRequests = 0;
    (rig.agent as any).config.askUserPort = {
      request: () => { hostRequests++; return new Promise(() => {}); },
      cancel: () => { throw new Error('pi-interaction-session-mismatch'); },
    };
    try {
      await rig.pushChunk(
        { type: 'ask_user_request', requestId: 'sub-ask-host', question: 'Continue?', options: ['Yes', 'No'], allowFreeText: false },
      );
      // MEASURED, not assumed — this is the branch fact the whole row rests on:
      // `requestAskUserPermission` returns `await hostPort.request(…)` and never
      // registers anything locally, so there is nothing for a sweep of
      // `pendingPermissions` to find on this path. Ever.
      expect(hostRequests).toBe(1);
      expect((rig.agent as any).hostAskUserRequestIds.has('sub-ask-host')).toBe(true);
      expect((rig.agent as any).pendingPermissions.size).toBe(0);

      await rig.pushChunk(
        { type: 'ask_user_cancel', requestId: 'sub-ask-host', reason: 'subprocess gave up' },
        { type: 'outside_root_request', requestId: 'belt-cancel-tail', canonicalTarget: '/etc/hosts', access: 'read' },
      );

      // What the belt buys here, and all it buys: the chunk tail survives the
      // port's throw, and the fault is recorded.
      expect(rig.published.map(request => request.requestId)).toEqual(['belt-cancel-tail']);
      expect(rig.diagnostics.some(line => line.includes('pi-interaction-session-mismatch'))).toBe(true);
      // Nothing is owed on the wire: the subprocess cancelled the question.
      expect(rig.sent).toEqual([]);
      // The honest negative. `cancelStrandedAskUserPermission` runs and finds
      // nothing, so it emits nothing — the card and the promise that strand are
      // the host `AskUserService`'s, outside `PiAgent`, and no code reachable
      // from this class settles them. Known residual, recorded rather than
      // papered over.
      //
      // Filtered by KIND, not counted: the tail `outside_root_request` registers
      // a pending entry of its own, and a bare `size` check reads that as the
      // ask-user card surviving. (It did, on the first run of this row.)
      const askUserPendings = [...(rig.agent as any).pendingPermissions.values()]
        .filter((pending: any) => pending.kind === 'ask_user');
      expect(askUserPendings).toHaveLength(0);
      expect(rig.queued.some(event => event.type === 'permission_request_cancelled')).toBe(false);
    } finally {
      rig.dispose();
    }
  });

  it('a cancel that throws before its own teardown still tears down the LOCAL pending', async () => {
    // The other branch — the only one where `pendingPermissions` holds an
    // `ask_user` entry at all. With no `askUserPort`, `requestAskUserPermission`
    // mints a `pi-ask-…` entry keyed by `subprocessRequestId` (the inert row
    // below builds one through the real path), and that entry is the whole of
    // what the recovery can reach.
    //
    // The thrower is a stub, deliberately and with the reason on the record: no
    // production code throws before `handleAskUserCancel`'s delete today, since
    // the host `cancel` sits on the branch this state excludes. So this row pins
    // the recovery as a guarantee for the edit that grows one — the same footing
    // as the `session_tool_completed` row, whose handler is inert today too.
    const rig = setupRig();
    let settled: unknown = 'unsettled';
    (rig.agent as any).pendingPermissions.set('pi-ask-9', {
      kind: 'ask_user',
      toolName: 'ask_user',
      subprocessRequestId: 'sub-ask-9',
      askUser: { question: 'Continue?', options: ['Yes', 'No'] },
      resolve: (value: unknown) => { settled = value; },
    });
    (rig.agent as any).handleAskUserCancel = () => { throw new Error('cancel teardown exploded'); };
    try {
      await rig.pushChunk(
        { type: 'ask_user_cancel', requestId: 'sub-ask-9', reason: 'subprocess gave up' },
        { type: 'outside_root_request', requestId: 'belt-cancel-tail', canonicalTarget: '/etc/hosts', access: 'read' },
      );

      expect(rig.published.map(request => request.requestId)).toEqual(['belt-cancel-tail']);
      // The teardown the cancel exists for happens anyway: the entry is dropped
      // and its answer promise settles as cancelled rather than never.
      expect((rig.agent as any).pendingPermissions.has('pi-ask-9')).toBe(false);
      expect(settled).toEqual({ error: 'subprocess gave up' });
      expect(rig.queued.some(event => event.type === 'permission_request_cancelled')).toBe(true);
      expect(rig.diagnostics.some(line => line.includes('cancel teardown exploded'))).toBe(true);
      // Nothing is owed on the wire: the subprocess cancelled the question.
      expect(rig.sent).toEqual([]);
    } finally {
      rig.dispose();
    }
  });

  it('a cancel that throws AFTER its own delete still settles the entry it removed', async () => {
    // P2.61 — the other side of the ordering the row above pins.
    // `handleAskUserCancel` DELETES the pending entry and only then cancels it,
    // so a throw from `cancelPendingPermission` itself lands after the delete
    // and the belt's map scan has nothing left to find.
    //
    // MEASURED on the pre-fix tree, in this exact rig: the chunk tail survived
    // (`belt-cancel-tail` published), the entry was gone
    // (`pendingPermissions.has('pi-ask-61')` false), the fault was on the debug
    // channel — and the answer promise stayed `'unsettled'` forever. The
    // `ask_user` tool call it belongs to would never have returned.
    //
    // The delete stays FIRST (a re-entrant cancel must not double-settle); what
    // changes is that the handler hands the belt the entry it just removed
    // instead of leaving it to re-scan an emptied map.
    //
    // Latent, not live: the ordering's only throw source today is
    // `eventQueue.enqueue` + `pending.resolve`, neither of which throws. Same
    // footing as the `session_tool_completed` row — pinned as a guarantee for
    // the edit that grows one.
    const rig = setupRig();
    let settled: unknown = 'unsettled';
    (rig.agent as any).pendingPermissions.set('pi-ask-61', {
      kind: 'ask_user',
      toolName: 'ask_user',
      subprocessRequestId: 'sub-ask-61',
      askUser: { question: 'Continue?', options: ['Yes', 'No'] },
      resolve: (value: unknown) => { settled = value; },
    });
    // The throw is placed at the ONE site the row names — the settle call the
    // handler makes after its own delete — not on the handler as a whole (that
    // is the row above, and it throws BEFORE the delete).
    // Throws ONCE, then hands the method back: `rejectPendingSubprocessRequests`
    // calls the same method during `dispose`, and a permanently-throwing stub
    // makes the teardown throw over the top of whatever this test measured.
    // (It did, on the first run of this row — the masked failure read as a
    // dispose bug.)
    const realCancelPendingPermission = (rig.agent as any).cancelPendingPermission.bind(rig.agent);
    let exploded = false;
    (rig.agent as any).cancelPendingPermission = (...args: unknown[]) => {
      if (exploded) return realCancelPendingPermission(...args);
      exploded = true;
      throw new Error('cancel settle exploded');
    };
    try {
      await rig.pushChunk(
        { type: 'ask_user_cancel', requestId: 'sub-ask-61', reason: 'subprocess gave up' },
        { type: 'outside_root_request', requestId: 'belt-cancel-tail', canonicalTarget: '/etc/hosts', access: 'read' },
      );

      expect(rig.published.map(request => request.requestId)).toEqual(['belt-cancel-tail']);
      expect((rig.agent as any).pendingPermissions.has('pi-ask-61')).toBe(false);
      // The assertion the fix exists for: the suspended `ask_user` settles.
      expect(settled).toEqual({ error: 'subprocess gave up' });
      expect(rig.diagnostics.some(line => line.includes('cancel settle exploded'))).toBe(true);
      expect(rig.sent).toEqual([]);
    } finally {
      rig.dispose();
    }
  });

  it('does not carry a settled cancel forward into a later fault on the same request id', async () => {
    // The capture is a ONE-SHOT handoff, cleared the moment the settle returns.
    // Without that clear it becomes a record of the LAST cancel, and the next
    // fault on the same subprocess request id consumes it — settling an
    // already-settled promise and returning EARLY, so the entry that actually
    // needed tearing down is left behind. Same wedge, arrived at from the
    // opposite direction.
    const rig = setupRig();
    const settlements: unknown[] = [];
    (rig.agent as any).pendingPermissions.set('pi-ask-a', {
      kind: 'ask_user',
      toolName: 'ask_user',
      subprocessRequestId: 'sub-ask-a',
      askUser: { question: 'First?', options: ['Yes', 'No'] },
      resolve: (value: unknown) => { settlements.push(['first', value]); },
    });
    try {
      await rig.pushChunk({ type: 'ask_user_cancel', requestId: 'sub-ask-a', reason: 'one' });
      expect(settlements).toEqual([['first', { error: 'one' }]]);

      // The subprocess asks again under the same id, and THIS time the handler
      // throws before its delete — the P2.41 branch, where the belt's map scan
      // is the only thing that can settle the entry.
      (rig.agent as any).pendingPermissions.set('pi-ask-b', {
        kind: 'ask_user',
        toolName: 'ask_user',
        subprocessRequestId: 'sub-ask-a',
        askUser: { question: 'Second?', options: ['Yes', 'No'] },
        resolve: (value: unknown) => { settlements.push(['second', value]); },
      });
      (rig.agent as any).handleAskUserCancel = () => { throw new Error('cancel teardown exploded'); };

      await rig.pushChunk(
        { type: 'ask_user_cancel', requestId: 'sub-ask-a', reason: 'two' },
        { type: 'outside_root_request', requestId: 'belt-cancel-tail', canonicalTarget: '/etc/hosts', access: 'read' },
      );

      expect(settlements).toEqual([['first', { error: 'one' }], ['second', { error: 'two' }]]);
      expect((rig.agent as any).pendingPermissions.has('pi-ask-b')).toBe(false);
      expect(rig.published.map(request => request.requestId)).toEqual(['belt-cancel-tail']);
    } finally {
      rig.dispose();
    }
  });

  it('a throwing session-tool-completed handler cannot eat the next line', async () => {
    // The handler is a deliberate no-op today (its callbacks already fired in
    // `executeSessionTool`), so the belt is what keeps a later edit's throw from
    // costing unrelated traffic. The reviewer demonstrated the loss live on
    // exactly this message, which is why it is belted while it is still inert.
    const rig = setupRig();
    (rig.agent as any).handleSessionToolCompleted = () => { throw new Error('completion handler exploded'); };
    try {
      await rig.pushChunk(
        { type: 'session_tool_completed', toolName: 'mcp__session__submit_plan', isError: false },
        { type: 'outside_root_request', requestId: 'belt-tool-tail', canonicalTarget: '/etc/hosts', access: 'read' },
      );

      expect(rig.published.map(request => request.requestId)).toEqual(['belt-tool-tail']);
      expect(rig.diagnostics.some(line => line.includes('completion handler exploded'))).toBe(true);
      expect(rig.sent).toEqual([]);
    } finally {
      rig.dispose();
    }
  });

  it('a throwing mini-completion handler settles the correlation entry, and the next line survives', async () => {
    const rig = setupRig();
    let resolved: unknown = 'unsettled';
    let rejected: unknown = null;
    (rig.agent as any).pendingMiniCompletions.set('mini-7', {
      resolve: (value: unknown) => { resolved = value; },
      reject: (error: unknown) => { rejected = error; },
    });
    (rig.agent as any).handleMiniCompletionResult = () => { throw new Error('mini handler exploded'); };
    try {
      await rig.pushChunk(
        { type: 'mini_completion_result', id: 'mini-7', text: 'a generated title' },
        { type: 'outside_root_request', requestId: 'belt-mini-tail', canonicalTarget: '/etc/hosts', access: 'read' },
      );

      expect(rig.published.map(request => request.requestId)).toEqual(['belt-mini-tail']);
      // `null` is the value `runMiniCompletion` already returns on timeout and
      // with no subprocess, so its callers handle it; the point of settling here
      // is that they do not wait out the full timeout first.
      expect(resolved).toBeNull();
      // …and settled by RESOLVING null, not by rejecting: `runMiniCompletion`
      // callers treat a rejection as a turn-level failure.
      expect(rejected).toBeNull();
      expect((rig.agent as any).pendingMiniCompletions.has('mini-7')).toBe(false);
      expect(rig.diagnostics.some(line => line.includes('mini handler exploded'))).toBe(true);
    } finally {
      rig.dispose();
    }
  });

  it('the event belt still owns every OTHER throw inside the event dispatch', async () => {
    // Coverage kept deliberately, not RED-first: P2.54 belts
    // `onPiContinuationBoundary` at its own call site, so the three boundary
    // rows above now measure THAT belt and no longer reach this one. The event
    // belt still exists and still owns everything else `handleSubprocessEvent`
    // can throw — the adapter, the detached-task fork, the compaction
    // bookkeeping — so it keeps a row of its own. Stubbed thrower, because the
    // real remaining sources are all several layers down.
    const rig = setupRig();
    (rig.agent as any).handleSubprocessEvent = () => { throw new Error('event adapter exploded'); };
    try {
      await rig.pushChunk(
        { type: 'event', event: { type: 'message_end' } },
        { type: 'outside_root_request', requestId: 'belt-event-belt-tail', canonicalTarget: '/etc/hosts', access: 'read' },
      );

      expect(rig.published.map(request => request.requestId)).toEqual(['belt-event-belt-tail']);
      expect(rig.diagnostics.some(line => line.includes('event adapter exploded'))).toBe(true);
      const surfaced = rig.queued.filter(event => event.type === 'error');
      expect(surfaced).toHaveLength(1);
      expect(String((surfaced[0] as { message?: unknown }).message)).toContain('event adapter exploded');
      expect(rig.sent).toEqual([]);
    } finally {
      rig.dispose();
    }
  });

  it('the notification belts are inert when nothing throws', async () => {
    // The boundary case: with no fault, each dispatch does exactly what it did
    // before — the event is adapted and forwarded, the cancel cancels, the mini
    // result carries its text, and NOTHING extra is surfaced or sent.
    const boundaries: string[] = [];
    const rig = setupRig({ onPiContinuationBoundary: phase => { boundaries.push(phase); } });
    let settled: unknown = 'unsettled';
    let resolved: unknown = 'unsettled';
    (rig.agent as any).pendingPermissions.set('pi-ask-quiet', {
      kind: 'ask_user',
      toolName: 'ask_user',
      subprocessRequestId: 'sub-ask-quiet',
      askUser: { question: 'Continue?', options: ['Yes', 'No'] },
      resolve: (value: unknown) => { settled = value; },
    });
    (rig.agent as any).pendingMiniCompletions.set('mini-quiet', {
      resolve: (value: unknown) => { resolved = value; },
      reject: () => {},
    });
    try {
      await rig.pushChunk(
        { type: 'event', event: { type: 'compaction_start' } },
        { type: 'ask_user_cancel', requestId: 'sub-ask-quiet', reason: 'user closed the card' },
        { type: 'session_tool_completed', toolName: 'mcp__session__submit_plan', isError: false },
        { type: 'mini_completion_result', id: 'mini-quiet', text: 'a generated title' },
      );

      expect(boundaries).toEqual(['pre']);
      expect(rig.queued.some(event => event.type === 'status')).toBe(true);
      expect(rig.queued.filter(event => event.type === 'error')).toHaveLength(0);
      expect(settled).toEqual({ error: 'user closed the card' });
      expect(resolved).toBe('a generated title');
      expect(rig.diagnostics.some(line => line.includes('Session tool completed'))).toBe(true);
      expect(rig.sent).toEqual([]);
    } finally {
      rig.dispose();
    }
  });
});

/**
 * P2.54 — the remaining six, and the escape that ran INSIDE the other belts.
 *
 * P2.41 belted four of ten sync dispatches by hand. The six left over each call
 * a HOST-supplied callback synchronously from `handleLine`, so each one could
 * still take the rest of the stdout chunk with it: `ready`,
 * `ensure_session_ready_result` and `session_id_update` through
 * `onSdkSessionIdUpdate` (plus `markRuntimeHandoffApplied`), `web_search_usage`
 * through `onPiWebSearchUsage`, and `error` + `compact_result` through
 * `onPiContinuationBoundary`.
 *
 * The fix is deliberately NOT a seventh hand-written `try`. Two mechanisms:
 *
 *  1. `safeHostCall` wraps each HOST callback at ITS OWN call site, so the case
 *     body CONTINUES past a throwing host instead of being abandoned part-way.
 *     That is what these rows measure as the fail-closed half — the ready
 *     promise still settles, the preflight and compaction promises still settle,
 *     the handoff still records the fork, and the `error` case still settles
 *     every pending map that follows the boundary call. Clearing state after the
 *     fact could not have reached two of those: `handleEnsureSessionReadyResult`
 *     and `handleCompactResult` both DELETE their correlation entry before the
 *     throwing line, so a belt that ran afterwards would have nothing to find
 *     (the same shape as P2.41's `cancelPendingPermission` residual).
 *  2. `handleLine` itself wraps the whole dispatch, so a case nobody thought
 *     about — including every case added after this one — still cannot eat the
 *     chunk. The last row here drives an unnamed case for exactly that.
 *
 * And M5, the escape that lived inside every belt already: each catch logs
 * through `this.debug`, which calls the HOST's `onDebug`. A throwing one escaped
 * from inside the catch and the tail was lost anyway (measured). `debug()` is
 * now belted at that single site — the one place every belt, old and new, logs
 * through.
 */
/**
 * The startup handshake `case 'ready'` settles; `resolveReady` is the fail-closed
 * half. Shared by the P2.54 and P2.65 blocks, which measure the same strand from
 * two different throw sites.
 */
function armReadyAttempt(agent: PiAgent): { readyResolved: () => boolean } {
  let readyResolved = false;
  const attempt = {
    id: 1,
    cancelled: false,
    readySettled: false,
    startupSettled: false,
    ready: new Promise<void>(() => {}),
    startup: new Promise<void>(() => {}),
    resolveReady: () => { readyResolved = true; },
    rejectReady: () => {},
    resolveStartup: () => {},
    rejectStartup: () => {},
  };
  (agent as any).subprocessAttempt = attempt;
  return { readyResolved: () => readyResolved };
}

describe('PiAgent host-callback dispatches — belted at the source (P2.54)', () => {
  it('a throwing session-id sink on `ready` cannot eat the chunk, and the subprocess still counts as ready', async () => {
    // `onSdkSessionIdUpdate` is HOST-supplied and called synchronously — no stub
    // of our own code. The strand it caused is the expensive half: the throw
    // landed BEFORE `resolveReady()`, so the spawn waited out its whole startup
    // timeout for a subprocess that had already reported itself ready.
    const rig = setupRig({ onSdkSessionIdUpdate: () => { throw new Error('session id sink exploded'); } });
    const ready = armReadyAttempt(rig.agent);
    try {
      await rig.pushChunk(
        { type: 'ready', callbackPort: 4321, sessionId: 'pi-session-ready' },
        { type: 'outside_root_request', requestId: 'belt-ready-tail', canonicalTarget: '/etc/hosts', access: 'read' },
      );

      // The half that matters.
      expect(rig.published.map(request => request.requestId)).toEqual(['belt-ready-tail']);
      // The fail-closed half: the handshake completes. The subprocess IS ready —
      // a host callback failing does not unmake what the subprocess reported.
      expect(ready.readyResolved()).toBe(true);
      expect((rig.agent as any).subprocessAttempt.readySettled).toBe(true);
      // …and everything the case had already recorded stands.
      expect((rig.agent as any).piSessionId).toBe('pi-session-ready');
      expect((rig.agent as any).callbackPort).toBeUndefined(); // F1.710: a stale `ready.callbackPort` is ignored, never stored
      expect(rig.diagnostics.some(line => line.includes('session id sink exploded'))).toBe(true);
    } finally {
      rig.dispose();
    }
  });

  it('a throwing session-id sink on `session_id_update` cannot eat the chunk, and the handoff still records the fork', async () => {
    const applied: Array<string | undefined> = [];
    const rig = setupRig({
      onSdkSessionIdUpdate: () => { throw new Error('session id sink exploded'); },
      markRuntimeHandoffApplied: delivery => { applied.push(delivery); },
    });
    (rig.agent as any).pendingRuntimeHandoff = { kind: 'native-transcript' };
    try {
      await rig.pushChunk(
        { type: 'session_id_update', sessionId: 'pi-session-forked', carriedHistory: true },
        { type: 'outside_root_request', requestId: 'belt-session-tail', canonicalTarget: '/etc/hosts', access: 'read' },
      );

      expect(rig.published.map(request => request.requestId)).toEqual(['belt-session-tail']);
      // The fail-closed half. The read-back arm is the whole point of the
      // message: the subprocess has ALREADY forked the carry session, so leaving
      // the handoff armed would make the next turn re-deliver the same span as
      // text on top of a history Pi already carried.
      expect((rig.agent as any).pendingRuntimeHandoff).toBeNull();
      expect(applied).toEqual(['native-transcript']);
      expect((rig.agent as any).piSessionId).toBe('pi-session-forked');
    } finally {
      rig.dispose();
    }
  });

  it('a throwing handoff marker cannot eat the chunk either', async () => {
    // The second host callback on the same case, and the one whose fail-closed
    // action is "nothing": the local arm is disarmed on the line above it, so a
    // throw here loses only the host's own note of the delivery.
    const rig = setupRig({
      markRuntimeHandoffApplied: () => { throw new Error('handoff marker exploded'); },
    });
    (rig.agent as any).pendingRuntimeHandoff = { kind: 'native-transcript' };
    try {
      await rig.pushChunk(
        { type: 'session_id_update', sessionId: 'pi-session-forked', carriedHistory: true },
        { type: 'outside_root_request', requestId: 'belt-handoff-tail', canonicalTarget: '/etc/hosts', access: 'read' },
      );

      expect(rig.published.map(request => request.requestId)).toEqual(['belt-handoff-tail']);
      expect((rig.agent as any).pendingRuntimeHandoff).toBeNull();
      expect(rig.diagnostics.some(line => line.includes('handoff marker exploded'))).toBe(true);
    } finally {
      rig.dispose();
    }
  });

  it('a throwing web-search usage sink cannot eat the chunk', async () => {
    // Pure notification: the host mirrors the subprocess's absolute count, and
    // there is nothing local to unwind — log and continue is the whole
    // fail-closed action. What a throw used to cost was unrelated traffic.
    const rig = setupRig({ onPiWebSearchUsage: () => { throw new Error('web search mirror exploded'); } });
    try {
      await rig.pushChunk(
        { type: 'web_search_usage', used: 3 },
        { type: 'outside_root_request', requestId: 'belt-search-tail', canonicalTarget: '/etc/hosts', access: 'read' },
      );

      expect(rig.published.map(request => request.requestId)).toEqual(['belt-search-tail']);
      expect(rig.diagnostics.some(line => line.includes('web search mirror exploded'))).toBe(true);
      expect(rig.sent).toEqual([]);
    } finally {
      rig.dispose();
    }
  });

  it('a throwing continuation boundary on the `error` path cannot eat the chunk, and the rest of the case still settles', async () => {
    // The throw source P2.41 used as its own example, on the case it never
    // reached. `finishContinuationBoundary('failed')` sits in the MIDDLE of the
    // `error` case: five pending maps are settled after it, and the visible
    // error row is enqueued after those. A throw there stranded every one of
    // them — commands waiting on a subprocess that had just announced it failed.
    const rig = setupRig({ onPiContinuationBoundary: () => { throw new Error('boundary exploded'); } });
    (rig.agent as any).continuationBoundaryOpen = true;
    let heapdumpRow: unknown = 'unsettled';
    let toggle: unknown = 'unsettled';
    (rig.agent as any).pendingHeapdumps.set('dump-1', {
      resolve: (row: unknown) => { heapdumpRow = row; },
    });
    (rig.agent as any).pendingAutoCompactionToggles.set('toggle-1', {
      resolve: () => {},
      reject: (error: unknown) => { toggle = error; },
    });
    try {
      await rig.pushChunk(
        { type: 'error', message: 'the subprocess gave up' },
        { type: 'outside_root_request', requestId: 'belt-error-tail', canonicalTarget: '/etc/hosts', access: 'read' },
      );

      expect(rig.published.map(request => request.requestId)).toEqual(['belt-error-tail']);
      // The fail-closed half: the case runs to its end past the throwing host.
      expect(heapdumpRow).toEqual({ success: false, errorMessage: 'the subprocess gave up' });
      expect(String((toggle as Error)?.message)).toBe('the subprocess gave up');
      // …including the row that tells the user anything happened at all.
      expect(rig.queued.some(event => event.type === 'error'
        && String((event as { message?: unknown }).message).includes('the subprocess gave up'))).toBe(true);
      expect(rig.diagnostics.some(line => line.includes('boundary exploded'))).toBe(true);
    } finally {
      rig.dispose();
    }
  });

  it('a throwing session-id sink on `ensure_session_ready_result` still settles the preflight promise', async () => {
    // `handleEnsureSessionReadyResult` DELETES the correlation entry, then calls
    // the host, then resolves. A belt that cleaned up afterwards could not have
    // reached this promise — the entry is already gone from the map. Which is
    // why the host call is belted where it is made.
    const rig = setupRig({ onSdkSessionIdUpdate: () => { throw new Error('session id sink exploded'); } });
    let settled: unknown = 'unsettled';
    let rejected: unknown = null;
    (rig.agent as any).pendingEnsureSessionReady.set('preflight-1', {
      resolve: (value: unknown) => { settled = value; },
      reject: (error: unknown) => { rejected = error; },
    });
    try {
      await rig.pushChunk(
        { type: 'ensure_session_ready_result', id: 'preflight-1', sessionId: 'pi-session-preflight' },
        { type: 'outside_root_request', requestId: 'belt-preflight-tail', canonicalTarget: '/etc/hosts', access: 'read' },
      );

      expect(rig.published.map(request => request.requestId)).toEqual(['belt-preflight-tail']);
      // Branch preflight awaits this. Unsettled, it hangs the branched session
      // start with no timeout of its own to fall back on.
      expect(settled).toBe('pi-session-preflight');
      expect(rejected).toBeNull();
    } finally {
      rig.dispose();
    }
  });

  it('a throwing continuation boundary on `compact_result` still settles the compaction promise', async () => {
    // Same delete-then-notify-then-settle shape as the row above, with the
    // boundary callback as the thrower.
    const rig = setupRig({ onPiContinuationBoundary: () => { throw new Error('boundary exploded'); } });
    (rig.agent as any).continuationBoundaryOpen = true;
    let resolved: unknown = 'unsettled';
    let rejected: unknown = null;
    (rig.agent as any).pendingCompactions.set('compact-1', {
      resolve: (value: unknown) => { resolved = value; },
      reject: (error: unknown) => { rejected = error; },
    });
    try {
      await rig.pushChunk(
        {
          type: 'compact_result',
          id: 'compact-1',
          success: true,
          result: { summary: 'the summary', firstKeptEntryId: 'entry-9', tokensBefore: 1200 },
        },
        { type: 'outside_root_request', requestId: 'belt-compact-tail', canonicalTarget: '/etc/hosts', access: 'read' },
      );

      expect(rig.published.map(request => request.requestId)).toEqual(['belt-compact-tail']);
      expect(resolved).toMatchObject({ summary: 'the summary', firstKeptEntryId: 'entry-9', tokensBefore: 1200 });
      expect(rejected).toBeNull();
    } finally {
      rig.dispose();
    }
  });

  it('a throwing host debug sink cannot escape from INSIDE a belt (M5)', async () => {
    // The escape that ran inside every belt P2.41 wrote. Each catch logs the
    // fault through `this.debug` → the HOST's `onDebug`, so a throwing logger
    // escaped from within the catch and the chunk tail was lost exactly as if
    // there had been no belt at all.
    //
    // The rig's own `debug` stub cannot reproduce that, so this row deletes it
    // and drives the real one. The sink throws ONLY on the belt's line: a logger
    // that throws on every line would also break the unrelated tail message,
    // which would prove nothing about where the escape was.
    const rig = setupRig();
    delete (rig.agent as any).debug;
    const logged: string[] = [];
    rig.agent.onDebug = (line: string) => {
      logged.push(line);
      if (line.includes('completion handler exploded')) throw new Error('host logger exploded');
    };
    (rig.agent as any).handleSessionToolCompleted = () => { throw new Error('completion handler exploded'); };
    try {
      await rig.pushChunk(
        { type: 'session_tool_completed', toolName: 'mcp__session__submit_plan', isError: false },
        { type: 'outside_root_request', requestId: 'belt-debug-tail', canonicalTarget: '/etc/hosts', access: 'read' },
      );

      expect(rig.published.map(request => request.requestId)).toEqual(['belt-debug-tail']);
      // The belt did log — the throw came from the host's sink, not from a
      // missing call.
      expect(logged.some(line => line.includes('completion handler exploded'))).toBe(true);
    } finally {
      rig.dispose();
    }
  });

  it('a case nobody belted by hand still cannot eat the chunk', async () => {
    // The structural half, and the reason this task did not write a seventh
    // hand-rolled `try`. `context_usage_result` is NOT one of the ten dispatches
    // anybody belted — it stands in here for every case that exists today
    // unexamined and every case added tomorrow.
    const rig = setupRig();
    (rig.agent as any).handleContextUsageResult = () => { throw new Error('usage handler exploded'); };
    try {
      await rig.pushChunk(
        { type: 'context_usage_result', id: 'usage-1' },
        { type: 'outside_root_request', requestId: 'belt-unnamed-tail', canonicalTarget: '/etc/hosts', access: 'read' },
      );

      expect(rig.published.map(request => request.requestId)).toEqual(['belt-unnamed-tail']);
      expect(rig.diagnostics.some(line => line.includes('usage handler exploded'))).toBe(true);
      // Not silent: an unclassified dispatch fault still gets one visible row.
      const surfaced = rig.queued.filter(event => event.type === 'error');
      expect(surfaced).toHaveLength(1);
      expect(String((surfaced[0] as { message?: unknown }).message)).toContain('usage handler exploded');
    } finally {
      rig.dispose();
    }
  });

  it('a bare `null` line cannot eat the chunk either', async () => {
    // Not a dispatch — the prologue. `handleLine` belted `JSON.parse` back in
    // P2.20, but `null` PARSES, and the `msg.type` read one line later is a
    // `TypeError` outside both belts. Measured on bun 1.3.14:
    // `JSON.parse('null').type` → "TypeError: null is not an object". Found
    // while checking that this task's headline claim — no line of a chunk is
    // lost to a throw — was actually true end to end.
    const rig = setupRig();
    try {
      await rig.pushChunk(
        null as any,
        { type: 'outside_root_request', requestId: 'belt-null-tail', canonicalTarget: '/etc/hosts', access: 'read' },
      );

      expect(rig.published.map(request => request.requestId)).toEqual(['belt-null-tail']);
      expect(rig.diagnostics.some(line => line.includes('Non-object JSONL'))).toBe(true);
      // Nothing to surface: a malformed line is the subprocess's fault, not a
      // dispatch that failed part-way.
      expect(rig.queued.filter(event => event.type === 'error')).toHaveLength(0);
    } finally {
      rig.dispose();
    }
  });

  it('the host-callback belts are inert when nothing throws', async () => {
    // The boundary case for all six: with no fault every callback fires exactly
    // once, with the same arguments, and nothing extra is surfaced or sent.
    const sessionIds: string[] = [];
    const searches: number[] = [];
    const boundaries: string[] = [];
    const applied: Array<string | undefined> = [];
    const rig = setupRig({
      onSdkSessionIdUpdate: id => { sessionIds.push(id); },
      onPiWebSearchUsage: used => { searches.push(used); },
      onPiContinuationBoundary: phase => { boundaries.push(phase); },
      markRuntimeHandoffApplied: delivery => { applied.push(delivery); },
    });
    const ready = armReadyAttempt(rig.agent);
    (rig.agent as any).pendingRuntimeHandoff = { kind: 'native-transcript' };
    (rig.agent as any).continuationBoundaryOpen = true;
    let compaction: unknown = 'unsettled';
    let preflight: unknown = 'unsettled';
    (rig.agent as any).pendingCompactions.set('quiet-compact', {
      resolve: (value: unknown) => { compaction = value; },
      reject: () => {},
    });
    (rig.agent as any).pendingEnsureSessionReady.set('quiet-preflight', {
      resolve: (value: unknown) => { preflight = value; },
      reject: () => {},
    });
    try {
      await rig.pushChunk(
        { type: 'ready', callbackPort: 4321, sessionId: 'pi-session-quiet' },
        { type: 'ensure_session_ready_result', id: 'quiet-preflight', sessionId: 'pi-session-preflight' },
        { type: 'compact_result', id: 'quiet-compact', success: true },
        { type: 'web_search_usage', used: 7 },
        { type: 'session_id_update', sessionId: 'pi-session-final', carriedHistory: true },
      );

      expect(ready.readyResolved()).toBe(true);
      // One per distinct session id: `ready`, then the preflight result, then the
      // update. `handleEnsureSessionReadyResult` notifies only on a CHANGE.
      expect(sessionIds).toEqual(['pi-session-quiet', 'pi-session-preflight', 'pi-session-final']);
      expect(preflight).toBe('pi-session-preflight');
      expect(compaction).toBeNull();
      expect(boundaries).toEqual(['post']);
      expect(searches).toEqual([7]);
      expect(applied).toEqual(['native-transcript']);
      expect((rig.agent as any).pendingRuntimeHandoff).toBeNull();
      expect(rig.queued.filter(event => event.type === 'error')).toHaveLength(0);
      expect(rig.sent).toEqual([]);
    } finally {
      rig.dispose();
    }
  });
});

describe('PiAgent belt catches — the catch itself cannot throw (P2.65)', () => {
  /**
   * P2.54's belts made every DISPATCH survive a throw. Their own catches did
   * not: each one re-rendered two values that a throw can come out of — the
   * message `type` (interpolated a second time, inside the catch) and the
   * caught value itself (`String(error)`). A throw from a catch is not caught
   * by the try it belongs to, so both escaped `handleLine` exactly like the
   * un-belted dispatches used to, and the tail of the chunk was lost with them.
   *
   * Neither shape is producible by today's subprocess protocol — and neither
   * was the bare `null` line P2.54 fixed for the same reason: the belt's value
   * is a STRUCTURAL claim about every case, including the one added tomorrow,
   * and a structural claim with two holes in its own catch is a claim, not a
   * guarantee.
   *
   * Both rows assert the same thing the rest of this file does — THE TAIL
   * ARRIVES — because "no throw escaped" is not observable here (see the file
   * header: bun swallows the listener's exception before any user
   * `uncaughtException` handler runs).
   */

  it('a non-string `type` cannot eat the chunk — the catch reports a label, not the value', async () => {
    // `{"type":{"toString":1}}` is valid JSON. `msg.type` is then an object
    // whose `toString` is not callable, so `${type}` raises "Cannot convert
    // object to primitive value" — TypeScript's `as string` says nothing at
    // runtime. The FIRST interpolation is `default:`'s debug line, inside the
    // belt and caught. The SECOND is the catch's own first debug line, outside
    // every belt: measured on this rig, the tail was gone.
    const rig = setupRig();
    try {
      await rig.pushChunk(
        { type: { toString: 1 } } as any,
        { type: 'outside_root_request', requestId: 'belt-type-tail', canonicalTarget: '/etc/hosts', access: 'read' },
      );

      expect(rig.published.map(request => request.requestId)).toEqual(['belt-type-tail']);
      // The label stands in for the unrenderable value everywhere the catch
      // names the message — debug line and visible row alike.
      expect(rig.diagnostics.some(line => line.includes('Subprocess message (non-string type) could not be dispatched'))).toBe(true);
      const surfaced = rig.queued.filter(event => event.type === 'error');
      expect(surfaced).toHaveLength(1);
      expect(String((surfaced[0] as { message?: unknown }).message)).toContain('(non-string type)');
      // P2.66 — added, not altered: the assertion above passes either way, and
      // what it let through was `A Pi subprocess message ((non-string type))
      // could not be processed` — the sentence's own parentheses around a label
      // that carries its own. The row reads with one pair now.
      // (The detail after the colon is the ENGINE's own wording for the
      // interpolation failure — "No default value" on bun 1.3.14 — so it is
      // deliberately not pinned here.)
      expect(String((surfaced[0] as { message?: unknown }).message)).toContain(
        'A Pi subprocess message (non-string type) could not be processed: ',
      );
    } finally {
      rig.dispose();
    }
  });

  it('a thrown value that cannot be rendered cannot eat the chunk — outer belt', async () => {
    // `String(Object.create(null))` throws: no prototype means no `toString`
    // and no `Symbol.toPrimitive`. The catch's `String(error)` is therefore a
    // throw site of its own, on the one path whose whole job is to absorb one.
    const rig = setupRig();
    (rig.agent as any).handleContextUsageResult = () => { throw Object.create(null); };
    try {
      await rig.pushChunk(
        { type: 'context_usage_result', id: 'usage-unrenderable' },
        { type: 'outside_root_request', requestId: 'belt-unrenderable-tail', canonicalTarget: '/etc/hosts', access: 'read' },
      );

      expect(rig.published.map(request => request.requestId)).toEqual(['belt-unrenderable-tail']);
      expect(rig.diagnostics.some(line => line.includes('Subprocess message context_usage_result could not be dispatched: (unrenderable thrown value)'))).toBe(true);
      // Still surfaced: a fault nobody can render is still a fault, and the
      // row is the only channel a packaged build has.
      const surfaced = rig.queued.filter(event => event.type === 'error');
      expect(surfaced).toHaveLength(1);
      expect(String((surfaced[0] as { message?: unknown }).message)).toContain('(unrenderable thrown value)');
    } finally {
      rig.dispose();
    }
  });

  it('a thrown value that cannot be rendered still lets the case body finish — `safeHostCall`', async () => {
    // The identical shape at the OTHER belt, and a DIFFERENT cost, measured
    // here rather than assumed: `safeHostCall`'s catch throws the same way, but
    // that throw lands in the outer belt one frame up (an ordinary `TypeError`
    // by then, so the outer catch renders it and the chunk survives). What it
    // costs instead is the thing `safeHostCall` exists for — THE REST OF THE
    // CASE. `case 'ready'` calls `resolveReady()` three lines after the sink,
    // so pre-fix the startup handshake never settled and the spawn waited out
    // its whole timeout for a subprocess that had already reported itself
    // ready: P2.54's own headline strand, reopened by its catch.
    const rig = setupRig({ onSdkSessionIdUpdate: () => { throw Object.create(null); } });
    const ready = armReadyAttempt(rig.agent);
    try {
      await rig.pushChunk(
        { type: 'ready', callbackPort: 4321, sessionId: 'pi-session-unrenderable' },
        { type: 'outside_root_request', requestId: 'belt-host-unrenderable-tail', canonicalTarget: '/etc/hosts', access: 'read' },
      );

      expect(ready.readyResolved()).toBe(true);
      expect(rig.published.map(request => request.requestId)).toEqual(['belt-host-unrenderable-tail']);
      // Attributed to the host callback, not laundered into a "message could
      // not be dispatched" by the outer belt catching our own catch.
      expect(rig.diagnostics.some(line => line.includes('Host callback onSdkSessionIdUpdate threw: (unrenderable thrown value)'))).toBe(true);
      const surfaced = rig.queued.filter(event => event.type === 'error');
      expect(surfaced).toHaveLength(1);
      expect(String((surfaced[0] as { message?: unknown }).message)).toBe(
        'A Pi subprocess update could not be delivered to the app (onSdkSessionIdUpdate): (unrenderable thrown value)',
      );
    } finally {
      rig.dispose();
    }
  });

  it('an ordinary type and an ordinary Error still read exactly as they did', async () => {
    // The negative half. The label and the renderer are only allowed to change
    // what was previously UNRENDERABLE: a string `type` and a normal `Error`
    // must produce the same debug line and the same visible row as before, at
    // both belts — stack in the log, message in the row.
    const rig = setupRig({ onPiWebSearchUsage: () => { throw new Error('ordinary host explosion'); } });
    (rig.agent as any).handleContextUsageResult = () => { throw new Error('ordinary dispatch explosion'); };
    try {
      await rig.pushChunk(
        { type: 'context_usage_result', id: 'usage-ordinary' },
        { type: 'web_search_usage', used: 2 },
        { type: 'outside_root_request', requestId: 'belt-ordinary-tail', canonicalTarget: '/etc/hosts', access: 'read' },
      );

      expect(rig.published.map(request => request.requestId)).toEqual(['belt-ordinary-tail']);

      const dispatchLine = rig.diagnostics.find(line => line.startsWith('Subprocess message context_usage_result could not be dispatched: '));
      expect(dispatchLine).toBeDefined();
      // The stack, not the bare message — unchanged from P2.54.
      expect(dispatchLine).toContain('Error: ordinary dispatch explosion');
      expect(dispatchLine).toContain('at ');

      const hostLine = rig.diagnostics.find(line => line.startsWith('Host callback onPiWebSearchUsage threw: '));
      expect(hostLine).toBeDefined();
      expect(hostLine).toContain('Error: ordinary host explosion');
      expect(hostLine).toContain('at ');

      expect(rig.queued.filter(event => event.type === 'error').map(event => (event as { message?: unknown }).message)).toEqual([
        'A Pi subprocess message (context_usage_result) could not be processed: ordinary dispatch explosion',
        'A Pi subprocess update could not be delivered to the app (onPiWebSearchUsage): ordinary host explosion',
      ]);
    } finally {
      rig.dispose();
    }
  });
});

/**
 * P2.66 — the REPORTING side of the belts above.
 *
 * The belts decide that a fault does not cost the chunk. What a user (and a bug
 * report) actually gets out of one is decided in two other places, and both were
 * broken in the direction that hides a fault:
 *
 *  1. The bound was a single LAST-SIGNATURE slot shared by every belt, so two
 *     fault sources alternating reset each other's count and NOTHING was
 *     suppressed. Measured on this rig before the fix: a broken host callback
 *     and a broken event handler over 10 cycles produced **20 error rows** — the
 *     bound never engaged once. It is a `Map<signature, count>` now, so each
 *     signature is bounded on its own and an alternating pair cannot defeat it.
 *
 *  2. `debug()` swallows a throwing HOST `onDebug` (it must — a logger that
 *     throws cannot be allowed to cost the traffic it only describes), which
 *     left a broken sink completely silent forever. It is latched now: the FIRST
 *     swallow surfaces one row, so the fault has a floor even though every
 *     subsequent one is still silent.
 *
 * Both are about a channel of last resort. `surfaceSubprocessFault`'s row is
 * itself dropped downstream when no turn is in flight (`SessionManager`'s
 * `case 'error'` — confirmed still true while writing this), so the debug
 * channel and the row are each other's only backup.
 */
describe('PiAgent dispatch-fault reporting — bounded per signature, with a floor (P2.66)', () => {
  it('alternating host and event faults no longer defeat each other\'s bound', async () => {
    // The measurement this row exists for, as a test. Two DIFFERENT fault
    // sources — a host callback through `safeHostCall` and an event handler
    // through the `event` belt — on the same wire, alternating. With one shared
    // last-signature slot each occurrence looked "new" and every one of the 20
    // was surfaced.
    const rig = setupRig({
      onPiContinuationBoundary: () => { throw new Error('boundary exploded'); },
      onPiWebSearchUsage: () => { throw new Error('web search exploded'); },
    });
    const errorRows = () => rig.queued.filter(event => event.type === 'error').length;
    try {
      for (let cycle = 0; cycle < 10; cycle++) {
        (rig.agent as any).continuationBoundaryOpen = false;
        await rig.pushChunk(
          { type: 'event', event: { type: 'compaction_start' } },
          { type: 'web_search_usage', used: cycle + 1 },
        );
      }

      // Three per SIGNATURE, not three per session and not one per occurrence:
      // the two faults are bounded independently. Pre-fix this was 20.
      expect(errorRows()).toBe(6);
      const messages = rig.queued
        .filter(event => event.type === 'error')
        .map(event => String((event as { message?: unknown }).message));
      expect(messages.filter(message => message.includes('boundary exploded'))).toHaveLength(3);
      expect(messages.filter(message => message.includes('web search exploded'))).toHaveLength(3);
      // Every occurrence is still on the debug channel — the cap suppresses the
      // duplicate ROWS, not the record.
      expect(rig.diagnostics.filter(line => line.includes('boundary exploded'))).toHaveLength(10);
      expect(rig.diagnostics.filter(line => line.includes('web search exploded'))).toHaveLength(10);
    } finally {
      rig.dispose();
    }
  });

  it('a repeating host-callback fault is still capped at the same bound', async () => {
    // The negative half: the fix must not make suppression LOOSER. The identical
    // fault repeating on a live wire is the case the bound exists for, and it
    // still gets three rows out of six occurrences.
    const rig = setupRig({ onPiWebSearchUsage: () => { throw new Error('web search exploded'); } });
    try {
      for (let index = 0; index < 6; index++) {
        await rig.pushChunk({ type: 'web_search_usage', used: index + 1 });
      }

      expect(rig.queued.filter(event => event.type === 'error')).toHaveLength(3);
      expect(rig.diagnostics.filter(line => line.includes('web search exploded'))).toHaveLength(6);
    } finally {
      rig.dispose();
    }
  });

  it('the signature map is bounded — the least-recently-seen signature is evicted', async () => {
    // A map keyed by a string the SUBPROCESS can vary needs a bound of its own,
    // and the varying part here is what a real handler produces: the fault text
    // carries the subprocess-supplied correlation id, so every message mints a
    // new signature.
    const rig = setupRig();
    (rig.agent as any).handleContextUsageResult = (msg: Record<string, unknown>) => {
      throw new Error(`usage handler exploded for ${String(msg.id)}`);
    };
    const errorRows = () => rig.queued.filter(event => event.type === 'error').length;
    const push = (id: string) => rig.pushChunk({ type: 'context_usage_result', id });
    try {
      // One signature, already capped.
      for (let index = 0; index < 4; index++) await push('usage-1');
      expect(errorRows()).toBe(3);

      // 32 further signatures — the last of them overflows the map and evicts
      // the least-recently-seen entry, which is `usage-1`.
      for (let index = 2; index <= 33; index++) await push(`usage-${index}`);
      expect(errorRows()).toBe(35);
      expect((rig.agent as any).subprocessDispatchFaultCounts.size).toBe(32);

      // Evicted, so its allowance starts over — the ONLY observable consequence
      // of the bound, and it errs toward reporting rather than hiding.
      await push('usage-1');
      expect(errorRows()).toBe(36);
      expect((rig.agent as any).subprocessDispatchFaultCounts.size).toBe(32);
    } finally {
      rig.dispose();
    }
  });

  it('a signature longer than the key bound keys the WHOLE signature, and the key is still bounded', async () => {
    // REWRITTEN BY P2.76 (M-4 of this row's own re-review), and the old
    // assertion is worth recording because it pinned the defect: it asserted 3
    // rows and a map of size 1 for six DISTINCT faults, i.e. it certified that
    // five of six distinct faults were hidden. "Tighter, never looser" was true
    // and beside the point — the fault was not deduplicated, it was absent, and
    // `describeThrown` does not truncate so the payload really can be that long.
    //
    // The bound the key exists for is MEMORY, and that is unchanged: at most 32
    // entries, each key at most the 200-char prefix plus a length and a hash. So
    // the key can be bounded AND faithful at once, and a false merge now needs a
    // hash collision instead of a shared 200-character prefix.
    const rig = setupRig();
    let suffix = 0;
    (rig.agent as any).handleContextUsageResult = () => {
      throw new Error(`${'x'.repeat(400)}-${suffix++}`);
    };
    try {
      for (let index = 0; index < 6; index++) {
        await rig.pushChunk({ type: 'context_usage_result', id: `long-${index}` });
      }

      const surfaced = rig.queued.filter(event => event.type === 'error');
      // Six distinct faults, six rows: the five the prefix key used to hide are
      // back. The 3-per-signature allowance and the 32-entry ceiling still bound
      // the volume — see the two rows in the P2.76 block for both directions.
      expect(surfaced).toHaveLength(6);
      const keys: string[] = [...(rig.agent as any).subprocessDispatchFaultCounts.keys()];
      expect(keys).toHaveLength(6);
      // Still bounded, and bounded WELL below the signature it stands for: the
      // suffix is a decimal length plus a base-36 hash, so a 400-char payload
      // cannot buy a 400-char key.
      const longest = Math.max(...keys.map(key => key.length));
      expect(longest).toBeGreaterThan(200);
      expect(longest).toBeLessThan(240);
      // The dedup key is bounded; the user-facing sentence is not.
      expect(String((surfaced[0] as { message?: unknown }).message)).toContain('-0');
      expect(String((surfaced[5] as { message?: unknown }).message)).toContain('-5');
    } finally {
      rig.dispose();
    }
  });

  it('a throwing host debug sink is reported once, not per swallow', async () => {
    // The floor. `debug()` swallows a throwing host sink deliberately (M5), and
    // that made a broken sink indistinguishable from a quiet session forever:
    // every belt in this class reports through it, so a session can lose every
    // diagnostic it has and say nothing at all.
    const rig = setupRig();
    delete (rig.agent as any).debug; // drive the REAL `debug`, whose catch is the swallow
    const logged: string[] = [];
    rig.agent.onDebug = (line: string) => {
      logged.push(line);
      throw new Error('host logger exploded');
    };
    try {
      await rig.pushChunk(
        { type: 'no_such_case_p266', id: 'sink-1' },
        { type: 'no_such_case_p266', id: 'sink-2' },
        { type: 'no_such_case_p266', id: 'sink-3' },
        { type: 'outside_root_request', requestId: 'belt-sink-tail', canonicalTarget: '/etc/hosts', access: 'read' },
      );

      // Unchanged from M5: the swallow still costs nothing downstream.
      expect(rig.published.map(request => request.requestId)).toEqual(['belt-sink-tail']);
      expect(logged.length).toBeGreaterThanOrEqual(3);
      // One row for the sink itself, no matter how many lines it ate.
      const surfaced = rig.queued.filter(event => event.type === 'error');
      expect(surfaced).toHaveLength(1);
      // The sentence claims only what happened. It used to end "…is being
      // dropped for the rest of this session", which the code does not do:
      // `debug()` keeps calling `onDebug` on every line, so a sink that recovers
      // resumes logging while the user had been told it was dead.
      expect(String((surfaced[0] as { message?: unknown }).message)).toBe(
        "A Pi diagnostic line could not be written to the app's log and was dropped (reported once per session): host logger exploded",
      );
    } finally {
      rig.dispose();
    }
  });

  it('the floor row survives the turn reset that used to destroy it', async () => {
    // The floor is worth nothing if the row is wiped before anyone reads it.
    // `EventQueue.reset()` drops the whole queue and runs at the top of every
    // turn, and a swallow with NO TURN IN FLIGHT is the ordinary case here: the
    // subprocess is spawned lazily and four `ensureSubprocess` callers run
    // outside a turn. Measured on the shipped tree before this fix — row
    // enqueued, then wiped, latch spent, **0 rows ever after**.
    //
    // DELIVERY is what is asserted, not enqueueing: the rig's `queued` array is
    // a wrapper on `enqueue` and would have shown the wiped row as present. This
    // row drains the real queue instead.
    const rig = setupRig();
    delete (rig.agent as any).debug;
    rig.agent.onDebug = () => { throw new Error('host logger exploded'); };
    const queue = (rig.agent as any).eventQueue;
    try {
      // A swallow before any turn exists.
      await rig.pushChunk({ type: 'no_such_case_p266', id: 'pre-turn' });
      expect(queue.hasPending).toBe(true);

      // The turn starts — `chatImpl`'s production reset path.
      (rig.agent as any).resetEventQueueForTurn();
      queue.complete();

      const delivered: AgentEvent[] = [];
      for await (const event of queue.drain()) delivered.push(event);
      expect(delivered.filter(event => event.type === 'error').map(event => (event as { message?: unknown }).message)).toEqual([
        "A Pi diagnostic line could not be written to the app's log and was dropped (reported once per session): host logger exploded",
      ]);
    } finally {
      rig.dispose();
    }
  });

  it('the floor row is re-posted until delivered, then never again', async () => {
    // The other half: "carried across a reset" must not become "re-posted
    // forever". The row is spent when the turn's drain loop actually hands it to
    // its consumer, which is what `noteDebugSinkFaultRowDelivered` records.
    const rig = setupRig();
    delete (rig.agent as any).debug;
    rig.agent.onDebug = () => { throw new Error('host logger exploded'); };
    const queue = (rig.agent as any).eventQueue;
    const errorRows = (events: AgentEvent[]) => events.filter(event => event.type === 'error');
    try {
      await rig.pushChunk({ type: 'no_such_case_p266', id: 'pre-turn' });
      const row = (rig.agent as any).pendingDebugSinkFaultRow;
      expect(row).not.toBeNull();

      // Two resets with no delivery in between: still exactly one row waiting,
      // not two.
      (rig.agent as any).resetEventQueueForTurn();
      (rig.agent as any).resetEventQueueForTurn();
      queue.complete();
      const firstTurn: AgentEvent[] = [];
      for await (const event of queue.drain()) firstTurn.push(event);
      expect(errorRows(firstTurn)).toHaveLength(1);

      // The turn hands it to the consumer…
      (rig.agent as any).noteDebugSinkFaultRowDelivered(row);
      expect((rig.agent as any).pendingDebugSinkFaultRow).toBeNull();

      // …so the next turn starts clean, and the latch still holds against a
      // sink that is still broken.
      (rig.agent as any).resetEventQueueForTurn();
      await rig.pushChunk({ type: 'no_such_case_p266', id: 'later' });
      queue.complete();
      const secondTurn: AgentEvent[] = [];
      for await (const event of queue.drain()) secondTurn.push(event);
      expect(errorRows(secondTurn)).toHaveLength(0);
    } finally {
      rig.dispose();
    }
  });

  it('a working debug sink surfaces nothing', async () => {
    // The negative half of the latch: the floor must be invisible to a host
    // whose logger works, on the exact same traffic.
    const rig = setupRig();
    delete (rig.agent as any).debug;
    const logged: string[] = [];
    rig.agent.onDebug = (line: string) => { logged.push(line); };
    try {
      await rig.pushChunk(
        { type: 'no_such_case_p266', id: 'quiet-1' },
        { type: 'no_such_case_p266', id: 'quiet-2' },
        { type: 'outside_root_request', requestId: 'belt-quiet-sink-tail', canonicalTarget: '/etc/hosts', access: 'read' },
      );

      expect(rig.published.map(request => request.requestId)).toEqual(['belt-quiet-sink-tail']);
      expect(logged.length).toBeGreaterThanOrEqual(2);
      expect(rig.queued.filter(event => event.type === 'error')).toHaveLength(0);
    } finally {
      rig.dispose();
    }
  });
});

/**
 * P2.40 — the BLOCKING proxy-tool wire answers on every path, prologue included.
 *
 * `tool_execute_request` is the odd one out in this file, and the difference is
 * worth stating before the rows read as more of the same. Its handler is
 * `async`, so a throw anywhere in it — including the synchronous prologue that
 * runs before the first `await` — becomes a REJECTION rather than an escape
 * from the readline listener. The stdout chunk therefore survives with or
 * without the fix, and the tail assertion the rest of this file leans on is NOT
 * the detector here. It is kept in the first row only, labelled, as a cheap
 * guard against a future edit that makes the dispatch synchronous.
 *
 * What an escape cost instead is the request: `pi-agent-server` suspends the
 * model's tool call on a promise keyed by `requestId` and settles it only on a
 * `tool_execute_response`. Nothing times that out — `pendingToolExecutions`
 * has no timer, and the only other settlers are the turn's own abort and the
 * shutdown sweep — so an unanswered request hangs the tool call for the rest of
 * the turn (`pi-agent-server/src/index.ts` `handleToolExecuteResponse` and the
 * pending it reads). The detector for
 * these rows is the ABSENCE OF A RESPONSE, and each one was run against the
 * reverted handler to confirm it fails that way (recorded per row).
 *
 * The prologue's throw source is real, not hypothetical:
 * `prerequisiteManager.checkPrerequisites` runs the invoked skill's deny list
 * through `matchesToolPattern`, resolves and `existsSync`-es a guide path per
 * matching rule, and calls the HOST-supplied `onDebug` — and it ran ahead of
 * the handler's only `try`.
 *
 * The two control rows below pin the SPLIT the fix depends on: only a fault
 * that got past nobody's decision surfaces a transcript row. A prerequisite
 * block and a routed failure are ordinary answers, and surfacing them would
 * post an error row for every MCP tool that legitimately fails.
 */
describe('PiAgent proxy tool dispatch — the request is always answered (P2.40)', () => {
  it('a throwing prerequisite check still answers the proxy tool call, and the fault is surfaced', async () => {
    const rig = setupRig();
    // The whole manager, replaced: the real one throws only under conditions
    // this rig cannot arrange (a host `onDebug` sink that raises, an fs layer
    // that does), and the row is about the handler's shape, not theirs.
    (rig.agent as any).prerequisiteManager = {
      checkPrerequisites: () => { throw new Error('prereq rule exploded'); },
    };
    try {
      await rig.pushChunk(
        { type: 'tool_execute_request', requestId: 'proxy-prereq-throw', toolName: 'mcp__docs__search', args: { query: 'x' } },
        { type: 'outside_root_request', requestId: 'proxy-prereq-tail', canonicalTarget: '/etc/hosts', access: 'read' },
      );

      // THE detector: pre-fix this array was empty and the subprocess's tool
      // call waited forever (measured — see the block comment above).
      expect(rig.sent).toContainEqual({
        type: 'tool_execute_response',
        requestId: 'proxy-prereq-throw',
        result: { content: 'Pi proxy tool call failed: prereq rule exploded', isError: true },
      });
      // Surfaced, bounded, through the same channel every other dispatch fault
      // uses — a rejection nobody catches is invisible in a packaged build.
      const surfaced = rig.queued.filter(event => event.type === 'error');
      expect(surfaced).toHaveLength(1);
      expect(String((surfaced[0] as { message?: unknown }).message)).toBe(
        'A Pi proxy tool call (mcp__docs__search) could not be dispatched: prereq rule exploded',
      );
      expect(rig.diagnostics.some(line =>
        line.includes('Pi proxy tool mcp__docs__search (proxy-prereq-throw) could not be dispatched'))).toBe(true);
      // Not the detector for this row (an `async` handler rejects rather than
      // unwinding the listener); a guard for the day someone makes it sync.
      expect(rig.published.map(request => request.requestId)).toEqual(['proxy-prereq-tail']);
    } finally {
      rig.dispose();
    }
  });

  it('a prerequisite throw nobody can render still answers', async () => {
    // P2.65's shape on P2.40's wire: `String(Object.create(null))` raises, so a
    // catch that rendered the caught value that way would itself throw — the
    // one place that must not, since it is the last chance the suspended tool
    // call has.
    const rig = setupRig();
    (rig.agent as any).prerequisiteManager = {
      checkPrerequisites: () => { throw Object.create(null); },
    };
    try {
      await rig.pushChunk(
        { type: 'tool_execute_request', requestId: 'proxy-prereq-unrenderable', toolName: 'api_tickets', args: {} },
      );

      expect(rig.sent).toEqual([{
        type: 'tool_execute_response',
        requestId: 'proxy-prereq-unrenderable',
        result: { content: 'Pi proxy tool call failed: (unrenderable thrown value)', isError: true },
      }]);
      const surfaced = rig.queued.filter(event => event.type === 'error');
      expect(surfaced).toHaveLength(1);
      expect(String((surfaced[0] as { message?: unknown }).message)).toContain('(unrenderable thrown value)');
    } finally {
      rig.dispose();
    }
  });

  it('a routed value nobody can render is rendered by the tool-result catch, not the belt', async () => {
    // The INNER catch's own totality, and the row that keeps the two catches
    // distinguishable: a value the tool-result catch renders itself produces
    // `(unrenderable thrown value)` as the RESULT and no transcript row. If
    // that catch went back to `String(error)` it would throw, the outer belt
    // would answer instead, and both assertions below would flip.
    const rig = setupRig();
    // First line of the inner `try`. An accessor is the only seam into it that
    // does not need a whole manifest; the no-op setter is there because
    // `destroy()` assigns `null` to this field on the way out.
    Object.defineProperty(rig.agent, 'activeExecutionManifest', {
      get() { throw Object.create(null); },
      set() {},
      configurable: true,
    });
    try {
      await rig.pushChunk(
        { type: 'tool_execute_request', requestId: 'proxy-route-unrenderable', toolName: 'SubmitPlan', args: {} },
      );

      expect(rig.sent).toEqual([{
        type: 'tool_execute_response',
        requestId: 'proxy-route-unrenderable',
        result: { content: '(unrenderable thrown value)', isError: true },
      }]);
      expect(rig.queued.filter(event => event.type === 'error')).toEqual([]);
    } finally {
      rig.dispose();
    }
  });

  it('a blocked prerequisite still answers with the block reason, and surfaces nothing', async () => {
    // Control: the ordinary refusal the prologue exists for. It is an ANSWER,
    // not a fault — the model reads the reason and retries — so the belt must
    // stay out of its way and no error row may appear.
    const rig = setupRig();
    (rig.agent as any).prerequisiteManager = {
      checkPrerequisites: () => ({ allowed: false, blockReason: 'Read sources/docs/guide.md first, then retry.' }),
    };
    try {
      await rig.pushChunk(
        { type: 'tool_execute_request', requestId: 'proxy-prereq-block', toolName: 'mcp__docs__search', args: { query: 'x' } },
      );

      expect(rig.sent).toEqual([{
        type: 'tool_execute_response',
        requestId: 'proxy-prereq-block',
        result: { content: 'Read sources/docs/guide.md first, then retry.', isError: true },
      }]);
      expect(rig.queued.filter(event => event.type === 'error')).toEqual([]);
      expect(rig.diagnostics.some(line => line.includes('could not be dispatched'))).toBe(false);
    } finally {
      rig.dispose();
    }
  });

  it('a routed failure is still the tool result, not a surfaced fault', async () => {
    // Control for the other side of the split, on the REAL prerequisite manager
    // (`SubmitPlan` matches no rule, so the prologue allows it): this rig has no
    // active execution manifest, so the identity check inside the inner `try`
    // refuses. That is a tool result the model reads, and it must not become an
    // error row.
    const rig = setupRig();
    try {
      await rig.pushChunk(
        { type: 'tool_execute_request', requestId: 'proxy-route-fail', toolName: 'SubmitPlan', args: {} },
      );

      expect(rig.sent).toEqual([{
        type: 'tool_execute_response',
        requestId: 'proxy-route-fail',
        result: { content: 'Pi proxy route is missing active manifest identity', isError: true },
      }]);
      expect(rig.queued.filter(event => event.type === 'error')).toEqual([]);
    } finally {
      rig.dispose();
    }
  });
});

/**
 * P2.73 — the ONE dispatch in `handleLine` with no failure channel at all.
 *
 * `case 'automation_event'` fired `void this.emitAutomationEvent(...)`. Both
 * belts are SYNCHRONOUS, so an async rejection there is caught by neither: it is
 * strictly weaker than the escapes P2.54/P2.65 closed (nothing throws
 * synchronously, so the stdout chunk survives — P2.65's own 36-type sweep
 * confirmed `automation_event` keeps its tail) and strictly worse in one
 * respect. Every other dispatch fault in this class reaches `debug` and a
 * bounded transcript row. This one reached NOTHING: a hook the user configured
 * did not run, and the only trace was an unhandled rejection, which Electron
 * logs without exiting and a packaged build does not log at all outside debug
 * mode.
 *
 * THE DETECTOR here is therefore neither the tail nor a missing response. It is
 * the presence of ANY report — `rig.diagnostics` and `rig.queued`. Pre-fix both
 * are empty for every row below; that is what "invisible to both belts" means
 * as a measurement rather than as a description.
 *
 * The channel is deliberately the EXISTING one. The alternatives were checked
 * rather than assumed: a durable capability-loss record is not reachable from
 * this dispatch (`applyPermissionRequestUpdates`' `deferred` is a function-local
 * array scoped to one hook's permission entries, and a failed emission loses no
 * component), and an install-success payload has no bearing on a per-turn event.
 * So the fault gets a LABEL ON THE EXISTING RECORD — `surfaceSubprocessFault`'s
 * row, named by the event — which buys P2.66's per-signature bound, P2.66's
 * broken-sink floor and P3.22's now-open host-side gates for free.
 */
describe('PiAgent automation_event — an async rejection is reported, not swallowed (P2.73)', () => {
  it('a rejecting automation emission is logged AND surfaced, naming the event', async () => {
    const rig = setupRig();
    // The rig stubs `emitAutomationEvent` to a resolving no-op; a REJECTING one
    // is the whole subject of this row. `Stop` is neither `SessionStart` (an
    // early break) nor on the echo drop list, so it reaches the dispatch.
    (rig.agent as any).emitAutomationEvent = async () => { throw new Error('hook runner exploded'); };
    try {
      await rig.pushChunk(
        { type: 'automation_event', event: 'Stop', input: { hook_event_name: 'Stop' } },
        { type: 'outside_root_request', requestId: 'auto-tail', canonicalTarget: '/etc/hosts', access: 'read' },
      );

      // THE detector: pre-fix BOTH of these were empty. Not "a lost tail" — a
      // lost report.
      expect(rig.diagnostics.some(line =>
        line.includes('Pi automation event Stop could not be delivered: '))).toBe(true);
      const surfaced = rig.queued.filter(event => event.type === 'error');
      expect(surfaced).toHaveLength(1);
      expect(String((surfaced[0] as { message?: unknown }).message)).toBe(
        'A Pi automation event (Stop) could not be delivered: hook runner exploded',
      );
      // Unchanged by the fix, asserted so a future edit cannot pay for the
      // report with the chunk.
      expect(rig.published.map(request => request.requestId)).toEqual(['auto-tail']);
    } finally {
      rig.dispose();
    }
  });

  it('a rejection nobody can render is still reported', async () => {
    // The report path is a REJECTION HANDLER, which is the one place a throw is
    // one more unhandled rejection rather than a caught fault. So it renders
    // through `describeThrown` like every other catch in the class: with
    // `String(error)` there, this row produces no report at all — the same
    // invisibility the fix exists to close, one layer in.
    const rig = setupRig();
    (rig.agent as any).emitAutomationEvent = async () => { throw Object.create(null); };
    try {
      await rig.pushChunk({ type: 'automation_event', event: 'Notification', input: {} });

      const surfaced = rig.queued.filter(event => event.type === 'error');
      expect(surfaced).toHaveLength(1);
      expect(String((surfaced[0] as { message?: unknown }).message)).toBe(
        'A Pi automation event (Notification) could not be delivered: (unrenderable thrown value)',
      );
    } finally {
      rig.dispose();
    }
  });

  it('a non-string event name is labelled, not interpolated', async () => {
    // `msg.event as AutomationAgentEvent` is a compile-time claim about JSON.
    // Unlike `handleLine`'s `type` — whose label is reached only by a throw, and
    // then only for values nothing can render — this name is on a path a
    // renderable non-string genuinely reaches, so the label earns its keep here
    // and only here.
    const rig = setupRig();
    (rig.agent as any).emitAutomationEvent = async () => { throw new Error('no such event'); };
    try {
      await rig.pushChunk(
        { type: 'automation_event', event: { toString: 1 }, input: {} } as any,
        { type: 'outside_root_request', requestId: 'auto-label-tail', canonicalTarget: '/etc/hosts', access: 'read' },
      );

      const surfaced = rig.queued.filter(event => event.type === 'error');
      expect(surfaced).toHaveLength(1);
      expect(String((surfaced[0] as { message?: unknown }).message)).toBe(
        'A Pi automation event ((non-string event)) could not be delivered: no such event',
      );
      expect(rig.published.map(request => request.requestId)).toEqual(['auto-label-tail']);
    } finally {
      rig.dispose();
    }
  });

  it('a successful emission reports nothing, and a dropped echo reports nothing', async () => {
    // Both controls in one row, because both are about the fix staying out of
    // the way. A resolving emission must produce no row (a report on success
    // would put an error row on every hook the user has). And the echo drop
    // list is a DECISION, not a failure — `UserPromptSubmit` is answered by the
    // host gate in `chatImpl`, and re-running it here would fire the user's hook
    // twice for one turn.
    const rig = setupRig();
    const emitted: unknown[] = [];
    (rig.agent as any).emitAutomationEvent = async (event: unknown) => { emitted.push(event); };
    try {
      await rig.pushChunk(
        { type: 'automation_event', event: 'Stop', input: {} },
        { type: 'automation_event', event: 'UserPromptSubmit', input: {} },
      );

      expect(emitted).toEqual(['Stop']);
      expect(rig.queued.filter(event => event.type === 'error')).toEqual([]);
      expect(rig.diagnostics.some(line => line.includes('could not be delivered'))).toBe(false);
      expect(rig.diagnostics.some(line =>
        line.includes('Prompt-gate event UserPromptSubmit was already decided'))).toBe(true);
    } finally {
      rig.dispose();
    }
  });
});

/**
 * P2.76 / P2.96 — the rendering sweep, and what it was actually protecting.
 *
 * P2.65 proved `String(x)` is not total and converted the two belt shapes. The
 * rest of `PiAgent` kept `error instanceof Error ? error.message : String(error)`
 * at 36 more sites, and the row that folded them together was framed as a
 * rendering cleanup. The census says otherwise: at every BLOCKING WIRE the
 * detail is rendered as the ARGUMENT to the send, so an unrenderable thrown
 * value means the catch throws before the answer goes out and the subprocess's
 * suspended call is never answered at all. That is P2.40's strand — measured
 * there as `rig.sent === []` — at seven more sites, on wires the belts keep the
 * CHUNK safe on and cannot keep the RESPONSE safe on.
 *
 * So the detector for these rows is P2.40's, not P2.41's: what the caller
 * observes is the ABSENCE OF A RESPONSE. Each row below was run against the
 * reverted rendering at its own site and recorded failing that way.
 *
 * P2.96's two sites (`process_start_request`, `child_session_request`) are the
 * same class one frame later — their prologues were verified inert by P2.40, and
 * their catches strand the same way — so they live here rather than in a block
 * of their own.
 */
describe('PiAgent thrown-value rendering — a catch cannot strand the answer (P2.76, P2.96)', () => {
  it('an unrenderable ask_user throw still answers the subprocess', async () => {
    const rig = setupRig();
    (rig.agent as any).handleAskUserRequest = () => { throw Object.create(null); };
    try {
      await rig.pushChunk(
        { type: 'ask_user_request', requestId: 'ask-unrenderable', question: 'q', options: [], allowFreeText: true },
      );

      expect(rig.sent).toEqual([{
        type: 'ask_user_response',
        requestId: 'ask-unrenderable',
        error: 'The question could not be put to the user: (unrenderable thrown value)',
      }]);
      // IDENTITY, not just presence: pre-fix the catch threw, `handleLine`'s
      // outer belt caught it, and the fault was laundered into "message
      // ask_user_request could not be dispatched" — a row that names the wrong
      // thing while the request goes unanswered. Asserting the absence of that
      // row is what makes this test fail on the revert rather than pass on a
      // different mechanism.
      expect(rig.diagnostics.some(line =>
        line.includes('Subprocess message ask_user_request could not be dispatched'))).toBe(false);
      expect(rig.diagnostics.some(line =>
        line.includes('AskUser request failed closed for ask-unrenderable'))).toBe(true);
    } finally {
      rig.dispose();
    }
  });

  it('an unrenderable outside-root throw still denies, and still clears the pending', async () => {
    const rig = setupRig();
    (rig.agent as any).handleOutsideRootRequest = () => {
      // The real handler registers the pending BEFORE it publishes, so the
      // stranded entry the catch has to clear is part of the shape.
      (rig.agent as any).pendingPermissions.set('outside-unrenderable', { kind: 'outside_root' });
      throw Object.create(null);
    };
    try {
      await rig.pushChunk(
        { type: 'outside_root_request', requestId: 'outside-unrenderable', canonicalTarget: '/etc/shadow', access: 'write' },
      );

      expect(rig.sent).toEqual([{
        type: 'outside_root_response',
        requestId: 'outside-unrenderable',
        root: null,
      }]);
      // The second half of that catch, which a throw one line earlier skipped:
      // a stranded entry the user could still approve would later grant a
      // session-lifetime root for a request already reported denied.
      expect((rig.agent as any).pendingPermissions.has('outside-unrenderable')).toBe(false);
    } finally {
      rig.dispose();
    }
  });

  it('an unrenderable pre-tool-use rejection still blocks instead of hanging', async () => {
    // The `.catch` on an async dispatch, rather than a sync catch — and the
    // worst of the three, because a throw inside a rejection handler is itself
    // an unhandled rejection: no answer, no log, nothing.
    const rig = setupRig();
    (rig.agent as any).handlePreToolUseRequest = async () => { throw Object.create(null); };
    try {
      await rig.pushChunk(
        { type: 'pre_tool_use_request', requestId: 'pre-unrenderable', toolName: 'Bash', input: { command: 'ls' } },
      );

      expect(rig.sent).toEqual([{
        type: 'pre_tool_use_response',
        requestId: 'pre-unrenderable',
        action: 'block',
        reason: 'The permission check for this tool call failed: (unrenderable thrown value)',
      }]);
    } finally {
      rig.dispose();
    }
  });

  it('an unrenderable mini-completion throw still settles the host promise', async () => {
    // Not a subprocess wire — a HOST promise. `runMiniCompletion` awaits an
    // entry in `pendingMiniCompletions`, and the catch settles it with `null`
    // (the value the timeout and no-subprocess paths already use). Pre-fix the
    // render threw ahead of that line, so a result that had already ARRIVED
    // cost the caller the full `LLM_QUERY_TIMEOUT_MS`.
    const rig = setupRig();
    const settled: Array<string | null> = [];
    (rig.agent as any).pendingMiniCompletions.set('mini-unrenderable', {
      resolve: (value: string | null) => { settled.push(value); },
      reject: () => { settled.push('REJECTED'); },
      timer: undefined,
    });
    (rig.agent as any).handleMiniCompletionResult = () => { throw Object.create(null); };
    try {
      await rig.pushChunk({ type: 'mini_completion_result', id: 'mini-unrenderable', text: 'x' });

      expect(settled).toEqual([null]);
      expect((rig.agent as any).pendingMiniCompletions.has('mini-unrenderable')).toBe(false);
    } finally {
      rig.dispose();
    }
  });

  it('the event belt catch keeps its own attribution and its own dedup signature', async () => {
    // The TENTH site, and the only one inside the belt machinery itself. The
    // chunk was never at risk here (the outer belt caught this catch's throw and
    // P2.66's 36/36 sweep re-proved it). What was lost is that the site whose
    // whole job is to NAME THE FAILING EVENT named nothing: the fault surfaced
    // as `message (event)` and the `event <type>` signature never reached
    // P2.66's per-signature bound, so the bound could not see this site at all.
    const rig = setupRig();
    (rig.agent as any).handleSubprocessEvent = () => { throw Object.create(null); };
    try {
      await rig.pushChunk({ type: 'event', event: { type: 'task_notification' } });

      const surfaced = rig.queued.filter(event => event.type === 'error');
      expect(surfaced).toHaveLength(1);
      expect(String((surfaced[0] as { message?: unknown }).message)).toBe(
        'A Pi subprocess event (task_notification) could not be processed: (unrenderable thrown value)',
      );
      // The identity assertion: pre-fix this said `A Pi subprocess message
      // (event) could not be processed`, which is a DIFFERENT sentence with a
      // different constant prefix, and P3.22's host-side recogniser reads those
      // prefixes.
      expect(String((surfaced[0] as { message?: unknown }).message)).not.toContain('A Pi subprocess message');
      expect(rig.diagnostics.some(line =>
        line.includes('Subprocess event task_notification could not be processed'))).toBe(true);
    } finally {
      rig.dispose();
    }
  });

  it('a fault that diverges only past the 200-character key still gets its own row', async () => {
    // P2.66's re-review (M-4). The key was a bare 200-char PREFIX, so a
    // genuinely distinct fault whose text diverges later shared an allowance and
    // was hidden once three prefix-siblings had spent it — not deduplicated,
    // absent. `describeThrown` does not truncate, so the payload really can be
    // that long.
    //
    // Four faults, three of one shape and one of the other. With the prefix-only
    // key all four collapse onto one allowance and the fourth is suppressed: 3
    // rows. With the length-and-hash suffix the second shape has its own: 4.
    const rig = setupRig();
    const shared = 'p'.repeat(200);
    let suffix = 'A';
    (rig.agent as any).handleSubprocessEvent = () => { throw new Error(`${shared}${suffix}`); };
    try {
      await rig.pushChunk({ type: 'event', event: { type: 'task_notification' } });
      await rig.pushChunk({ type: 'event', event: { type: 'task_notification' } });
      await rig.pushChunk({ type: 'event', event: { type: 'task_notification' } });
      suffix = 'B';
      await rig.pushChunk({ type: 'event', event: { type: 'task_notification' } });

      const surfaced = rig.queued.filter(event => event.type === 'error');
      expect(surfaced).toHaveLength(4);
      expect(String((surfaced[3] as { message?: unknown }).message).endsWith(`${shared}B`)).toBe(true);
    } finally {
      rig.dispose();
    }
  });

  it('the bound still bounds — a repeat past the allowance is still suppressed', async () => {
    // The control for the row above, and the one that stops "give it its own
    // key" from turning into "no bound at all": the same signature four times
    // still surfaces three rows.
    const rig = setupRig();
    const shared = 'q'.repeat(200);
    (rig.agent as any).handleSubprocessEvent = () => { throw new Error(`${shared}same`); };
    try {
      for (let attempt = 0; attempt < 4; attempt += 1) {
        await rig.pushChunk({ type: 'event', event: { type: 'task_notification' } });
      }

      expect(rig.queued.filter(event => event.type === 'error')).toHaveLength(3);
    } finally {
      rig.dispose();
    }
  });

  it('an unrenderable process-start throw still answers the blocking wire (P2.96)', async () => {
    // `process_start_response` is the ONLY settler for this requestId. Pre-fix
    // the catch rendered with `String(error)` and threw before `reply` ran, so
    // WHAT THE CALLER OBSERVED was nothing at all: `sent === []`, the child's
    // process-start call suspended for the rest of the turn behind an unhandled
    // rejection.
    const rig = setupRig({ processSupervisorPort: { start: async () => ({}) } as any });
    (rig.agent as any).resolveActivePluginSkillRuntimeForProcess = () => { throw Object.create(null); };
    try {
      await rig.pushChunk({
        type: 'process_start_request',
        requestId: 'proc-unrenderable',
        request: { profile: 'workspace', command: 'ls', args: [], executionId: 'exec-1' },
      });

      expect(rig.sent).toEqual([{
        type: 'process_start_response',
        requestId: 'proc-unrenderable',
        error: '(unrenderable thrown value)',
      }]);
      // The `finally` still runs on the fixed path, so a cancel arriving later
      // cannot find a controller for a request that is already answered.
      expect((rig.agent as any).pendingProcessStarts.has('proc-unrenderable')).toBe(false);
    } finally {
      rig.dispose();
    }
  });

  it('an unrenderable child-session throw still answers the blocking wire (P2.96)', async () => {
    const rig = setupRig({
      childSessionPort: { start: async () => { throw Object.create(null); } } as any,
    });
    try {
      await rig.pushChunk({
        type: 'child_session_request',
        requestId: 'child-unrenderable',
        request: { operation: 'start', input: { prompt: 'go' } },
      });

      expect(rig.sent).toEqual([{
        type: 'child_session_response',
        requestId: 'child-unrenderable',
        error: '(unrenderable thrown value)',
      }]);
    } finally {
      rig.dispose();
    }
  });

  it('a renderable failure on both blocking wires still reads as before', async () => {
    // Control for the pair above: the sweep must not change what an ORDINARY
    // failure says. `describeThrown` returns `error.message` for an `Error`,
    // which is what the ternary returned, so both replies are byte-identical to
    // the pre-sweep ones.
    const rig = setupRig({
      processSupervisorPort: { start: async () => ({}) } as any,
      childSessionPort: { start: async () => { throw new Error('child port refused'); } } as any,
    });
    (rig.agent as any).resolveActivePluginSkillRuntimeForProcess = () => {
      throw new Error('plugin runtime missing');
    };
    try {
      await rig.pushChunk(
        {
          type: 'process_start_request',
          requestId: 'proc-plain',
          request: { profile: 'workspace', command: 'ls', args: [], executionId: 'exec-2' },
        },
        {
          type: 'child_session_request',
          requestId: 'child-plain',
          request: { operation: 'start', input: { prompt: 'go' } },
        },
      );

      expect(rig.sent).toContainEqual({
        type: 'process_start_response',
        requestId: 'proc-plain',
        error: 'plugin runtime missing',
      });
      expect(rig.sent).toContainEqual({
        type: 'child_session_response',
        requestId: 'child-plain',
        error: 'child port refused',
      });
    } finally {
      rig.dispose();
    }
  });
});
