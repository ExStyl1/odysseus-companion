import { describe, expect, it } from 'bun:test'
import { handleUsageUpdate } from '../session'
import type { SessionState, UsageUpdateEvent } from '../../types'

function state(): SessionState {
  return {
    session: {
      id: 'session-1',
      workspaceId: 'ws-1',
      workspaceName: 'Workspace',
      lastMessageAt: Date.now(),
      messages: [],
      isProcessing: true,
      tokenUsage: {
        inputTokens: 123,
        outputTokens: 10,
        totalTokens: 133,
        contextTokens: 0,
        costUsd: 0,
      },
    },
    streaming: null,
  }
}

describe('handleUsageUpdate', () => {
  it('stores context usage snapshots without coercing unknown input to zero', () => {
    const event: UsageUpdateEvent = {
      type: 'usage_update',
      sessionId: 'session-1',
      tokenUsage: {
        inputTokens: null,
        contextWindow: 200_000,
        contextUsage: {
          inputTokens: null,
          contextWindow: 200_000,
          contextWindowSource: 'remote_reported',
          source: 'remote_reported',
        },
      },
    }

    const result = handleUsageUpdate(state(), event)

    expect(result.state.session.tokenUsage?.inputTokens).toBe(123)
    expect(result.state.session.tokenUsage?.contextWindow).toBe(200_000)
    expect(result.state.session.contextUsage).toMatchObject({
      inputTokens: null,
      contextWindow: 200_000,
      source: 'remote_reported',
    })
  })

  // F1.248 (b) — the claude adapter sends `contextWindow: cachedContextWindow`,
  // which is undefined until the first result, and the host forwards the event's
  // window raw. Upstream v0.13.4 falls back to the session's value; this fork
  // had lost that fallback, so a window-less update cleared a known window.
  it('an update WITHOUT a window keeps the session\'s known window', () => {
    const known = handleUsageUpdate(state(), {
      type: 'usage_update',
      sessionId: 'session-1',
      tokenUsage: { inputTokens: 150, contextWindow: 200_000 },
    })
    const result = handleUsageUpdate(known.state, {
      type: 'usage_update',
      sessionId: 'session-1',
      tokenUsage: { inputTokens: 160 },
    })

    expect(result.state.session.tokenUsage?.inputTokens).toBe(160)
    expect(result.state.session.tokenUsage?.contextWindow).toBe(200_000)
  })

  it('an update WITH a window replaces the known one', () => {
    const known = handleUsageUpdate(state(), {
      type: 'usage_update',
      sessionId: 'session-1',
      tokenUsage: { inputTokens: 150, contextWindow: 200_000 },
    })
    const result = handleUsageUpdate(known.state, {
      type: 'usage_update',
      sessionId: 'session-1',
      tokenUsage: { inputTokens: 160, contextWindow: 1_000_000 },
    })

    expect(result.state.session.tokenUsage?.contextWindow).toBe(1_000_000)
  })

  // F1.240 — the renderer half of the claude compaction chain. The agent now
  // puts a snapshot on the boundary's usage_update and the host forwards it;
  // this pins that the renderer REPLACES a prior /context snapshot with it
  // (post_tokens counted) and that a stale one carries an UNKNOWN count, so
  // the donut — which on a fresh-local provider reads only
  // `session.contextUsage` — stops showing the pre-compaction number.
  // Green before F1.240 as well: the defect was that no such event existed.
  it('a compaction snapshot replaces a prior /context snapshot, and a stale one leaves the count unknown', () => {
    const refreshed = handleUsageUpdate(state(), {
      type: 'usage_update',
      sessionId: 'session-1',
      tokenUsage: { inputTokens: 180_000, contextWindow: 200_000 },
      contextUsage: { inputTokens: 180_000, contextWindow: 200_000, source: 'sdk_usage' },
    })
    expect(refreshed.state.session.contextUsage?.inputTokens).toBe(180_000)

    const compacted = handleUsageUpdate(refreshed.state, {
      type: 'usage_update',
      sessionId: 'session-1',
      tokenUsage: { inputTokens: 24_000, contextWindow: 200_000 },
      contextUsage: {
        inputTokens: 24_000,
        contextWindow: 200_000,
        source: 'estimated_after_compact',
        lastCompaction: { tokensBefore: 180_000, estimatedTokensAfter: 24_000 },
      },
    })
    expect(compacted.state.session.contextUsage?.inputTokens).toBe(24_000)

    const stale = handleUsageUpdate(refreshed.state, {
      type: 'usage_update',
      sessionId: 'session-1',
      tokenUsage: {},
      contextUsage: { inputTokens: null, contextWindow: 200_000, source: 'unavailable', stale: true },
    })
    expect(stale.state.session.contextUsage?.inputTokens).toBeNull()
    expect(stale.state.session.contextUsage?.stale).toBe(true)
    // The window survives both — F1.248's fallback on the tokenUsage side.
    expect(stale.state.session.tokenUsage?.contextWindow).toBe(200_000)
  })

  // F1.1294 — /usage's per-model lines read `tokenUsage.modelUsage`
  // (`modelCostRows`), and a usage_update rebuilt tokenUsage from a fixed field
  // list that dropped it (and `costReporting`, so a reported cost read as
  // unsupported). The accumulated per-model breakdown is history, like costUsd.
  it('a usage_update keeps the per-model breakdown and the cost basis', () => {
    const opus = {
      inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheCreationTokens: 0,
      webSearchRequests: 0, costUsd: 0.42, costReporting: 'reported' as const,
    }
    const before = state()
    before.session.tokenUsage = {
      ...before.session.tokenUsage!,
      costUsd: 0.42,
      costReporting: 'reported',
      modelUsage: { 'claude-opus-5': opus },
    }
    const result = handleUsageUpdate(before, {
      type: 'usage_update',
      sessionId: 'session-1',
      tokenUsage: { inputTokens: 160, contextWindow: 200_000 },
    })
    const usage = result.state.session.tokenUsage
    expect(usage?.modelUsage).toEqual({ 'claude-opus-5': opus })
    expect(usage?.costReporting).toBe('reported')
    expect(usage?.inputTokens).toBe(160)
  })

  it('a session with no per-model breakdown does not grow an empty one', () => {
    const result = handleUsageUpdate(state(), {
      type: 'usage_update',
      sessionId: 'session-1',
      tokenUsage: { inputTokens: 160 },
    })
    expect(result.state.session.tokenUsage).not.toHaveProperty('modelUsage')
    expect(result.state.session.tokenUsage).not.toHaveProperty('costReporting')
  })
})
