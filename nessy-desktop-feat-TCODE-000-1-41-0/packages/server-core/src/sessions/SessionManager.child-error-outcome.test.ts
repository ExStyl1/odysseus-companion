/**
 * A child whose turn ENDED IN AN ERROR must not be reported to its parent as a
 * completed run with no output.
 *
 * Q6-D1, measured live on the packaged 1.25.1: a subagent granted `Agent` died
 * on its first turn (`Pi execution manifest model contract mismatch for
 * subagent`), its session record held exactly that one error row — and the
 * parent's tool result read `1. <agent> - done … (no output)`. The manifest half
 * of that defect is fixed at its own seam; THIS is the half that made it
 * invisible, and it is not specific to that error: `runPiChildTurn` read only
 * the last ASSISTANT message, so every child failure that ends a turn rather
 * than throwing arrived at the parent as success.
 *
 * The child's own transcript is the authority here — the send resolves either
 * way, so the error row is the only thing that distinguishes the two outcomes.
 */
import { describe, expect, test } from 'bun:test'
import { encodeSessionKey } from '@nessy-agent/shared/sessions/session-key'
import type { PiChildBudgetsV1 } from '@nessy-agent/shared/agent/pi-harness/child-session-port'
import { createTestSessionManager } from './__tests__/test-session-manager.ts'
import { createManagedSession, setSessionPlatform } from './SessionManager.ts'
import { createHeadlessPlatform } from '../runtime/platform-headless.ts'

const workspace = { id: 'workspace-child-error', name: 'Child error', rootPath: process.cwd(), createdAt: 1 }

function budgets(): PiChildBudgetsV1 {
  return {
    depth: 1,
    maxDepth: 1,
    fanout: 1,
    concurrency: 1,
    tokenLimit: 100_000,
    costLimitUsd: 100,
    deadlineAt: Date.now() + 60_000,
    ancestry: [],
  }
}

/**
 * Drive the real `runPiChildTurn` over a child whose transcript is `messages`
 * and whose send RESOLVES — the shape a turn that died inside the runtime takes,
 * as opposed to the throwing shape `SessionManager.child-partial-output.test.ts`
 * already covers.
 */
async function runChildWithTranscript(
  messages: Array<{ role: string; content: string }>,
): Promise<{ status: string; output: string; error?: string }> {
  setSessionPlatform(createHeadlessPlatform())
  const manager = createTestSessionManager()
  const child: any = createManagedSession(
    { id: `child-${Math.random().toString(36).slice(2)}`, name: 'Child', ephemeral: true },
    workspace as never,
    { messagesLoaded: true },
  )
  child.messages = messages
  const childSessionKey = { workspaceId: workspace.id, sessionId: child.id }
  ;(manager as any).sessions.set(encodeSessionKey(childSessionKey), child)
  ;(manager as any).ensureMessagesLoaded = async () => {}
  ;(manager as any).sendMessage = async () => {}

  try {
    return await (manager as any).runPiChildTurn(
      { workspaceId: workspace.id, sessionId: 'parent' },
      'agent-1',
      childSessionKey,
      'do the work',
      budgets(),
    )
  } finally {
    await manager.cleanup()
  }
}

describe('a child that fails without throwing still reports the failure', () => {
  test('an error-terminated turn fails with the child\'s own error, not "completed"', async () => {
    const result = await runChildWithTranscript([
      { role: 'user', content: 'Read /tmp/tag.txt and reply' },
      { role: 'error', content: 'Pi execution manifest model contract mismatch for subagent' },
    ])

    expect(result.status).toBe('failed')
    expect(result.error).toBe('Pi execution manifest model contract mismatch for subagent')
  })

  test('an error the child recovered from does not fail the turn', async () => {
    const result = await runChildWithTranscript([
      { role: 'user', content: 'do the work' },
      { role: 'error', content: 'transient provider hiccup' },
      { role: 'assistant', content: 'TAG=recovered' },
    ])

    expect(result.status).toBe('completed')
    expect(result.output).toBe('TAG=recovered')
    expect(result.error).toBeUndefined()
  })

  test('a normal turn is untouched', async () => {
    const result = await runChildWithTranscript([
      { role: 'user', content: 'do the work' },
      { role: 'assistant', content: 'TAG=done' },
    ])

    expect(result.status).toBe('completed')
    expect(result.output).toBe('TAG=done')
    expect(result.error).toBeUndefined()
  })

  test('a child that produced nothing and errored keeps the error, not silence', async () => {
    const result = await runChildWithTranscript([
      { role: 'user', content: 'do the work' },
      { role: 'assistant', content: 'partial thinking' },
      { role: 'error', content: 'child-runtime-exploded' },
    ])

    expect(result.status).toBe('failed')
    expect(result.error).toBe('child-runtime-exploded')
    // The work it did still travels, exactly as the throwing path already does.
    expect(result.output).toBe('partial thinking')
  })
})
