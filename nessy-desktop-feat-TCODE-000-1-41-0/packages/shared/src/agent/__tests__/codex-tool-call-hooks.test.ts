/**
 * P3.335 — the tool-call hook events reach a codex session.
 *
 * ## What was wrong
 *
 * `codex-agent.ts` had four `emitAutomationEvent` sites — SessionStart,
 * UserPromptSubmit, Stop, SessionEnd — while `runtime-hook-events.ts` marked
 * PreToolUse, PostToolUse, PostToolUseFailure, PermissionRequest and
 * PermissionDenied `unwired`: the occurrence EXISTS on codex and nothing minted
 * it. A plugin whose hooks were installed and reported enabled did nothing on
 * this runtime, silently.
 *
 * ## Native-first, asked and closed by ruling rather than by absence
 *
 * codex HAS `[hooks]` and `buildCodexHooksToml` exists; the owner closed that
 * route on 2026-08-29 ("a user- or plugin-authored one would hand codex
 * something to execute that we neither wrote nor can revoke"). So step 1 is
 * refused-by-policy and the host supplies it.
 *
 * ## What these cases assert, and the one they deliberately do not
 *
 * The payload is Pi's, field for field, so one hook body behaves the same on
 * both runtimes — that is the whole point of the row and it is what the first
 * two cases pin. `tool_input` is the field that cannot come from
 * `item/completed` (which carries the OUTPUT), so the start/result pairing has
 * its own case.
 *
 * PreToolUse is NOT minted and has no case here beyond the absence one, on
 * purpose: its contract is that it can DENY, and the only place a codex call can
 * still be stopped is the approval bridge, which codex does not raise under
 * `dangerFullAccess` or auto-approval. A report-only emission would move its
 * ledger cell to `emitted` while its deny enforced nothing.
 */
import { describe, expect, it } from 'bun:test'
import type { AgentEvent } from '@nessy-agent/core/types'
import type { BackendConfig } from '../backend/types.ts'
import { CodexAgent } from '../codex-agent.ts'

function createConfig(): BackendConfig {
  return {
    provider: 'codex-runtime',
    workspace: {
      id: 'ws-codex-tool-hooks',
      name: 'Codex Tool Hooks Workspace',
      rootPath: '/tmp/ws-codex-tool-hooks',
      workspaceRootPath: '/tmp/ws-codex-tool-hooks',
      sessionRootPath: '/tmp/nessy-general-agent-test-sessions/ws-codex-tool-hooks',
    } as never,
    session: {
      id: 'session-codex-tool-hooks',
      workspaceRootPath: '/tmp/ws-codex-tool-hooks',
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      workingDirectory: '/tmp/project-root',
    } as never,
    model: 'codex/test-model',
    isHeadless: true,
  } as BackendConfig
}

interface Emitted { event: string; input: Record<string, unknown> }

/**
 * Drive the private minting seam with the adapter's own event shapes, and
 * capture what would have gone to the automation bus.
 */
function harness(decision?: Record<string, unknown>) {
  const agent = new CodexAgent(createConfig())
  const emitted: Emitted[] = []
  const debugLines: string[] = []
  const internals = agent as unknown as {
    emitAutomationEvent: (event: string, input: Record<string, unknown>) => Promise<unknown>
    noteCodexToolCallForHooks: (event: AgentEvent) => void
    debug: (message: string) => void
  }
  internals.emitAutomationEvent = async (event, input) => {
    emitted.push({ event, input })
    return decision ? { decision } : undefined
  }
  internals.debug = (message: string) => { debugLines.push(message) }
  return {
    emitted,
    debugLines,
    feed: (event: AgentEvent) => internals.noteCodexToolCallForHooks(event),
    destroy: () => agent.destroy(),
  }
}

function toolStart(id: string, toolName: string, input: Record<string, unknown>): AgentEvent {
  return { type: 'tool_start', toolUseId: id, toolName, input } as AgentEvent
}

function toolResult(id: string, toolName: string, result: string, isError: boolean): AgentEvent {
  return { type: 'tool_result', toolUseId: id, toolName, result, isError } as AgentEvent
}

/** One microtask turn, so the detached emission has run. */
const settle = () => new Promise<void>(resolve => setTimeout(resolve, 0))

describe('P3.335 · codex mints the tool-call hook events', () => {
  /**
   * THE ROW. KILLS the shipped state, where five events were `unwired` and a
   * completed tool call reached no hook at all.
   */
  it('emits PostToolUse with Pi’s payload, field for field', async () => {
    const h = harness()
    try {
      h.feed(toolStart('call-1', 'Bash', { command: 'ls -la' }))
      h.feed(toolResult('call-1', 'Bash', 'total 0\n', false))
      await settle()
      expect(h.emitted).toHaveLength(1)
      expect(h.emitted[0]!.event).toBe('PostToolUse')
      expect(h.emitted[0]!.input).toEqual({
        hook_event_name: 'PostToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'ls -la' },
        tool_response: 'total 0\n',
      })
    } finally { h.destroy() }
  })

  /**
   * The error split, which Pi and nestor-cloud both make off `isError` and codex
   * did not. `error` rather than `tool_response` is Pi's own field choice.
   */
  it('splits a failed call into PostToolUseFailure carrying `error`', async () => {
    const h = harness()
    try {
      h.feed(toolStart('call-2', 'Edit', { changes: [] }))
      h.feed(toolResult('call-2', 'Edit', 'failed', true))
      await settle()
      expect(h.emitted).toHaveLength(1)
      expect(h.emitted[0]!.event).toBe('PostToolUseFailure')
      expect(h.emitted[0]!.input.error).toBe('failed')
      expect(h.emitted[0]!.input.tool_response).toBeUndefined()
    } finally { h.destroy() }
  })

  /**
   * `tool_input` is the field that CANNOT come from `item/completed` — which
   * carries the output — so the start/result pairing is the mechanism under
   * test, not an implementation detail.
   */
  it('carries the input remembered from the matching tool_start, and only that one', async () => {
    const h = harness()
    try {
      h.feed(toolStart('call-a', 'Bash', { command: 'echo a' }))
      h.feed(toolStart('call-b', 'Bash', { command: 'echo b' }))
      h.feed(toolResult('call-b', 'Bash', 'b', false))
      h.feed(toolResult('call-a', 'Bash', 'a', false))
      await settle()
      expect(h.emitted.map(e => (e.input.tool_input as { command: string }).command)).toEqual(['echo b', 'echo a'])
    } finally { h.destroy() }
  })

  /**
   * A result with no start — the shape a reconnect or a refused call produces —
   * must still hook, with an empty input rather than a missing field. A hook
   * body reading `tool_input.command` should find `undefined`, not throw.
   */
  it('emits with an empty input when no start was seen', async () => {
    const h = harness()
    try {
      h.feed(toolResult('orphan', 'Bash', 'out', false))
      await settle()
      expect(h.emitted).toHaveLength(1)
      expect(h.emitted[0]!.input.tool_input).toEqual({})
    } finally { h.destroy() }
  })

  /**
   * NEGATIVE CONTROL: the events that are NOT tool events must mint nothing.
   * Without it every case above would pass on an emitter that fired on
   * everything the adapter produced.
   */
  it('mints nothing for a non-tool event', async () => {
    const h = harness()
    try {
      h.feed({ type: 'text_complete', text: 'hello' } as AgentEvent)
      h.feed({ type: 'complete' } as AgentEvent)
      await settle()
      expect(h.emitted).toEqual([])
    } finally { h.destroy() }
  })

  /**
   * RESIDUE 1, asserted rather than left in prose: Pi rewrites a tool result
   * before the model sees it, and on codex the item is already committed. A hook
   * that returns one is TOLD so; silently ignoring it is the failure this
   * assertion exists to prevent.
   */
  it('reports an unhonourable updatedToolOutput instead of dropping it', async () => {
    const h = harness({ updatedToolOutput: 'rewritten' })
    try {
      h.feed(toolStart('call-3', 'Bash', { command: 'ls' }))
      h.feed(toolResult('call-3', 'Bash', 'original', false))
      await settle()
      expect(h.debugLines.some(l => l.includes('updatedToolOutput') && l.includes('cannot honour'))).toBe(true)
    } finally { h.destroy() }
  })

  /** RESIDUE 2, same rule: a `block` decision has no result left to speak on. */
  it('reports an unhonourable block decision', async () => {
    const h = harness({ decision: 'block', reason: 'no' })
    try {
      h.feed(toolStart('call-4', 'Bash', { command: 'ls' }))
      h.feed(toolResult('call-4', 'Bash', 'original', false))
      await settle()
      expect(h.debugLines.some(l => l.includes('"block"'))).toBe(true)
    } finally { h.destroy() }
  })

  /** A rejecting hook must never escape into the notification handler. */
  it('a rejecting hook is reported, not thrown', async () => {
    const agent = new CodexAgent(createConfig())
    const debugLines: string[] = []
    const internals = agent as unknown as {
      emitAutomationEvent: () => Promise<unknown>
      noteCodexToolCallForHooks: (event: AgentEvent) => void
      debug: (message: string) => void
    }
    internals.emitAutomationEvent = async () => { throw new Error('hook exploded') }
    internals.debug = (message: string) => { debugLines.push(message) }
    try {
      expect(() => internals.noteCodexToolCallForHooks(toolResult('call-5', 'Bash', 'x', false))).not.toThrow()
      await settle()
      expect(debugLines.some(l => l.includes('hook exploded'))).toBe(true)
    } finally { agent.destroy() }
  })
})
