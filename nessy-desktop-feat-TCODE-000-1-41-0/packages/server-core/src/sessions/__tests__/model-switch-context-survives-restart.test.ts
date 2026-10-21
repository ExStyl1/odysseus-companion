/**
 * UB12.104 — a `PostModelSwitch` context owed to the next prompt survives a quit.
 *
 * UB12.69 made the host keep the last switch's context on
 * `ManagedSession.pendingModelSwitchContext` and add it, fenced, to the next
 * prompt — `hooks.md#postmodelswitch-decision-control` (curl'd 2026-10-17):
 * Claude Code "delivers it to Claude with the next request after the switch".
 * The field lived in memory only, so a quit between the switch and that prompt
 * dropped it, the residue UB12.69 stated. This row persists it the way F1.689
 * persists `wasInterrupted`: the session header carries it at every persist,
 * both load doors restore it, and the next real prompt spends it and the stored
 * copy with it.
 *
 * What runs for real: `updateSessionModel` (Pre, the switch, Post) with its
 * persist, `sendMessage`'s composition and spend, `persistSession`,
 * `flushAllSessions` (the quit's flush) and the persistence queue writing the
 * session file, then a FRESH manager (the restart) loading it through the real
 * session store by both doors — `ensureMessagesLoaded` (opening the chat, and
 * the first thing `sendMessage` does) and the cold-persist hydration (a write
 * before the chat is opened). The automation system, the capability lease and
 * the agent are stubs, as in UB12.69's `post-model-switch-context.test.ts`: the
 * event is host-emitted on Pi, claude-runtime and codex (D1.165), so one stub
 * backend stands for all three.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentEvent } from '@nessy-agent/core/types'
import { getSessionFilePath } from '@nessy-agent/shared/sessions'
import { SessionManager, createManagedSession } from '../SessionManager.ts'
import { createTestSessionManager } from './test-session-manager.ts'

const WORKSPACE_ID = 'ws-ub12-104'
const GUIDANCE = 'On Opus, delegate implementation work to subagents and keep this conversation for planning and review.'
const BAND_OPEN = '<hook_context event="PostModelSwitch">'

const roots: string[] = []
const managers: SessionManager[] = []
let counter = 0

afterEach(async () => {
  for (const manager of managers.splice(0)) {
    await manager.flushAllSessions().catch(() => undefined)
    await manager.cleanup()
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

interface Internals {
  sessions: Map<string, unknown>
  persistSession(managed: unknown): void
  ensureMessagesLoaded(managed: unknown): Promise<void>
}

/**
 * One process: a manager holding one non-ephemeral session, a stub agent and
 * an automation system whose `PostModelSwitch` answers come from `post`, in
 * order (`undefined` = a hook that printed nothing).
 */
function launch(sessionId: string, messagesLoaded: boolean, post: Array<string | undefined> = []) {
  const stateRoot = mkdtempSync(join(tmpdir(), 'ub12-104-'))
  roots.push(stateRoot)
  const workspace = { id: WORKSPACE_ID, name: 'UB12.104', slug: 'ub12-104', rootPath: join(stateRoot, 'workspace'), createdAt: Date.now() }
  mkdirSync(workspace.rootPath, { recursive: true })

  const manager = createTestSessionManager()
  managers.push(manager)
  manager.setEventSink((() => {}) as Parameters<SessionManager['setEventSink']>[0])
  // A name, so the first prompt does not start title generation.
  const managed = createManagedSession({ id: sessionId, name: 'UB12.104' }, workspace as never, { messagesLoaded })
  const internals = manager as unknown as Internals & Record<string, unknown>
  internals.sessions.set(`${workspace.id}:${managed.id}`, managed)

  const system = {
    async executeAgentEvent(event: string) {
      if (event !== 'PostModelSwitch') return { matchedCount: 0 }
      const text = post.shift()
      return text === undefined ? { matchedCount: 1 } : { matchedCount: 1, decision: { additionalContext: text } }
    },
  }
  const chatMessages: string[] = []
  let model = 'claude-sonnet-5'
  const agent = {
    isProcessing: () => true,
    setAllSources: () => {},
    setSourceServers: async () => {},
    getModel: () => model,
    setModel: (next: string) => { model = next },
    getSessionId: () => undefined,
    setAutomationSystem: () => {},
    setCapabilityTurnRuntime: () => {},
    drainAutomationEvents: async () => {},
    forceAbort: () => {},
    endLifecycle: async () => {},
    dispose: () => {},
    updateWorkingDirectory: () => {},
    updateSdkCwd: () => {},
    chat: async function* (text: string): AsyncGenerator<AgentEvent> {
      chatMessages.push(text)
      yield { type: 'complete' } as AgentEvent
    },
  }

  // The header's model write is not this row's subject; the session file is.
  internals.writeSessionMetadata = async () => {}
  internals.acquireCapabilityTurn = async () => () => {}
  internals.createCapabilityTurn = async (target: { capabilityLeaseId?: string; capabilityRuntime?: unknown }) => {
    const runtime = { view: { sources: [] }, materializer: {} }
    target.capabilityLeaseId = 'ub12-104-lease'
    target.capabilityRuntime = runtime
    return { snapshot: { leaseId: 'ub12-104-lease' }, runtime }
  }
  internals.createRetainedCapabilityLease = () => ({ retain: () => () => {}, release: () => {} })
  internals.buildAgentAutomationSystem = async () => system
  internals.getOrCreateAgent = async () => {
    managed.agent = agent as never
    return agent
  }

  return {
    manager,
    internals,
    managed,
    chatMessages,
    /** A switch on a session with a live agent, as after its first turn: `runModelSwitchHook` fires nothing without one. */
    switchTo: (to: string) => {
      managed.agent = agent as never
      return manager.updateSessionModel(managed.id, workspace.id, to)
    },
    send: (message: string) => manager.sendMessage(
      managed.id, message, undefined, undefined, undefined, undefined, undefined, undefined, { workspaceId: workspace.id },
    ),
  }
}

function header(sessionId: string): Record<string, unknown> {
  const file = getSessionFilePath(WORKSPACE_ID, sessionId)
  expect(existsSync(file)).toBe(true)
  const firstLine = readFileSync(file, 'utf-8').split('\n')[0]!
  return JSON.parse(firstLine) as Record<string, unknown>
}

function nextSessionId(): string {
  counter += 1
  return `session-ub12-104-${counter}`
}

/** The process before the restart: a switch whose hook printed GUIDANCE, then the quit. */
async function switchedThenQuit(): Promise<string> {
  const sessionId = nextSessionId()
  const before = launch(sessionId, true, [GUIDANCE])
  await before.switchTo('claude-opus-5')
  expect(before.managed.pendingModelSwitchContext).toBe(GUIDANCE) // the live half, UB12.69's
  await before.manager.flushAllSessions()
  return sessionId
}

describe('UB12.104 — a PostModelSwitch context owed to the next prompt survives a quit', () => {
  it('POSITIVE: the switch writes it into the session header, and opening the chat after the restart restores it', async () => {
    const sessionId = await switchedThenQuit()
    expect(header(sessionId).pendingModelSwitchContext).toBe(GUIDANCE)

    const after = launch(sessionId, false)
    expect(after.managed.pendingModelSwitchContext).toBeUndefined() // the listing does not carry it; the door does
    await after.internals.ensureMessagesLoaded(after.managed)

    expect(after.managed.pendingModelSwitchContext).toBe(GUIDANCE)
  })

  it('POSITIVE: a write before the chat is opened (the cold-persist hydration) restores it and keeps it on disk', async () => {
    const sessionId = await switchedThenQuit()

    const after = launch(sessionId, false)
    after.internals.persistSession(after.managed)
    await after.manager.flushAllSessions()

    expect(after.managed.pendingModelSwitchContext).toBe(GUIDANCE)
    expect(header(sessionId).pendingModelSwitchContext).toBe(GUIDANCE)
  })

  it('POSITIVE end to end: the first prompt after the restart carries it once, fenced, and spends the stored copy', async () => {
    const sessionId = await switchedThenQuit()

    const after = launch(sessionId, false)
    await after.send('hello')
    await after.send('and again')
    await after.manager.flushAllSessions()

    const [first, second] = after.chatMessages
    expect(first).toContain(GUIDANCE)
    expect(first!.split(BAND_OPEN).length - 1).toBe(1)
    expect(second).not.toContain(GUIDANCE)
    expect(after.managed.pendingModelSwitchContext).toBeUndefined()
    expect('pendingModelSwitchContext' in header(sessionId)).toBe(false)
  })

  it('NEGATIVE: a context spent before the quit leaves no stored copy, and the restored session owes none', async () => {
    const sessionId = nextSessionId()
    const before = launch(sessionId, true, [GUIDANCE])
    await before.switchTo('claude-opus-5')
    await before.send('hello')
    expect(before.chatMessages[0]).toContain(GUIDANCE) // spent by the real send path, not by the test
    await before.manager.flushAllSessions()

    expect('pendingModelSwitchContext' in header(sessionId)).toBe(false)
    const after = launch(sessionId, false)
    await after.internals.ensureMessagesLoaded(after.managed)
    expect(after.managed.pendingModelSwitchContext).toBeUndefined()
  })

  it('BOUNDARY: a later switch whose hook printed nothing clears the stored copy too (only the last switch is owed)', async () => {
    const sessionId = nextSessionId()
    const before = launch(sessionId, true, [GUIDANCE, undefined])
    await before.switchTo('claude-opus-5')
    await before.manager.flushAllSessions()
    expect(header(sessionId).pendingModelSwitchContext).toBe(GUIDANCE)

    await before.switchTo('claude-sonnet-5')
    await before.manager.flushAllSessions()

    expect(before.managed.pendingModelSwitchContext).toBeUndefined()
    expect('pendingModelSwitchContext' in header(sessionId)).toBe(false)
  })
})
