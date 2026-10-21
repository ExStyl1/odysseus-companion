/**
 * F1.460 (11) — F1.240's done-means, driven: the host's compaction `info`
 * re-send must not ship a `/context` snapshot as CURRENT after a boundary that
 * made it untrue.
 *
 * The host's `info` case re-sends `managed.contextUsage` to the renderer at the
 * moment the "Compacted Conversation" banner lands ("Emit usage_update so the
 * context count badge refreshes immediately after compaction"). Before F1.240
 * the claude agent emitted nothing snapshot-bearing at a boundary with no
 * `post_tokens`, so the re-send carried the pre-compaction `/context` count as
 * if it were still true. Since F1.240 it emits `claudeContextAfterCompaction`'s
 * stale, count-less snapshot BEFORE the banner (the seam test pins that order,
 * F1.460 (12)), and the re-send carries that.
 *
 * Driven through the REAL `processEvent` with the event shapes the agent emits
 * (the probe WJ-ii's verifier ran, landed as a test). The seam test's
 * `mirrorSessionManager` does not model `contextUsage`, and the renderer arm is
 * a characterization, so this is the one place the re-send itself is asserted.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { SESSIONS_DIR } from '@nessy-agent/shared/workspaces'
import type { ContextUsageSnapshot } from '@nessy-agent/shared/protocol/dto'
import { claudeContextAfterCompaction } from '@nessy-agent/shared/agent/backend/claude/sdk-context-usage'
import { createManagedSession, type SessionManager } from '../SessionManager'
import { createTestSessionManager } from './test-session-manager'

const WS = 'ws_f1460_11'
const managers: SessionManager[] = []

afterEach(() => {
  for (const manager of managers.splice(0)) manager.cleanup()
  rmSync(join(SESSIONS_DIR, WS), { recursive: true, force: true })
})

function rig(id: string) {
  const manager = createTestSessionManager()
  managers.push(manager)
  const managed = createManagedSession({ id }, { id: WS, name: 'F1.460', rootPath: '/tmp/nessy-f1460-11', createdAt: 1 } as never, { messagesLoaded: true })
  ;(manager as unknown as { sessions: Map<string, unknown> }).sessions.set(`${WS}:${id}`, managed)
  const sent: Array<Record<string, unknown>> = []
  ;(manager as unknown as { sendEvent: (event: Record<string, unknown>) => void }).sendEvent = event => { sent.push(event) }
  const internals = manager as unknown as { processEvent(m: unknown, e: Record<string, unknown>): Promise<void> }
  return { managed, sent, run: (event: Record<string, unknown>) => internals.processEvent(managed, event) }
}

/** The `/context` refresh's own snapshot shape (`refreshContextUsage` → `applyContextUsageSnapshot`). */
const contextReport: ContextUsageSnapshot = {
  inputTokens: 180_000,
  contextWindow: 200_000,
  contextWindowSource: 'runtime',
  remainingWindow: 20_000,
  source: 'sdk_usage',
}

type Resend = { contextUsage?: ContextUsageSnapshot } | undefined

describe('F1.460 (11) — the compaction info re-send after a boundary with no post_tokens', () => {
  it('re-sends the stale, count-less snapshot — never the /context count as current', async () => {
    const { sent, run } = rig('f1460-stale')
    await run({ type: 'usage_update', usage: { inputTokens: 180_000, contextWindow: 200_000, contextUsage: contextReport } })
    const stale = claudeContextAfterCompaction(
      { type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'manual', pre_tokens: 180_000 } },
      200_000,
    )
    // Fixture positive control: the agent's boundary snapshot really is the stale, count-less one.
    expect(stale?.stale).toBe(true)
    expect(stale?.inputTokens).toBeNull()
    await run({ type: 'usage_update', usage: { contextUsage: stale } })

    sent.length = 0
    await run({ type: 'info', message: 'Compacted Conversation', compactionTrigger: 'manual' })
    const resend = sent.find(event => event.type === 'usage_update') as Resend
    expect(resend).toBeDefined()
    expect(resend?.contextUsage?.stale).toBe(true)
    expect(resend?.contextUsage?.inputTokens).toBeNull()
  })

  it('CONTROL — the parent shape (no snapshot-bearing update before the banner) re-ships 180 000 as current', async () => {
    // What claude-agent.ts emitted before F1.240 on this boundary: nothing, so the
    // re-send reads the /context report untouched. This is the red the fix removed,
    // kept as the arm that proves the positive one can fail.
    const { sent, run } = rig('f1460-parent')
    await run({ type: 'usage_update', usage: { inputTokens: 180_000, contextWindow: 200_000, contextUsage: contextReport } })
    sent.length = 0
    await run({ type: 'info', message: 'Compacted Conversation', compactionTrigger: 'manual' })
    const resend = sent.find(event => event.type === 'usage_update') as Resend
    expect(resend?.contextUsage?.inputTokens).toBe(180_000)
    expect(resend?.contextUsage?.stale).toBeUndefined()
  })

  it('post_tokens present: the re-send carries post_tokens as the snapshot count', async () => {
    const { sent, run } = rig('f1460-post')
    await run({ type: 'usage_update', usage: { inputTokens: 180_000, contextWindow: 200_000, contextUsage: contextReport } })
    const snap = claudeContextAfterCompaction(
      { type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'manual', pre_tokens: 180_000, post_tokens: 24_000 } },
      200_000,
    )
    await run({ type: 'usage_update', usage: { inputTokens: 24_000, contextWindow: 200_000, contextUsage: snap } })
    sent.length = 0
    await run({ type: 'info', message: 'Compacted Conversation', compactionTrigger: 'manual' })
    const resend = sent.find(event => event.type === 'usage_update') as Resend
    expect(resend?.contextUsage?.inputTokens).toBe(24_000)
    expect(resend?.contextUsage?.stale).toBeUndefined()
  })
})
