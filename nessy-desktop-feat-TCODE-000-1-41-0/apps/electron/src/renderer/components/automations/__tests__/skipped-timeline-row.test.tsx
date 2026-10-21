/**
 * UB4.8 (the reader half) — a run the automation loop guard silenced reads on the
 * timeline as its own `skipped` status, at upstream v0.15.1's styling.
 *
 * The host half landed in `1069fc5c9` (the guard writes a history row `ok: true`
 * with `skipped: <reason>` and no session); the serializer, the dto field and the
 * `useAutomations` mapping landed with UB6.9 (`26934ca19`), which reads the same
 * field for its semantic-condition skips. Nothing on the renderer side tested the
 * loop guard's row until this file.
 *
 * Arms, each through the shipped code:
 *  - READER — the real `useAutomations` hook, rendered once with
 *    `renderToStaticMarkup` to capture its result; its `getAutomationHistory` then
 *    runs against a stubbed `window.electronAPI`. Positive: a loop-guard row maps
 *    to `skipped` with `automations.skippedSummary` around the host's reason, in en
 *    and ru. Negative/boundary: `ok: true` WITHOUT `skipped` stays `success`, a
 *    failure stays `error`, and neither carries the skipped summary.
 *  - TIMELINE — the real `AutomationEventTimeline`. Positive: a skipped entry draws
 *    `CircleSlash` at `text-tertiary` (v0.15.1 `statusConfig.skipped`) beside its
 *    summary, with no session link. Negative: a success entry keeps `CheckCircle2`
 *    at `text-success` and nothing on it is drawn tertiary.
 *  - UB12.20 READER — the loop guard records its arm (`skippedLoopGuard`), and the
 *    hook rebuilds the reason from `automations.skippedLoopSelfTrigger` /
 *    `automations.skippedLoopChainDepth`. Positive: in ru a coded row reads with no
 *    English at all (both arms), in en it reads exactly the host's own line.
 *    Negative: a row written before UB12.20 (no code) still shows the stored reason —
 *    the first READER arm above, unchanged.
 *  - PLAYGROUND (source pin) — the registry's module graph pulls a Vite-only
 *    `?url` import bun cannot load (see `automation-script-registry.test.ts`), so
 *    this pins that the timeline's mock history carries a skipped row, which
 *    `registry-render.test.ts` then renders, in the dark theme, with every variant.
 *
 * Instrument: `renderToStaticMarkup` (no DOM in this repo's `bun test`), as
 * `webhook-details.test.tsx` beside it.
 */
import { afterEach, beforeAll, describe, expect, it } from 'bun:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync } from 'node:fs'
import { createInstance, type i18n as I18nInstance } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import type { SafeAutomationHistoryEntry } from '@nessy-agent/shared/protocol'
import { MAX_AUTOMATION_CHAIN_DEPTH } from '@nessy-agent/shared/automations/constants'
import { NavigationContext } from '@/contexts/NavigationContext'
import { useAutomations, type UseAutomationsResult } from '@/hooks/useAutomations'
import { AutomationEventTimeline } from '../AutomationEventTimeline'
import type { ExecutionEntry } from '../types'

const LOCALES = new URL('../../../../../../../packages/shared/src/i18n/locales/', import.meta.url)
const locale = (code: 'en' | 'ru'): Record<string, string> =>
  JSON.parse(readFileSync(new URL(`${code}.json`, LOCALES), 'utf8'))

/** The host's own reason string (`SessionManager` symbol `automationLoopGuard`, self-trigger arm). */
const LOOP_REASON = 'the event is about a session this automation created (loop guard)'
/** The host's chain-depth reason, built as the guard builds it. */
const CHAIN_REASON = `automation chain deeper than ${MAX_AUTOMATION_CHAIN_DEPTH} sessions (loop guard)`

const i18nFor: Partial<Record<'en' | 'ru', I18nInstance>> = {}

beforeAll(async () => {
  for (const code of ['en', 'ru'] as const) {
    const instance = createInstance()
    await instance.use(initReactI18next).init({
      lng: code,
      fallbackLng: 'en',
      resources: { [code]: { translation: locale(code) } },
      interpolation: { escapeValue: false },
    })
    i18nFor[code] = instance
  }
})

// ---------------------------------------------------------------------------
// READER — the real useAutomations mapping
// ---------------------------------------------------------------------------

const scope = globalThis as Record<string, unknown>
const hadWindow = Object.prototype.hasOwnProperty.call(scope, 'window')
const previousWindow = scope.window

afterEach(() => {
  if (hadWindow) scope.window = previousWindow
  else delete scope.window
})

function captureHook(i18n: I18nInstance): UseAutomationsResult {
  let captured: UseAutomationsResult | undefined
  function Probe() {
    captured = useAutomations('ws-test')
    return null
  }
  renderToStaticMarkup(<I18nextProvider i18n={i18n}><Probe /></I18nextProvider>)
  if (!captured) throw new Error('useAutomations did not render')
  return captured
}

async function mapHistory(code: 'en' | 'ru', rows: SafeAutomationHistoryEntry[]): Promise<ExecutionEntry[]> {
  const hook = captureHook(i18nFor[code]!)
  scope.window = { electronAPI: { getAutomationHistory: async () => rows } }
  return hook.getAutomationHistory('packing')
}

describe('UB4.8 · the loop guard\'s skipped run on the automation timeline', () => {
  it('READER positive — a loop-guard row maps to `skipped` with the summary around the host\'s reason (en, ru)', async () => {
    const row: SafeAutomationHistoryEntry = { id: 'packing', ts: 1_000, ok: true, skipped: LOOP_REASON }

    const [en] = await mapHistory('en', [row])
    expect(en!.status).toBe('skipped')
    expect(en!.actionSummary).toBe(`Skipped: ${LOOP_REASON}`)
    expect(en!.sessionId).toBeUndefined()
    expect(en!.error).toBeUndefined()

    const [ru] = await mapHistory('ru', [row])
    expect(ru!.status).toBe('skipped')
    expect(ru!.actionSummary).toBe(`Пропущено: ${LOOP_REASON}`)
  })

  it('READER negative — `ok: true` without `skipped` stays success, a failure stays error, neither reads as skipped', async () => {
    const [ran, failed] = await mapHistory('en', [
      { id: 'packing', ts: 2_000, ok: true, sessionId: 'session-1' },
      { id: 'packing', ts: 3_000, ok: false, error: 'Automation failed' },
    ])
    expect(ran!.status).toBe('success')
    expect(ran!.sessionId).toBe('session-1')
    expect(failed!.status).toBe('error')
    expect(failed!.error).toBe('Automation failed')
    for (const entry of [ran!, failed!]) expect(entry.actionSummary ?? '').not.toContain('Skipped')
  })

  it('UB12.20 READER positive — a coded loop-guard row reads in ru with no English, and in en exactly as the host wrote it', async () => {
    const rows: SafeAutomationHistoryEntry[] = [
      { id: 'packing', ts: 4_000, ok: true, skipped: LOOP_REASON, skippedLoopGuard: 'self-trigger' },
      { id: 'packing', ts: 5_000, ok: true, skipped: CHAIN_REASON, skippedLoopGuard: 'chain-depth' },
    ]

    const [selfRu, chainRu] = await mapHistory('ru', rows)
    for (const entry of [selfRu!, chainRu!]) {
      expect(entry.status).toBe('skipped')
      expect(entry.actionSummary!.startsWith('Пропущено: ')).toBe(true)
      // The defect this row fixes: 'Пропущено: the event is about…'.
      expect(entry.actionSummary).not.toMatch(/[A-Za-z]/)
    }
    expect(selfRu!.actionSummary).toBe(`Пропущено: ${locale('ru')['automations.skippedLoopSelfTrigger']}`)
    expect(chainRu!.actionSummary).toContain(String(MAX_AUTOMATION_CHAIN_DEPTH))

    // en reads the host's own lines, so nothing changes for an English user.
    const [selfEn, chainEn] = await mapHistory('en', rows)
    expect(selfEn!.actionSummary).toBe(`Skipped: ${LOOP_REASON}`)
    expect(chainEn!.actionSummary).toBe(`Skipped: ${CHAIN_REASON}`)
  })

  // -------------------------------------------------------------------------
  // TIMELINE — the real component, v0.15.1 styling
  // -------------------------------------------------------------------------

  function renderTimeline(entries: ExecutionEntry[]): string {
    return renderToStaticMarkup(
      <I18nextProvider i18n={i18nFor.en!}>
        <NavigationContext.Provider value={{ navigateToSession: () => {} } as never}>
          <AutomationEventTimeline entries={entries} />
        </NavigationContext.Provider>
      </I18nextProvider>,
    )
  }

  const base = { automationId: 'packing', event: 'LabelAdd' as const, duration: 0, timestamp: Date.now() - 60_000 }

  it('TIMELINE positive — a skipped entry draws CircleSlash at text-tertiary beside its summary, with no session link', () => {
    const markup = renderTimeline([
      { ...base, id: 'skipped-1', status: 'skipped', actionSummary: `Skipped: ${LOOP_REASON}` },
    ])
    expect(markup).toMatch(/<svg[^>]*class="[^"]*lucide-circle-slash[^"]*text-tertiary[^"]*"/)
    expect(markup).toContain(`Skipped: ${LOOP_REASON}`)
    expect(markup).not.toContain('Open session') // en `automations.openSession`: a skipped run has no session
  })

  it('TIMELINE negative — a success entry keeps CheckCircle2 at text-success, and nothing on it is drawn tertiary', () => {
    const markup = renderTimeline([
      { ...base, id: 'ran-1', status: 'success', actionSummary: 'prompt → pack for the trip' },
    ])
    expect(markup).toMatch(/<svg[^>]*class="[^"]*text-success[^"]*"/)
    expect(markup).not.toContain('lucide-circle-slash')
    expect(markup).not.toMatch(/<svg[^>]*class="[^"]*text-tertiary[^"]*"/)
  })

  it('PLAYGROUND — the timeline\'s mock history carries a skipped loop-guard row (source pin)', () => {
    const source = readFileSync(new URL('../../../playground/registry/automations.tsx', import.meta.url), 'utf8')
    const start = source.indexOf('const mockExecutions: ExecutionEntry[] = [')
    expect(start).toBeGreaterThan(0)
    const body = source.slice(start, source.indexOf('const mockWebhookExecutions', start))
    expect(body).toContain("status: 'skipped'")
    expect(body).toContain('(loop guard)')
  })
})
