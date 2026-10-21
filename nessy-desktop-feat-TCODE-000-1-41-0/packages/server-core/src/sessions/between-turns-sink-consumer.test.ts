/**
 * L1 — WHO CONSUMES A SESSION-LEVEL EVENT WHEN NO TURN IS OPEN.
 *
 * The design routes between-turns traffic to a "session-level sink". A sink with
 * no consumer is a thing whose only owner is a function that returns, so L1 had
 * to name a real path to the renderer or say one must be built.
 *
 * It does not have to be built. `SessionManager.processEvent` is a standalone
 * method (SessionManager.ts:20378), and `sendEvent` → `eventSink` → RPC is not
 * bound to the chat loop at all. The repo already calls `processEvent` with no
 * turn open: `recordForkResultInTranscript` (`:6495`) replays a
 * `tool_start`/`tool_result` pair for a BACKGROUND fork whose child turn was
 * started with `void run` (`:11763`) and settles after the parent's turn ended.
 * `deliverMonitorEvent` (`:3202`) is the other half — the class of event that
 * must reach the MODEL rather than only the screen — and it is already fed by
 * session-lifetime producers that never touch the chat loop
 * (`ensureSessionChannelSubscription`, `:2856`).
 *
 * What is missing is only the PUMP: nothing pulls AgentEvents out of a backend
 * between turns, because `agent.chat(` is iterated in exactly one place.
 *
 * These tests pin the consumer half so L2 can be built against it, and pin the
 * one reason the sink needs a WHITELIST rather than "anything with no slot open".
 */
import { afterEach, describe, expect, it } from 'bun:test'
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

interface Rig {
  manager: SessionManager
  managed: { id: string; isProcessing: boolean } & Record<string, unknown>
  events: SessionEvent[]
  deliver(event: AgentEvent): Promise<void>
}

function createRig(): Rig {
  const stateRoot = mkdtempSync(join(tmpdir(), 'sm-between-turns-sink-'))
  roots.push(stateRoot)
  const workspace = {
    id: 'ws-between-turns',
    name: 'Between Turns Workspace',
    slug: 'between-turns',
    rootPath: join(stateRoot, 'workspace'),
    createdAt: Date.now(),
  }
  mkdirSync(workspace.rootPath, { recursive: true })

  const manager: SessionManager = createTestSessionManager()
  const managed = createManagedSession(
    { id: 'session-between-turns' },
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

  const internals = manager as unknown as {
    processEvent(managed: unknown, event: AgentEvent): Promise<void>
  }

  return {
    manager,
    managed: managed as never,
    events,
    deliver: (event: AgentEvent) => internals.processEvent(managed, event),
  }
}

describe('a between-turns consumer already exists (L1)', () => {
  it('processEvent reaches the renderer with NO turn open', async () => {
    const rig = createRig()
    // The state a between-turns event arrives in: nothing is processing, and
    // no chat loop is iterating anything.
    expect(rig.managed.isProcessing).toBeFalsy()

    await rig.deliver({
      type: 'shell_backgrounded',
      toolUseId: 'tool-1',
      shellId: 'shell-1',
      command: 'sleep 60',
    })

    const forwarded = rig.events.find(event => event.type === 'shell_backgrounded')
    expect(forwarded).toBeDefined()
    expect((forwarded as { shellId: string }).shellId).toBe('shell-1')
    // And it landed on the session's own state, not only on the wire.
    expect(
      (rig.managed as unknown as { backgroundShellCommands: Map<string, string> })
        .backgroundShellCommands.get('shell-1'),
    ).toBe('sleep 60')

    // L2 may route the sink anywhere it likes. It does NOT need a new transport:
    // this is the same `sendEvent` → `eventSink` path the chat loop uses, and it
    // works with the turn closed.
  })

  it('a tool pair replayed between turns produces the transcript entry, exactly as the background-fork path relies on', async () => {
    // `recordForkResultInTranscript` does precisely this, for a fork whose child
    // was started with `void run`. It is the shipping proof that `processEvent`
    // is safe to call outside the loop.
    const rig = createRig()

    await rig.deliver({
      type: 'tool_start',
      toolName: 'subagent',
      toolUseId: 'subtask-agent-1',
      input: { agent: 'fork', task: 'do the thing' },
    } as AgentEvent)
    await rig.deliver({
      type: 'tool_result',
      toolName: 'subagent',
      toolUseId: 'subtask-agent-1',
      input: { agent: 'fork', task: 'do the thing' },
      result: 'done',
      isError: false,
    } as AgentEvent)

    expect(rig.events.some(event => event.type === 'tool_start')).toBe(true)
    expect(rig.events.some(event => event.type === 'tool_result')).toBe(true)
    const messages = (rig.managed as unknown as { messages: Array<{ role: string }> }).messages
    expect(messages.some(message => message.role === 'tool')).toBe(true)
  })

  it('WHITELIST REQUIRED: a `complete` on the sink parks turn state for the NEXT turn', async () => {
    // The reason the sink cannot be "every event that arrives with no slot
    // open". `processEvent`'s `complete` case parks `terminalReason`,
    // `terminalIsError` and the structured-output fields on the session, and
    // `onProcessingStopped` reads them when the next turn ends. A stray
    // between-turns `complete` would therefore mislabel a turn that has not
    // started yet.
    const rig = createRig()

    await rig.deliver({
      type: 'complete',
      terminalReason: 'provider_error',
      terminalIsError: true,
    } as AgentEvent)

    const managed = rig.managed as unknown as {
      turnTerminalReason?: string
      turnTerminalIsError?: boolean
    }
    expect(managed.turnTerminalReason).toBe('provider_error')
    expect(managed.turnTerminalIsError).toBe(true)

    // SETTLED BY L2 as "admit nothing between turns", and WIDENED by F1.492 and
    // F1.511 to the whitelist this test argues for: `ClaudeAgent.noteBetweenTurnsMessage`
    // hands the host door (`BackendConfig.onBetweenTurnsEvent`) a background
    // task's row feed and `task_completed`, and the main thread's `text_complete`,
    // `tool_start` and `tool_result` of a turn the CLI opens itself (each result
    // through the host turn's large-result guard). Everything else — a subagent's
    // own messages, `complete`, status, usage — is still logged and dropped, so
    // the parking behaviour asserted above is still why the list stays a list.
  })
})
