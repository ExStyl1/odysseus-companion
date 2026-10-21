// UB6.14 — the sources-half module's tests, upstream's suggestion arms rebased
// onto this tree's decision-point seam (the skill arms are D(c) with the half).

import { describe, expect, it } from 'bun:test'
import {
  normalizeDecisionLayerSettings,
  resolveDecisionEndpoint,
  type DecisionClientResolution,
} from '@nessy-agent/shared/decisions'
import type { LoadedSource } from '@nessy-agent/shared/sources'
import {
  candidatesUsedBy,
  collectSuggestionCandidates,
  formatSuggestionHint,
  pickSuggestion,
  wantsSuggestion,
} from './suggestions'

function source(slug: string, name = slug, provider = 'api', enabled = true): LoadedSource {
  return {
    config: { slug, name, provider, enabled },
    folderPath: `/ws/sources/${slug}`,
    guide: null,
    status: 'connected',
  } as unknown as LoadedSource
}

function answering(choice: string, confidence: number): () => Promise<DecisionClientResolution> {
  return async () => {
    const settings = normalizeDecisionLayerSettings({ enabled: true, provider: 'openrouter', features: { suggestions: true } })
    const endpoint = resolveDecisionEndpoint(settings)
    const client = {
      decide: async () => ({
        model: 'jev-1.13.0', modelReported: true, requestedModel: 'jev-1.13.0',
        answers: { needed: { type: 'choice' as const, choice, confidence, probabilities: { [choice]: confidence } } },
        usage: { inputTokens: 5, outputTokens: 1 }, latencyMs: 5,
        state: { sha256: 'x', bytes: 2, truncated: false },
      }),
    }
    return { ok: true, value: { client: client as never, settings, provider: 'openrouter', endpoint, keySource: 'provider' } }
  }
}

describe('wantsSuggestion', () => {
  it('skips slash commands, already-chosen skills, and the activation re-send suffix', () => {
    expect(wantsSuggestion('/compact')).toBe(false)
    expect(wantsSuggestion('plan the offsite', { skillSlugs: ['offsite-planner'] })).toBe(false)
    expect(wantsSuggestion('ship it\n\n[calendar activated]')).toBe(false)
    expect(wantsSuggestion('what is on my calendar tomorrow')).toBe(true)
  });
});

describe('collectSuggestionCandidates', () => {
  it('offers usable INACTIVE sources only, capped', () => {
    const candidates = collectSuggestionCandidates({
      sources: [source('calendar'), source('sheets'), source('archived', 'Archived', 'file', false)],
      activeSourceSlugs: ['sheets'],
    })
    expect(candidates.map(c => c.slug)).toEqual(['calendar'])
    for (const c of candidates) expect(c.kind).toBe('source')
  });
});

describe('pickSuggestion', () => {
  it('positive — a message that plainly needs an inactive source gets the hint, once', async () => {
    const candidates = collectSuggestionCandidates({ sources: [source('calendar', 'Calendar')], activeSourceSlugs: [] })
    const { hint, trace } = await pickSuggestion('what is on my calendar tomorrow', candidates, { resolveClient: answering('source:calendar', 0.9) })
    expect(hint?.slug).toBe('calendar')
    expect(trace?.hinted).toBe(true)
    expect(formatSuggestionHint(hint!)).toContain('source_test')
    expect(formatSuggestionHint(hint!)).not.toContain('@calendar')
  });

  it('controls — nothing is activated, no hint below the floor, none picked, layer off', async () => {
    const candidates = collectSuggestionCandidates({ sources: [source('calendar')], activeSourceSlugs: [] })
    const low = await pickSuggestion('what is on my calendar tomorrow', candidates, { resolveClient: answering('source:calendar', 0.5) })
    expect(low.hint).toBeNull()
    expect(low.trace?.hinted).toBe(false)
    const none = await pickSuggestion('hello world', candidates, { resolveClient: answering('none', 0.95) })
    expect(none.hint).toBeNull()
    const off = await pickSuggestion('what is on my calendar tomorrow', candidates, { resolveClient: async () => ({ ok: false as const, failure: { kind: 'disabled' as const, message: 'off' } }) })
    expect(off.hint).toBeNull()
    expect(off.trace).toBeNull()
    expect(await pickSuggestion('what is on my calendar', [], { resolveClient: answering('source:calendar', 0.9) })).toEqual({ hint: null, trace: null })
  });
});

describe('candidatesUsedBy + the follow-up arms', () => {
  it('names the source a tool call or an activation used, by its own tools, session tools or activation', () => {
    const candidates = collectSuggestionCandidates({ sources: [source('calendar'), source('sheets')], activeSourceSlugs: [] })
    expect(candidatesUsedBy(candidates, { toolName: 'mcp__calendar__list_events' })).toEqual(['source:calendar'])
    expect(candidatesUsedBy(candidates, { toolName: 'source_test', input: { sourceSlug: 'sheets' } })).toEqual(['source:sheets'])
    expect(candidatesUsedBy(candidates, { activatedSource: 'calendar' })).toEqual(['source:calendar'])
    expect(candidatesUsedBy(candidates, { toolName: 'Read', input: { file_path: '/ws/sources/calendar/guide.md' } })).toEqual([])
  });
});
