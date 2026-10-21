/**
 * F1.477 (P2) — inside an auto-compacted turn the boundary's post-compaction
 * count showed as CURRENT until the turn completed.
 *
 * An auto compaction arrives MID-turn and the turn goes on: the claude agent
 * writes the boundary snapshot (`claudeContextAfterCompaction`, `post_tokens`),
 * then every later assistant message reports its own context size as a
 * `usage_update` carrying tokens and no snapshot (the claude event adapter's
 * per-message usage). F1.440's supersede rule ran only on `complete`, so for
 * the rest of that turn the donut drew the boundary count while the turn grew
 * past it. The rule now runs on the in-turn reading too — and the stale copy is
 * SENT, because the renderer keeps its old snapshot when an update carries none.
 *
 * Driven through the REAL `processEvent` with the claude event shapes, reading
 * both the session state and what reached the renderer.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { SESSIONS_DIR } from '@nessy-agent/shared/workspaces'
import type { ContextUsageSnapshot } from '@nessy-agent/shared/protocol/dto'
import { claudeContextAfterCompaction } from '@nessy-agent/shared/agent/backend/claude/sdk-context-usage'
import { createManagedSession, type SessionManager } from '../SessionManager'
import { createTestSessionManager } from './test-session-manager'

const WS = 'ws_f1477_p2'
const managers: SessionManager[] = []

afterEach(() => {
  for (const manager of managers.splice(0)) manager.cleanup()
  rmSync(join(SESSIONS_DIR, WS), { recursive: true, force: true })
})

function rig(id: string) {
  const manager = createTestSessionManager()
  managers.push(manager)
  const managed = createManagedSession({ id }, { id: WS, name: 'F1.477', rootPath: '/tmp/nessy-f1477-p2', createdAt: 1 } as never, { messagesLoaded: true })
  ;(manager as unknown as { sessions: Map<string, unknown> }).sessions.set(`${WS}:${id}`, managed)
  const sent: Array<Record<string, unknown>> = []
  ;(manager as unknown as { sendEvent: (event: Record<string, unknown>) => void }).sendEvent = event => { sent.push(event) }
  const internals = manager as unknown as { processEvent(m: unknown, e: Record<string, unknown>): Promise<void> }
  return { managed, sent, run: (event: Record<string, unknown>) => internals.processEvent(managed, event) }
}

function autoBoundary(post: number): ContextUsageSnapshot {
  const snapshot = claudeContextAfterCompaction({
    type: 'system',
    subtype: 'compact_boundary',
    compact_metadata: { trigger: 'auto', pre_tokens: 180_000, post_tokens: post },
  }, 200_000)
  if (!snapshot) throw new Error('fixture: the boundary produced no snapshot')
  return snapshot
}

type Sent = { contextUsage?: ContextUsageSnapshot; tokenUsage?: { contextUsage?: ContextUsageSnapshot } }

describe('F1.477 (P2) — an in-turn reading supersedes the boundary snapshot', () => {
  it('positive — the next assistant message\'s size marks it stale, and the renderer is SENT the stale copy', async () => {
    const { managed, sent, run } = rig('p2-auto')
    // The boundary's own emission: tokens AND the snapshot, agreeing — nothing marked.
    await run({ type: 'usage_update', usage: { inputTokens: 14_748, contextWindow: 200_000, contextUsage: autoBoundary(14_748) } })
    expect(managed.contextUsage?.source).toBe('estimated_after_compact')
    expect(managed.contextUsage?.stale).toBeUndefined()

    sent.length = 0
    // The claude adapter's per-assistant-message usage: tokens, no snapshot.
    await run({ type: 'usage_update', usage: { inputTokens: 16_900, contextWindow: 200_000 } })

    expect(managed.contextUsage?.stale).toBe(true)
    expect(managed.contextUsage?.inputTokens).toBe(14_748)
    expect(managed.tokenUsage?.contextUsage?.stale).toBe(true)
    const update = sent.find(event => event.type === 'usage_update') as Sent | undefined
    expect(update?.contextUsage?.stale).toBe(true)
    expect(update?.tokenUsage?.contextUsage?.stale).toBe(true)
  })

  it('negative — an update carrying its OWN snapshot (Pi) replaces it and nothing is marked', async () => {
    const { managed, run } = rig('p2-pi')
    await run({ type: 'usage_update', usage: { inputTokens: 14_748, contextWindow: 200_000, contextUsage: autoBoundary(14_748) } })
    const own: ContextUsageSnapshot = { inputTokens: 16_900, contextWindow: 200_000, contextWindowSource: 'runtime', source: 'sdk_usage' }
    await run({ type: 'usage_update', usage: { inputTokens: 16_900, contextWindow: 200_000, contextUsage: own } })
    expect(managed.contextUsage?.inputTokens).toBe(16_900)
    expect(managed.contextUsage?.stale).toBeUndefined()
  })

  it('negative — an agreeing reading, or an update with no count, leaves it current and sends nothing new', async () => {
    const { managed, sent, run } = rig('p2-agree')
    await run({ type: 'usage_update', usage: { inputTokens: 14_748, contextWindow: 200_000, contextUsage: autoBoundary(14_748) } })
    sent.length = 0
    await run({ type: 'usage_update', usage: { inputTokens: 14_748, contextWindow: 200_000 } })
    await run({ type: 'usage_update', usage: { contextWindow: 200_000 } })
    expect(managed.contextUsage?.stale).toBeUndefined()
    for (const event of sent as Sent[]) expect(event.contextUsage).toBeUndefined()
  })
})
