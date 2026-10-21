/**
 * S14 — the deferred-tool-loading trigger and its override.
 *
 * The contract these assertions come from, quoted at the seam that reads it:
 * `agent-sdk/tool-search.md:36-42` (the five `ENABLE_TOOL_SEARCH` values),
 * `:34` (the override outranks the platform default), `mcp.md:1221`
 * (`alwaysLoad` holds "regardless of the `ENABLE_TOOL_SEARCH` setting"),
 * `mcp.md:189` (`WaitForMcpServers` is what Claude uses where we have only the
 * uncached-source fallback).
 */
import { describe, expect, it } from 'bun:test'

import {
  TOOL_SEARCH_AUTO_DEFAULT_PERCENT,
  parseToolSearchMode,
  resolveDeferredMcpToolLoading,
  toolSearchMode,
  type ToolSearchMode,
} from '../tool-search-settings.ts'

/** A session comfortably under both thresholds unless a case says otherwise. */
function decide(overrides: Partial<Parameters<typeof resolveDeferredMcpToolLoading>[0]> = {}) {
  return resolveDeferredMcpToolLoading({
    mode: { kind: 'default' },
    workspacePreference: false,
    hasUncachedMcpSource: false,
    candidateCount: 4,
    candidateEstimatedTokens: 1_000,
    countThreshold: 48,
    modelContextWindow: 200_000,
    ...overrides,
  })
}

describe('NESSY_ENABLE_TOOL_SEARCH parsing', () => {
  it('accepts the five documented values and both auto spellings', () => {
    const cases: Array<[string | undefined, ToolSearchMode]> = [
      [undefined, { kind: 'default' }],
      ['', { kind: 'default' }],
      ['   ', { kind: 'default' }],
      ['true', { kind: 'always' }],
      ['1', { kind: 'always' }],
      ['ON', { kind: 'always' }],
      ['false', { kind: 'never' }],
      ['0', { kind: 'never' }],
      ['off', { kind: 'never' }],
      ['auto', { kind: 'auto', percentOfContextWindow: TOOL_SEARCH_AUTO_DEFAULT_PERCENT }],
      [' AUTO ', { kind: 'auto', percentOfContextWindow: TOOL_SEARCH_AUTO_DEFAULT_PERCENT }],
      // tool-search.md:41 — "`auto:5` activates when tool definitions exceed 5%".
      ['auto:5', { kind: 'auto', percentOfContextWindow: 5 }],
      ['auto:0', { kind: 'auto', percentOfContextWindow: 0 }],
      ['auto:100', { kind: 'auto', percentOfContextWindow: 100 }],
    ]
    for (const [raw, expected] of cases) {
      expect(parseToolSearchMode(raw), `value ${JSON.stringify(raw)}`).toEqual(expected)
    }
  })

  it('keeps threshold mode when only the number is unreadable, and ignores an unknown value', () => {
    // A typo in the percentage must not silently switch the MECHANISM off — the
    // value selected threshold mode unambiguously, so it falls back to auto's
    // own documented 10% rather than to the unset default.
    for (const raw of ['auto:', 'auto:abc', 'auto:-1', 'auto:101', 'auto:NaN']) {
      expect(parseToolSearchMode(raw), raw)
        .toEqual({ kind: 'auto', percentOfContextWindow: TOOL_SEARCH_AUTO_DEFAULT_PERCENT })
    }
    // An unrecognized value is the default, per the repo's env convention.
    for (const raw of ['maybe', 'enabled', 'auto5', '10%']) {
      expect(parseToolSearchMode(raw), raw).toEqual({ kind: 'default' })
    }
  })

  it('reads the Nessy-namespaced variable and nothing else', () => {
    expect(toolSearchMode({ NESSY_ENABLE_TOOL_SEARCH: 'auto:5' }))
      .toEqual({ kind: 'auto', percentOfContextWindow: 5 })
    // The upstream spelling is not ours and must not be honoured, or an operator
    // exporting Claude's name would think the switch was live.
    expect(toolSearchMode({ ENABLE_TOOL_SEARCH: 'false' })).toEqual({ kind: 'default' })
  })
})

describe('the deferral decision', () => {
  it('lets the override outrank the workspace preference in both directions', () => {
    // Preference OFF and only 4 candidates: `true` still defers.
    expect(decide({ mode: { kind: 'always' } }))
      .toEqual({ enabled: true, reason: 'override-always' })
    // Preference ON and past the count: `false` still loads upfront.
    expect(decide({ mode: { kind: 'never' }, workspacePreference: true, candidateCount: 60 }))
      .toEqual({ enabled: false, reason: 'override-never' })
  })

  it('puts the unset default on the preference alone, consulting no count', () => {
    // Contract point 1 at the top of the module: the `(unset)` row reads "Tool
    // search is on by default", and no count or percentage is consulted — the
    // 10% belongs to the opt-in `auto` row.
    expect(decide({ workspacePreference: false, candidateCount: 60 }))
      .toEqual({ enabled: false, reason: 'preference-off' })

    // THE CASE THAT MADE THIS ARM WRONG. C.4 measured the shipped profile at 43
    // deferrable tools against a threshold of 48, so the arm this replaced
    // answered `preference-under-count` — the two config sites would have read
    // `true`, every test would have passed, and not one of the 20 078 tokens of
    // eager MCP definitions would have been deferred. It needed 49 tools to
    // fire and the machine had 43.
    expect(decide({ workspacePreference: true, candidateCount: 43 }))
      .toEqual({ enabled: true, reason: 'preference-on' })
    // Far below any threshold, and still on: the count is genuinely gone rather
    // than lowered, which is what "no count is consulted" has to mean.
    expect(decide({ workspacePreference: true, candidateCount: 1 }))
      .toEqual({ enabled: true, reason: 'preference-on' })
  })

  it('never registers discovery tools for an empty catalog under the default either', () => {
    // The same guard the `always` arm carries: nothing deferrable means the
    // discovery tools would advertise an empty catalog. Narrowing only — it
    // cannot hide a tool, because there is no candidate to hide.
    expect(decide({ workspacePreference: true, candidateCount: 0, candidateEstimatedTokens: 0 }))
      .toEqual({ enabled: false, reason: 'preference-no-candidates' })
  })

  it('measures auto against the percentage of the context window, not the count', () => {
    // 10% of 200_000 is 20_000. The count stays at 4 throughout, so a count
    // threshold could not produce either answer.
    expect(decide({ mode: { kind: 'auto', percentOfContextWindow: 10 }, candidateEstimatedTokens: 19_999 }))
      .toEqual({ enabled: false, reason: 'auto-under-percent' })
    expect(decide({ mode: { kind: 'auto', percentOfContextWindow: 10 }, candidateEstimatedTokens: 20_001 }))
      .toEqual({ enabled: true, reason: 'auto-over-percent' })
    // Exactly at the budget DOES fire. C9: the current page says the threshold
    // activates "When the total REACHES 10% of the window"; the superseded
    // sentence said "If they EXCEED 10%", and this row asserted the old one.
    // The boundary is the whole decision here — one token either side of it is
    // the difference between deferring and not.
    expect(decide({ mode: { kind: 'auto', percentOfContextWindow: 10 }, candidateEstimatedTokens: 20_000 }))
      .toEqual({ enabled: true, reason: 'auto-over-percent' })
    // And one token below still does not, so `>=` did not become "always".
    expect(decide({ mode: { kind: 'auto', percentOfContextWindow: 10 }, candidateEstimatedTokens: 19_999 }))
      .toEqual({ enabled: false, reason: 'auto-under-percent' })
    // "Lower values activate sooner" — the same tools now exceed 5%.
    expect(decide({ mode: { kind: 'auto', percentOfContextWindow: 5 }, candidateEstimatedTokens: 10_001 }))
      .toEqual({ enabled: true, reason: 'auto-over-percent' })
    // The same token count on a 1M window is 1%, so it does not fire. This is
    // the case a fixed count cannot express: identical tools, opposite answers.
    expect(decide({
      mode: { kind: 'auto', percentOfContextWindow: 10 },
      candidateEstimatedTokens: 20_001,
      modelContextWindow: 1_000_000,
    })).toEqual({ enabled: false, reason: 'auto-under-percent' })
  })

  it('falls back to the count, not to silence, when the model window is unknown', () => {
    // Arbitrary gateway models often carry no window. `auto` asked for a
    // threshold, so it gets the one we can compute — and the preference is
    // bypassed, because the request was explicit.
    for (const modelContextWindow of [undefined, 0]) {
      expect(resolveDeferredMcpToolLoading({
        mode: { kind: 'auto', percentOfContextWindow: 10 },
        workspacePreference: false,
        hasUncachedMcpSource: false,
        candidateCount: 60,
        candidateEstimatedTokens: 15_000,
        countThreshold: 48,
        ...(modelContextWindow === undefined ? {} : { modelContextWindow }),
      })).toEqual({ enabled: true, reason: 'auto-context-window-unknown-over-count' })
    }
    expect(decide({ mode: { kind: 'auto', percentOfContextWindow: 10 }, modelContextWindow: undefined }))
      .toEqual({ enabled: false, reason: 'auto-context-window-unknown-under-count' })
  })

  it('never registers discovery tools for an empty catalog under an explicit true', () => {
    expect(decide({ mode: { kind: 'always' }, candidateCount: 0, candidateEstimatedTokens: 0 }))
      .toEqual({ enabled: false, reason: 'override-always-no-candidates' })
  })

  it('keeps the uncached-source floor above every override, including false', () => {
    // We have no `WaitForMcpServers` (mcp.md:189), so honouring `false` here
    // would remove the ONLY path to a server whose tools are not yet cached and
    // report nothing. The floor is deliberately unconditional.
    for (const mode of [
      { kind: 'default' } as const,
      { kind: 'never' } as const,
      { kind: 'always' } as const,
      { kind: 'auto', percentOfContextWindow: 90 } as const,
    ]) {
      expect(decide({ mode, hasUncachedMcpSource: true, candidateCount: 0, candidateEstimatedTokens: 0 }))
        .toEqual({ enabled: true, reason: 'uncached-source' })
    }
  })
})
