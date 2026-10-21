/**
 * D1.218 — `context_tokens` on a `SessionStart` whose source is `resume` or
 * `fork`, uniformly on all three runtimes.
 *
 * ## What is being proved, and where
 *
 * SDK 0.3.251 gives `SessionStartHookInput` four resume/fork fields. D1.202
 * decided three of them deliberately unread — the reasons are in
 * `automations/types.ts`'s `EVENT_INVENTORY` and are not restated — and named
 * this one as the piece that was owed, because `modelSwitchCostFields` already
 * computes exactly the figure the SDK's gloss describes.
 *
 * The fill lives in `SessionManager.withSessionStartContextTokens`, called from
 * the `trackAgentAutomationSystem` wrapper, which is the SINGLE funnel every
 * host hook event on every runtime passes through. **So these arms drive that
 * wrapper for real** rather than planting a system on `managed` the way the
 * model-switch fixture beside them does: the wrapper IS the change, and a rig
 * that installed a bare system would measure the enricher's absence and pass.
 * That is WC-c's finding in the small — a lever exercised only through a stub
 * measures the lever's key and never its posture.
 *
 * ## Why the negatives carry the weight
 *
 * "The field is filled" is satisfied just as well by a host that stamps it on
 * every event of every session, which would be a claim about a resumed
 * transcript that does not exist on a `startup`, and a number where the page
 * and the typings both say there is none.
 */
import { describe, expect, test } from 'bun:test'
import { createTestSessionManager } from './__tests__/test-session-manager.ts'

interface Seen { event: string; input: Record<string, unknown> }

const WORKSPACE = {
  id: 'workspace-ss', name: 'Workspace SS', rootPath: '/tmp/nessy-session-start',
  workspaceRootPath: '/tmp/nessy-session-start', sessionRootPath: '/tmp/nessy-session-start-sessions',
  config: { id: 'workspace-ss', name: 'Workspace SS', createdAt: 1, updatedAt: 1 },
  lastAccessedAt: 1,
}

/**
 * `tokenUsage` is the producer's ONLY input, so a rig that omits it is the
 * "no turn has reported usage yet" case — which is a real arm below, not a gap.
 */
function rig(tokenUsage?: Record<string, unknown>) {
  const manager = createTestSessionManager()
  const seen: Seen[] = []
  const inner = {
    serializesAgentEvents: true,
    async executeAgentEvent(event: string, input: Record<string, unknown>) {
      seen.push({ event, input })
      return { matchedCount: 1 }
    },
  }
  const managed: any = {
    id: 'ss-session', workspace: WORKSPACE, permissionMode: 'default', model: 'a-model',
    messages: [], messagesLoaded: true,
    ...(tokenUsage ? { tokenUsage } : {}),
  }
  // The REAL wrapper, reached the way production reaches it.
  const wrapped = (manager as any).trackAgentAutomationSystem(managed, inner)
  return { manager, managed, wrapped, seen }
}

function usage(contextTokens: number): Record<string, unknown> {
  return {
    inputTokens: 10, outputTokens: 5, totalTokens: 15, contextTokens, costUsd: 0,
  }
}

async function emit(wrapped: any, source: string | undefined): Promise<void> {
  await wrapped.executeAgentEvent('SessionStart', {
    hook_event_name: 'SessionStart',
    ...(source === undefined ? {} : { source }),
  })
}

describe('D1.218 · context_tokens on a resumed SessionStart', () => {
  test('a resume and a fork both carry the figure the host already holds', async () => {
    for (const source of ['resume', 'fork']) {
      const { manager, wrapped, seen } = rig(usage(48_000))
      await emit(wrapped, source)

      expect(seen, source).toHaveLength(1)
      expect(seen[0]!.input.context_tokens, source).toBe(48_000)
      // The event's own fields are untouched — the enricher adds, never rebuilds.
      expect(seen[0]!.input.hook_event_name, source).toBe('SessionStart')
      expect(seen[0]!.input.source, source).toBe(source)
      await manager.cleanup()
    }
  })

  test('NEGATIVE — a startup carries no number, because there is no resumed transcript', async () => {
    const { manager, wrapped, seen } = rig(usage(48_000))
    await emit(wrapped, 'startup')

    // The session HAS a reading; the gate is the source, and without this arm
    // the positive above is equally satisfied by stamping every session start.
    expect(seen[0]!.input.context_tokens).toBeUndefined()
    await manager.cleanup()
  })

  test('NEGATIVE — clear, compact and a missing source are all excluded by the same sentence', async () => {
    for (const source of ['clear', 'compact', undefined]) {
      const { manager, wrapped, seen } = rig(usage(48_000))
      await emit(wrapped, source)

      expect(seen[0]!.input.context_tokens, String(source)).toBeUndefined()
      await manager.cleanup()
    }
  })

  test('BOUNDARY — no reported usage is ABSENT, never zero', async () => {
    const { manager, wrapped, seen } = rig()
    await emit(wrapped, 'resume')

    // "No reading" and "an empty context" are different answers, and a hook must
    // be able to tell them apart — the producer's own rule, kept here.
    expect(seen[0]!.input).not.toHaveProperty('context_tokens')
    await manager.cleanup()

    const zero = rig(usage(0))
    await emit(zero.wrapped, 'resume')
    expect(zero.seen[0]!.input).not.toHaveProperty('context_tokens')
    await zero.manager.cleanup()
  })

  test('CONTROL — the call site wins, and no other event is touched', async () => {
    const { manager, wrapped, seen } = rig(usage(48_000))

    // A backend that one day supplies the field itself must not be overwritten,
    // which is the rule the effort enricher beside this one already keeps.
    await wrapped.executeAgentEvent('SessionStart', {
      hook_event_name: 'SessionStart', source: 'resume', context_tokens: 1,
    })
    expect(seen[0]!.input.context_tokens).toBe(1)

    // And the enricher is keyed on the event: a sibling that carries no such
    // field in any SDK must come through the same funnel unchanged.
    await wrapped.executeAgentEvent('SessionEnd', { hook_event_name: 'SessionEnd', reason: 'clear' })
    expect(seen[1]!.input).not.toHaveProperty('context_tokens')
    await manager.cleanup()
  })
})
