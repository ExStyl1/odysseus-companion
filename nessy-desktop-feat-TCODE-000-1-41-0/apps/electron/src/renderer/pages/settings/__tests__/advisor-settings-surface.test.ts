/**
 * P6.122 — the advisor ran, and named its advising model in the chat, on a
 * model the user could neither choose nor switch off.
 *
 * All four advisor channels (`getAdvisorEnabled`/`setAdvisorEnabled`,
 * `getAdvisorModel`/`setAdvisorModel`) existed end to end — storage, RPC
 * handler, channel map, preload type — and had NO consumer in the renderer,
 * while `AdvisorConsultationCard` was already rendering
 * `chat.advisor.advisedBy` with the model id to a running user.
 *
 * `bun test` has no DOM in this repo, so the WIRING is pinned by source match —
 * the instrument the sibling `ai-settings-reconnect.test.ts` uses, and for the
 * same reason. Importing `AiSettingsPage` here would drag in the
 * `@nessy-agent/ui` barrel and its pdfjs `?url` chain for no gain: nothing below
 * needs the component to render, only to be wired.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'bun:test'
import en from '@nessy-agent/shared/i18n/locales/en.json'
import ru from '@nessy-agent/shared/i18n/locales/ru.json'

// UB15.10 — the page's first reads moved into ONE snapshot, `ai-settings-loader.ts` (v0.15.1 `loadAiSettings`), so the
// getters live there and the setters stay in the page: the wiring is the two files together.
const source = ['../AiSettingsPage.tsx', '../ai-settings-loader.ts']
  .map(file => readFileSync(fileURLToPath(new URL(file, import.meta.url)), 'utf8'))
  .join('\n')

const ADVISOR_CHANNELS = [
  'getAdvisorEnabled',
  'setAdvisorEnabled',
  'getAdvisorModel',
  'setAdvisorModel',
] as const

const ADVISOR_KEYS = [
  'settings.ai.advisor.title',
  'settings.ai.advisor.description',
  'settings.ai.advisor.scopeNote',
  'settings.ai.advisor.enabledLabel',
  'settings.ai.advisor.enabledDesc',
  'settings.ai.advisor.modelLabel',
  'settings.ai.advisor.modelDesc',
  'settings.ai.advisor.modelDefault',
  'settings.ai.advisor.modelDefaultDesc',
] as const

describe('advisor settings surface', () => {
  it('consumes all four advisor channels', () => {
    // The row's own evidence grep, inverted: it returned only `shared/types.ts`
    // and `transport/channel-map.ts` before this page existed as a consumer.
    // The positive control is the guardian pair, which was always consumed here.
    for (const channel of ADVISOR_CHANNELS) {
      expect(source).toContain(`${channel}(`)
    }
    expect(source).toContain('getGuardianEnabled(')
  })

  it('offers the default advising model even with an empty catalogue', () => {
    // The honest empty state (the RPC handler's own warning): an empty
    // catalogue is NOT an empty list — the resolver reads an unset id as "the
    // session's own model advises", so the default row is unconditional.
    expect(source).toContain(
      "{ value: '', label: t('settings.ai.advisor.modelDefault'), description: t('settings.ai.advisor.modelDefaultDesc') }",
    )
    // Boundary, and the thing most likely to be copied wrong from the guardian
    // block directly above: guardian hides its picker behind
    // `llmConnections.length > 0`, which would blank the advisor's default row
    // on a machine with no connection yet. The advisor's gate is the toggle
    // alone.
    expect(source).toContain('{advisorEnabled && (')
    expect(source).not.toContain('advisorEnabled && llmConnections.length')
  })

  it('carries the block copy in every locale', () => {
    const locales: Record<string, Record<string, string>> = {
      en: en as Record<string, string>,
      ru: ru as Record<string, string>,
    }
    for (const [name, bundle] of Object.entries(locales)) {
      for (const key of ADVISOR_KEYS) {
        expect(`${name}:${key}:${(bundle[key] ?? '').length > 0}`).toBe(`${name}:${key}:true`)
      }
    }
  })

  it('names all three refusal gates in the model description', () => {
    // Two of the three gates (entitlement, capability) are SESSION-scoped and
    // cannot be answered on a settings page, so the page states them as gates
    // and points at the session for which one fired. A copy edit that drops a
    // gate turns the sentence back into the silent-substitution promise this
    // row exists to remove.
    const desc = (en as Record<string, string>)['settings.ai.advisor.modelDesc'] ?? ''
    expect(desc).toContain('connection')
    expect(desc).toContain('managed policy')
    expect(desc).toContain('capable')
    // And the three session-side status lines it defers to still exist.
    for (const arm of ['Entitlement', 'Allowlist', 'Capability']) {
      expect((en as Record<string, string>)[`settings.ai.advisor.statusRefused${arm}`]).toBeTruthy()
    }
  })
})
