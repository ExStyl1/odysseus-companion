/**
 * The host half of the session-command seam.
 *
 * `SessionManager.sendMessage` is where a `/compact` typed in the composer turns
 * into a turn, and where the backend's "Compacted …" info turns back into the
 * `compaction_complete` the renderer's pre-plan wait listens for. Neither end was
 * covered: the "Compacted" prefix is a load-bearing string contract between
 * `PiAgent.runSessionCommand` and `FreeFormInput`, and nothing pinned it.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentEvent } from '@nessy-agent/core/types'
import type { SessionEvent } from '@nessy-agent/shared/protocol'
import { SessionManager, createManagedSession } from '../SessionManager.ts'
import { createTestSessionManager } from './test-session-manager.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

interface Harness {
  manager: SessionManager
  managed: ReturnType<typeof createManagedSession>
  workspace: { id: string; rootPath: string }
  events: SessionEvent[]
  /** persistSession / flushSession call counters — the non-persistence proof. */
  counters: { persist: number; flush: number }
  internals: {
    persistSession(managed: unknown): void
    acquireCapabilityTurn(managed: unknown): Promise<() => void>
    createCapabilityTurn(managed: unknown): Promise<unknown>
    createRetainedCapabilityLease(leaseId: string): unknown
    getOrCreateAgent(managed: unknown, runtime: unknown): Promise<unknown>
  }
}

/** Manager + one managed session with the capability machinery stubbed out. */
function createHarness(mutate?: (managed: ReturnType<typeof createManagedSession>) => void): Harness {
  const stateRoot = mkdtempSync(join(tmpdir(), 'sm-session-command-'))
  roots.push(stateRoot)
  const workspace = {
    id: 'ws-session-command',
    name: 'Session Command Workspace',
    slug: 'session-command',
    rootPath: join(stateRoot, 'workspace'),
    createdAt: Date.now(),
  }
  mkdirSync(workspace.rootPath, { recursive: true })

  const manager: SessionManager = createTestSessionManager()
  const managed = createManagedSession(
    { id: 'session-command' },
    workspace as never,
    { messagesLoaded: true, ephemeral: true },
  )
  ;(manager as unknown as { sessions: Map<string, unknown> }).sessions.set(
    `${workspace.id}:${managed.id}`,
    managed,
  )
  mutate?.(managed)

  const events: SessionEvent[] = []
  manager.setEventSink(((_channel: unknown, _target: unknown, event: SessionEvent) => {
    events.push(event)
  }) as Parameters<SessionManager['setEventSink']>[0])

  const counters = { persist: 0, flush: 0 }
  const internals = manager as unknown as Harness['internals']
  internals.persistSession = () => { counters.persist += 1 }
  manager.flushSession = async () => { counters.flush += 1 }
  internals.acquireCapabilityTurn = async () => () => {}
  // D1.435 / F1.125 — BIND THE CAPABILITY LEASE THE WAY PRODUCTION BINDS IT, in
  // every case. This stub used to return a turn whose `leaseId` it never wrote
  // onto the managed session, so `withCapabilityRuntime`'s `finally` — guarded by
  // `managed.capabilityLeaseId === turn.snapshot.leaseId` — never fired here, and
  // the whole teardown class was invisible: that is how D1.398's five cases were
  // green on a build where a `/btw` on a cold chat failed 5 times out of 5.
  // Production's `createCapabilityTurn` assigns `managed.capabilityLeaseId` and
  // `managed.capabilityRuntime` before it returns; so does this, so a fake agent
  // that a turn publishes needs `lifecycleNoOps` below.
  internals.createCapabilityTurn = async (target: unknown) => {
    const runtime = { view: { sources: [] }, materializer: {} }
    const bound = target as { capabilityLeaseId?: string; capabilityRuntime?: unknown }
    bound.capabilityLeaseId = 'session-command-lease'
    bound.capabilityRuntime = runtime
    return { snapshot: { leaseId: 'session-command-lease' }, runtime }
  }
  internals.createRetainedCapabilityLease = () => ({ retain: () => () => {}, release: () => {} })

  return { manager, managed, workspace, events, counters, internals }
}

/**
 * The three lifecycle calls `withCapabilityRuntime`'s teardown makes on the
 * published agent (F1.125), as no-ops that RECORD the turn-runtime pair — so a
 * case can see the teardown run instead of inferring it. A fake without them
 * throws inside that `finally`, which is why the cases written before D1.435
 * could only stay green while the teardown never fired.
 */
function lifecycleNoOps(calls: string[]): Record<string, unknown> {
  return {
    setAutomationSystem: () => {},
    drainAutomationEvents: async () => {},
    setCapabilityTurnRuntime: (runtime: unknown) => {
      calls.push(runtime ? 'turn-runtime-set' : 'turn-runtime-cleared')
    },
  }
}

/** Drives one full turn with a scripted backend and records what `chat()` got. */
async function runTurn(
  message: string,
  backendEvents: AgentEvent[],
  mutate?: (managed: ReturnType<typeof createManagedSession>) => void,
): Promise<{ events: SessionEvent[]; chatMessages: string[]; managed: ReturnType<typeof createManagedSession> }> {
  const { manager, managed, workspace, events, internals } = createHarness(mutate)

  const chatMessages: string[] = []
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
    chat: async function* (text: string) {
      chatMessages.push(text)
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
      message,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { workspaceId: workspace.id },
    )
  } finally {
    manager.cleanup()
  }
  return { events, chatMessages, managed }
}

const COMPACTED_INFO: AgentEvent = {
  type: 'info',
  message: 'Compacted context to fit within limits (from ~12,345 tokens)',
}

describe('SessionManager and the session-command seam', () => {
  it('turns the backend "Compacted …" info into the compaction_complete the pre-plan wait needs', async () => {
    const { events } = await runTurn('/compact', [COMPACTED_INFO, { type: 'complete' }])

    const info = events.find(event => event.type === 'info' && 'statusType' in event && event.statusType === 'compaction_complete')
    expect(info).toBeDefined()
  })

  it('does not report compaction_complete for an ordinary info message', async () => {
    const { events } = await runTurn('hello', [
      { type: 'info', message: 'Retrying with fallback model' },
      { type: 'complete' },
    ])

    expect(events.some(event => event.type === 'info' && 'statusType' in event && event.statusType === 'compaction_complete')).toBe(false)
  })

  /**
   * f081 — a warning-level info (the Claude adapter's mapping of an
   * SDKInformationalMessage, e.g. a UserPromptSubmit hook's block reason)
   * threads its level onto the wire event AND persists with the same shape
   * reportHookErrors uses (role: 'info', infoLevel: 'warning'), so the reason
   * survives reload instead of disappearing with the renderer.
   */
  it('threads level onto the wire info event and persists a warning banner for reload', async () => {
    const reason = 'UserPromptSubmit hook blocked the prompt: contains a secret'
    const { events, managed } = await runTurn(
      'hello',
      [
        { type: 'info', message: reason, level: 'warning' },
        { type: 'complete' },
      ],
      m => { m.ephemeral = false },
    )

    const wire = events.find(event => event.type === 'info' && event.message === reason)
    expect(wire).toMatchObject({ level: 'warning' })

    const persisted = managed.messages.find(m => m.role === 'info' && m.infoLevel === 'warning')
    expect(persisted).toBeDefined()
    expect(persisted?.content).toBe(reason)
  })

  it('keeps non-warning levels transient and leaves un-levelled info byte-identical', async () => {
    const { events, managed } = await runTurn(
      'hello',
      [
        { type: 'info', message: 'Model fallback engaged', level: 'info' },
        { type: 'info', message: 'plain banner' },
        { type: 'complete' },
      ],
      m => { m.ephemeral = false },
    )

    const levelled = events.find(event => event.type === 'info' && event.message === 'Model fallback engaged')
    expect(levelled).toMatchObject({ level: 'info' })

    // No level on the backend event -> no level key on the wire (today's shape).
    const plain = events.find(event => event.type === 'info' && event.message === 'plain banner')
    expect(plain).toBeDefined()
    expect('level' in plain!).toBe(false)

    // Neither non-warning banner reached the transcript.
    expect(managed.messages.some(m => m.role === 'info')).toBe(false)
  })

  /**
   * The host's model-only decorations are prefixes and suffixes on the message
   * `chat()` receives. A session command never reaches the model, so decorating
   * one would only hide it from the seam again — the same failure, one layer up.
   * The interruption reminder stands in for all three (it is also the one a
   * "Stop, then Accept & Compact" actually hits).
   */
  it('hands a session command to the backend undecorated, and keeps the decoration for the next prompt', async () => {
    const { chatMessages, managed } = await runTurn('/compact', [COMPACTED_INFO, { type: 'complete' }], m => {
      m.wasInterrupted = true
    })

    expect(chatMessages).toEqual(['/compact'])
    expect(managed.wasInterrupted).toBe(true)
  })

  it('still decorates an ordinary prompt', async () => {
    const { chatMessages, managed } = await runTurn('hello', [{ type: 'complete' }], m => {
      m.wasInterrupted = true
    })

    expect(chatMessages[0]).toContain('hello')
    expect(chatMessages[0]).toContain('The previous assistant response was interrupted')
    expect(managed.wasInterrupted).toBe(false)
  })

  /**
   * R36/f074 — `/clear` rides the EXISTING isSessionCommand path (undecorated,
   * straight to `chat()`), and when the seam's turn completes the managed state
   * resets copy-shaped from the rewind path: live transcript emptied, streaming
   * and badge trackers cleared, the persisted resume anchor dropped.
   */
  it('resets the managed session state after a /clear turn completes', async () => {
    const { chatMessages, managed } = await runTurn(
      '/clear',
      [{ type: 'info', message: 'Context cleared — the next prompt starts a fresh conversation.' }, { type: 'complete' }],
      m => {
        m.messages.push(
          { id: 'm1', role: 'user', content: 'first', timestamp: 1 } as never,
          { id: 'm2', role: 'assistant', content: 'second', timestamp: 2 } as never,
        )
        m.lastMessageRole = 'assistant'
        m.lastFinalMessageId = 'm2'
        m.sdkSessionId = 'sdk-123'
        m.streamingText = 'partial'
      },
    )

    // Undecorated command, same contract as /compact above.
    expect(chatMessages).toEqual(['/clear'])
    // The reset wiped the seeded history AND the '/clear' user entry itself.
    expect(managed.messages).toHaveLength(0)
    expect(managed.sdkSessionId).toBeUndefined()
    expect(managed.lastMessageRole).toBeUndefined()
    expect(managed.lastFinalMessageId).toBeUndefined()
    expect(managed.streamingText).toBe('')
  })

  /**
   * F1.1290 — a `/clear` in a BRANCHED chat before its first thread open. The host
   * retires its fork anchor only when the child's own session id arrives
   * (`onSdkSessionIdUpdate`), which a `/clear` on a never-opened branch never
   * produces, so the anchor survived the clear and the next agent build (a
   * relaunch, a rebuild before the next ask) forked the parent again and the
   * cleared history came back. The clear drops it; the lineage stays.
   */
  it('drops a branch\'s fork anchor on /clear and keeps its lineage', async () => {
    const parent = { workspaceId: 'ws-session-command', sessionId: 'parent-session' }
    const { managed } = await runTurn(
      '/clear',
      [{ type: 'info', message: 'Context cleared — the next prompt starts a fresh conversation.' }, { type: 'complete' }],
      m => {
        m.branchFromParent = parent
        m.branchFromMessageId = 'parent-m2'
        m.branchContextStrategy = 'sdk-fork'
        m.branchFromSdkSessionId = 'parent-thread'
        m.branchFromSdkCwd = '/parent/cwd'
        m.branchFromSdkTurnId = 'parent-turn'
      },
    )
    expect(managed.branchFromSdkSessionId).toBeUndefined()
    expect(managed.branchFromSdkCwd).toBeUndefined()
    expect(managed.branchFromSdkTurnId).toBeUndefined()
    expect(managed.branchFromParent).toEqual(parent)
    expect(managed.branchFromMessageId).toBe('parent-m2')
  })

  it('keeps a branch\'s fork anchor across a /compact turn (only /clear drops it)', async () => {
    const { managed } = await runTurn('/compact', [COMPACTED_INFO, { type: 'complete' }], m => {
      m.branchFromParent = { workspaceId: 'ws-session-command', sessionId: 'parent-session' }
      m.branchFromMessageId = 'parent-m2'
      m.branchContextStrategy = 'sdk-fork'
      m.branchFromSdkSessionId = 'parent-thread'
      m.branchFromSdkCwd = '/parent/cwd'
      m.branchFromSdkTurnId = 'parent-turn'
    })
    expect(managed.branchFromSdkSessionId).toBe('parent-thread')
    expect(managed.branchFromSdkCwd).toBe('/parent/cwd')
    expect(managed.branchFromSdkTurnId).toBe('parent-turn')
  })
})

/**
 * R36/f124/f183 — the out-of-band commands. A typed `/btw` or `/recap` must
 * NEVER become a model turn on the sendMessage path, and the side-question /
 * recap answers must never touch the transcript or the session file
 * (interactive-mode.md:365 — "never enter the conversation history"). The
 * persist/flush counters are the "writes no session file" proof: the harness
 * counts every route to disk the manager has.
 */
describe('SessionManager and the out-of-band side channel', () => {
  it('rejects a typed /btw from sendMessage outright — no turn, no transcript entry', async () => {
    const { manager, managed, workspace, events, counters } = createHarness()
    try {
      await expect(manager.sendMessage(
        managed.id,
        '/btw what was that config file?',
        undefined, undefined, undefined, undefined, undefined, undefined,
        { workspaceId: workspace.id },
      )).rejects.toThrow('out-of-band')

      expect(managed.messages).toHaveLength(0)
      expect(events.some(event => event.type === 'user_message')).toBe(false)
      expect(counters.persist).toBe(0)
      expect(counters.flush).toBe(0)
    } finally {
      manager.cleanup()
    }
  })

  it('rejects a typed /recap from sendMessage the same way', async () => {
    const { manager, managed, workspace, events } = createHarness()
    try {
      await expect(manager.sendMessage(
        managed.id,
        '/recap',
        undefined, undefined, undefined, undefined, undefined, undefined,
        { workspaceId: workspace.id },
      )).rejects.toThrow('out-of-band')

      expect(managed.messages).toHaveLength(0)
      expect(events.some(event => event.type === 'user_message')).toBe(false)
    } finally {
      manager.cleanup()
    }
  })

  /**
   * The doc-bound invariant, at the closest SessionManager-adjacent surface:
   * an askSideQuestion round-trip leaves `managed.messages` length unchanged
   * and writes no session file (persist and flush never called), while the
   * session is mid-turn (`isProcessing` — interactive-mode.md:367).
   */
  it('askSideQuestion answers from the transcript without persisting, mid-turn', async () => {
    const { manager, managed, workspace, events, counters } = createHarness(m => {
      m.messages.push(
        { id: 'm1', role: 'user', content: 'first', timestamp: 1 } as never,
        { id: 'm2', role: 'assistant', content: 'second', timestamp: 2 } as never,
        { id: 'm3', role: 'assistant', content: 'stream chunk', timestamp: 3, isIntermediate: true } as never,
      )
      m.isProcessing = true
    })
    try {
      let seenTranscript: unknown
      managed.agent = {
        askSideQuestion: async (input: { question: string; transcript: unknown }) => {
          seenTranscript = input.transcript
          return { text: 'the answer' }
        },
      } as never

      const result = await manager.askSideQuestion(managed.id, 'what was that?', workspace.id)

      expect(result).toEqual({ success: true, text: 'the answer' })
      // Full visibility, intermediate stream entries excluded.
      expect(seenTranscript).toEqual([
        { type: 'user', content: 'first' },
        { type: 'assistant', content: 'second' },
      ])
      expect(managed.messages).toHaveLength(3)
      expect(counters.persist).toBe(0)
      expect(counters.flush).toBe(0)
      expect(events).toHaveLength(0)
    } finally {
      manager.cleanup()
    }
  })

  it('askSideQuestion returns the typed empty-question error — the renderer owns the bare-/btw reopen', async () => {
    const { manager, managed, workspace } = createHarness()
    try {
      managed.agent = {
        askSideQuestion: async () => {
          throw new Error('must not be called for an empty question')
        },
      } as never

      expect(await manager.askSideQuestion(managed.id, '   ', workspace.id))
        .toEqual({ success: false, error: 'empty-question' })
    } finally {
      manager.cleanup()
    }
  })

  /**
   * D1.398 — OWNER, 2026-09-19, screenshot: on a `pi` card the first thing typed
   * into the new `/btw` composer came back as a red bubble reading the raw code
   * `agent-not-started`. R36 refused BY DESIGN there ("a command that must stay
   * weightless"); the owner's posture supersedes it — a side question is a chat,
   * so a chat whose agent has not started yet STARTS one, through the ordinary
   * send's own `getOrCreateAgent` and nothing else. Creating the agent is not a
   * capability TURN: the answer still rides the tool-less `queryLlm` route and
   * nothing is pushed, persisted or emitted, which the counters below pin.
   */
  it('askSideQuestion starts the agent on a chat that has none, and stays weightless', async () => {
    const { manager, managed, workspace, internals, counters, events } = createHarness()
    try {
      const runtimes: unknown[] = []
      const calls: string[] = []
      internals.getOrCreateAgent = async (m, runtime) => {
        runtimes.push(runtime)
        const started = {
          ...lifecycleNoOps(calls),
          askSideQuestion: async () => { calls.push('ask'); return { text: 'a general answer' } },
        }
        ;(m as { agent?: unknown }).agent = started
        return started
      }
      expect(managed.agent).toBeFalsy()

      const result = await manager.askSideQuestion(managed.id, 'what is a git rebase?', workspace.id)

      expect(result).toEqual({ success: true, text: 'a general answer' })
      // F1.125 — the capability-turn teardown RAN, after the answer: the lease the
      // turn bound is released and the agent's turn runtime cleared.
      expect(calls).toEqual(['ask', 'turn-runtime-cleared'])
      expect(managed.capabilityLeaseId).toBeUndefined()
      // Exactly one start, and it was handed a capability runtime — the same
      // argument the send path's start gets, not an invented default.
      expect(runtimes).toHaveLength(1)
      expect(runtimes[0]).toBeDefined()
      // Still weightless: no transcript entry, no session file, no event.
      expect(managed.messages).toHaveLength(0)
      expect(counters.persist).toBe(0)
      expect(counters.flush).toBe(0)
      expect(events).toHaveLength(0)
    } finally {
      manager.cleanup()
    }
  })

  /**
   * The control for the case above: ONE start method serves both paths. The
   * harness stubs exactly one — `getOrCreateAgent` — and a side question on a
   * cold session and a full `sendMessage` turn both come through it, so the spy
   * above is a spy on the SEND path's start rather than on a second one.
   */
  it('one start method serves both a side question and an ordinary send', async () => {
    const { manager, managed, workspace, internals } = createHarness()
    try {
      let starts = 0
      const calls: string[] = []
      const agent = {
        isProcessing: () => false,
        setAllSources: () => {},
        setSourceServers: async () => {},
        getModel: () => 'test-model',
        getSessionId: () => undefined,
        ...lifecycleNoOps(calls),
        forceAbort: () => {},
        dispose: () => {},
        updateWorkingDirectory: () => {},
        updateSdkCwd: () => {},
        chat: async function* () { yield { type: 'complete' } as AgentEvent },
        askSideQuestion: async () => ({ text: 'the answer' }),
      }
      internals.getOrCreateAgent = async () => {
        starts += 1
        managed.agent = agent as never
        return agent
      }

      expect(await manager.askSideQuestion(managed.id, 'what is this chat about?', workspace.id))
        .toEqual({ success: true, text: 'the answer' })
      expect(starts).toBe(1)
      // F1.125 — both paths end their capability turn the same way.
      expect(calls).toEqual(['turn-runtime-cleared'])

      await manager.sendMessage(
        managed.id,
        'hello',
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        { workspaceId: workspace.id },
      )
      expect(starts).toBe(2)
      expect(calls.at(-1)).toBe('turn-runtime-cleared')
      expect(managed.capabilityLeaseId).toBeUndefined()
    } finally {
      manager.cleanup()
    }
  })

  /**
   * A live agent is REUSED, never restarted — the half of R36's posture that
   * survives the owner's ruling. `:367` says a side question must work while the
   * model is working, and mid-turn `managed.agent` is always present, so the
   * start path above is reached only by a cold chat and can never make a side
   * question wait on the capability turn a live turn is holding.
   *
   * This is also the CONTROL that the instrument reads the real file: it passes
   * at HEAD and after the fix, where the four cases around it are red at HEAD.
   */
  it('askSideQuestion reuses a live agent without starting a second one', async () => {
    const { manager, managed, workspace, internals } = createHarness(m => { m.isProcessing = true })
    try {
      let starts = 0
      internals.getOrCreateAgent = async () => { starts += 1; return {} }
      managed.agent = { askSideQuestion: async () => ({ text: 'mid-turn answer' }) } as never

      expect(await manager.askSideQuestion(managed.id, 'what was that?', workspace.id))
        .toEqual({ success: true, text: 'mid-turn answer' })
      expect(starts).toBe(0)
    } finally {
      manager.cleanup()
    }
  })

  /**
   * A start that FAILS is its own fact, with its own sentence in the panel — it
   * is not the old `agent-not-started` (which said "we declined to try") and it
   * is not a thrown error either, because the DTO's posture is a typed result.
   */
  it('askSideQuestion reports agent-start-failed when the start throws', async () => {
    const { manager, managed, workspace, internals } = createHarness()
    try {
      internals.getOrCreateAgent = async () => { throw new Error('backend refused to start') }

      expect(await manager.askSideQuestion(managed.id, 'anything', workspace.id))
        .toEqual({ success: false, error: 'agent-start-failed' })
    } finally {
      manager.cleanup()
    }
  })

  it('generateSessionRecap starts the agent the same way', async () => {
    const { manager, managed, workspace, internals, counters } = createHarness(m => {
      m.messages.push(
        { id: 'm1', role: 'user', content: 'refactor the parser', timestamp: 1 } as never,
        { id: 'm2', role: 'assistant', content: 'done, tests green', timestamp: 2 } as never,
      )
    })
    try {
      let starts = 0
      const calls: string[] = []
      internals.getOrCreateAgent = async (m) => {
        starts += 1
        const started = {
          ...lifecycleNoOps(calls),
          runMiniCompletion: async () => { calls.push('recap'); return 'Parser refactored; tests green.' },
        }
        ;(m as { agent?: unknown }).agent = started
        return started
      }

      expect(await manager.generateSessionRecap(managed.id, workspace.id))
        .toEqual({ success: true, text: 'Parser refactored; tests green.' })
      expect(starts).toBe(1)
      expect(counters.persist).toBe(0)
      // F1.125 — the teardown ran, after the completion.
      expect(calls).toEqual(['recap', 'turn-runtime-cleared'])
      expect(managed.capabilityLeaseId).toBeUndefined()
    } finally {
      manager.cleanup()
    }
  })

  /**
   * R49/f210 — `/heapdump` (troubleshooting.md:39). The sendMessage guard is
   * the backstop that keeps a snapshot holding every credential in the process
   * from ever becoming a model turn; `heapdump()` itself persists exactly ONE
   * badged summary message via the runShellCommand idiom.
   */
  it('rejects a typed /heapdump from sendMessage outright — never a model turn', async () => {
    const { manager, managed, workspace, events, counters } = createHarness()
    try {
      await expect(manager.sendMessage(
        managed.id,
        '/heapdump',
        undefined, undefined, undefined, undefined, undefined, undefined,
        { workspaceId: workspace.id },
      )).rejects.toThrow('use the heapdump session command')

      expect(managed.messages).toHaveLength(0)
      expect(events.some(event => event.type === 'user_message')).toBe(false)
      expect(counters.persist).toBe(0)
      expect(counters.flush).toBe(0)
    } finally {
      manager.cleanup()
    }
  })

  it('heapdump() dumps host + pi and persists exactly ONE badged summary message', async () => {
    const { manager, managed, workspace, events, counters } = createHarness()
    try {
      const writerCalls: Array<{ baseName: string }> = []
      ;(manager as unknown as { heapdumpWriter: (options: { baseName: string }) => unknown }).heapdumpWriter =
        (options: { baseName: string }) => {
          writerCalls.push({ baseName: options.baseName })
          return {
            success: true,
            wroteTo: 'desktop',
            snapshotPath: `/fake/Desktop/${options.baseName}.heapsnapshot`,
            diagnosticsPath: `/fake/Desktop/${options.baseName}-diagnostics.json`,
            memory: { rss: 1000, heapUsed: 600, heapTotal: 700, external: 100, arrayBuffers: 50, unaccountedNative: 200 },
          }
        }
      // A Pi row that ERRORED (e.g. an old subprocess bundle timing out) still
      // rides the summary instead of failing the command.
      managed.agent = {
        requestHeapdump: async () => ({ success: false, errorMessage: 'heapdump timed out after 15s' }),
      } as never

      const result = await manager.heapdump(managed.id, workspace.id)

      expect(result.success).toBe(true)
      expect(result.wroteTo).toBe('desktop')
      expect(result.snapshotPath).toBe('/fake/Desktop/session-command.heapsnapshot')
      // Host dump base name IS the session id (troubleshooting.md:39 —
      // `<session-id>.heapsnapshot`).
      expect(writerCalls).toEqual([{ baseName: 'session-command' }])

      expect(managed.messages).toHaveLength(1)
      const summary = managed.messages[0]!
      expect(summary.role).toBe('user')
      expect(summary.badges).toEqual([{ type: 'command', label: '/heapdump', rawText: '/heapdump', start: 0, end: 9 }])
      expect(summary.content.startsWith('/heapdump')).toBe(true)
      // The four documented numbers and the heap-vs-native verdict
      // (troubleshooting.md:45).
      expect(summary.content).toContain('resident set size')
      expect(summary.content).toContain('JS heap')
      expect(summary.content).toContain('array buffers')
      expect(summary.content).toContain('unaccounted native memory')
      expect(summary.content).toContain('most memory is in the JS heap')
      expect(summary.content).toContain('session-command.heapsnapshot')
      expect(summary.content).toContain('heapdump timed out after 15s')
      // The privacy warning is part of the contract (troubleshooting.md:41,49).
      expect(summary.content).toContain('attach only the -diagnostics.json file')

      expect(counters.persist).toBe(1)
      expect(counters.flush).toBe(1)
      expect(events.filter(event => event.type === 'user_message')).toHaveLength(1)
    } finally {
      manager.cleanup()
    }
  })

  it('generateSessionRecap returns one line and persists nothing', async () => {
    const { manager, managed, workspace, events, counters } = createHarness(m => {
      m.messages.push(
        { id: 'm1', role: 'user', content: 'refactor the parser', timestamp: 1 } as never,
        { id: 'm2', role: 'assistant', content: 'done, tests green', timestamp: 2 } as never,
      )
    })
    try {
      let seenPrompt = ''
      managed.agent = {
        runMiniCompletion: async (prompt: string) => {
          seenPrompt = prompt
          return 'Parser refactored;\ntests green.'
        },
      } as never

      const result = await manager.generateSessionRecap(managed.id, workspace.id)

      // The one-line form is enforced structurally (interactive-mode.md:400).
      expect(result).toEqual({ success: true, text: 'Parser refactored; tests green.' })
      expect(seenPrompt).toContain('refactor the parser')
      expect(managed.messages).toHaveLength(2)
      expect(counters.persist).toBe(0)
      expect(counters.flush).toBe(0)
      expect(events).toHaveLength(0)
    } finally {
      manager.cleanup()
    }
  })

  /**
   * The agent a COLD chat gets: a freshly constructed backend whose subprocess
   * has not spawned yet.
   *
   * `askSideQuestion`'s refusal is not invented — `PiAgent.spawnSubprocess`
   * throws *"Pi capability runtime manifest is required before subprocess
   * spawn"* whenever `capabilityTurnRuntime` is absent, and `PiAgent.queryLlm`,
   * which is the route `BaseAgent.askSideQuestion` takes, goes through
   * `ensureSubprocess` first. So this models the guard production really holds
   * at this moment in the lifecycle rather than planting a collaborator
   * production lacks. That half is a PI portrait on purpose: `ClaudeAgent`
   * answers from the SDK `query()` and `CodexAgent` posts to its upstream
   * directly, neither reading the turn runtime, so neither could raise it.
   *
   * `runMiniCompletion` is every runtime's portrait since F1.127: `PiAgent`'s
   * cold-spawns only for a caller holding a capability turn (this lease), so a
   * cold `/recap` now answers on pi too; before F1.127 it refused to cold-spawn
   * at all and answered `null`, so pi reported `recap-unavailable` both before
   * and after D1.435 — it never carried D1.435's user-visible refusal. Claude's
   * and codex's read no turn runtime and always answered. What the recap case
   * below pins is the STRUCTURE (the lease spans the work); F1.127's own test
   * (`pi-cold-recap-mini-completion.test.ts`) pins the pi outcome.
   */
  function createColdStartAgent(calls: string[]): Record<string, unknown> {
    let turnRuntime: unknown = null
    return {
      setAutomationSystem: () => {},
      drainAutomationEvents: async () => {},
      setCapabilityTurnRuntime: (runtime: unknown) => {
        turnRuntime = runtime
        calls.push(runtime ? 'turn-runtime-set' : 'turn-runtime-cleared')
      },
      askSideQuestion: async () => {
        calls.push('ask')
        if (!turnRuntime) throw new Error('Pi capability runtime manifest is required before subprocess spawn')
        return { text: 'a general answer' }
      },
      runMiniCompletion: async () => {
        calls.push('recap')
        return 'Parser refactored; tests green.'
      },
    }
  }

  /** Publish the cold-start agent the way `getOrCreateAgent` publishes one. */
  function startColdAgent(harness: Harness, calls: string[]): void {
    harness.internals.getOrCreateAgent = async (managed: unknown, runtime: unknown) => {
      const agent = createColdStartAgent(calls)
      ;(managed as { agent?: unknown }).agent = agent
      // Production's `getOrCreateAgent` hands the turn runtime to the agent it
      // publishes, for a created agent and for a refreshed one alike.
      ;(agent.setCapabilityTurnRuntime as (r: unknown) => void)(runtime)
      return agent
    }
  }

  /**
   * D1.435, RELEASE BLOCKER, measured by SIT-9 on the packaged 1.40.0: a side
   * question on a chat that has never run a turn came back *"Pi capability
   * runtime manifest is required before subprocess spawn"*, 5 cold chats out of
   * 5, while the same question on a chat that had run one turn answered in the
   * same run.
   *
   * D1.398 started the agent through the ordinary send's own path, which is
   * right — but it took the agent as `withCapabilityRuntime`'s RETURN VALUE, and
   * that wrapper's `finally` clears the agent's turn runtime on the way out. So
   * the agent handed back had already lost the manifest one statement before it
   * was used. `sendMessage` never met this because it holds the turn for the
   * whole turn; a live agent never met it because its subprocess already exists
   * — exactly the warm/cold split SIT-9 measured.
   *
   * The assertion is the MECHANISM as well as the outcome: the turn runtime is
   * cleared AFTER the question has been asked, never before it.
   */
  it('askSideQuestion answers on a chat that has never run a turn, with the capability turn still held', async () => {
    const harness = createHarness()
    const { manager, managed, workspace, counters, events } = harness
    try {
      const calls: string[] = []
      startColdAgent(harness, calls)
      expect(managed.agent).toBeFalsy()

      const result = await manager.askSideQuestion(managed.id, 'what is a git rebase?', workspace.id)

      expect(result).toEqual({ success: true, text: 'a general answer' })
      expect(calls).toEqual(['turn-runtime-set', 'ask', 'turn-runtime-cleared'])
      // Still weightless: no transcript entry, no session file, no event.
      expect(managed.messages).toHaveLength(0)
      expect(counters.persist).toBe(0)
      expect(counters.flush).toBe(0)
      expect(events).toHaveLength(0)
    } finally {
      manager.cleanup()
    }
  })

  /**
   * The recap twin, and the honest version of it. It takes its agent from the
   * same helper, so it had the same SHAPE — the lease was released before the
   * completion ran — but not the same user-visible failure: `PiAgent`'s own
   * `runMiniCompletion` did not cold-spawn before F1.127, and claude's and codex's
   * read no turn runtime at all, so nothing measured here was refused. What this pins is that
   * the ONE helper now spans the work for both callers, so the next backend
   * whose mini completion does need the turn cannot re-open D1.435 quietly.
   */
  it('generateSessionRecap answers on a chat that has never run a turn, inside the same held lease', async () => {
    const harness = createHarness(m => {
      m.messages.push(
        { id: 'm1', role: 'user', content: 'refactor the parser', timestamp: 1 } as never,
        { id: 'm2', role: 'assistant', content: 'done, tests green', timestamp: 2 } as never,
      )
    })
    const { manager, managed, workspace, counters, events } = harness
    try {
      const calls: string[] = []
      startColdAgent(harness, calls)
      expect(managed.agent).toBeFalsy()

      const result = await manager.generateSessionRecap(managed.id, workspace.id)

      expect(result).toEqual({ success: true, text: 'Parser refactored; tests green.' })
      expect(calls).toEqual(['turn-runtime-set', 'recap', 'turn-runtime-cleared'])
      expect(managed.messages).toHaveLength(2)
      expect(counters.persist).toBe(0)
      expect(counters.flush).toBe(0)
      expect(events).toHaveLength(0)
    } finally {
      manager.cleanup()
    }
  })

  /**
   * THE WARM CONTROL, and it can fail: a live agent's side question must take NO
   * capability turn at all. `:367` ("Available while Claude is working") depends
   * on it — mid-turn the session is already holding its own turn, so a side
   * question that queued behind one would wait for the model to finish, which is
   * the opposite of the feature. This is the arm that goes red if the fix is
   * ever widened into "always acquire a turn", and it is green at HEAD, which
   * is what says the two cases above are reading the real file.
   */
  it('a live agent answers a side question without taking a capability turn', async () => {
    const harness = createHarness(m => { m.isProcessing = true })
    const { manager, managed, workspace } = harness
    try {
      let turns = 0
      const releaseTurn = harness.internals.acquireCapabilityTurn.bind(harness.internals)
      harness.internals.acquireCapabilityTurn = async (m: unknown) => {
        turns += 1
        return releaseTurn(m)
      }
      let starts = 0
      harness.internals.getOrCreateAgent = async () => { starts += 1; return {} }
      managed.agent = { askSideQuestion: async () => ({ text: 'mid-turn answer' }) } as never

      expect(await manager.askSideQuestion(managed.id, 'what was that?', workspace.id))
        .toEqual({ success: true, text: 'mid-turn answer' })
      expect(starts).toBe(0)
      expect(turns).toBe(0)
    } finally {
      manager.cleanup()
    }
  })
})
