/**
 * `hooks.md:707`, the common `effort` hook input field: "Object with a `level`
 * field holding the active effort level for the turn … Present for events that
 * fire within a tool-use context, such as `PreToolUse`, `PostToolUse`, `Stop`,
 * and `SubagentStop`, when the current model supports the effort parameter."
 *
 * The injection lives on the automation-system WRAPPER rather than on
 * `BaseAgent.emitAutomationEvent`, and that is the choice this file pins:
 * `SubagentStop` is named by the page and is emitted by SessionManager
 * directly, never through the agent, so an agent-side injection would miss it.
 */
import { describe, expect, test } from 'bun:test'

import { SessionManager } from './SessionManager.ts'
import { createTestSessionManager } from './__tests__/test-session-manager.ts'

type CapturedEvent = { event: string; input: Record<string, unknown> }

function createHarness(agent: { thinkingLevel: string; model: string } | null) {
  // D1.242 — a REAL instance through `createTestSessionManager`, not
  // a bare prototype double. Every assignment below still
  // overrides what it overrode; the fields nobody seeded are now the
  // constructor's rather than `undefined`. D1.109 priced it: a `mkdtemp` and
  // four in-memory stores, not measurably expensive.
  const manager = createTestSessionManager() as any
  manager.enqueueAgentAutomationEvent = (_managed: unknown, run: () => unknown) => run()
  manager.reportHookErrors = () => {}
  const captured: CapturedEvent[] = []
  const managed = {
    agentLifecycleEnding: false,
    agent: agent === null ? undefined : {
      getThinkingLevel: () => agent.thinkingLevel,
      getModel: () => agent.model,
    },
  }
  const wrapped = manager.trackAgentAutomationSystem(managed, {
    executeAgentEvent: async (event: string, input: Record<string, unknown>) => {
      captured.push({ event, input })
      return { matchedCount: 0 }
    },
  })
  return { wrapped, captured }
}

describe('hook input effort injection', () => {
  test('carries the resolved level on the four documented tool-context events', async () => {
    const { wrapped, captured } = createHarness({ thinkingLevel: 'high', model: 'claude-opus-4-7' })
    for (const event of ['PreToolUse', 'PostToolUse', 'Stop', 'SubagentStop']) {
      await wrapped.executeAgentEvent(event, { hook_event_name: event })
    }
    expect(captured.map(entry => entry.input.effort)).toEqual([
      { level: 'high' }, { level: 'high' }, { level: 'high' }, { level: 'high' },
    ])
  })

  test('reports the DOWNGRADED level the model actually used', async () => {
    // `model-config.md:452`'s worked example — "`xhigh` runs as `high` on Opus
    // 4.6". Reporting the requested level would name one that never ran.
    const { wrapped, captured } = createHarness({ thinkingLevel: 'xhigh', model: 'claude-opus-4-6' })
    await wrapped.executeAgentEvent('PreToolUse', { hook_event_name: 'PreToolUse' })
    expect(captured[0]?.input.effort).toEqual({ level: 'high' })
  })

  test('omits the field outside a tool-use context', async () => {
    const { wrapped, captured } = createHarness({ thinkingLevel: 'high', model: 'claude-opus-4-7' })
    for (const event of ['SessionStart', 'PreCompact', 'CwdChanged', 'FileChanged']) {
      await wrapped.executeAgentEvent(event, { hook_event_name: event })
    }
    for (const entry of captured) expect(entry.input).not.toHaveProperty('effort')
  })

  test('emits NO effort key at all when the model does not support the effort parameter', async () => {
    // The negative that must never become a default. `medium` here would tell
    // every hook on a Nestor Cloud session a level the model never ran at.
    const { wrapped, captured } = createHarness({ thinkingLevel: 'high', model: 'nestor-cloud-code-agent' })
    await wrapped.executeAgentEvent('PreToolUse', { hook_event_name: 'PreToolUse' })
    expect(captured[0]?.input).not.toHaveProperty('effort')

    // Same for Nessy's `off`, which the page lists no spelling for, and for an
    // event that reaches the wrapper with no agent behind it.
    const offSession = createHarness({ thinkingLevel: 'off', model: 'claude-opus-4-7' })
    await offSession.wrapped.executeAgentEvent('Stop', { hook_event_name: 'Stop' })
    expect(offSession.captured[0]?.input).not.toHaveProperty('effort')

    const agentless = createHarness(null)
    await agentless.wrapped.executeAgentEvent('SubagentStop', { hook_event_name: 'SubagentStop' })
    expect(agentless.captured[0]?.input).not.toHaveProperty('effort')
  })

  test('lets a backend that already supplied its own effort win', async () => {
    // The Claude SDK authors its own hook input; ours must never overwrite it.
    const { wrapped, captured } = createHarness({ thinkingLevel: 'low', model: 'claude-opus-4-7' })
    await wrapped.executeAgentEvent('PostToolUse', {
      hook_event_name: 'PostToolUse',
      effort: { level: 'max' },
    })
    expect(captured[0]?.input.effort).toEqual({ level: 'max' })
  })
})
