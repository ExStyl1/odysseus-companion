/**
 * C3.245 — the session notices are bounded, scrollable, and collapsed by
 * default, and their dismiss control does not scroll away.
 *
 * Owner request 2026-09-11, from packaged 1.36.0: "предупреждение сделать не на
 * весь экран, добавить скролл". With a long inventory the capability notice
 * covered the conversation and the composer, and nothing scrolled — the card
 * was as tall as its content and its content was the whole catalogue.
 *
 * Four claims, and the instrument for each. There is no React DOM harness in
 * this tree and nothing here has a layout engine, so "under the ceiling" cannot
 * be a pixel measurement; it is the ceiling being ON the region and the content
 * being INSIDE it, which is what makes the pixels come out right:
 *
 * 1. the ceiling and the scroll belong to the REGION (two separately bounded
 *    cards still add up to the whole pane, which is the defect itself);
 * 2. a 200-entry inventory renders NO rows until asked, so the default shape is
 *    two lines however large the workspace is;
 * 3. expanding it puts all 200 rows inside the SAME bounded region, so the
 *    growth is absorbed by a scrollbar rather than by the chat;
 * 4. the dismiss × is in a header pinned to the top of that scroller, so it is
 *    reachable without scrolling — and `ChatDisplay` puts both notices in ONE
 *    region rather than two.
 *
 * Mutation probe: dropping `max-h-[33vh]` or `overflow-y-auto` from
 * `CHAT_NOTICE_REGION_CLASS` turns case 1 red; removing `stickyHeader` from the
 * card turns case 4 red; rendering the lists unconditionally turns case 2 red.
 */
import * as React from 'react'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'bun:test'
import { createInstance, type i18n as I18nInstance } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { renderToStaticMarkup } from 'react-dom/server'
import type { RuntimeWithheldCapability } from '../../../../shared/types'
import {
  CHAT_NOTICE_REGION_CLASS,
  CHAT_NOTICE_REGION_MAX_HEIGHT,
  ChatNoticeRegion,
} from '../chat-notice-region'
import {
  SessionCapabilityInventoryView,
  type CapabilityNameRow,
} from '../SessionCapabilityInventoryNotice'

const translations = {
  'sessionCapabilities.activeList': 'Active in this chat: {{names}}',
  'sessionCapabilities.activeNone': 'Nothing else is active in this chat.',
  'sessionCapabilities.dismiss': 'Dismiss',
  'sessionCapabilities.reasonBlocked': 'blocked',
  'sessionCapabilities.reasonDisabled': 'turned off',
  'sessionCapabilities.reasonReviewRequired': 'waiting for a trust review',
  'sessionCapabilities.reasonUnsupportedRuntime': 'not supported by this runtime',
  'sessionCapabilities.summaryHide': '{{active}} active · {{withheld}} did not load — hide list',
  'sessionCapabilities.summaryShow': '{{active}} active · {{withheld}} did not load — show list',
  'sessionCapabilities.title': 'Not everything loaded in this chat',
  'sessionCapabilities.withheldHeading': 'Did not load:',
  'sessionCapabilities.withheldRow': '{{name}} — {{reason}}',
}

let testI18n: I18nInstance

beforeAll(async () => {
  testI18n = createInstance()
  await testI18n.use(initReactI18next).init({
    lng: 'en',
    fallbackLng: 'en',
    resources: { en: { translation: translations } },
    interpolation: { escapeValue: false },
  })
})

/**
 * About a third of the chat pane, written out here rather than imported, so
 * that a change to the shipped ceiling has to be made in two places by a person
 * who meant it.
 */
const CEILING = 'max-h-[33vh]'

/** The size the owner met: a workspace whose inventory is longer than the chat. */
const LONG_INVENTORY: RuntimeWithheldCapability[] = Array.from({ length: 200 }, (_, index) => ({
  key: `cap:${index}`,
  kind: 'mcp',
  logicalName: `server-${index}`,
  reason: 'disabled',
}))

const CATALOG: CapabilityNameRow[] = [
  ...LONG_INVENTORY.map(entry => ({ key: entry.key, logicalName: entry.logicalName })),
  { key: 'cap:live', logicalName: 'linear' },
]

function renderRegion(defaultExpanded: boolean): string {
  return renderToStaticMarkup(
    <I18nextProvider i18n={testI18n}>
      <ChatNoticeRegion>
        <SessionCapabilityInventoryView
          withheld={LONG_INVENTORY}
          capabilities={CATALOG}
          defaultExpanded={defaultExpanded}
          onDismiss={() => {}}
        />
      </ChatNoticeRegion>
    </I18nextProvider>,
  )
}

describe('the bounded notice region (C3.245)', () => {
  it('caps the whole stack and gives it its own scroll', () => {
    const html = renderRegion(false)

    // The LITERAL ceiling, not the constant the markup came from. Measured
    // 2026-09-11: asserting `toContain(CHAT_NOTICE_REGION_MAX_HEIGHT)` is a
    // dead control — a mutation of the constant to `max-h-none` left all seven
    // cases GREEN, because both arms moved together. The pin has to be a value
    // this file states itself.
    expect(html).toContain(CEILING)
    expect(CHAT_NOTICE_REGION_MAX_HEIGHT).toBe(CEILING)
    expect(html).toContain('overflow-y-auto')
    // A wheel that runs out of notice must not carry on into the transcript.
    expect(CHAT_NOTICE_REGION_CLASS).toContain('overscroll-contain')
  })

  it('collapses to two lines even at 200 entries — no row is rendered', () => {
    const html = renderRegion(false)

    expect(html).toContain('1 active · 200 did not load — show list')
    expect(html).not.toContain('server-0 — turned off')
    expect(html).not.toContain('Did not load:')
    expect((html.match(/<li /g) ?? []).length).toBe(0)
  })

  it('keeps all 200 rows INSIDE the bounded region when expanded', () => {
    const html = renderRegion(true)

    // The whole answer is still there — nothing was removed, only deferred.
    expect((html.match(/data-testid="session-capability-withheld-/g) ?? []).length).toBe(200)
    expect(html).toContain('server-199 — turned off')
    // And the ceiling is still the region's, so the 200 rows scroll rather than
    // push the composer off the pane.
    const regionOpen = html.indexOf(CEILING)
    const firstRow = html.indexOf('data-testid="session-capability-withheld-')
    expect(regionOpen).toBeGreaterThan(-1)
    expect(regionOpen).toBeLessThan(firstRow)
  })

  it('pins the dismiss × above the scrolling rows', () => {
    const html = renderRegion(true)

    // `stickyHeader` on the card: the header band sticks to the top of the
    // region's scroll box, so the × is reachable at any scroll offset.
    expect(html).toContain('sticky top-0')
    const dismiss = html.indexOf('aria-label="Dismiss"')
    const firstRow = html.indexOf('data-testid="session-capability-withheld-')
    expect(dismiss).toBeGreaterThan(-1)
    expect(dismiss).toBeLessThan(firstRow)
  })

  it('collapses to nothing when every notice renders null — the positive control', () => {
    // The region must not become a permanent empty plate with a gap above the
    // composer on the ordinary session that has nothing to report.
    const html = renderToStaticMarkup(
      <I18nextProvider i18n={testI18n}>
        <ChatNoticeRegion>
          <SessionCapabilityInventoryView withheld={[]} onDismiss={() => {}} />
        </ChatNoticeRegion>
      </I18nextProvider>,
    )

    expect(html).toContain('empty:hidden')
    expect(html).not.toContain('session-capability-inventory')
    expect(html.endsWith('></div>')).toBe(true)
  })
})

describe('ChatDisplay stacks both notices in ONE region (C3.245)', () => {
  // A source read, for the claim static markup cannot make: that the two cards
  // share a region rather than each getting one — two separately bounded cards
  // still add up to the whole pane.
  const source = readFileSync(join(import.meta.dir, '..', 'ChatDisplay.tsx'), 'utf8')

  it('opens the region once and closes it once', () => {
    expect((source.match(/<ChatNoticeRegion>/g) ?? []).length).toBe(1)
    expect((source.match(/<\/ChatNoticeRegion>/g) ?? []).length).toBe(1)
  })

  it('puts the sign-in notice and the capability inventory inside it', () => {
    const open = source.indexOf('<ChatNoticeRegion>')
    const close = source.indexOf('</ChatNoticeRegion>')
    expect(open).toBeGreaterThan(-1)
    expect(close).toBeGreaterThan(open)
    const inside = source.slice(open, close)
    expect(inside).toContain('<PendingAuthNotice')
    expect(inside).toContain('<SessionCapabilityInventoryNotice')
  })
})
