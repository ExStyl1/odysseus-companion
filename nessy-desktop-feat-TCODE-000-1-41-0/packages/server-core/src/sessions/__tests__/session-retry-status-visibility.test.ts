/**
 * The user-visible half of the gateway-429 work (plan 2026-08-07, T4).
 *
 * When the Nestor gateway throttles a turn, the Pi SDK sleeps 15/30/60/60/60s
 * between attempts. Nothing else is emitted during that sleep, so unless the
 * `auto_retry_start` event reaches the renderer as a status line the chat is
 * dead silent for minutes and then produces an error. This pins the WHOLE
 * chain that makes the wait visible — raw Pi SDK event -> PiEventAdapter ->
 * SessionManager -> the wire event the renderer stores as `currentStatus` —
 * rather than only the adapter case, because every earlier version of this
 * behavior had the adapter case and still showed the user nothing useful.
 *
 * The load-bearing pieces:
 *  - the adapter must put the WAIT and the CAUSE in the message;
 *  - SessionManager's keyword sniff must stamp `statusType: 'retrying'`
 *    (same mechanism `Compacting` uses — the internal AgentEvent carries no
 *    statusType field, and adding one would change a frozen contract).
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentEvent } from '@nessy-agent/core/types'
import type { SessionEvent } from '@nessy-agent/shared/protocol'
import { PiEventAdapter } from '../../../../shared/src/agent/backend/pi/event-adapter.ts'
import { createManagedSession } from '../SessionManager.ts'
import { createTestSessionManager } from './test-session-manager.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** Run a raw Pi SDK session event through the real adapter. */
function adapt(sdkEvent: Record<string, unknown>): AgentEvent[] {
  const adapter = new PiEventAdapter()
  adapter.startTurn()
  return [...adapter.adaptEvent(sdkEvent as never)]
}

/**
 * Drives one turn whose backend emits `backendEvents`, and returns the wire
 * events the renderer would receive.
 */
async function runTurn(backendEvents: AgentEvent[]): Promise<SessionEvent[]> {
  const stateRoot = mkdtempSync(join(tmpdir(), 'sm-retry-status-'))
  roots.push(stateRoot)
  const workspace = {
    id: 'ws-retry-status',
    name: 'Retry Status Workspace',
    slug: 'retry-status',
    rootPath: join(stateRoot, 'workspace'),
    createdAt: Date.now(),
  }
  mkdirSync(workspace.rootPath, { recursive: true })

  const manager = createTestSessionManager()
  const managed = createManagedSession(
    { id: 'retry-status' },
    workspace as never,
    { messagesLoaded: true, ephemeral: true },
  )
  ;(manager as unknown as { sessions: Map<string, unknown> }).sessions.set(
    `${workspace.id}:${managed.id}`,
    managed,
  )

  const events: SessionEvent[] = []
  manager.setEventSink(((_channel: unknown, _target: unknown, event: SessionEvent) => {
    events.push(event)
  }) as Parameters<typeof manager.setEventSink>[0])

  const internals = manager as unknown as {
    persistSession(managed: unknown): void
    acquireCapabilityTurn(managed: unknown): Promise<() => void>
    createCapabilityTurn(managed: unknown): Promise<unknown>
    createRetainedCapabilityLease(leaseId: string): unknown
    getOrCreateAgent(managed: unknown, runtime: unknown): Promise<unknown>
  }
  internals.persistSession = () => {}
  manager.flushSession = async () => {}
  internals.acquireCapabilityTurn = async () => () => {}
  internals.createCapabilityTurn = async () => ({
    snapshot: { leaseId: 'retry-status-lease' },
    runtime: { view: { sources: [] }, materializer: {} },
  })
  internals.createRetainedCapabilityLease = () => ({ retain: () => () => {}, release: () => {} })

  const agent = {
    isProcessing: () => true,
    setAllSources: () => {},
    setSourceServers: async () => {},
    getModel: () => 'test-model',
    getSessionId: () => undefined,
    setAutomationSystem: () => {},
    setCapabilityTurnRuntime: () => {},
    drainAutomationEvents: async () => {},
    forceAbort: () => {},
    dispose: () => {},
    updateWorkingDirectory: () => {},
    updateSdkCwd: () => {},
    chat: async function* () {
      for (const event of backendEvents) yield event
    },
  }
  internals.getOrCreateAgent = async () => {
    managed.agent = agent as never
    return agent
  }

  try {
    await manager.sendMessage(
      managed.id,
      'hello',
      undefined, undefined, undefined, undefined, undefined, undefined,
      { workspaceId: workspace.id },
    )
  } finally {
    manager.cleanup()
  }
  return events
}

/** Exactly the payload `agent-session.js` `_prepareRetry` emits. */
function autoRetryStart(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'auto_retry_start',
    attempt: 2,
    maxAttempts: 5,
    delayMs: 30_000,
    errorMessage: 'API error: 429 Too Many Requests',
    ...overrides,
  }
}

describe('a throttled turn is visible in chat, not dead silence', () => {
  it('surfaces the cause and the wait as a retrying status on the wire', async () => {
    const adapted = adapt(autoRetryStart())
    const events = await runTurn([...adapted, { type: 'complete' }])

    const status = events.find(event => event.type === 'status')
    expect(status).toBeDefined()
    // The user learns WHY the turn stalled...
    expect(status!.message).toContain('Rate limited')
    // ...how long it will stall for (30000ms -> 30s, not "30000")...
    expect(status!.message).toContain('30s')
    // ...and how many attempts are left before it gives up.
    expect(status!.message).toContain('2/5')
    // ...and the renderer can style it as a retry rather than a generic status.
    expect(status).toMatchObject({ statusType: 'retrying' })
  })

  it('does not blame rate limiting for a retry the gateway did not throttle', async () => {
    // `auto_retry_start` fires for EVERY retryable error pi-ai classifies
    // (timeouts, 5xx, socket drops — `pi-ai/dist/utils/retry.js`), so a fixed
    // "rate limited" wording would state a false cause on most retries.
    const adapted = adapt(autoRetryStart({
      attempt: 1,
      delayMs: 15_000,
      errorMessage: 'fetch failed: socket hang up',
    }))
    const events = await runTurn([...adapted, { type: 'complete' }])

    const status = events.find(event => event.type === 'status')
    expect(status).toBeDefined()
    expect(status!.message).not.toContain('Rate limited')
    expect(status!.message).toContain('15s')
    expect(status!.message).toContain('1/5')
    // Still a retry as far as the renderer is concerned.
    expect(status).toMatchObject({ statusType: 'retrying' })
  })

  it('replaces the stale wait line once the retry succeeds', async () => {
    const events = await runTurn([
      ...adapt(autoRetryStart()),
      ...adapt({ type: 'auto_retry_end', success: true, attempt: 2 }),
      { type: 'complete' },
    ])

    const statuses = events.filter(event => event.type === 'status')
    expect(statuses).toHaveLength(2)
    expect(statuses[1]!.message).toContain('Retry succeeded')
  })

  it('carries the retry FACTS on the wire, not only in the sentence', async () => {
    // P6.916 — the half the renderer used to re-derive with a regex. The
    // sentence is unchanged (the cases above pin it); what is new is that the
    // attempt, the budget and the wait ride as fields, so a client reads them
    // instead of parsing English.
    const events = await runTurn([...adapt(autoRetryStart()), { type: 'complete' }])

    const status = events.find(event => event.type === 'status') as
      { retry?: Record<string, unknown>; statusType?: string } | undefined
    // Read into a local BEFORE asserting the shape: `toMatchObject` overwrites
    // the object's fields with any asymmetric matcher it is given
    // (AGENTS.md §Traps), and this object is read again below.
    const retry = status?.retry
    expect(retry).toEqual({
      kind: 'rate_limit',
      attempt: 2,
      maxAttempts: 5,
      delaySeconds: 30,
    })
    // And the stamp comes FROM that field now, which is what lets the three
    // hand-written prefix sniffs go.
    expect(status?.statusType).toBe('retrying')
  })

  it('sends no retry field for a status that is not a retry', async () => {
    const events = await runTurn([
      { type: 'status', message: 'Compacting conversation' },
      { type: 'complete' },
    ])

    const status = events.find(event => event.type === 'status') as
      { retry?: unknown; statusType?: string } | undefined
    expect(status?.statusType).toBe('compacting')
    expect(status && 'retry' in status).toBe(false)
  })

  it('leaves an ordinary status untouched — the field is not a catch-all', async () => {
    const events = await runTurn([
      { type: 'status', message: 'Pi queue updated: 1 steering, 0 follow-up' },
      { type: 'complete' },
    ])

    const status = events.find(event => event.type === 'status')
    expect(status).toBeDefined()
    expect((status as { statusType?: string }).statusType).toBeUndefined()
  })
})
