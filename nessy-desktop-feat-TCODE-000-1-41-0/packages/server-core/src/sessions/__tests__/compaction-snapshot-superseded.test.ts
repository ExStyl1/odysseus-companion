import { afterEach, describe, expect, it } from 'bun:test'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { SESSIONS_DIR } from '@nessy-agent/shared/workspaces'
import type { ContextUsageSnapshot } from '@nessy-agent/shared/protocol/dto'
import { claudeContextAfterCompaction } from '@nessy-agent/shared/agent/backend/claude/sdk-context-usage'
import { createManagedSession, type SessionManager } from '../SessionManager'
import { supersededCompactionSnapshot } from '../context-snapshot-supersede'
import { createTestSessionManager } from './test-session-manager'

/**
 * F1.440 — after a compaction boundary the claude context snapshot was frozen
 * at `post_tokens` for every later turn, unmarked: nothing but `/context`
 * replaced it, and claude's donut reads only the snapshot. Driven through the
 * REAL `processEvent` with the event shapes the claude agent emits (the
 * boundary's `usage_update` carries `claudeContextAfterCompaction`, a later
 * turn's `complete` carries tokens and never a snapshot).
 */

const WS = 'ws_f1440'
const managers: SessionManager[] = []

afterEach(() => {
  for (const manager of managers.splice(0)) manager.cleanup()
  rmSync(join(SESSIONS_DIR, WS), { recursive: true, force: true })
})

function rig(id: string) {
  const manager = createTestSessionManager()
  managers.push(manager)
  const managed = createManagedSession({ id }, { id: WS, name: 'F1.440', rootPath: '/tmp/nessy-f1440', createdAt: 1 } as never, { messagesLoaded: true })
  ;(manager as unknown as { sessions: Map<string, unknown> }).sessions.set(`${WS}:${id}`, managed)
  const internals = manager as unknown as { processEvent(m: unknown, e: Record<string, unknown>): Promise<void> }
  return { managed, run: (event: Record<string, unknown>) => internals.processEvent(managed, event) }
}

function boundary(trigger: 'auto' | 'manual', post: number): ContextUsageSnapshot {
  const snapshot = claudeContextAfterCompaction({
    type: 'system',
    subtype: 'compact_boundary',
    compact_metadata: { trigger, pre_tokens: 180_000, post_tokens: post },
  }, 200_000)
  if (!snapshot) throw new Error('fixture: the boundary produced no snapshot')
  return snapshot
}

describe('F1.440 — a later turn supersedes the compaction boundary\'s snapshot', () => {
  it('positive — completes of 38 000 and 120 000 after an AUTO boundary leave the snapshot marked stale, its count kept', async () => {
    const { managed, run } = rig('f1440-frozen')
    const snap = boundary('auto', 14_748)
    await run({ type: 'usage_update', usage: { inputTokens: 14_748, contextWindow: 200_000, contextUsage: snap } })
    // Fixture positive control: the boundary really landed as the session's snapshot.
    expect(managed.contextUsage?.source).toBe('estimated_after_compact')
    expect(managed.contextUsage?.stale).toBeUndefined()

    await run({ type: 'complete', usage: { inputTokens: 38_000, outputTokens: 900, costUsd: 0.2, contextWindow: 200_000 } })
    expect(managed.contextUsage?.stale).toBe(true)
    await run({ type: 'complete', usage: { inputTokens: 120_000, outputTokens: 900, costUsd: 0.2, contextWindow: 200_000 } })

    expect(managed.contextUsage?.stale).toBe(true)
    expect(managed.contextUsage?.inputTokens).toBe(14_748)
    // The overlay path reads tokenUsage.contextUsage — the same stale copy.
    expect(managed.tokenUsage?.contextUsage?.stale).toBe(true)
    // The turn's own reading still owns tokenUsage (R14's auto rule, untouched).
    expect(managed.tokenUsage?.inputTokens).toBe(120_000)
  })

  it('negative — the manual /compact turn\'s own complete (contextTokens = post_tokens) keeps the fresh snapshot current', async () => {
    const { managed, run } = rig('f1440-manual')
    const snap = boundary('manual', 24_000)
    await run({ type: 'usage_update', usage: { inputTokens: 24_000, contextWindow: 200_000, contextUsage: snap } })
    // R16: the compaction request's input is the pre-compaction size; the context left is post_tokens.
    await run({ type: 'complete', usage: { inputTokens: 180_000, contextTokens: 24_000, outputTokens: 3000, costUsd: 0.4, contextWindow: 200_000 } })

    expect(managed.contextUsage?.inputTokens).toBe(24_000)
    expect(managed.contextUsage?.stale).toBeUndefined()
  })

  it('negative — a complete that carries its OWN snapshot replaces the boundary one and is not marked', async () => {
    const { managed, run } = rig('f1440-own')
    await run({ type: 'usage_update', usage: { inputTokens: 14_748, contextWindow: 200_000, contextUsage: boundary('auto', 14_748) } })
    const own: ContextUsageSnapshot = { inputTokens: 40_000, contextWindow: 200_000, contextWindowSource: 'runtime', source: 'sdk_usage' }
    await run({ type: 'complete', usage: { inputTokens: 40_000, outputTokens: 10, costUsd: 0, contextWindow: 200_000, contextUsage: own } })

    expect(managed.contextUsage?.source).toBe('sdk_usage')
    expect(managed.contextUsage?.inputTokens).toBe(40_000)
    expect(managed.contextUsage?.stale).toBeUndefined()
  })
})

describe('F1.440 — supersededCompactionSnapshot, the rule on its own', () => {
  const snap: ContextUsageSnapshot = { inputTokens: 14_748, contextWindow: 200_000, source: 'estimated_after_compact' }

  it('a different real reading with no snapshot of the turn\'s own marks it stale and keeps the count', () => {
    expect(supersededCompactionSnapshot(snap, undefined, 38_000)).toEqual({ ...snap, stale: true })
  })

  it('an agreeing reading, a missing reading, or a zero leaves it alone', () => {
    expect(supersededCompactionSnapshot(snap, undefined, 14_748)).toBeUndefined()
    expect(supersededCompactionSnapshot(snap, undefined, undefined)).toBeUndefined()
    expect(supersededCompactionSnapshot(snap, undefined, 0)).toBeUndefined()
  })

  // F1.477 (P1) — this arm pinned the opposite until F1.477: a `/context` report
  // is a point-in-time reading exactly like a boundary's, and claude (a
  // `fresh-local` provider) never replaces it on its own, so after later turns
  // the donut drew it as today's occupancy. It is marked now, count kept.
  it('scope — a /context report (sdk_usage) a later turn contradicts is marked too, count and categories kept', () => {
    const report: ContextUsageSnapshot = {
      ...snap,
      source: 'sdk_usage',
      categories: [{ id: 'conversation_messages', tokens: 14_000 }],
    }
    expect(supersededCompactionSnapshot(report, undefined, 38_000)).toEqual({ ...report, stale: true })
    // An agreeing reading still leaves it alone.
    expect(supersededCompactionSnapshot(report, undefined, 14_748)).toBeUndefined()
  })

  it('scope — a remote agent\'s own report and a count-less snapshot stay out of the rule', () => {
    expect(supersededCompactionSnapshot({ ...snap, source: 'remote_reported' }, undefined, 38_000)).toBeUndefined()
    expect(supersededCompactionSnapshot({ ...snap, inputTokens: null, source: 'unavailable' }, undefined, 38_000)).toBeUndefined()
  })
})

describe('F1.477 (P1) — a /context snapshot is superseded by a later turn, through processEvent', () => {
  it('positive — a claude-shaped complete (tokens, no snapshot) after a /context refresh marks it stale', async () => {
    const { managed, run } = rig('f1477-context')
    const report: ContextUsageSnapshot = { inputTokens: 52_000, contextWindow: 200_000, contextWindowSource: 'runtime', remainingWindow: 148_000, source: 'sdk_usage' }
    // The /context refresh's own emission shape.
    await run({ type: 'usage_update', usage: { inputTokens: 52_000, contextWindow: 200_000, contextUsage: report } })
    expect(managed.contextUsage?.source).toBe('sdk_usage')
    expect(managed.contextUsage?.stale).toBeUndefined()

    await run({ type: 'complete', usage: { inputTokens: 61_000, outputTokens: 700, costUsd: 0.1, contextWindow: 200_000 } })
    expect(managed.contextUsage?.stale).toBe(true)
    expect(managed.contextUsage?.inputTokens).toBe(52_000)
    expect(managed.tokenUsage?.contextUsage?.stale).toBe(true)
  })

  it('negative — a Pi-shaped complete carrying its own sdk_usage snapshot replaces it and nothing is marked', async () => {
    const { managed, run } = rig('f1477-pi')
    const before: ContextUsageSnapshot = { inputTokens: 52_000, contextWindow: 200_000, contextWindowSource: 'runtime', source: 'sdk_usage' }
    await run({ type: 'usage_update', usage: { inputTokens: 52_000, contextWindow: 200_000, contextUsage: before } })
    const own: ContextUsageSnapshot = { ...before, inputTokens: 61_000 }
    await run({ type: 'complete', usage: { inputTokens: 61_000, outputTokens: 700, costUsd: 0.1, contextWindow: 200_000, contextUsage: own } })
    expect(managed.contextUsage?.inputTokens).toBe(61_000)
    expect(managed.contextUsage?.stale).toBeUndefined()
  })
})
