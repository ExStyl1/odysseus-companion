/**
 * P3.21 · the turn-end conformance bench — the instrument that replaces reading
 * source text with reading the running system.
 *
 * ## The decision this file records
 *
 * P3.21 listed four candidate instruments. Three were measured, and the
 * measurements chose this one.
 *
 * 1. **A type-level door** — "a terminal-event union only `sendTurnEndEvent`
 *    can construct". Refuted with `tsc`: a branded `complete` member rejects a
 *    bare object literal (TS2345, the positive control) and accepts
 *    `{ type: 'complete', sessionId } as SessionEvent` without a murmur. That
 *    cast is not hypothetical — it is the exact spelling of the one real
 *    out-of-door site in the tree today (`handlers/rpc/sessions.ts`, the
 *    post-ack `.catch`). The door would have been defeated by the site it
 *    exists to catch.
 * 2. **An AST / source check over the emit surface** — another static matcher.
 *    P3.16 already measured that class: its source-regex guard caught 1 of 8
 *    ways to spell the same emit, and an AST guard still loses the variable,
 *    the spread and the alias without type-flow analysis.
 * 3. **A choke-point re-entrancy flag inside `sendEvent`** — the cheapest of
 *    the four and NOT subsumed by this file. It is production code in
 *    `SessionManager.ts`, held by another lane. See "What this cannot see",
 *    point 4.
 * 4. **A live conformance bench** (the omnigent reference, Apache-2.0). Its
 *    SHAPE is what this file adopts. Its LIVENESS is what this file rejects:
 *    that bench decides its own mode from credentials and exits `1 if
 *    matrix.has_drift else 0`, so with no gateway creds it runs every probe as
 *    SKIPPED, finds no drift, and exits 0. On our feature branches — no
 *    protected-ref secrets — that is the default run, not the edge case. An
 *    instrument that is green because it measured nothing is precisely P3.21's
 *    boundary (d). This bench drives the REAL code paths in-process instead,
 *    needs no credentials, and asserts that every dimension it claims produced
 *    a concrete verdict.
 *
 * ## What it observes, and why THERE
 *
 * At the transport, not at `SessionManager`'s sink. The renderer-facing event
 * stream has two writers and they converge on one call: the bootstrap wires the
 * manager with `wsServer.push.bind(wsServer)`, and `pushTyped` is a typed
 * wrapper over the same `server.push`. The sweep watches only the first writer,
 * so P3.19's site is invisible to it even on a driven path — boundary (a). One
 * recorder standing in for both writers sees both.
 *
 * The door is read from the STACK: was `sendTurnEndEvent` on it when the event
 * reached the transport. That question has no spellings, so all eight of
 * P3.16's evasion shapes — including the direct `this.eventSink(...)` the sweep
 * also misses — answer it the same way.
 *
 * ## Reconciliation, and why it is symmetric
 *
 * Every observation is reconciled against {@link DECLARED} with the reference's
 * rule: DRIFT when two concrete facts disagree, in EITHER direction. The second
 * direction is what does the work here. A declared emitter that is never
 * observed produces UNKNOWN cells, and {@link unarmedCells} refuses them — so
 * deleting the drive for a declared site turns this file RED rather than green.
 * That is boundary (d) inverted: coverage loss is itself a failure.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { RPC_CHANNELS } from '@nessy-agent/shared/protocol'
import { SESSIONS_DIR } from '@nessy-agent/shared/workspaces'
import type { HandlerDeps } from '../../handlers/handler-deps.ts'
import type { HandlerFn, RequestContext } from '../../transport/types.ts'
import { registerSessionsHandlers } from '../../handlers/rpc/sessions.ts'
import { createManagedSession, type SessionManager } from '../../sessions/SessionManager.ts'
import { createTestSessionManager } from '../../sessions/__tests__/test-session-manager.ts'
import {
  DELTA_BATCH_INTERVAL_MS,
  DELTA_SETTLE_MARGIN_MS,
  TURN_END_DOOR,
  createWireObserver,
  isDoorFrame,
  readWire,
  settleDeltaBatcher,
  instrumentFlushSeam,
  type WireEntry,
  type WireReading,
} from './wire-observer.ts'
import {
  Verdict,
  cell,
  driftCells,
  renderCell,
  unarmedCells,
  type Cell,
  type ProbeResult,
} from './verdict.ts'

// ============================================================
// The declaration. Two entries, because the repo has two writers of
// renderer-facing terminal events and P3.19 is the reason the second one is
// written down rather than fixed away.
// ============================================================

interface EmitterDeclaration {
  /** Does every terminal event from this file pass `sendTurnEndEvent`? */
  door: Verdict
  /**
   * Does the shared flush seam run before every terminal event from this file?
   *
   * Unlike `door`, this is the SAME answer for every writer, which is what
   * makes it the dimension that can police a new out-of-manager emitter.
   */
  flushedFirst: Verdict
  /** Does every turn it ends have streamed first (so the late-delta rule can see it)? */
  turnVisible: Verdict
  why: string
}

const DECLARED: Readonly<Record<string, EmitterDeclaration>> = {
  'packages/server-core/src/sessions/SessionManager.ts': {
    door: Verdict.Supported,
    flushedFirst: Verdict.Supported,
    turnVisible: Verdict.Supported,
    why:
      'P3.16 built the door here and routed all nine of this file’s renderer-facing '
      + 'terminal events through it, so the queued delta is flushed first.',
  },
  'packages/server-core/src/handlers/rpc/sessions.ts': {
    door: Verdict.Unsupported,
    flushedFirst: Verdict.Supported,
    turnVisible: Verdict.Supported,
    why:
      'P3.19, FIXED rather than exempted (`c22139850`). A renderer-facing `complete` still '
      + 'goes straight through `pushTyped`, outside the door and outside the manager’s sink, '
      + 'and it stays there deliberately: `sendTurnEndEvent` broadcasts to the workspace and '
      + 'this report is addressed to one client. What changed is that the site now awaits '
      + '`flushBeforeTurnEndEvent` itself, so `door` is UNSUPPORTED and `flushedFirst` is '
      + 'SUPPORTED — the pair is the whole point of splitting the two dimensions. '
      + '`turnVisible` is SUPPORTED because the row’s original reachability argument was '
      + 'REFUTED by measurement: the post-turn cleanup block in `sendMessage`’s `finally` '
      + 'runs OUTSIDE the chat loop’s non-rethrowing catch and rethrows here, after the '
      + 'model streamed and with text still in the batcher. So the probe below streams '
      + 'before it rejects, because that is the shape the path actually takes.',
  },
}

// ============================================================
// The probes. Each drives a REAL path and returns what the wire showed.
// ============================================================

const managers: SessionManager[] = []

afterAll(() => {
  for (const manager of managers.splice(0)) manager.cleanup()
  rmSync(join(SESSIONS_DIR, 'ws_test'), { recursive: true, force: true })
})

type Internals = {
  processEvent(managed: unknown, event: Record<string, unknown>): Promise<void>
  beginAuthRequest(managed: unknown, request: Record<string, unknown>): Promise<void> | void
  onProcessingStopped(sessionId: string, reason: string, workspaceId?: string): Promise<void>
}

function bindSession(manager: SessionManager, sessionId: string): Record<string, unknown> {
  const managed = createManagedSession({ id: sessionId }, {
    id: 'ws_test', name: 'Test Workspace', rootPath: `/tmp/nessy-${sessionId}`, createdAt: 1,
  } as never, { messagesLoaded: true })
  ;(manager as unknown as { sessions: Map<string, unknown> }).sessions.set(`ws_test:${sessionId}`, managed)
  ;(managed as unknown as { isProcessing: boolean }).isProcessing = true
  ;(managed as unknown as { agent: unknown }).agent = {
    interruptForHandoff: () => undefined, forceAbort: () => undefined, getSessionId: () => undefined,
  }
  return managed as unknown as Record<string, unknown>
}

/** Three real SessionManager turn-ends: an ordinary stop, a user stop, an auth handoff. */
async function driveSessionManagerPaths(observer: ReturnType<typeof createWireObserver>): Promise<void> {
  const manager = createTestSessionManager()
  managers.push(manager)
  manager.setEventSink(observer.sink)
  // The seam is instrumented, not replaced: the production flush still runs.
  instrumentFlushSeam(manager, observer, 'SessionManager.flushBeforeTurnEndEvent')
  const internals = manager as unknown as Internals

  const stopped = bindSession(manager, 'bench-stopped')
  await internals.processEvent(stopped, { type: 'text_delta', text: 'Hello world', turnId: 'X' })
  await internals.onProcessingStopped('bench-stopped', 'complete', 'ws_test')

  const cancelled = bindSession(manager, 'bench-cancel')
  await internals.processEvent(cancelled, { type: 'text_delta', text: 'Hello world', turnId: 'Y' })
  await manager.cancelProcessing('bench-cancel', false, 'ws_test')

  const auth = bindSession(manager, 'bench-auth')
  await internals.processEvent(auth, { type: 'text_delta', text: 'Hello world', turnId: 'Z' })
  await internals.beginAuthRequest(auth, {
    type: 'oauth', provider: 'github', requestId: 'req-bench',
    sessionId: 'bench-auth', sourceSlug: 'github', sourceName: 'GitHub',
  })
}

/**
 * The tenth site, driven for real: the send handler acks, then `sendMessage`
 * rejects. Nothing about this path goes through `SessionManager`'s sink, which
 * is the whole reason it is here.
 */
async function driveRpcPostAckRejection(
  observer: ReturnType<typeof createWireObserver>,
): Promise<void> {
  const handlers = new Map<string, HandlerFn>()
  const server = observer.recordingServer({
    handle(channel, handler) { handlers.set(channel, handler) },
  })
  const deps = {
    sessionManager: {
      waitForInit: async () => {},
      getSessions: () => [],
      resolveStagedAttachments: () => undefined,
      // The stub must OWN this, not merely tolerate its absence: the landed fix
      // awaits it inside a `try` that swallows a throw, so a rig without it
      // would measure a site that never flushed and call the path covered.
      flushBeforeTurnEndEvent: async (sessionId: string) => {
        observer.noteFlush(sessionId, 'rpc/sessions.ts -> flushBeforeTurnEndEvent')
      },
      sendMessage: async (
        sessionId: string, _message: string, _attachments: unknown, _stored: unknown,
        _options: unknown, _a: unknown, _b: unknown, onAck: (id: string) => void,
      ) => {
        onAck('bench-msg-1')
        // The turn streamed before it failed. Not decoration: the P3.19 lane
        // measured that the post-turn cleanup block in `sendMessage`'s
        // `finally` rethrows into this `.catch` AFTER the model streamed, so a
        // probe that never streams would measure the easy half of the path and
        // report the turn as blind.
        observer.sink(
          RPC_CHANNELS.sessions.EVENT,
          { to: 'client', clientId: 'client-bench' },
          { type: 'text_delta', sessionId, delta: 'Hello ', turnId: 'R' } as never,
        )
        throw new Error('post-ack-failure')
      },
    },
    platform: { logger: { info() {}, warn() {}, error() {}, debug() {} } },
    oauthFlowStore: {},
  } as unknown as HandlerDeps
  registerSessionsHandlers(server, deps)
  const handler = handlers.get(RPC_CHANNELS.sessions.SEND_MESSAGE)
  if (!handler) throw new Error('bench rig broken: the send handler did not register')
  const ctx: RequestContext = { clientId: 'client-bench', workspaceId: 'ws_test', webContentsId: null }
  await Promise.resolve(handler(ctx, 'bench-rpc', 'hello')).catch(() => undefined)
}

// ============================================================
// The matrix.
// ============================================================

function probeDoor(reading: WireReading, emitter: string): ProbeResult {
  const mine = reading.terminals.filter(entry => entry.emitter === emitter)
  if (!mine.length) return { verdict: Verdict.Unknown, note: `no terminal event observed from ${emitter}` }
  const outside = mine.filter(entry => !entry.throughDoor)
  return {
    verdict: outside.length ? Verdict.Unsupported : Verdict.Supported,
    note: `${mine.length} terminal event(s), ${outside.length} outside sendTurnEndEvent`,
    detail: { events: mine },
  }
}

function probeFlushedFirst(reading: WireReading, emitter: string): ProbeResult {
  const mine = reading.terminals.filter(entry => entry.emitter === emitter)
  if (!mine.length) return { verdict: Verdict.Unknown, note: `no terminal event observed from ${emitter}` }
  const unflushed = mine.filter(entry => entry.flushedFirst === null)
  return {
    verdict: unflushed.length ? Verdict.Unsupported : Verdict.Supported,
    note: `${mine.length} terminal event(s), ${unflushed.length} with no flush at the shared seam`,
    detail: { seams: [...new Set(mine.map(entry => entry.flushedFirst))] },
  }
}

function probeTurnVisible(reading: WireReading, emitter: string): ProbeResult {
  const mine = reading.terminals.filter(entry => entry.emitter === emitter)
  if (!mine.length) return { verdict: Verdict.Unknown, note: `no terminal event observed from ${emitter}` }
  const blind = mine.filter(entry => entry.blind)
  return {
    verdict: blind.length ? Verdict.Unsupported : Verdict.Supported,
    note: `${blind.length} of ${mine.length} ended a turn that had streamed nothing`,
    detail: { blind },
  }
}

/** Every dimension for every subject the run knows about, declared or observed. */
export function buildMatrix(reading: WireReading): Cell[] {
  const subjects = new Set<string>([...Object.keys(DECLARED), ...reading.emitters])
  const cells: Cell[] = []
  for (const subject of [...subjects].sort()) {
    const declaration = DECLARED[subject]
    if (!declaration) {
      // An emitter nobody wrote down. The registry makes no claim about this
      // file, and it just put a terminal event on the renderer's wire — two
      // concrete facts that disagree, which is the drift rule doing its job on
      // the exact shape P3.21 was opened for.
      cells.push(cell({
        dimension: 'terminal-emitter-declared',
        subject,
        declared: Verdict.NotApplicable,
        observed: {
          verdict: Verdict.Supported,
          note: 'emitted a renderer-facing terminal event but is not in DECLARED',
          detail: { events: reading.terminals.filter(entry => entry.emitter === subject) },
        },
      }))
      continue
    }
    cells.push(cell({
      dimension: 'terminal-emitter-declared',
      subject,
      declared: Verdict.Supported,
      observed: reading.emitters.includes(subject)
        ? { verdict: Verdict.Supported, note: 'declared and observed' }
        : { verdict: Verdict.Unknown, note: 'declared but nothing drove it this run' },
    }))
    cells.push(cell({
      dimension: 'terminal-through-door',
      subject,
      declared: declaration.door,
      observed: probeDoor(reading, subject),
    }))
    cells.push(cell({
      dimension: 'terminal-flushed-first',
      subject,
      declared: declaration.flushedFirst,
      observed: probeFlushedFirst(reading, subject),
    }))
    cells.push(cell({
      dimension: 'turn-visible-to-late-delta-rule',
      subject,
      declared: declaration.turnVisible,
      observed: probeTurnVisible(reading, subject),
    }))
  }
  cells.push(cell({
    dimension: 'no-late-delta-after-turn-end',
    subject: 'every driven path',
    declared: Verdict.Supported,
    observed: reading.terminals.length
      ? {
        verdict: reading.lateDeltas.length ? Verdict.Unsupported : Verdict.Supported,
        note: `${reading.lateDeltas.length} late delta(s) across ${reading.terminals.length} turn end(s)`,
        detail: { lateDeltas: reading.lateDeltas },
      }
      : { verdict: Verdict.Unknown, note: 'no turn ended this run' },
  }))
  return cells
}

const failure = (cells: readonly Cell[]): string[] => cells.map(renderCell)

let reading: WireReading
let matrix: Cell[]
let entries: readonly WireEntry[]

beforeAll(async () => {
  const observer = createWireObserver()
  await driveSessionManagerPaths(observer)
  await driveRpcPostAckRejection(observer)
  // The bench owns the wait rather than trusting each probe to remember it —
  // P3.21's boundary (b). Before the batch timer the late-delta count reads 0
  // whether or not the flush happened.
  await settleDeltaBatcher()
  entries = observer.entries
  reading = readWire(entries)
  matrix = buildMatrix(reading)
})

describe('P3.21 · turn-end conformance', () => {
  it('the bench is ARMED: every dimension it claims produced a concrete verdict', () => {
    // The assertion the reference does not have, and the reason its
    // credential-less run exits 0. A probe that stopped running fails HERE.
    expect(failure(unarmedCells(matrix))).toEqual([])
  })

  it('observed behaviour reconciles with the declaration (no DRIFT)', () => {
    expect(failure(driftCells(matrix))).toEqual([])
  })

  it('it really watched both writers of the renderer-facing wire', () => {
    // Positive control for the whole rig: an absence finding from this bench is
    // only worth something if the bench is looking at both halves of the wire.
    // The sweep in `sessions/__tests__/delta-flush-before-turn-end.test.ts`
    // structurally cannot produce the second entry here.
    expect(reading.emitters).toEqual([
      'packages/server-core/src/handlers/rpc/sessions.ts',
      'packages/server-core/src/sessions/SessionManager.ts',
    ].sort())
    expect(entries.length).toBeGreaterThan(reading.terminals.length)
  })

  it('the out-of-door site is observed as out-of-door, not merely declared so', () => {
    const rpc = reading.terminals.filter(
      entry => entry.emitter === 'packages/server-core/src/handlers/rpc/sessions.ts',
    )
    expect(rpc.map(entry => ({ type: entry.type, throughDoor: entry.throughDoor })))
      .toEqual([{ type: 'complete', throughDoor: false }])
  })
})

// ============================================================
// Positive controls. Each one introduces the defect the bench exists to catch
// and shows the bench reporting DRIFT, so a green run above means "measured
// clean" rather than "measured nothing".
// ============================================================

describe('P3.21 · the bench fires (positive controls)', () => {
  it('a REAL terminal event that bypasses the door drifts', async () => {
    // Not a synthetic wire: `sendTurnEndEvent` is overridden ON THE INSTANCE to
    // emit without flushing — the same technique P3.16's review used, because
    // reverting the source on a shared tree is not available. Everything else
    // is the production path.
    //
    // MEASURED, and it corrected this control's first expectation: on the
    // single-delta shape the late-delta rule stays QUIET. The one queued delta
    // never reached the wire before the `complete`, so the ended turn has no
    // known turnId, and the delta that arrives 50 ms later is indistinguishable
    // from the first delta of a new turn. That is P3.21's boundary (c) firing
    // on the REAL defect rather than on a constructed wire — the sweep in
    // `sessions/__tests__/delta-flush-before-turn-end.test.ts` passes here.
    // What goes red instead is `turn-visible`, a dimension the sweep does not
    // have: a SessionManager turn end that closed a turn which streamed nothing
    // contradicts what SessionManager declares about itself.
    const observer = createWireObserver()
    const manager = createTestSessionManager()
    managers.push(manager)
    manager.setEventSink(observer.sink)
    const internals = manager as unknown as Internals & {
      sendTurnEndEvent(event: unknown, workspaceId: string): Promise<void>
      sendEvent(event: unknown, workspaceId?: string): void
    }
    const managed = bindSession(manager, 'bench-control-door')
    await internals.processEvent(managed, { type: 'text_delta', text: 'Hello world', turnId: 'C' })
    internals.sendTurnEndEvent = async function bypassed(event: unknown, workspaceId: string) {
      this.sendEvent(event, workspaceId)
    }
    await internals.onProcessingStopped('bench-control-door', 'complete', 'ws_test')
    await settleDeltaBatcher()

    const control = readWire(observer.entries)
    expect(control.terminals.map(entry => ({ door: entry.throughDoor, blind: entry.blind })))
      .toEqual([{ door: false, blind: true }])
    expect(driftCells(buildMatrix(control)).map(entry => `${entry.dimension}/${entry.subject}`))
      .toEqual([
        'terminal-through-door/packages/server-core/src/sessions/SessionManager.ts',
        // The seam dimension catches the same bypass INDEPENDENTLY of the door,
        // which is what lets it police an out-of-manager emitter that has no
        // door to go through.
        'terminal-flushed-first/packages/server-core/src/sessions/SessionManager.ts',
        'turn-visible-to-late-delta-rule/packages/server-core/src/sessions/SessionManager.ts',
      ])
  })

  it('a bypass on a turn that ALREADY streamed drifts on the late-delta rule too', async () => {
    // The other half of the same defect, and the shape the late-delta rule was
    // built for: the turn has already put a delta on the wire, so the ended
    // turnId is known and the delta the missing flush stranded is provably
    // LATE rather than merely unattributable.
    const observer = createWireObserver()
    const manager = createTestSessionManager()
    managers.push(manager)
    manager.setEventSink(observer.sink)
    const internals = manager as unknown as Internals & {
      sendTurnEndEvent(event: unknown, workspaceId: string): Promise<void>
      sendEvent(event: unknown, workspaceId?: string): void
    }
    const managed = bindSession(manager, 'bench-control-late')
    await internals.processEvent(managed, { type: 'text_delta', text: 'Hello ', turnId: 'L' })
    await settleDeltaBatcher() // let the batcher deliver the first delta for real
    await internals.processEvent(managed, { type: 'text_delta', text: 'world', turnId: 'L' })
    internals.sendTurnEndEvent = async function bypassed(event: unknown, workspaceId: string) {
      this.sendEvent(event, workspaceId)
    }
    await internals.onProcessingStopped('bench-control-late', 'complete', 'ws_test')
    await settleDeltaBatcher()

    const control = readWire(observer.entries)
    expect(control.lateDeltas.map(entry => entry.delta)).toEqual(['world'])
    expect(driftCells(buildMatrix(control)).map(entry => `${entry.dimension}/${entry.subject}`))
      .toEqual(expect.arrayContaining([
        'terminal-through-door/packages/server-core/src/sessions/SessionManager.ts',
        'no-late-delta-after-turn-end/every driven path',
      ]))
  })

  it('an UNDECLARED emitter drifts — the tenth-site shape', () => {
    const undeclared: WireEntry[] = [
      {
        kind: 'push',
        channel: RPC_CHANNELS.sessions.EVENT,
        target: { to: 'workspace', workspaceId: 'ws_test' },
        event: { type: 'text_delta', sessionId: 's', delta: 'hi', turnId: 'T' } as never,
        emitter: 'packages/server-core/src/sessions/SessionManager.ts',
        emitterFn: 'sendEvent',
        throughDoor: false,
      },
      {
        kind: 'push',
        channel: RPC_CHANNELS.sessions.EVENT,
        target: { to: 'workspace', workspaceId: 'ws_test' },
        event: { type: 'complete', sessionId: 's' } as never,
        emitter: 'packages/server-core/src/some/new/file.ts',
        emitterFn: 'emitComplete',
        throughDoor: false,
      },
    ]
    const drift = driftCells(buildMatrix(readWire(undeclared)))
    expect(drift.map(entry => `${entry.dimension}/${entry.subject}`)).toContain(
      'terminal-emitter-declared/packages/server-core/src/some/new/file.ts',
    )
  })

  it('a DECLARED emitter nobody drove leaves the bench unarmed, and that fails', () => {
    // Boundary (d), inverted into a failure. Delete the drive for a declared
    // site and the bench does not go quiet — it goes red.
    const onlyManager = entries.filter(
      entry => entry.kind !== 'push' || entry.emitter !== 'packages/server-core/src/handlers/rpc/sessions.ts',
    )
    const unarmed = unarmedCells(buildMatrix(readWire(onlyManager)))
    expect(unarmed.map(entry => `${entry.dimension}/${entry.subject}`)).toEqual(
      expect.arrayContaining([
        'terminal-emitter-declared/packages/server-core/src/handlers/rpc/sessions.ts',
        'terminal-through-door/packages/server-core/src/handlers/rpc/sessions.ts',
      ]),
    )
  })

  it('a turn that ends after streaming NOTHING is reported, not silently skipped', () => {
    // Boundary (c). The sweep cannot tell a late delta from a new turn here and
    // passes; the bench names the blind turn end and reconciles it.
    const silent: WireEntry[] = [
      { kind: 'flush', sessionId: 's', via: 'SessionManager.flushBeforeTurnEndEvent' },
      {
        kind: 'push',
        channel: RPC_CHANNELS.sessions.EVENT,
        target: { to: 'workspace', workspaceId: 'ws_test' },
        event: { type: 'complete', sessionId: 's' } as never,
        emitter: 'packages/server-core/src/sessions/SessionManager.ts',
        emitterFn: 'sendEvent',
        throughDoor: true,
      },
    ]
    const control = readWire(silent)
    expect(control.blindTurnEnds).toBe(1)
    expect(driftCells(buildMatrix(control)).map(entry => `${entry.dimension}/${entry.subject}`))
      .toContain('turn-visible-to-late-delta-rule/packages/server-core/src/sessions/SessionManager.ts')
  })
})

// ============================================================
// P2.134 · the bench's own PREMISES, guarded.
//
// Everything above measures behaviour on a rig that injects its recorder at two
// hand-picked seams. That rig is only as good as three claims made ABOUT the
// production wiring, and until this block none of them was asserted anywhere:
//
//  (1) `RPC_CHANNELS.sessions.EVENT` has exactly TWO production writers, and
//      they are the two subjects in `DECLARED`. A third writer — the shape
//      P3.21's review named as the bench's own blind spot — would make the
//      matrix complete and wrong at the same time, because `buildMatrix` can
//      only reconcile emitters something drove.
//  (2) Every host wires the manager's sink to the TRANSPORT push. The design
//      argument for observing at the transport is "two writers, one call"; a
//      host that wired the sink somewhere else would leave the second writer
//      unobserved while the bench still reported it clean.
//  (3) The bench waits LONGER than the production batch interval before it
//      reads the wire. That was a literal 80 against a module-private 50 —
//      boundary (b), re-openable by editing a constant in another file.
//
// These are SOURCE reads, deliberately, and that is not the thing P2.122
// objects to. A grep standing in for a behaviour is the defect; a grep asserting
// that the behaviour has exactly the writers the behavioural rig was pointed at
// is the complement of one — it polices the rig's REACH, which no amount of
// running the rig can do. Every scan below carries a positive control (a token
// known present, found) and a negative control (a token known absent, not
// found), because AGENTS.md makes an absence claim worthless without one.
// ============================================================

const REPO_ROOT = fileURLToPath(new URL('../../../../../', import.meta.url))

/** The production roots the bench's premises are read over. */
const PREMISE_ROOTS = ['packages/server-core/src', 'packages/server/src', 'apps/electron/src/main']

/**
 * Every first-party PRODUCTION `.ts`/`.tsx` under {@link PREMISE_ROOTS} whose
 * text contains `needle` — tests excluded — as repo-relative paths.
 *
 * One `git grep`, not a directory walk (F1.336). The walk read every file of
 * the three roots once per call, five calls per run, and on this rig a cold
 * file open is the cost: the writers case timed out at 31 684 ms inside an
 * 11-file batch (5 000 ms budget, zero assertion failures) and passed alone in
 * 1.0 s straight after. Measured 2026-09-24 over six needles (the five below
 * plus `import`, 160 files): identical sets, the walk 12 491 ms against 182 ms.
 *
 * Why these flags. `-a` searches a file carrying a NUL byte as text, which is
 * why this used to be a `readFileSync` walk — plain grep skips such a file
 * SILENTLY (AGENTS.md), and so would `git grep -I`, so `-I` is never added.
 * `--untracked` keeps the walk's reach over a writer a lane has not committed
 * yet; ignored paths stay out, as the walk's `node_modules`/`dist` skip kept
 * them. `:(glob)` because a bare `**` pathspec is read without glob magic and
 * silently drops files (AGENTS.md). `-z` because a C-quoted path would
 * otherwise come back quoted.
 */
function sourcesContaining(needle: string): string[] {
  const pathspecs = [
    ...PREMISE_ROOTS.flatMap((root) => [`:(glob)${root}/**/*.ts`, `:(glob)${root}/**/*.tsx`]),
    ':(exclude,glob)**/__tests__/**',
    ':(exclude,glob)**/*.test.ts',
    ':(exclude,glob)**/*.test.tsx',
    ':(exclude,glob)**/node_modules/**',
    ':(exclude,glob)**/dist/**',
  ]
  const result = Bun.spawnSync(
    ['git', 'grep', '--untracked', '-z', '-l', '-a', '-F', '-e', needle, '--', ...pathspecs],
    { cwd: REPO_ROOT, stdout: 'pipe', stderr: 'pipe' },
  )
  // 0 = matches, 1 = none; anything else is a broken instrument, never "no writer".
  if (result.exitCode !== 0 && result.exitCode !== 1) {
    throw new Error(`git grep failed (${String(result.exitCode)}): ${result.stderr.toString()}`)
  }
  return result.stdout.toString().split('\0').filter(Boolean).sort()
}

describe('P2.134 · the premises the bench rests on', () => {
  it('the channel has exactly the two production writers the bench declares', () => {
    const writers = sourcesContaining('RPC_CHANNELS.sessions.EVENT')
    // Positive control: the scan reaches real files and the needle is a real
    // needle. A path typo or an empty walk would satisfy the equality below
    // with an empty set on both sides if `DECLARED` were ever emptied too.
    expect(sourcesContaining('RPC_CHANNELS').length).toBeGreaterThan(writers.length)
    // Negative control on the same rig: a needle that cannot be there is not.
    expect(sourcesContaining('nessyNotARealChannelNeedle')).toEqual([])
    expect(writers).toEqual(Object.keys(DECLARED).sort())
  })

  it('every host wires the manager sink to the transport push, at one site', () => {
    // The convergence claim in `wire-observer.ts`'s header, asserted instead of
    // argued. One supplier of the sink...
    const suppliers = sourcesContaining('options.setSessionEventSink(')
    expect(suppliers).toEqual(['packages/server-core/src/bootstrap/headless-start.ts'])
    const bootstrap = readFileSync(join(REPO_ROOT, suppliers[0]!), 'utf8')
    expect(bootstrap).toContain('.push.bind(')
    // ...and every host adapter FORWARDS what it is given, rather than building
    // its own sink. Enumerated rather than named: every mention of the option
    // outside the bootstrap that declares it must be a verbatim forward, so a
    // NEW host that wires the manager somewhere else fails here rather than
    // silently going unobserved — which is the failure this premise guards.
    const FORWARDS = /setSessionEventSink: \((\w+), (\w+)\) => \1\.setEventSink\(\2\)/
    const mentions = sourcesContaining('setSessionEventSink:')
      .filter(file => file !== suppliers[0])
    expect(mentions).toEqual([
      'apps/electron/src/main/index.ts',
      'packages/server/src/index.ts',
    ])
    for (const host of mentions) {
      expect(readFileSync(join(REPO_ROOT, host), 'utf8'), host).toMatch(FORWARDS)
    }
    // Negative control for the regex: it is not a match-anything. The bootstrap
    // mentions the option and does NOT forward it, and must not match.
    expect(bootstrap).not.toMatch(FORWARDS)
  })

  it('the door is matched by identity, not by prefix', () => {
    // P2.134's third item, measured on this runtime rather than assumed: Bun
    // renders a class method's stack frame as the BARE method name — no class
    // prefix — and the match used to be `fn.includes(TURN_END_DOOR)`. So
    // `sendTurnEndEventForClient`, the obvious name for the single-client twin
    // of a method that broadcasts, would have read as through-the-door while
    // bypassing the door entirely: the bench would call a real bypass clean.
    expect(isDoorFrame(TURN_END_DOOR)).toBe(true)
    // V8 spells some frames `Class.method`; both spellings must resolve.
    expect(isDoorFrame(`SessionManager.${TURN_END_DOOR}`)).toBe(true)
    // The mutation this kills, in both directions.
    expect(isDoorFrame(`${TURN_END_DOOR}ForClient`)).toBe(false)
    expect(isDoorFrame(`maybe${TURN_END_DOOR}`)).toBe(false)
    expect(isDoorFrame('sendEvent')).toBe(false)
  })

  it('the bench waits LONGER than the production batch interval, measured', async () => {
    // Boundary (b), closed by coupling rather than by a comment: raising
    // `DELTA_BATCH_INTERVAL_MS` moves the wait with it, because the wait is
    // derived from it. Asserted by CLOCK rather than by re-reading the same two
    // constants the implementation adds — an assertion that only restates the
    // formula would pass against any formula.
    expect(DELTA_SETTLE_MARGIN_MS).toBeGreaterThan(0)
    const started = performance.now()
    await settleDeltaBatcher()
    // `setTimeout` never fires early, so this lower bound is stable; it is the
    // one that matters, and it is the production constant, not a literal.
    expect(performance.now() - started).toBeGreaterThanOrEqual(DELTA_BATCH_INTERVAL_MS)
  })
})
