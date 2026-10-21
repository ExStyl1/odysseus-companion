/**
 * UB4.27 (R7-05) — a webhook's error and response body show again on the
 * automation timeline.
 *
 * The host writes both into the history JSONL, capped (`webhook-utils.ts`
 * `createWebhookHistoryEntry`, `HISTORY_FIELD_MAX_LENGTH`), but the renderer
 * mapping in `useAutomations.ts` dropped them — the removal came in `b0053399e`
 * ("fix: align displayed app version source", a bulk commit with no stated
 * reason) — so a failed webhook expanded to method/url/status/duration and no
 * hint WHY it failed.
 *
 * Instrument: `renderToStaticMarkup`, the renderer instrument this repo
 * already uses (`components/app-shell/input/__tests__/queue-paused-banner.test.tsx`),
 * so no DOM is needed. The expanded panel is exported
 * (`WebhookDetailsPanel`) because the timeline keeps `expandedId` internal and
 * static markup cannot click; a source pin below fails loudly if the timeline
 * ever stops mounting it for an expanded webhook entry.
 */
import { beforeAll, describe, expect, it } from 'bun:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createInstance, type i18n as I18nInstance } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { readFileSync } from 'node:fs'
import { WebhookDetailsPanel, buildWebhookCopyText } from '../AutomationEventTimeline'

/** Passthrough translations, so the assertions key on stable i18n keys. */
const KEYS = [
  'automations.webhookError',
  'automations.webhookResponse',
  'automations.webhookMethod',
  'automations.webhookUrl',
  'automations.webhookStatus',
  'automations.webhookDuration',
]

let testI18n: I18nInstance

beforeAll(async () => {
  testI18n = createInstance()
  await testI18n.use(initReactI18next).init({
    lng: 'en',
    fallbackLng: 'en',
    resources: { en: { translation: Object.fromEntries(KEYS.map(k => [k, k])) } },
    interpolation: { escapeValue: false },
  })
})

function renderPanel(details: Record<string, unknown>): string {
  return renderToStaticMarkup(
    <I18nextProvider i18n={testI18n}>
      <WebhookDetailsPanel details={details as never} />
    </I18nextProvider>,
  )
}

const WITH_EXTRAS = {
  method: 'POST',
  url: 'https://example.coop/hook',
  statusCode: 500,
  durationMs: 1234,
  error: 'HTTP 500: upstream exploded',
  responseBody: '{"error":"upstream exploded"}',
}

const WITHOUT_EXTRAS = {
  method: 'POST',
  url: 'https://example.coop/hook',
  statusCode: 0,
  durationMs: 20,
}

describe('UB4.27 · a failed webhook says why on the timeline', () => {
  it('THE ROW: the expanded panel renders the error and the response body', () => {
    const markup = renderPanel(WITH_EXTRAS)

    expect(markup).toContain('automations.webhookError')
    expect(markup).toContain('HTTP 500: upstream exploded')
    expect(markup).toContain('automations.webhookResponse')
    // renderToStaticMarkup escapes the JSON body's quotes inside the <pre>.
    expect(markup).toContain('{&quot;error&quot;:&quot;upstream exploded&quot;}')
    expect(markup).toContain('<pre')
  })

  it('CONTROL: an entry without error/responseBody renders neither row nor an empty <pre>', () => {
    const markup = renderPanel(WITHOUT_EXTRAS)

    expect(markup).not.toContain('automations.webhookError')
    expect(markup).not.toContain('automations.webhookResponse')
    expect(markup).not.toContain('<pre')
  })

  it('the copy payload carries --- Response Body --- and the error (the row names the marker)', () => {
    const withBody = buildWebhookCopyText(WITH_EXTRAS as never)
    expect(withBody).toContain('--- Response Body ---')
    expect(withBody).toContain('{"error":"upstream exploded"}')
    expect(withBody).toContain('"error": "HTTP 500: upstream exploded"')

    const withoutBody = buildWebhookCopyText(WITHOUT_EXTRAS as never)
    expect(withoutBody).not.toContain('--- Response Body ---')
  })

  it('the timeline mounts the panel for an expanded webhook entry (source pin)', () => {
    const source = readFileSync(new URL('../AutomationEventTimeline.tsx', import.meta.url), 'utf8')
    expect(source).toContain('isExpanded && entry.webhookDetails && (')
    expect(source).toContain('<WebhookDetailsPanel details={entry.webhookDetails} />')
  })
})
