/**
 * P3.21 · the observation point.
 *
 * ## Why this sits at the transport and not at SessionManager's sink
 *
 * P3.16's wire sweep observes `SessionManager.setEventSink`. That is one of TWO
 * writers of the renderer-facing event stream, and P3.19 is the other:
 * `handlers/rpc/sessions.ts` pushes a `complete` through `pushTyped` on the same
 * channel. Both funnel into ONE call — the headless bootstrap wires the manager
 * with `setSessionEventSink(sessionManager, wsServer.push.bind(wsServer))`
 * (`bootstrap/headless-start.ts`), and `pushTyped` is a thin typed wrapper over
 * `server.push`. `EventSink` and `RpcServer['push']` are the same signature for
 * that reason, which is why one recorder can stand in for both.
 *
 * Observing there is what closes P3.21's boundary (a): a site emitting OUTSIDE
 * the manager's sink, on a path a test DOES drive, is invisible to the sweep by
 * construction and visible here.
 *
 * ## Why the door is read from the STACK and not from the source
 *
 * The question "did this terminal event go through `sendTurnEndEvent`?" has
 * exactly one honest answer at runtime: was that frame on the stack when the
 * event reached the transport. P3.16 measured a source-text guard against eight
 * ways of spelling the same emit and it caught ONE. A stack frame has no
 * spellings — object literal, reordered keys, a comment, other quotes, a
 * variable, a spread, an aliased send, or a direct `this.eventSink(...)` that
 * never touches `sendEvent` all produce the same frames.
 *
 * Measured before relying on it (Bun 1.x / JSC): an `async` method's own frame
 * SURVIVES its `await`, so `sendTurnEndEvent`'s frame is present at push time
 * even though it awaits `flushDelta` first. The frames ABOVE it are not, which
 * is why the door is matched by name anywhere in the stack rather than by the
 * immediate caller.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { RPC_CHANNELS, type SessionEvent } from '@nessy-agent/shared/protocol'
import type { PushTarget } from '@nessy-agent/shared/protocol'
import type { EventSink, RpcServer } from '../../transport/types.ts'

/** The full door: flush, then send. Only reachable from inside `SessionManager`. */
export const TURN_END_DOOR = 'sendTurnEndEvent'

/**
 * The flush half, and the ONLY seam both writers of the wire share.
 *
 * P3.19 landed as a fix rather than an exemption (`c22139850`): the RPC send
 * handler's post-ack `.catch` cannot use the door — `sendTurnEndEvent`
 * broadcasts to the workspace and that report is addressed to one client — so
 * it awaits this method explicitly instead. `sendTurnEndEvent` awaits the same
 * method (`SessionManager.ts:23956`), which makes it the first invariant that
 * spans BOTH writers.
 *
 * That matters for what the bench can police. `terminal-through-door` cannot
 * constrain an out-of-manager emitter, because such an emitter legitimately
 * declares UNSUPPORTED there. `terminal-flushed-first` constrains everyone: a
 * NEW site outside `SessionManager` that forgets the flush drifts, and that is
 * the boundary-(a) shape the sweep structurally cannot reach.
 *
 * It is observed by INSTRUMENTING the seam, not by reading the stack: the call
 * is awaited and has returned by the time the event reaches the transport, so
 * its frame is gone. `sendTurnEndEvent`'s own async frame survives its await
 * (measured), which is why the door is still stack-read.
 */
export const TURN_END_FLUSH_SEAM = 'flushBeforeTurnEndEvent'

const REPO_ROOT = new URL('../../../../../', import.meta.url).pathname
const THIS_FILE = new URL(import.meta.url).pathname

/**
 * Frames that are the transport itself rather than an emitter.
 *
 * `pushTyped` is a one-line typed wrapper over `server.push`; attributing an
 * emit to it would name the wrapper on every out-of-manager site and collapse
 * them all onto one subject. Skipping it attributes the emit to the file that
 * actually built the event.
 */
const TRANSPORT_FRAMES: readonly string[] = ['/src/transport/push.ts']

export interface ObservedPush {
  channel: string
  target: PushTarget
  event: SessionEvent
  /**
   * Repo-relative FILE of the innermost first-party frame.
   *
   * File, not `file#function`, and the choice is load-bearing in both
   * directions. A function name is unstable exactly where it matters — the one
   * out-of-door site today is an arrow inside a `.catch`, which Bun renders
   * `<anonymous>` — and it is redundant where it is stable, because a new
   * method inside `SessionManager` that bypasses the door is caught by
   * {@link ObservedPush.throughDoor}, not by its name. The function is kept in
   * {@link ObservedPush.emitterFn} for the failure message only.
   */
  emitter: string
  /** The frame's function name. Diagnostic; never reconciled against. */
  emitterFn: string
  /** Whether {@link TURN_END_DOOR} appears anywhere in the captured stack. */
  throughDoor: boolean
}

/** `at name (file:line:col)` / `at file:line:col`, Bun and V8 alike. */
const FRAME = /^\s*at\s+(?:(?<fn>[^(]+?)\s+\()?(?<file>\/[^):]+):\d+:\d+\)?$/

/**
 * Is this frame the door itself, rather than a name that merely starts like it?
 *
 * P2.134's third item. The match used to be `fn.includes(TURN_END_DOOR)`, so a
 * future `sendTurnEndEventForClient` — the obvious name for the single-client
 * twin of a method that broadcasts — would have read as through-the-door while
 * bypassing it. Measured on this runtime rather than assumed: Bun renders a
 * class method's frame as the BARE method name (`sendTurnEndEvent`, no class
 * prefix), and `'sendTurnEndEventForClient'.includes('sendTurnEndEvent')` is
 * true. So the comparison is by identity, on the last dot-segment (V8 spells
 * some frames `Class.method`; Bun does not, and both survive the strip).
 */
export const isDoorFrame = (fn: string): boolean => fn.slice(fn.lastIndexOf('.') + 1) === TURN_END_DOOR

interface Frame { fn: string; file: string }

function parseFrames(stack: string): Frame[] {
  const frames: Frame[] = []
  for (const line of stack.split('\n')) {
    const match = FRAME.exec(line)
    if (!match?.groups) continue
    // `file` is a named capture like `fn`, so it is `string | undefined` for the
    // same reason and needs the same default — a frame with no file is a frame,
    // and dropping it would silently shorten the stack this observer reports.
    frames.push({
      fn: (match.groups.fn ?? '<top>').trim(),
      file: match.groups.file ?? '<unknown>',
    })
  }
  return frames
}

function emitterOf(frames: readonly Frame[]): { file: string; fn: string } {
  for (const frame of frames) {
    if (frame.file === THIS_FILE) continue
    if (!frame.file.startsWith(REPO_ROOT)) continue
    if (frame.file.includes('/node_modules/')) continue
    if (TRANSPORT_FRAMES.some(suffix => frame.file.endsWith(suffix))) continue
    return { file: frame.file.slice(REPO_ROOT.length), fn: frame.fn }
  }
  return { file: '<unattributable>', fn: '<unattributable>' }
}

/** A flush observed at the shared seam, ordered against the pushes. */
export interface ObservedFlush {
  sessionId: string
  /** Who called it — the instrumented manager, or a test-owned caller. */
  via: string
}

/** The ordered log: pushes and flushes interleaved as they happened. */
export type WireEntry =
  | ({ kind: 'push' } & ObservedPush)
  | ({ kind: 'flush' } & ObservedFlush)

export interface WireObserver {
  /**
   * Usable as a `SessionManager` event sink AND as an `RpcServer.push`. One
   * recorder, both writers — that identity is the whole design.
   */
  readonly sink: EventSink
  /** An `RpcServer` whose `push` is {@link sink}; everything else delegates. */
  recordingServer(base?: Partial<RpcServer>): RpcServer
  /** Pushes and flushes, interleaved in the order they happened. */
  readonly entries: readonly WireEntry[]
  /** Just the pushes, for probes that only care about the wire. */
  readonly pushes: readonly ObservedPush[]
  /**
   * Record a flush at the shared seam. Call it from a stubbed session manager;
   * {@link instrumentFlushSeam} does it for a real one.
   */
  noteFlush(sessionId: string, via: string): void
  reset(): void
}

export function createWireObserver(): WireObserver {
  const entries: WireEntry[] = []
  const sink: EventSink = (channel, target, ...args) => {
    if (channel !== RPC_CHANNELS.sessions.EVENT) return
    const frames = parseFrames(new Error().stack ?? '')
    const origin = emitterOf(frames)
    entries.push({
      kind: 'push',
      channel,
      target,
      event: args[0] as SessionEvent,
      emitter: origin.file,
      emitterFn: origin.fn,
      throughDoor: frames.some(frame => isDoorFrame(frame.fn)),
    })
  }
  return {
    sink,
    entries,
    get pushes() { return entries.filter((e): e is { kind: 'push' } & ObservedPush => e.kind === 'push') },
    noteFlush(sessionId: string, via: string) { entries.push({ kind: 'flush', sessionId, via }) },
    reset() { entries.length = 0 },
    recordingServer(base: Partial<RpcServer> = {}): RpcServer {
      return {
        handle() {},
        async invokeClient() {},
        hasClientCapability() { return false },
        findClientsWithCapability() { return [] },
        ...base,
        push: sink,
      }
    },
  }
}

const TERMINAL_TYPES: ReadonlySet<string> = new Set(['complete', 'interrupted'])

export const isTerminal = (event: SessionEvent): boolean => TERMINAL_TYPES.has(event.type)

export interface LateDelta { sessionId: string; after: string; turnId: unknown; delta: unknown }

export interface WireReading {
  /** Terminal events seen, with the door verdict and emitter for each. */
  terminals: Array<{
    sessionId: string
    type: string
    emitter: string
    emitterFn: string
    throughDoor: boolean
    /**
     * Who ran the shared flush seam for this session before this event reached
     * the transport, or `null` if nobody did. The one invariant both writers
     * share, so it is the only dimension that can police a NEW out-of-manager
     * emitter.
     */
    flushedFirst: string | null
    /**
     * This terminal event closed a turn that had streamed NOTHING, so the
     * late-delta property is BLIND for it — P3.21's boundary (c). Carried per
     * event rather than as one counter so a caller can reconcile it against
     * what each emitter DECLARES about itself.
     */
    blind: boolean
  }>
  /**
   * Distinct emitters of terminal events, as repo-relative FILES.
   *
   * File only — the same choice {@link ObservedPush.emitter} argues for 130
   * lines above, and this line used to say `file#function`, contradicting it.
   * The subjects of {@link WireReading.terminals} are these strings, so the
   * bench's DECLARED registry is keyed by file too; adding the function here
   * would split one declared subject into one subject per method.
   */
  emitters: string[]
  /** A delta carrying the turnId a terminal event had just closed. */
  lateDeltas: LateDelta[]
  /**
   * Terminal events that closed a turn which had streamed NOTHING.
   *
   * P3.21's boundary (c): with no streaming turnId to key on, a later delta is
   * indistinguishable from a new turn, so the late-delta property is BLIND for
   * that turn. The sweep passes silently in this state. Here it is counted, so
   * a caller can refuse to call the dimension measured.
   */
  blindTurnEnds: number
}

/**
 * Read the recorded wire.
 *
 * The late-delta rule discriminates BY TURN, for the reason P3.16's review
 * measured: "any delta after any complete" reports an ordinary second turn as a
 * violation, and the natural repair for that false alarm disarms the instrument.
 * Deltas carry `turnId`; terminal events do not, so the closed turn is the one
 * that was streaming when the terminal event went out.
 */
export function readWire(entries: readonly WireEntry[]): WireReading {
  const streaming = new Map<string, unknown>()
  const ended = new Map<string, { turnId: unknown; after: string }>()
  /** Per session: a flush was seen at the shared seam and not yet consumed. */
  const flushPending = new Map<string, string>()
  const terminals: WireReading['terminals'] = []
  const lateDeltas: LateDelta[] = []
  const emitters = new Set<string>()
  let blindTurnEnds = 0

  for (const entry of entries) {
    if (entry.kind === 'flush') {
      flushPending.set(entry.sessionId, entry.via)
      continue
    }
    const push = entry
    const event = push.event
    const sessionId = (event as { sessionId?: string }).sessionId
    if (!sessionId) continue
    if (isTerminal(event)) {
      const turnId = streaming.get(sessionId)
      const blind = turnId === undefined
      if (blind) blindTurnEnds += 1
      ended.set(sessionId, { turnId, after: event.type })
      streaming.delete(sessionId)
      terminals.push({
        sessionId,
        type: event.type,
        emitter: push.emitter,
        emitterFn: push.emitterFn,
        throughDoor: push.throughDoor,
        flushedFirst: flushPending.get(sessionId) ?? null,
        blind,
      })
      flushPending.delete(sessionId)
      emitters.add(push.emitter)
      continue
    }
    if (event.type !== 'text_delta' && event.type !== 'text_complete') continue
    const turnId = (event as { turnId?: unknown }).turnId
    const closed = ended.get(sessionId)
    if (event.type === 'text_delta' && closed && turnId === closed.turnId) {
      lateDeltas.push({ sessionId, after: closed.after, turnId, delta: (event as { delta?: unknown }).delta })
      continue
    }
    if (closed) ended.delete(sessionId)
    streaming.set(sessionId, turnId)
  }

  return { terminals, emitters: [...emitters].sort(), lateDeltas, blindTurnEnds }
}

/**
 * Wrap a real `SessionManager`'s flush seam so its calls land in the observer's
 * log, then delegate to the original. The production method still runs — this
 * records that it ran, it does not replace it.
 */
export function instrumentFlushSeam(manager: object, observer: WireObserver, via: string): void {
  const target = manager as Record<string, unknown>
  const original = target[TURN_END_FLUSH_SEAM]
  if (typeof original !== 'function') {
    throw new Error(`bench rig broken: ${via} has no ${TURN_END_FLUSH_SEAM}`)
  }
  target[TURN_END_FLUSH_SEAM] = async function instrumented(this: unknown, sessionId: string, workspaceId: string) {
    observer.noteFlush(sessionId, via)
    return (original as (s: string, w: string) => Promise<void>).call(this, sessionId, workspaceId)
  }
}

/**
 * The PRODUCTION batch interval, read from the module that owns it.
 *
 * P2.134's second item. `settleDeltaBatcher` used to wait a literal 80 ms
 * against a module-private `DELTA_BATCH_INTERVAL_MS = 50` that nothing coupled
 * it to, so raising the production constant past 80 would have reopened P3.21's
 * boundary (b) SILENTLY: the bench reads the wire before the batcher delivers,
 * sees no late delta, and passes.
 *
 * The obvious repair is to export the constant. It is not taken here for a
 * measured reason rather than a stylistic one: `SessionManager.ts` is a file
 * other work is live in, and AGENTS.md records that `git commit <pathspec>`
 * takes the file's WORKING-TREE state rather than your hunks — so a one-line
 * export lands whatever else is mid-edit in that file. The coupling is made at
 * the seam this file already owns instead.
 *
 * It is a source read, and it is the kind that is honest: the number IS the
 * source text, not a behaviour a token is standing in for. A rename or a
 * refactor makes it THROW at import — the rig announces that it can no longer
 * measure, which is the one thing P3.21's boundary (d) says an instrument must
 * never do quietly.
 */
export const DELTA_BATCH_INTERVAL_MS = (() => {
  const source = readFileSync(
    fileURLToPath(new URL('../../sessions/SessionManager.ts', import.meta.url)),
    'utf8',
  )
  const match = /\bconst DELTA_BATCH_INTERVAL_MS = (\d+)\b/.exec(source)
  if (!match) {
    throw new Error(
      'bench rig broken: SessionManager.ts no longer declares DELTA_BATCH_INTERVAL_MS — '
      + 'the turn-end bench cannot size its settle margin, and a guessed one reopens P3.21 boundary (b)',
    )
  }
  return Number(match[1])
})()

/**
 * How much longer than one batch interval the bench waits before reading.
 *
 * A margin, not a timeout: the timer has already fired by then, and the extra
 * is scheduling slack. Kept above zero deliberately — AGENTS.md records that a
 * narrowing knob sized against zero instead of against the system's resting
 * state manufactures its own failure.
 */
export const DELTA_SETTLE_MARGIN_MS = 30

/**
 * Wait past `DELTA_BATCH_INTERVAL_MS` so a delta the flush missed has been
 * delivered by its timer before the wire is read.
 *
 * P3.21's boundary (b): the sweep's sensitivity is time-bounded and it trusts
 * each row to wait — 0 violations before the timer, 1 after — so a row that
 * forgets is silently unswept. The bench owns this instead of delegating it.
 *
 * P2.134's second item: the wait used to be the literal `80`, written against a
 * module-private `DELTA_BATCH_INTERVAL_MS = 50` that nothing coupled it to.
 * Raising the production constant past 80 would have reopened boundary (b)
 * SILENTLY. It is now DERIVED from {@link DELTA_BATCH_INTERVAL_MS}, which is
 * read from the production module itself and throws when it cannot be found.
 */
export const settleDeltaBatcher = (): Promise<void> =>
  new Promise(resolve => { setTimeout(resolve, DELTA_BATCH_INTERVAL_MS + DELTA_SETTLE_MARGIN_MS) })
