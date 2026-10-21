/**
 * UA1.2 (OQ-6, spec §8) — agents cannot close a card; the host and the UI still can.
 *
 * The closure guard lives in the AGENT tool (`handleSetSessionStatus`, session-tools-core), which every runtime's
 * `set_session_status` runs. `SessionManager.setSessionStatus` is the HOST port behind the `setSessionStatus` RPC
 * command (`handlers/rpc/sessions.ts`), the mini-agent's auto-`done` and, from Phase 3, the Conductor: it carries no
 * guard, and this file is the control that it still closes on the real `SessionManager`.
 *
 * UA1.3 adds the other half: the AGENT's host closures (`setSessionStatusForAgent` / `setSessionLabelsForAgent`,
 * bound into the per-session registry for every runtime and reached by codex over the bridge) are the authority for
 * the closure rule and for the caller's workspace, measured here on the real class and through the real bridge.
 */
import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { encodeSessionKey } from '@nessy-agent/shared/sessions/session-key'
import { startCodexSessionCallbackBridge } from '@nessy-agent/shared/agent/backend/codex/session-callback-bridge'
import { closedStatusRefusal, HOST_CALLBACK_BRIDGE_ROUTES } from '@nessy-agent/session-tools-core'
import { createTestSessionManager } from './test-session-manager.ts'

const WORKSPACE_ID = 'ws-status-closure'
const callerKey = { workspaceId: WORKSPACE_ID, sessionId: 'caller' }
/** A real workspace root, so `loadStatusConfig` answers the real default config (it seeds icon files there). */
const workspaceRoot = mkdtempSync(join(tmpdir(), 'ua13-status-closure-'))
afterAll(() => rmSync(workspaceRoot, { recursive: true, force: true }))

interface Internals {
  sessions: Map<string, unknown>
  sendEvent(event: unknown, workspaceId: string): void
  persistSession(managed: unknown, immediate?: boolean): void
  flushSession(sessionId: string, workspaceId?: string): Promise<void>
  setSessionStatusForAgent(caller: unknown, sessionId: string | undefined, status: string): Promise<void>
  setSessionLabelsForAgent(caller: unknown, sessionId: string | undefined, labels: string[]): Promise<void>
}

type Managed = Record<string, unknown> & { sessionStatus?: string; labels?: string[] }

const makeManaged = (workspaceId: string, sessionId: string): Managed => ({
  id: sessionId,
  name: sessionId,
  workspace: { id: workspaceId, rootPath: workspaceRoot },
  sessionStatus: 'todo',
  labels: [],
})

function harness() {
  const manager = createTestSessionManager()
  const internals = manager as unknown as Internals
  const events: Array<Record<string, unknown>> = []
  const caller = makeManaged(WORKSPACE_ID, callerKey.sessionId)
  const sibling = makeManaged(WORKSPACE_ID, 'sibling')
  // A session in ANOTHER workspace, under an id the caller could name.
  const foreign = makeManaged('ws-other', 'foreign')
  internals.sessions.set(encodeSessionKey(callerKey), caller)
  internals.sessions.set(encodeSessionKey({ workspaceId: WORKSPACE_ID, sessionId: 'sibling' }), sibling)
  internals.sessions.set(encodeSessionKey({ workspaceId: 'ws-other', sessionId: 'foreign' }), foreign)
  // Only the persistence below the decision is stubbed; the setter is the production one.
  internals.sendEvent = event => { events.push(event as Record<string, unknown>) }
  internals.persistSession = () => undefined
  internals.flushSession = async () => undefined
  return { manager, internals, caller, sibling, foreign, events }
}

describe('the host/UI path still closes (control for the agent guard)', () => {
  for (const closed of ['done', 'cancelled']) {
    test(`SessionManager.setSessionStatus sets "${closed}" — the RPC command's path`, async () => {
      const { manager, caller, events } = harness()
      await manager.setSessionStatus('caller', closed, WORKSPACE_ID)
      expect(caller.sessionStatus).toBe(closed)
      expect(events).toContainEqual({ type: 'session_status_changed', sessionId: 'caller', sessionStatus: closed })
    })
  }
})

/**
 * UA1.3 — the AGENT's host closures (`setSessionStatusFn` / `setSessionLabelsFn` in the per-session registry, which
 * Pi and Claude reach in process and codex over the bridge) are the authority for both rules, on the real class.
 */
describe('the agent host closures are the authority (UA1.2 rule + caller workspace)', () => {
  test('an open status is set on the caller and on an own-workspace sibling', async () => {
    const { internals, caller, sibling } = harness()
    await internals.setSessionStatusForAgent(caller, undefined, 'needs-review')
    await internals.setSessionStatusForAgent(caller, 'sibling', 'backlog')
    expect(caller.sessionStatus).toBe('needs-review')
    expect(sibling.sessionStatus).toBe('backlog')
  })

  for (const closed of ['done', 'cancelled']) {
    test(`a closed status ("${closed}") is refused with UA1.2's sentence and the target is unchanged`, async () => {
      const { internals, caller } = harness()
      await expect(internals.setSessionStatusForAgent(caller, undefined, closed)).rejects.toThrow(closedStatusRefusal(closed))
      expect(caller.sessionStatus).toBe('todo')
    })
  }

  test('an unknown status id is refused with the real ids', async () => {
    const { internals, caller } = harness()
    await expect(internals.setSessionStatusForAgent(caller, undefined, 'in_progress'))
      .rejects.toThrow('Available status IDs: backlog, todo, needs-review, done, cancelled')
    expect(caller.sessionStatus).toBe('todo')
  })

  test('a target in another workspace is refused by name — status and labels — and is unchanged', async () => {
    const { internals, caller, foreign } = harness()
    await expect(internals.setSessionStatusForAgent(caller, 'foreign', 'needs-review'))
      .rejects.toThrow('No session "foreign" in your own workspace.')
    await expect(internals.setSessionLabelsForAgent(caller, 'foreign', ['bug']))
      .rejects.toThrow('No session "foreign" in your own workspace.')
    expect(foreign.sessionStatus).toBe('todo')
    expect(foreign.labels).toEqual([])
  })

  test('labels are set on the caller (positive control for the refusal above, same instrument)', async () => {
    const { internals, caller } = harness()
    await internals.setSessionLabelsForAgent(caller, undefined, ['bug'])
    expect(caller.labels).toEqual(['bug'])
  })

  test('over the REAL codex bridge: done is refused, a foreign target is refused, needs-review is set', async () => {
    const { internals, caller, foreign } = harness()
    const bridge = await startCodexSessionCallbackBridge({
      sessionKey: callerKey,
      resolvePorts: () => ({
        setSessionStatusFn: (sessionId, status) => internals.setSessionStatusForAgent(caller, sessionId, status),
        setSessionLabelsFn: (sessionId, labels) => internals.setSessionLabelsForAgent(caller, sessionId, labels),
      }),
    })
    try {
      const post = async (route: string, payload: unknown) => {
        const response = await fetch(`http://127.0.0.1:${bridge.port}${route}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId: callerKey.sessionId, payload }),
        })
        return (await response.json()) as { result?: unknown; error?: string }
      }
      expect((await post(HOST_CALLBACK_BRIDGE_ROUTES.sessionSetStatus, { status: 'done' })).error).toBe(closedStatusRefusal('done'))
      expect((await post(HOST_CALLBACK_BRIDGE_ROUTES.sessionSetStatus, { sessionId: 'foreign', status: 'todo' })).error)
        .toBe('No session "foreign" in your own workspace.')
      expect((await post(HOST_CALLBACK_BRIDGE_ROUTES.sessionSetLabels, { sessionId: 'foreign', labels: ['x'] })).error)
        .toBe('No session "foreign" in your own workspace.')
      expect(caller.sessionStatus).toBe('todo')
      expect(foreign.sessionStatus).toBe('todo')
      expect((await post(HOST_CALLBACK_BRIDGE_ROUTES.sessionSetStatus, { status: 'needs-review' })).error).toBeUndefined()
      expect(caller.sessionStatus).toBe('needs-review')
    } finally {
      await bridge.close()
    }
  })
})

/**
 * UA1.3 follow-up — the ONE link the arms above cannot execute: the registration site in `getOrCreateAgentUnchecked`
 * that binds `setSessionStatusFn` / `setSessionLabelsFn` in the per-session registry to the `…ForAgent` closures. That
 * binding is what makes them the authority on every runtime (Pi and Claude read the registry in process; codex's
 * bridge resolves it by default). The arms above call the closures directly or hand the bridge their own
 * `resolvePorts`, so reverting the binding kept them green. A unit test cannot drive that method without constructing
 * an agent, so — as `claude-cron-port-binding.test.ts` and `agent-message-delivery.test.ts` do for their sites — it is
 * read as TEXT, and the boundary arm runs the same predicate over the same file with the pre-UA1.3 bodies put back.
 */
describe('the registry slots SessionManager binds are the agent closures (UA1.3 wiring)', () => {
  const sessionManagerSource = readFileSync(new URL('../SessionManager.ts', import.meta.url), 'utf8')
  const REGISTRATION = 'mergeSessionScopedToolCallbacks({ workspaceId: managed.workspace.id, sessionId: managed.id }, {'
  const BINDINGS = {
    setSessionStatusFn: {
      bound: 'await this.setSessionStatusForAgent(managed, sessionId, status)',
      preUa13: 'await this.setSessionStatus(sessionId ?? managed.id, status as SessionStatus, managed.workspace.id)',
    },
    setSessionLabelsFn: {
      bound: 'await this.setSessionLabelsForAgent(managed, sessionId, labels)',
      preUa13: 'await this.setSessionLabels(sessionId ?? managed.id, labels, managed.workspace.id)',
    },
  } as const

  /** The body line of the ONE `<slot>: async (` registration, inside the managed session's block, or why not. */
  function slotBody(source: string, slot: keyof typeof BINDINGS): string {
    const lines = source.split('\n')
    const heads = lines.flatMap((line, index) => (line.trimStart().startsWith(`${slot}: async (`) ? [index] : []))
    if (heads.length !== 1) return `<${heads.length} registrations of ${slot}>`
    const head = heads[0]!
    const opener = lines.slice(0, head).findLastIndex(line => line.includes('mergeSessionScopedToolCallbacks('))
    if (opener < 0 || !lines[opener]!.includes(REGISTRATION)) return `<${slot} is not in the managed session's registration>`
    return lines[head + 1]!.trim()
  }

  for (const slot of Object.keys(BINDINGS) as Array<keyof typeof BINDINGS>) {
    test(`${slot} is bound to the ${slot === 'setSessionStatusFn' ? 'setSessionStatusForAgent' : 'setSessionLabelsForAgent'} closure`, () => {
      // Positive control: the registration block this claim is about is present (an emptied or moved file is red).
      expect(sessionManagerSource.includes(REGISTRATION)).toBe(true)
      expect(slotBody(sessionManagerSource, slot)).toStartWith(BINDINGS[slot].bound)
    })

    test(`${slot}: the pre-UA1.3 body (a silent no-op on a foreign target) fails the same predicate`, () => {
      const head = sessionManagerSource.split('\n').findIndex(line => line.trimStart().startsWith(`${slot}: async (`))
      const lines = sessionManagerSource.split('\n')
      const indent = lines[head + 1]!.match(/^\s*/)![0]
      lines[head + 1] = `${indent}${BINDINGS[slot].preUa13}`
      const reverted = lines.join('\n')
      expect(slotBody(reverted, slot)).toBe(BINDINGS[slot].preUa13)
      expect(slotBody(reverted, slot).startsWith(BINDINGS[slot].bound)).toBe(false)
    })
  }
})
