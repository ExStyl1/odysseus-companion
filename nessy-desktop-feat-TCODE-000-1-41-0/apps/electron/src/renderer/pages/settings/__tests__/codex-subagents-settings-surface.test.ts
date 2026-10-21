/**
 * C3.286 — the in-app half of C3.109: codex's own delegation off-switch was
 * fully wired and reachable by nothing.
 *
 * Everything BELOW the settings page already existed at `e9549e62c`:
 * `config-writer.ts` writes `enabled = false` first among the bare `[agents]`
 * keys, `CodexAgent` passes `subagentsEnabled: getCodexSubagentsEnabled()`, and
 * `config/storage.ts` carried the key, its default and its reader. What was
 * missing was the control that supplies it — the same shape, and the same
 * reason, as its sibling `codex-auto-review-settings-surface.test.ts`, whose
 * recipe W16-g's hand-off named as the model to copy.
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

const CODEX_SUBAGENT_KEYS = [
  'settings.ai.codexSubagentsLabel',
  'settings.ai.codexSubagentsDesc',
] as const

describe('codex subagents settings surface', () => {
  it('consumes both codexSubagents channels', () => {
    // The row's own evidence, inverted: before this control, `codexSubagents`
    // over `apps/electron/src/renderer` returned ZERO files while the config
    // half had been landed for a day. The positive control is the auto-review
    // pair beside it, which has been consumed here since P6.225.
    expect(source).toContain('getCodexSubagentsEnabled(')
    expect(source).toContain('setCodexSubagentsEnabled(')
    expect(source).toContain('getCodexAutoReviewEnabled(')
  })

  it('rolls the switch back when the write fails', () => {
    // The boundary that matters for a boolean toggle: an optimistic switch whose
    // write threw must not keep showing the value it did not save. Pinned on the
    // handler rather than on the toggle, because the rollback is the half a copy
    // of a simpler toggle would drop.
    expect(source).toContain('const handleCodexSubagentsToggle = useCallback(async (enabled: boolean) => {')
    expect(source).toContain('setCodexSubagentsEnabled(!enabled)')
    expect(source).toContain('onCheckedChange={handleCodexSubagentsToggle}')
  })

  it('seeds the switch ON, which is codex\'s own default', () => {
    // Seeding `false` would show every operator a delegation switch turned off
    // for the moment before the read lands, and `[agents] enabled` defaults to
    // true in codex's own schema. The default is not restated here — it is read
    // from the same shipped defaults file the reader falls through to.
    expect(source).toContain('useState(true)\n')
    expect(source).toContain('const [codexSubagentsEnabled, setCodexSubagentsEnabled] = useState(true)')
  })

  it('carries the copy in every locale', () => {
    const locales: Record<string, Record<string, string>> = {
      en: en as Record<string, string>,
      ru: ru as Record<string, string>,
    }
    for (const [name, bundle] of Object.entries(locales)) {
      for (const key of CODEX_SUBAGENT_KEYS) {
        expect(`${name}:${key}:${(bundle[key] ?? '').length > 0}`).toBe(`${name}:${key}:true`)
      }
    }
  })

  it('states the conditionality the schema states, rather than promising a plain off switch', () => {
    // C3.109's done-means asks for the precedence to be pinned rather than
    // assumed: codex's own `config-schema.json` says an enabled
    // `features.multi_agent_v2` takes precedence, so an operator who turns this
    // off while that feature is on has changed nothing. The copy has to say so,
    // and it has to name what is actually written.
    const description = (en as Record<string, string>)['settings.ai.codexSubagentsDesc'] ?? ''
    expect(description).toContain('multi_agent_v2')
    expect(description).toContain('takes precedence')
    expect(description).toContain('[agents] enabled = false')
  })

  it('routes both channels locally, like the auto-review pair they are shaped after', () => {
    // The value ends up in `~/.nessy-agent/config.json` on THIS machine and is
    // read when codex's own config file is written here, so crossing to another
    // server would set the wrong machine's switch. `routing.ts` is total by
    // construction, which makes `'unclassified'` the failure this guards against
    // as much as `'workspace'` is.
    for (const channel of Object.values(RPC_CHANNELS.codexSubagents)) {
      expect(`${channel}:${channelLocality(channel)}`).toBe(`${channel}:local`)
    }
  })
})
