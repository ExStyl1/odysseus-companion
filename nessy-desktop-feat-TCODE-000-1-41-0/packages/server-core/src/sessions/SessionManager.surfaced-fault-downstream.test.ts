/**
 * P3.22 — a surfaced subprocess fault is NOT dropped downstream.
 *
 * The DOWNSTREAM half of `pi-agent.ts`'s belts. The upstream half — that a
 * swallowed dispatch fault is SURFACED as an `{ type: 'error', message }`
 * AgentEvent onto the turn's queue — is pinned in
 * `packages/shared/src/agent/__tests__/pi-agent-sync-dispatch-belt.test.ts`.
 * That channel was then dropped or misrouted by three gates in
 * `SessionManager.processEvent`'s `case 'error'` (the pi-agent.ts:3063 comment
 * documents the same three holes from the emitting side):
 *
 *   1. `!managed.isProcessing`            → the whole event was dropped;
 *   2. message CONTAINS `aborted`/`AbortError` (substring) → dropped;
 *   3. auth-looking text                  → routed into `attemptAuthRetry`,
 *                                            which RE-SENDS `lastSentMessage`.
 *
 * These tests drive the shipped `processEvent` through the same rig the
 * between-turns sink consumer test uses (`SessionManager.processEvent` is a
 * standalone method; `sendEvent` works with the turn closed). Each fix has a
 * positive case (a fault that must surface / not re-send) and a control (the
 * legitimate behaviour the gate was built for — a real abort stays quiet, a real
 * auth-expiry still retries). RE-BREAK (revert the three gate edits in
 * SessionManager.ts): the gate-1, self-suppression and belt-site tests fail
 * because the fault is dropped again (no `error` event, no error row); the
 * gate-3 test fails because `attemptAuthRetry` is called on a fault report.
 */
import { afterEach, describe, expect, it, mock } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentEvent } from '@nessy-agent/core/types'
import type { SessionEvent } from '@nessy-agent/shared/protocol'
import { SessionManager, createManagedSession } from './SessionManager.ts'
import { createTestSessionManager } from './__tests__/test-session-manager.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

// The exact messages pi-agent.ts builds. The `<detail>` (host-supplied thrown
// value) is appended AFTER a constant prefix at every site, so it can never
// forge the prefix. Kept as literals here so this test fails if pi-agent.ts (a
// different lane, P2.76) rewords one, rather than the recogniser silently going
// blind. Sources: safeHostCall (pi-agent.ts ~996), dispatchSubprocessMessage
// catch (~2920), handleSubprocessEvent catch (~3086), proxy tool catch (~6425),
// reportBrokenDebugSink (~9678).
function safeHostCallFault(what: string, detail: string): string {
  return `A Pi subprocess update could not be delivered to the app (${what}): ${detail}`
}
function messageDispatchFault(typeDisplay: string, detail: string): string {
  return `A Pi subprocess message ${typeDisplay} could not be processed: ${detail}`
}
function eventDispatchFault(eventType: string, detail: string): string {
  return `A Pi subprocess event (${eventType}) could not be processed: ${detail}`
}
function proxyToolFault(toolLabel: string, detail: string): string {
  return `A Pi proxy tool call (${toolLabel}) could not be dispatched: ${detail}`
}
function brokenDebugSinkFault(detail: string): string {
  return `A Pi diagnostic line could not be written to the app's log and was dropped (reported once per session): ${detail}`
}

interface Rig {
  manager: SessionManager
  internal: Record<string, unknown> & {
    processEvent(managed: unknown, event: AgentEvent): Promise<void>
    isSurfacedSubprocessFault(message: string): boolean
  }
  managed: Record<string, unknown> & { id: string; isProcessing: boolean }
  events: SessionEvent[]
  authRetry: ReturnType<typeof mock>
  deliver(event: AgentEvent): Promise<void>
  errorRows(): Array<{ role: string; content?: string }>
}

function createRig(): Rig {
  const stateRoot = mkdtempSync(join(tmpdir(), 'sm-surfaced-fault-'))
  roots.push(stateRoot)
  const workspace = {
    id: 'ws-surfaced-fault',
    name: 'Surfaced Fault Workspace',
    slug: 'surfaced-fault',
    rootPath: join(stateRoot, 'workspace'),
    createdAt: Date.now(),
  }
  mkdirSync(workspace.rootPath, { recursive: true })

  const manager = createTestSessionManager()
  const managed = createManagedSession(
    { id: 'session-surfaced-fault' },
    workspace as never,
    { messagesLoaded: true, ephemeral: true },
  )
  ;(manager as unknown as { sessions: Map<string, unknown> }).sessions.set(
    `${workspace.id}:${managed.id}`,
    managed,
  )
  ;(manager as unknown as { persistSession(m: unknown): void }).persistSession = () => {}
  manager.flushSession = async () => {}

  const events: SessionEvent[] = []
  manager.setEventSink(((_channel: unknown, _target: unknown, event: SessionEvent) => {
    events.push(event)
  }) as Parameters<SessionManager['setEventSink']>[0])

  const internal = manager as unknown as Rig['internal']
  // Spy on the re-send path. Default: report "no retry initiated" so the gate
  // falls through to surfacing, which is what a non-auth error should do.
  const authRetry = mock(() => false)
  internal.attemptAuthRetry = authRetry as never

  return {
    manager,
    internal,
    managed: managed as never,
    events,
    authRetry,
    deliver: (event: AgentEvent) => internal.processEvent(managed, event),
    errorRows: () =>
      (managed as unknown as { messages: Array<{ role: string; content?: string }> }).messages
        .filter(message => message.role === 'error'),
  }
}

function errorEvents(events: SessionEvent[]): Array<{ type: string; error?: string }> {
  return events.filter(event => event.type === 'error') as Array<{ type: string; error?: string }>
}

describe('P3.22 — a surfaced subprocess fault survives the three downstream gates', () => {
  // ── Gate 1: no turn in flight ────────────────────────────────────────────
  it('gate 1 (positive): a surfaced fault with NO turn in flight is surfaced', async () => {
    const rig = createRig()
    rig.managed.isProcessing = false // the state the three no-turn belt sites arrive in

    await rig.deliver({
      type: 'error',
      message: safeHostCallFault('onSdkSessionIdUpdate', 'sink exploded'),
    })

    expect(errorEvents(rig.events)).toHaveLength(1)
    expect(errorEvents(rig.events)[0]!.error).toContain('onSdkSessionIdUpdate')
    expect(rig.errorRows()).toHaveLength(1)
  })

  it('gate 1 (control): a NON-fault error with no turn in flight is still dropped (late handoff error)', async () => {
    const rig = createRig()
    rig.managed.isProcessing = false

    // The documented legitimate case: after a plan-submission / auth-request
    // handoff, the interrupted query emits a late error with the turn closed.
    await rig.deliver({ type: 'error', message: 'Request failed after handoff' })

    expect(errorEvents(rig.events)).toHaveLength(0)
    expect(rig.errorRows()).toHaveLength(0)
  })

  it('gate 1: all three no-turn belt sites (ready, session_id_update, ensure_session_ready_result) surface', async () => {
    const rig = createRig()
    rig.managed.isProcessing = false

    // `session_id_update` and `ready` go through safeHostCall('onSdkSessionIdUpdate');
    // `ready` and `ensure_session_ready_result` also reach the message-dispatch belt.
    const faults = [
      safeHostCallFault('onSdkSessionIdUpdate', 'boom'),        // session_id_update
      messageDispatchFault('ready', 'resolveReady threw'),      // ready (message belt)
      messageDispatchFault('ensure_session_ready_result', 'x'), // ensure_session_ready_result
    ]
    for (const message of faults) await rig.deliver({ type: 'error', message })

    expect(errorEvents(rig.events)).toHaveLength(3)
    expect(rig.errorRows()).toHaveLength(3)
  })

  // ── Gate 2: aborted/AbortError — test a CAUSE, not a substring ────────────
  it('gate 2 (control): a genuine user abort stays quiet (cause = stopRequested)', async () => {
    const rig = createRig()
    rig.managed.isProcessing = true
    rig.managed.stopRequested = true // cancelProcessing() set this before forceAbort

    await rig.deliver({ type: 'error', message: 'Request was aborted.' })

    expect(errorEvents(rig.events)).toHaveLength(0)
    expect(rig.errorRows()).toHaveLength(0)
  })

  it('gate 2 (control): a redirect-fallback abort stays quiet (cause = wasInterrupted)', async () => {
    const rig = createRig()
    rig.managed.isProcessing = true
    rig.managed.wasInterrupted = true

    await rig.deliver({ type: 'error', message: 'AbortError: The operation was aborted' })

    expect(errorEvents(rig.events)).toHaveLength(0)
  })

  it('gate 2 (positive, the fourth gate): a REAL fault whose host <detail> contains "aborted" is surfaced', async () => {
    const rig = createRig()
    rig.managed.isProcessing = true // P2.66 re-posts the broken-sink row inside the window
    // No abort was initiated (stopRequested/wasInterrupted/authRetryInProgress all falsy).

    await rig.deliver({
      type: 'error',
      message: brokenDebugSinkFault('logger threw: connection aborted'),
    })

    expect(errorEvents(rig.events)).toHaveLength(1)
    expect(errorEvents(rig.events)[0]!.error).toContain('could not be written')
    expect(rig.errorRows()).toHaveLength(1)
  })

  it('gate 2 (positive): a non-fault error containing "aborted" with NO abort in flight is surfaced', async () => {
    const rig = createRig()
    rig.managed.isProcessing = true
    // A genuine server-side failure whose text happens to contain "aborted",
    // but this session initiated no abort — the substring alone must not suppress.

    await rig.deliver({ type: 'error', message: 'upstream request was aborted by the server' })

    expect(errorEvents(rig.events)).toHaveLength(1)
  })

  // ── Gate 3: never re-send the user's message on a fault ───────────────────
  it('gate 3 (positive): a fault report with auth-looking detail does NOT trigger attemptAuthRetry', async () => {
    const rig = createRig()
    rig.managed.isProcessing = true
    rig.managed.lastSentMessage = 'the user turn'
    // A host callback threw an error whose text looks like an auth failure.
    rig.authRetry.mockImplementation(() => true) // would re-send if wrongly reached

    await rig.deliver({
      type: 'error',
      message: safeHostCallFault('onSdkSessionIdUpdate', '401 unauthorized: token is expired'),
    })

    expect(rig.authRetry).not.toHaveBeenCalled()
    // The fault is surfaced instead of silently re-sending the user's message.
    expect(errorEvents(rig.events)).toHaveLength(1)
    expect(rig.errorRows()).toHaveLength(1)
  })

  it('gate 3 (control): a real plain auth-expiry error still retries', async () => {
    const rig = createRig()
    rig.managed.isProcessing = true
    rig.managed.lastSentMessage = 'the user turn'
    rig.authRetry.mockImplementation(() => true) // retry initiated

    await rig.deliver({ type: 'error', message: 'authentication token is expired' })

    expect(rig.authRetry).toHaveBeenCalledTimes(1)
    // When the retry is initiated no error row is appended (handled via retry).
    expect(errorEvents(rig.events)).toHaveLength(0)
    expect(rig.errorRows()).toHaveLength(0)
  })

  /*
   * DA1.14 — the 403 arm of the plain-text auth classifier, and the negative
   * control the row asks for by name.
   *
   * The asymmetry it closes is with nessy-cli's
   * `packages/core/src/dp/dpContentGenerator.ts` symbol `isAuthError`, which
   * fires on 401 AND 403; this tree classified no 403 anywhere. CARRY THE NULL:
   * no 403 has been measured on the gateway chat endpoint, so these arms pin a
   * classifier, not a reproduced failure.
   */
  it('gate 3 (403 positive): a 403 that NAMES the credential reaches attemptAuthRetry', async () => {
    const rig = createRig()
    rig.managed.isProcessing = true
    rig.managed.lastSentMessage = 'the user turn'
    rig.authRetry.mockImplementation(() => true)

    await rig.deliver({ type: 'error', message: 'HTTP 403: the access token was rejected' })

    expect(rig.authRetry).toHaveBeenCalledTimes(1)
    expect(errorEvents(rig.events)).toHaveLength(0)
    expect(rig.errorRows()).toHaveLength(0)
  })

  /*
   * DA1.41 — THIS ASSERTION USED TO BE ITS OWN INVERSE, and the flip IS the row.
   * DA1.14 shipped the arm as `403 && (forbidden || auth)`, and `HTTP 403
   * Forbidden` was its positive case. That contradicts a rule this tree has
   * stated twice: `packages/shared/src/agent/claude-sdk-error-mapper.ts` —
   * *"A 403 IS NOT AN AUTH FAILURE, and telling the user it is sends them to
   * re-enter a working key"* — and P3.334 (`c5a1f8bcd`), which split 403 out of
   * the 401 family on the codex wire. A bare `403 Forbidden` is what a generic
   * transport renders for EVERY refusal, so accepting it re-sent the user's turn
   * on a policy refusal that no re-mint can fix.
   */
  it('gate 3 (403 negative): a bare "403 Forbidden" with no credential word does NOT re-send', async () => {
    const rig = createRig()
    rig.managed.isProcessing = true
    rig.managed.lastSentMessage = 'the user turn'
    rig.authRetry.mockImplementation(() => true) // would re-send if wrongly reached

    await rig.deliver({ type: 'error', message: 'HTTP 403 Forbidden' })

    expect(rig.authRetry).not.toHaveBeenCalled()
    expect(errorEvents(rig.events)).toHaveLength(1)
    expect(rig.errorRows()).toHaveLength(1)
  })

  it('gate 3 (403 negative): the MEASURED guardrail refusal is a policy refusal, not a bad key', async () => {
    // The body llm-proxy was measured returning on 2026-08-15, quoted in
    // `claude-sdk-error-mapper.ts`'s own 403 branch. It contains the word
    // `auth` — which is why the old pair accepted it — and the request WAS
    // authenticated. Re-sending it spends a second turn and tells the user to
    // check credentials that are fine.
    const rig = createRig()
    rig.managed.isProcessing = true
    rig.managed.lastSentMessage = 'the user turn'
    rig.authRetry.mockImplementation(() => true)

    await rig.deliver({
      type: 'error',
      message: 'authentication_failed: 403 {"error":"Security Guardrail Triggered: Malicious MCP detected. Invalid tools: shell"}',
    })

    expect(rig.authRetry).not.toHaveBeenCalled()
    expect(errorEvents(rig.events)).toHaveLength(1)
    expect(rig.errorRows()).toHaveLength(1)
  })

  /*
   * DA1.29 — the NOT-FOUND case, which the heuristic recognised on no route.
   *
   * The adapter types its two refusals, but the typed code reaches nothing at
   * this layer (measured: `credentials_expired` scores 0 occurrences in
   * `packages/server-core` and 0 in `packages/core`, against `invalid_api_key`
   * at 6 in server-core as the positive control), so the sentence is the floor.
   * The two strings below are the ones the adapter and `queryLlm` actually
   * emit — `packages/codex-responses-adapter/src/server.ts` symbol
   * `NO_CREDENTIALS`, and `packages/shared/src/agent/codex-agent.ts` symbol
   * `queryLlm`'s not-found twin. They are spelled out rather than imported
   * because `packages/server-core` has no dependency on the adapter package and
   * adding one for two sentences would be a heavier coupling than the row buys;
   * the adapter's own docblock carries the back-pointer. (Since review R6,
   * 2026-09-17, that symbol is a FUNCTION and its parenthetical follows
   * `NESSY_HOME`; the literal below is its default-home rendering, which is all
   * this fixture needs — the clause `messageLooksLikePlainAuthError` matches is
   * the path-independent pair.)
   */
  it('gate 3 (not-found positive): a "Nessy Gateway credentials not found" error reaches attemptAuthRetry', async () => {
    const rig = createRig()
    rig.managed.isProcessing = true
    rig.managed.lastSentMessage = 'the user turn'
    rig.authRetry.mockImplementation(() => true)

    await rig.deliver({
      type: 'error',
      message: 'Nessy Gateway credentials not found (~/.nessy/dp_auth_creds.json)',
    })

    expect(rig.authRetry).toHaveBeenCalledTimes(1)
    expect(errorEvents(rig.events)).toHaveLength(0)
    expect(rig.errorRows()).toHaveLength(0)
  })

  it('gate 3 (not-found positive): queryLlm\'s own not-found sentence reaches it too', async () => {
    const rig = createRig()
    rig.managed.isProcessing = true
    rig.managed.lastSentMessage = 'the user turn'
    rig.authRetry.mockImplementation(() => true)

    await rig.deliver({ type: 'error', message: 'Nessy Gateway credentials not found for queryLlm' })

    expect(rig.authRetry).toHaveBeenCalledTimes(1)
  })

  it('gate 3 (not-found negative): an unpaired "credentials not found" does NOT re-send', async () => {
    // PAIRED for the same reason as the 401 and 403 arms: this branch re-sends
    // the user's message, and the text it reads can be a tool's own prose.
    const rig = createRig()
    rig.managed.isProcessing = true
    rig.managed.lastSentMessage = 'the user turn'
    rig.authRetry.mockImplementation(() => true)

    await rig.deliver({ type: 'error', message: 'aws profile: credentials not found in ~/.aws/credentials' })

    expect(rig.authRetry).not.toHaveBeenCalled()
    expect(errorEvents(rig.events)).toHaveLength(1)
    expect(rig.errorRows()).toHaveLength(1)
  })

  it('gate 3 (403 negative): a FAULT report containing "forbidden" cannot re-send the user message', async () => {
    const rig = createRig()
    rig.managed.isProcessing = true
    rig.managed.lastSentMessage = 'the user turn'
    rig.authRetry.mockImplementation(() => true) // would re-send if wrongly reached

    await rig.deliver({
      type: 'error',
      message: proxyToolFault('Bash', 'the server answered 403 forbidden'),
    })

    expect(rig.authRetry).not.toHaveBeenCalled()
    expect(errorEvents(rig.events)).toHaveLength(1)
    expect(rig.errorRows()).toHaveLength(1)
  })

  it('gate 3 (403 boundary): a bare "forbidden" with no status is NOT an auth failure', async () => {
    // The deliberate divergence from the donor, which matches a bare substring.
    // This branch re-sends the user's message, so a tool's own prose saying
    // "forbidden" must not be able to trigger one.
    const rig = createRig()
    rig.managed.isProcessing = true
    rig.managed.lastSentMessage = 'the user turn'
    rig.authRetry.mockImplementation(() => true)

    await rig.deliver({ type: 'error', message: 'Editing that path is forbidden by policy' })

    expect(rig.authRetry).not.toHaveBeenCalled()
    expect(errorEvents(rig.events)).toHaveLength(1)
  })

  // ── The recogniser is pinned to pi-agent.ts's exact fault shapes ──────────
  it('recogniser: matches every fault-surfacing shape and rejects ordinary errors', () => {
    const rig = createRig()
    const faults = [
      safeHostCallFault('onSdkSessionIdUpdate', 'x'),
      messageDispatchFault('ready', 'x'),
      eventDispatchFault('ready', 'x'),
      proxyToolFault('Bash', 'x'),
      brokenDebugSinkFault('x'),
    ]
    for (const message of faults) {
      expect(rig.internal.isSurfacedSubprocessFault(message)).toBe(true)
    }
    // Host detail cannot forge the prefix: a plain error that merely mentions the
    // words is not recognised as a surfaced fault.
    expect(rig.internal.isSurfacedSubprocessFault('token is expired')).toBe(false)
    expect(rig.internal.isSurfacedSubprocessFault('The operation was aborted')).toBe(false)
    expect(rig.internal.isSurfacedSubprocessFault('Pi subprocess error: boom')).toBe(false)
  })
})
