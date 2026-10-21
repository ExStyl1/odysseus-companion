/**
 * UB12.69 — a `PostModelSwitch` hook's context reaches the model with the next
 * prompt after the switch, on every runtime.
 *
 * hooks.md § Exit code 0 (curl'd 2026-10-17) names FOUR events whose exit-0
 * plain stdout is context — `UserPromptSubmit`, `UserPromptExpansion`,
 * `SessionStart` and `PostModelSwitch` — and
 * `hooks.md#postmodelswitch-decision-control` says when it arrives: Claude Code
 * "takes your hook's plain-text stdout on exit 0, or `additionalContext` from
 * JSON output, and delivers it to Claude with the next request after the
 * switch", and "If the model changes several times before the next request,
 * Claude Code delivers only the output for the last switch's target model."
 *
 * Before this row the host fired the event and dropped its result
 * (`runModelSwitchHook` returned `{}` for Post), so the page's own example — an
 * `echo` of model-specific guidance — never reached the model on any runtime.
 *
 * What runs for real: `updateSessionModel` (Pre, the write, Post, through
 * `withPinnedConfigChange`) and `sendMessage`'s composition of the text the
 * backend's `chat()` receives. The automation system answers what the executor
 * produces for a hook that printed text (`decision.additionalContext`, which
 * `hookCommandStdoutContext` fills from plain stdout — pinned in shared's
 * `hook-stdout-context.test.ts`). The host has no per-runtime branch here (the
 * event is host-emitted on Pi, claude-runtime and codex, D1.165), so one stub
 * backend stands for all three.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentEvent } from '@nessy-agent/core/types'
import { SessionManager, createManagedSession } from '../SessionManager.ts'
import { createTestSessionManager } from './test-session-manager.ts'

const roots: string[] = []
const managers: SessionManager[] = []

afterEach(() => {
  for (const manager of managers.splice(0)) manager.cleanup()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const GUIDANCE = 'On Opus, delegate implementation work to subagents and keep this conversation for planning and review.'
const BAND_OPEN = '<hook_context event="PostModelSwitch">'

interface Answers {
  /** What each `PostModelSwitch` run answers with, in order; `undefined` = a hook that printed nothing. */
  post: Array<string | undefined>
  /** `additionalContext` a `PreModelSwitch` hook returns — a field the page never gives that event. */
  pre?: string
}

function harness(answers: Answers) {
  const stateRoot = mkdtempSync(join(tmpdir(), 'ub12-69-'))
  roots.push(stateRoot)
  const workspace = { id: 'ws-ub12-69', name: 'UB12.69', slug: 'ub12-69', rootPath: join(stateRoot, 'workspace'), createdAt: Date.now() }
  mkdirSync(workspace.rootPath, { recursive: true })

  const manager = createTestSessionManager()
  managers.push(manager)
  manager.setEventSink((() => {}) as Parameters<SessionManager['setEventSink']>[0])
  const managed = createManagedSession({ id: 'ub12-69-session' }, workspace as never, { messagesLoaded: true, ephemeral: true })
  ;(manager as unknown as { sessions: Map<string, unknown> }).sessions.set(`${workspace.id}:${managed.id}`, managed)

  const fired: string[] = []
  const system = {
    async executeAgentEvent(event: string) {
      fired.push(event)
      if (event === 'PostModelSwitch') {
        const text = answers.post.shift()
        return text === undefined ? { matchedCount: 1 } : { matchedCount: 1, decision: { additionalContext: text } }
      }
      if (event === 'PreModelSwitch' && answers.pre) return { matchedCount: 1, decision: { additionalContext: answers.pre } }
      return { matchedCount: 0 }
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

  const internals = manager as unknown as Record<string, unknown>
  internals.persistSession = () => {}
  manager.flushSession = async () => {}
  internals.writeSessionMetadata = async () => {}
  internals.acquireCapabilityTurn = async () => () => {}
  internals.createCapabilityTurn = async (target: { capabilityLeaseId?: string; capabilityRuntime?: unknown }) => {
    const runtime = { view: { sources: [] }, materializer: {} }
    target.capabilityLeaseId = 'ub12-69-lease'
    target.capabilityRuntime = runtime
    return { snapshot: { leaseId: 'ub12-69-lease' }, runtime }
  }
  internals.createRetainedCapabilityLease = () => ({ retain: () => () => {}, release: () => {} })
  internals.buildAgentAutomationSystem = async () => system
  internals.getOrCreateAgent = async () => {
    managed.agent = agent as never
    return agent
  }
  // A live agent, as after the session's first turn: `runModelSwitchHook` fires
  // nothing without one.
  managed.agent = agent as never

  const switchTo = (to: string) => manager.updateSessionModel(managed.id, workspace.id, to)
  const send = (message: string) => manager.sendMessage(
    managed.id, message, undefined, undefined, undefined, undefined, undefined, undefined, { workspaceId: workspace.id },
  )
  return { managed, fired, chatMessages, switchTo, send }
}

function bandCount(text: string): number {
  return text.split(BAND_OPEN).length - 1
}

describe('UB12.69 — PostModelSwitch context rides the next prompt', () => {
  it('POSITIVE: the hook\'s text reaches the next prompt once, fenced, and not the one after', async () => {
    const h = harness({ post: [GUIDANCE] })
    await h.switchTo('claude-opus-5')
    expect(h.fired).toEqual(['PreModelSwitch', 'PostModelSwitch'])

    await h.send('hello')
    await h.send('and again')

    expect(h.chatMessages).toHaveLength(2)
    const first = h.chatMessages[0]!
    expect(first).toContain('hello')
    expect(first).toContain(GUIDANCE)
    expect(bandCount(first)).toBe(1)
    // The same composer every runtime's hook band uses: the notice and the
    // untrusted fence ride inside the element.
    expect(first).toContain('was produced by a HOOK')
    expect(first.indexOf('hello')).toBeLessThan(first.indexOf(BAND_OPEN))
    // Spent: the second prompt carries nothing of it.
    expect(h.chatMessages[1]).not.toContain(GUIDANCE)
    expect(bandCount(h.chatMessages[1]!)).toBe(0)
  })

  it('NEGATIVE: a PreModelSwitch hook\'s additionalContext is never delivered', async () => {
    // The page gives `additionalContext` to PostModelSwitch alone; a Pre hook
    // that returns one has used a field its event does not have.
    const h = harness({ post: [undefined], pre: 'pre-only text' })
    await h.switchTo('claude-opus-5')
    await h.send('hello')

    expect(h.chatMessages[0]).not.toContain('pre-only text')
    expect(bandCount(h.chatMessages[0]!)).toBe(0)
  })

  it('BOUNDARY: only the last switch\'s output is delivered, and an empty last run clears an earlier one', async () => {
    const h = harness({ post: ['context for opus', 'context for haiku', 'context for opus again', undefined] })
    await h.switchTo('claude-opus-5')
    await h.switchTo('claude-haiku-5')
    await h.send('first')
    await h.switchTo('claude-opus-5')
    await h.switchTo('claude-sonnet-5')
    await h.send('second')

    const [first, second] = h.chatMessages
    expect(first).toContain('context for haiku')
    expect(first).not.toContain('context for opus')
    expect(bandCount(first!)).toBe(1)
    // The fourth switch's hook printed nothing, so the third's context is not
    // this prompt's either.
    expect(second).not.toContain('context for opus again')
    expect(bandCount(second!)).toBe(0)
  })

  it('BOUNDARY: a session command leaves the context for the next real prompt', async () => {
    const h = harness({ post: [GUIDANCE] })
    await h.switchTo('claude-opus-5')
    await h.send('/compact')
    await h.send('hello')

    expect(h.chatMessages[0]).toBe('/compact')
    expect(h.chatMessages[1]).toContain(GUIDANCE)
    expect(h.managed.pendingModelSwitchContext).toBeUndefined()
  })
})
