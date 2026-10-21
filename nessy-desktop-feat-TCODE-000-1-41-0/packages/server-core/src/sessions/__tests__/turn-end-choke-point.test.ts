/**
 * P3.21 · the choke-point check — the instrument that fires on a path NOTHING
 * DRIVES.
 *
 * This row's history is the reason the shape matters. P3.16 shipped a
 * source-text guard over the terminal-emit surface; review measured it at 1 of 8
 * evasion shapes and it was deleted. Of the four replacements the row listed, two
 * were then refuted by measurement — a type-level door compiles clean on the
 * literal `{ type: 'complete', … } as SessionEvent`, which is the exact spelling
 * of the one out-of-class site, and a literal port of the reference bench is
 * GREEN when it measures nothing. What shipped was a conformance bench observing
 * at the transport (`__tests__/conformance/turn-end-conformance.test.ts`), whose
 * own stated remainder is the whole of this file's subject:
 *
 *   > the bench fires on DRIVEN paths only, so a site on a path nothing drives
 *   > is still uncaught — the choke-point check is NOT subsumed.
 *
 * So the check lives in production code, in `sendEvent`, and it is asserted here
 * through the LOG it writes, because log-only is the deliberate posture: a turn
 * ending is the last thing a user waits for, and turning this into a refusal
 * would trade "the renderer may show a duplicated bubble" for "the turn never
 * ends".
 *
 * The four rows below are the four states, and the last two are the ones that
 * make the instrument trustworthy rather than merely loud: a correctly doored
 * turn must be SILENT, and a manager on which the check was never armed must say
 * so instead of passing. Amendments (b) and (d) of this row both name
 * "instrument silently disarmed" as the harder failure than "instrument wrong",
 * which is why the unarmed state is a case and not a comment.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { SESSIONS_DIR } from '@nessy-agent/shared/workspaces'
import type { SessionEvent } from '@nessy-agent/shared/protocol'
import { createHeadlessPlatform } from '../../runtime/platform-headless.ts'
import { createManagedSession, setSessionPlatform, SessionManager } from '../SessionManager.ts'
import { createTestSessionManager } from './test-session-manager.ts'

/** Everything `sessionLog` was asked to warn about, in order. */
const warnings: string[] = []

beforeAll(() => {
  const platform = createHeadlessPlatform()
  setSessionPlatform({
    ...platform,
    logger: {
      ...platform.logger,
      warn: (...args: unknown[]) => { warnings.push(args.map(String).join(' ')) },
    },
  })
})

afterAll(() => {
  // Left on the headless platform, which is what every other `setSessionPlatform`
  // caller in this package leaves behind. There is no getter for the previous
  // value, so restoring the exact prior logger is not available.
  setSessionPlatform(createHeadlessPlatform())
})

const managers: SessionManager[] = []
afterEach(() => {
  warnings.length = 0
  for (const manager of managers.splice(0)) manager.cleanup()
  rmSync(join(SESSIONS_DIR, 'ws_test'), { recursive: true, force: true })
})

type Internals = {
  sessions: Map<string, unknown>
  sendEvent(event: SessionEvent, workspaceId?: string): void
  onProcessingStopped(sessionId: string, reason: string, workspaceId?: string): Promise<void>
}

function setUp(sessionId: string) {
  const manager = createTestSessionManager()
  managers.push(manager)
  const sent: SessionEvent[] = []
  manager.setEventSink((_channel, _target, event) => { sent.push(event as SessionEvent) })
  const managed = createManagedSession({ id: sessionId }, {
    id: 'ws_test',
    name: 'Test Workspace',
    rootPath: `/tmp/nessy-${sessionId}`,
    createdAt: 1,
  } as never, { messagesLoaded: true })
  ;(manager as unknown as Internals).sessions.set(`ws_test:${sessionId}`, managed)
  return { manager, managed, sent, internals: manager as unknown as Internals }
}

const bypassed = () => warnings.filter(line => line.includes('Turn-end door BYPASSED'))
const unarmed = () => warnings.filter(line => line.includes('Turn-end door check is UNARMED'))

describe('P3.21 · a terminal event that skipped the door is named, on any path that runs', () => {
  it('flags an emit that never went through the door', () => {
    // The tenth-site shape, and the one no bench can see: this call is not on
    // any test-driven production path — it IS the undriven path.
    const { internals } = setUp('p321-bypass')
    internals.sendEvent({ type: 'complete', sessionId: 'p321-bypass' } as SessionEvent, 'ws_test')
    expect(bypassed()).toHaveLength(1)
    expect(bypassed()[0]).toContain('p321-bypass')
    expect(bypassed()[0]).toContain('"complete"')
  })

  it('flags `interrupted` too, not only `complete`', () => {
    // The user-stop path has the identical split (`handleInterrupted` clears the
    // same pair), so an instrument that watched only `complete` would be blind
    // to half the defect.
    const { internals } = setUp('p321-interrupted')
    internals.sendEvent({ type: 'interrupted', sessionId: 'p321-interrupted' } as SessionEvent, 'ws_test')
    expect(bypassed()).toHaveLength(1)
    expect(bypassed()[0]).toContain('"interrupted"')
  })

  it('stays SILENT on a turn routed through the real door — the false-positive control', async () => {
    // An instrument that flags everything is as useless as one that flags
    // nothing. Same event, same session, reached through the production path.
    const { sent, internals } = setUp('p321-clean')
    await internals.onProcessingStopped('p321-clean', 'complete', 'ws_test')
    expect(sent.map(event => event.type)).toContain('complete')
    expect(bypassed()).toEqual([])
  })

  it('counts the out-of-class flush ONCE, then bites again', async () => {
    // `handlers/rpc/sessions.ts`'s post-persist error arm awaits
    // `flushBeforeTurnEndEvent` and then pushes to one client with `pushTyped`,
    // so its ticket is never spent by `sendEvent`. That excuses exactly one
    // later undoored emit for that session — a bounded false negative, pinned
    // here so it is a known cost rather than a surprise — and the NEXT one is
    // caught.
    const { manager, internals } = setUp('p321-rpc')
    await manager.flushBeforeTurnEndEvent('p321-rpc', 'ws_test')
    internals.sendEvent({ type: 'complete', sessionId: 'p321-rpc' } as SessionEvent, 'ws_test')
    expect(bypassed()).toEqual([])
    internals.sendEvent({ type: 'complete', sessionId: 'p321-rpc' } as SessionEvent, 'ws_test')
    expect(bypassed()).toHaveLength(1)
  })

  it('a ticket is spent by its OWN session and no other', async () => {
    // The ticket set is keyed by session, so one session passing the door must
    // not excuse another's bypass. Without the key this row is green anyway,
    // which is why it asserts the ticket is still spendable afterwards.
    const { manager, internals } = setUp('p321-owner')
    setUp('p321-other')
    await manager.flushBeforeTurnEndEvent('p321-owner', 'ws_test')
    internals.sendEvent({ type: 'complete', sessionId: 'p321-other' } as SessionEvent, 'ws_test')
    expect(bypassed()).toHaveLength(1)
    internals.sendEvent({ type: 'complete', sessionId: 'p321-owner' } as SessionEvent, 'ws_test')
    expect(bypassed()).toHaveLength(1)
  })

  it('says so, once, when the check is UNARMED rather than passing silently', () => {
    // A manager built with `Object.create` has no class fields at all — several
    // tests in this package build one. A check that answered "fine" there would
    // be green because it measured nothing, which is this row's own amendment
    // (d): "instrument silently disarmed" is the harder failure than
    // "instrument wrong".
    const partial = Object.create(SessionManager.prototype) as Internals & { eventSink: unknown }
    partial.eventSink = () => undefined
    // `sendEvent`'s own tail reads `this.sessions` for the Pi invalidation
    // companion, which predates this row; supplied so the crash under test is
    // the check's verdict and not that unrelated TypeError. What is ABSENT is
    // `turnEndDoorTickets`, which is the state this case is about.
    partial.sessions = new Map()
    partial.sendEvent({ type: 'complete', sessionId: 'p321-unarmed' } as SessionEvent, 'ws_test')
    partial.sendEvent({ type: 'complete', sessionId: 'p321-unarmed' } as SessionEvent, 'ws_test')
    expect(unarmed()).toHaveLength(1)
    expect(bypassed()).toEqual([])
  })

  it('ignores every non-terminal event, so ordinary traffic pays nothing', () => {
    const { internals } = setUp('p321-quiet')
    internals.sendEvent({ type: 'text_delta', sessionId: 'p321-quiet', delta: 'hi' } as unknown as SessionEvent, 'ws_test')
    internals.sendEvent({ type: 'text_complete', sessionId: 'p321-quiet', text: 'hi' } as unknown as SessionEvent, 'ws_test')
    expect(warnings).toEqual([])
  })
})
