/**
 * P6.225 — codex's own reviewer was fully wired and reachable only by
 * hand-editing our config file.
 *
 * Everything BELOW the settings page already existed: `config-writer.ts` emits
 * `approvals_reviewer = "auto_review"` and `[auto_review].policy`,
 * `CodexAutoReviewBreaker` opens the turn-scoped circuit, `/approve` overrules a
 * denial, and `config/storage.ts` carries both keys with getters and setters.
 * What was missing was the two controls that supply them — so this file pins the
 * CONSUMER, the same shape and for the same reason as its sibling
 * `advisor-settings-surface.test.ts`.
 *
 * `bun test` has no DOM in this repo, so the wiring is pinned by source match.
 * Importing `AiSettingsPage` would drag in the `@nessy-agent/ui` barrel and its
 * pdfjs `?url` chain for no gain: nothing below needs the component to render,
 * only to be wired.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'bun:test'
import en from '@nessy-agent/shared/i18n/locales/en.json'
import ru from '@nessy-agent/shared/i18n/locales/ru.json'
import { RPC_CHANNELS } from '@nessy-agent/shared/protocol/channels'
import { channelLocality } from '@nessy-agent/shared/protocol/routing'

// UB15.10 — the page's first reads moved into ONE snapshot, `ai-settings-loader.ts` (v0.15.1 `loadAiSettings`), so the
// getters live there and the setters stay in the page: the wiring is the two files together.
const source = ['../AiSettingsPage.tsx', '../ai-settings-loader.ts']
  .map(file => readFileSync(fileURLToPath(new URL(file, import.meta.url)), 'utf8'))
  .join('\n')

const CODEX_AUTO_REVIEW_CHANNELS = [
  'getCodexAutoReviewEnabled',
  'setCodexAutoReviewEnabled',
  'getCodexAutoReviewPolicy',
  'setCodexAutoReviewPolicy',
] as const

const CODEX_AUTO_REVIEW_KEYS = [
  'settings.ai.codexAutoReview.title',
  'settings.ai.codexAutoReview.description',
  'settings.ai.codexAutoReview.scopeNote',
  'settings.ai.codexAutoReview.enabledLabel',
  'settings.ai.codexAutoReview.enabledDesc',
  'settings.ai.codexAutoReview.policyLabel',
  'settings.ai.codexAutoReview.policyDesc',
  'settings.ai.codexAutoReview.policyPlaceholder',
] as const

describe('codex auto-review settings surface', () => {
  it('consumes all four codexAutoReview channels', () => {
    // The row's own evidence grep, inverted: `autoReview` over
    // `apps/electron/src/renderer` returned ZERO files before this page became a
    // consumer. The positive control is the advisor pair beside it, which has
    // been consumed here since P6.122.
    for (const channel of CODEX_AUTO_REVIEW_CHANNELS) {
      expect(source).toContain(`${channel}(`)
    }
    expect(source).toContain('getAdvisorEnabled(')
  })

  it('gates the policy field on the toggle and commits it on blur', () => {
    // Boundary. Two things a copy of the advisor block above would get wrong:
    //
    // 1. The advisor's picker is gated on its toggle alone and so is this
    //    field — NOT on `llmConnections.length`, which is guardian's gate and
    //    would blank the policy box on a machine with no connection yet, even
    //    though codex's reviewer runs on codex's own model and needs none of
    //    ours.
    // 2. The policy persists on BLUR. Every write here is a whole-config
    //    `saveConfig`, and the field is a paragraph; a per-keystroke commit
    //    would be one config write per character.
    expect(source).toContain('{codexAutoReviewEnabled && (')
    expect(source).not.toContain('codexAutoReviewEnabled && llmConnections.length')
    expect(source).toContain('onBlur={handleCodexAutoReviewPolicyCommit}')
    // The negative half of the same claim: the change handler is the local
    // setState, never the channel.
    expect(source).toContain('onChange={setCodexAutoReviewPolicy}')
    expect(source).not.toContain('onChange={handleCodexAutoReviewPolicyCommit}')
  })

  it('carries the block copy in every locale', () => {
    const locales: Record<string, Record<string, string>> = {
      en: en as Record<string, string>,
      ru: ru as Record<string, string>,
    }
    for (const [name, bundle] of Object.entries(locales)) {
      for (const key of CODEX_AUTO_REVIEW_KEYS) {
        expect(`${name}:${key}:${(bundle[key] ?? '').length > 0}`).toBe(`${name}:${key}:true`)
      }
    }
  })

  it('says the reviewer is codex-only, and says it beside the judge that is not', () => {
    // The row's `done_means` asks for the scope to be stated. The guardian note
    // directly above claims Pi ONLY; this one has to claim codex only, or the
    // two sections together read as if either covered the other.
    const scope = (en as Record<string, string>)['settings.ai.codexAutoReview.scopeNote'] ?? ''
    expect(scope).toContain('Codex sessions only')
    expect(scope).toContain('Claude Code')
    expect(source).toContain('settings.ai.codexAutoReview.scopeNote')
    expect(source).toContain('settings.ai.guardian.scopeNote')
  })

  it('F1.724 · discloses that a Nessy Gateway connection cannot serve the reviewer, in both locales', () => {
    // Measured on the release sitting SIT-u (2026-09-25): the reviewer calls codex's own `codex-auto-review` model,
    // the gateway answers 404, and every review fails closed. Codex has no setting naming the reviewer's model
    // (`AutoReviewToml` carries policy text only), so the setting is disclosed rather than redirected.
    for (const bundle of [en, ru] as Array<Record<string, string>>) {
      const scope = bundle['settings.ai.codexAutoReview.scopeNote'] ?? ''
      expect(scope).toContain('Nessy Gateway')
      expect(scope).toContain('codex-auto-review')
    }
  })

  it('routes all four channels locally, like the advisor pair they are shaped after', () => {
    // Both values end up in `~/.nessy-agent/config.json` on THIS machine and are
    // read when codex's own config file is written here, so crossing to another
    // server would write the wrong machine's reviewer settings. `routing.ts` is
    // total by construction, which makes `'unclassified'` the failure this
    // guards against as much as `'workspace'` is.
    for (const channel of Object.values(RPC_CHANNELS.codexAutoReview)) {
      expect(`${channel}:${channelLocality(channel)}`).toBe(`${channel}:local`)
    }
  })
})
