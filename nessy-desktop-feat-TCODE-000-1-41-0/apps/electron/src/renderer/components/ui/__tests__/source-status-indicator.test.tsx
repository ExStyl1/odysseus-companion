/**
 * P6.681 — the two defects that kept `SourceStatusIndicator` unusable, pinned
 * so neither can come back quietly.
 *
 * **It threw without a `TooltipProvider`.** A raw Radix `Tooltip` root outside a
 * provider raises at render time, which is why the component had zero callers
 * and why `ClaudeImportPanel` wrote a card by hand instead. The first test
 * renders it with NO provider around it: before this row that was an exception,
 * not an assertion failure, and it is the only arm that can tell the two apart.
 *
 * **Its labels were hardcoded English.** The second test is a totality sweep
 * over the component's OWN status map — not a hand-written list of five, which
 * would pass unchanged the day a sixth status is added — asserting that every
 * label and description key it names exists in BOTH locale files and that the
 * two locales differ. A key present in one locale and missing in the other
 * fails `lint:i18n:parity`; a key copied verbatim between them passes parity and
 * says nothing, which is what this catches.
 */

import * as React from 'react'
import { beforeAll, describe, expect, test } from 'bun:test'
import { createInstance, type i18n as I18nInstance } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import enMessages from '../../../../../../../packages/shared/src/i18n/locales/en.json'
import ruMessages from '../../../../../../../packages/shared/src/i18n/locales/ru.json'
import type { SafeCapabilitySummary } from '@nessy-agent/shared/protocol/capabilities'

/**
 * P6.837 — the barrel `mock.module` that stood here is GONE, and the two
 * imports below are static again.
 *
 * It existed because `source-status-indicator.tsx` imported `Tooltip*` from the
 * `@nessy-agent/ui` BARREL, whose module graph reaches the Vite-only
 * `pdfjs-dist/...?url` specifier bun cannot resolve — so the module could not
 * load at all, and the mock had to hand back the real Radix primitives without
 * a spread (the AGENTS.md trap: a spreadless `mock.module` amputates that
 * module for every later file in the process, and the real one could not be
 * spread because it could not be loaded).
 *
 * The component now imports `@nessy-agent/ui/ui/tooltip`, which resolves under
 * bun on its own. So this file exercises the SHIPPED `packages/ui` tooltip
 * wrapper rather than a hand-assembled stand-in — which makes the first test
 * below stronger, not weaker: the provider that has to be present for Radix's
 * root not to throw is now the real one the app mounts.
 */

import {
  SourceStatusIndicator,
  STATUS_CONFIG,
  capabilitySummaryConnectionStatus,
  capabilitySummaryDisplayStatus,
  type SourceDisplayStatus,
} from '../source-status-indicator'
import { SourceAvatar } from '../source-avatar'
import { sourceStatusIndicatorComponents } from '../../../playground/registry/source-status-indicator'

const en = enMessages as Record<string, string>
const ru = ruMessages as Record<string, string>

let i18nInstances: Record<'en' | 'ru', I18nInstance>

beforeAll(async () => {
  const make = async (lng: 'en' | 'ru', resources: Record<string, string>) => {
    const instance = createInstance()
    await instance.use(initReactI18next).init({
      lng,
      fallbackLng: lng,
      resources: { [lng]: { translation: resources } },
      interpolation: { escapeValue: false },
    })
    return instance
  }
  i18nInstances = { en: await make('en', en), ru: await make('ru', ru) }
})

const statuses = Object.keys(STATUS_CONFIG) as SourceDisplayStatus[]

const renderDot = (locale: 'en' | 'ru', status: SourceDisplayStatus): string =>
  renderToStaticMarkup(
    <I18nextProvider i18n={i18nInstances[locale]}>
      <SourceStatusIndicator status={status} />
    </I18nextProvider>,
  )

describe('SourceStatusIndicator', () => {
  test('renders with NO TooltipProvider around it — the defect that kept it callerless', () => {
    // Nothing here mounts a provider. Before P6.681 this threw.
    for (const status of statuses) {
      const html = renderDot('en', status)
      expect(html).toContain(`data-source-status="${status}"`)
    }
    expect(statuses.length).toBeGreaterThan(0)
  })

  test('every status it knows has a label and a description in BOTH locales', () => {
    // Swept over the component's own map, so a sixth status arrives here on the
    // day it is added rather than the day someone remembers this file.
    // UB12.87 added the sixth: `disabled`, a source the user switched off.
    expect(statuses).toEqual(['connected', 'needs_auth', 'failed', 'untested', 'local_disabled', 'disabled'])
    for (const status of statuses) {
      const { labelKey, descriptionKey } = STATUS_CONFIG[status]
      for (const key of [labelKey, descriptionKey]) {
        expect(en[key], `${key} missing from en.json`).toBeTruthy()
        expect(ru[key], `${key} missing from ru.json`).toBeTruthy()
        // A copied English value passes parity and sortedness and translates
        // nothing — the exact failure those two gates cannot see.
        expect(ru[key], `${key} is untranslated`).not.toBe(en[key])
      }
    }
  })

  test('the accessible name is the localized label, not a colour', () => {
    // The dot carries no text of its own; the tooltip a screen reader never
    // opens was its only wording. Both locales are read off the rendered markup
    // rather than off the JSON, so a component that stopped calling `t` fails.
    expect(renderDot('en', 'needs_auth')).toContain(`aria-label="${en['sourceStatus.needsAuth.label']}"`)
    expect(renderDot('ru', 'needs_auth')).toContain('aria-label=')
    expect(renderDot('ru', 'needs_auth')).not.toContain(`aria-label="${en['sourceStatus.needsAuth.label']}"`)
    // And no raw key reached the screen.
    expect(renderDot('ru', 'needs_auth')).not.toContain('sourceStatus.')
  })

  test('only `connected` animates, and the default status is `untested`', () => {
    // The pulse is the one piece of motion in the vocabulary; a status that
    // starts pulsing is a design change, not a refactor.
    expect(renderDot('en', 'connected')).toContain('animate-ping')
    for (const status of statuses.filter(entry => entry !== 'connected')) {
      expect(renderDot('en', status)).not.toContain('animate-ping')
    }
    const defaulted = renderToStaticMarkup(
      <I18nextProvider i18n={i18nInstances.en}>
        <SourceStatusIndicator />
      </I18nextProvider>,
    )
    expect(defaulted).toContain('data-source-status="untested"')
  })
})

/**
 * P6.745 — the Sources page gets a caller, so "needs authorisation" survives the
 * import screen being dismissed.
 *
 * The needs-auth card P6.654/P6.681 built lives on the Claude-import DONE
 * screen. Dismiss it and nothing in the product named those servers again: the
 * Sources list, the management rows and the source detail page all wear
 * `SourceAvatar`'s pip, and that pip was a BOOLEAN over `state === 'active'` —
 * so a server awaiting sign-in was the same grey dot as one switched off, with
 * the raw untranslated state string as its accessible name.
 *
 * These four cases are about the two halves of the fix that can each break on
 * their own: the mapping from a SAFE row to the five-status vocabulary, and the
 * pip actually rendering it.
 */
const summaryWith = (extra: Partial<SafeCapabilitySummary>): SafeCapabilitySummary => ({
  key: 'source:test-server',
  kind: 'source',
  logicalName: 'test-server',
  sourceType: 'mcp',
  origin: 'native',
  scope: { kind: 'workspace', workspaceId: 'ws-1' },
  state: 'active',
  readOnly: false,
  trustState: 'trusted',
  credentialState: 'not-required',
  selectedAsUnqualifiedAlias: false,
  diagnosticCodes: [],
  ...extra,
})

const renderAvatar = (summary: SafeCapabilitySummary, localMcpEnabled?: boolean): string =>
  renderToStaticMarkup(
    <I18nextProvider i18n={i18nInstances.en}>
      <SourceAvatar source={summary} size="sm" showStatus localMcpEnabled={localMcpEnabled} />
    </I18nextProvider>,
  )

describe('P6.745 — the Sources pip names the state instead of collapsing it', () => {
  test('a source whose credential is missing renders as needs_auth, named in words', () => {
    const html = renderAvatar(summaryWith({ state: 'missing-credential', credentialState: 'missing' }))
    expect(html).toContain('data-source-status="needs_auth"')
    // The whole point of the row: the state is READABLE without re-running the
    // import, and it is readable to a screen reader too.
    expect(html).toContain(`aria-label="${en['sourceStatus.needsAuth.label']}"`)
    expect(html).not.toContain('aria-label="missing-credential"')
  })

  test('an ENABLED server with an empty credential slot is needs_auth, not connected', () => {
    // The case a state-first mapping gets wrong, and the reason the credential is
    // read first. `resolver.ts` deliberately keeps a plugin http/sse server with
    // declared endpoint auth ENABLED while its slot is empty, saying in as many
    // words that "credentialState still reports 'missing'/'expired' for the UI".
    // Reading `state` alone would paint that server green while it waits for a
    // sign-in the user cannot see it needs.
    expect(capabilitySummaryConnectionStatus({ state: 'active', credentialState: 'missing' }))
      .toBe('needs_auth')
    expect(renderAvatar(summaryWith({ state: 'active', credentialState: 'missing' })))
      .toContain('data-source-status="needs_auth"')
  })

  test('a state that is not a connection verdict stays untested rather than inventing one', () => {
    // The negative half. `disabled`, `shadowed`, `review-required` and
    // `unsupported-runtime` say nothing about a connection ever having been
    // attempted; calling any of them `failed` would put a red dot on a source
    // that is merely off. They stay grey, exactly as before this row.
    for (const state of ['disabled', 'shadowed', 'review-required', 'unsupported-runtime'] as const) {
      expect(capabilitySummaryConnectionStatus({ state, credentialState: 'not-required' })).toBe('untested')
    }
    // Only the two ends of the vocabulary are claimed.
    expect(capabilitySummaryConnectionStatus({ state: 'invalid', credentialState: 'not-required' })).toBe('failed')
    expect(capabilitySummaryConnectionStatus({ state: 'active', credentialState: 'ready' })).toBe('connected')
  })

  test('the pip does not animate, while a standalone connected dot still does', () => {
    // Twenty pinging dots down a list draw the eye nowhere. `pulse` defaults to
    // true so every pre-P6.745 caller is unchanged; the pip opts out.
    expect(renderAvatar(summaryWith({ state: 'active', credentialState: 'ready' })))
      .not.toContain('animate-ping')
    expect(renderDot('en', 'connected')).toContain('animate-ping')
  })
})

/**
 * P6.769 — the setting reached the list and stopped there.
 *
 * `SourcesListPanel` declared `localMcpEnabled`, `AppShell` passed it, and the
 * component never destructured it. Meanwhile `mcp-pool.ts` filters a stdio
 * connection out entirely while that setting is off and marks it failed with
 * "Local MCP servers are disabled for this workspace." — so the one server the
 * user had switched off wore the same dot as one nobody had tested yet, and
 * `local_disabled`, a status this component has always known how to render, had
 * no producer at all.
 *
 * Three arms, because three separate things can break: the verdict, the two
 * boundaries that must NOT change with it, and the wiring — which is the actual
 * defect and the one a mapping test cannot see.
 */
describe('P6.769 — a stdio server switched off in Settings says so', () => {
  test('stdio plus the setting off is local_disabled, named in words', () => {
    expect(capabilitySummaryConnectionStatus(
      { state: 'active', credentialState: 'ready', mcpTransport: 'stdio' }, false,
    )).toBe('local_disabled')

    const html = renderAvatar(summaryWith({ kind: 'mcp', mcpTransport: 'stdio' }), false)
    expect(html).toContain('data-source-status="local_disabled"')
    // Readable, and readable to a screen reader: the row now says WHY.
    expect(html).toContain(`aria-label="${en['sourceStatus.localDisabled.label']}"`)
    expect(html).not.toContain('data-source-status="untested"')
  })

  test('the two boundaries: another transport, and the setting on', () => {
    // The setting is `settings.workspace.localMcpServersDesc`, "Enable stdio
    // subprocess servers", and `mcp-pool` gates exactly `type === 'stdio'`.
    // Greying an http/sse/ws server out would invent a cause.
    for (const transport of ['http', 'sse', 'ws'] as const) {
      expect(capabilitySummaryConnectionStatus(
        { state: 'active', credentialState: 'ready', mcpTransport: transport }, false,
      )).toBe('connected')
    }
    // And with the setting ON, stdio is exactly what it was before this row —
    // including the default, which is what every caller that does not know the
    // setting keeps getting.
    expect(capabilitySummaryConnectionStatus(
      { state: 'active', credentialState: 'ready', mcpTransport: 'stdio' }, true,
    )).toBe('connected')
    expect(capabilitySummaryConnectionStatus(
      { state: 'active', credentialState: 'ready', mcpTransport: 'stdio' },
    )).toBe('connected')
    expect(renderAvatar(summaryWith({ kind: 'mcp', mcpTransport: 'stdio' })))
      .toContain('data-source-status="connected"')
  })

  test('DECISION: the switched-off server is not asked to authenticate first', () => {
    // Precedence, stated rather than inherited. The server is never started, so
    // a credential it would have needed is not the user's next move; naming
    // `needs_auth` there would point at a remedy that changes nothing.
    expect(capabilitySummaryConnectionStatus(
      { state: 'missing-credential', credentialState: 'missing', mcpTransport: 'stdio' }, false,
    )).toBe('local_disabled')
    // The same row with the setting on is still the P6.745 verdict, so this is
    // a precedence claim and not a swallowed one.
    expect(capabilitySummaryConnectionStatus(
      { state: 'missing-credential', credentialState: 'missing', mcpTransport: 'stdio' }, true,
    )).toBe('needs_auth')
  })

  test('SourcesListPanel actually reads the prop it declares and hands it to the pip', () => {
    // The defect itself. Bun cannot render this panel (it needs the app-shell
    // context, the plugin-enablement hook and the entity panel), and the mapping
    // arms above pass just as well with the prop left unread — which is the
    // state this row found. So the wiring is asserted on the source, the same
    // way `source-card.test.tsx` asserts the badge slot of this same panel.
    const panel = readFileSync(
      fileURLToPath(new URL('../../app-shell/SourcesListPanel.tsx', import.meta.url)),
      'utf8',
    )
    // Destructured out of props — not merely declared in the interface.
    expect(panel).toMatch(/^\s*localMcpEnabled = true,$/m)
    // …and reaching the avatar, which is the only thing that can render it.
    expect(panel).toMatch(/<SourceAvatar[^>]*localMcpEnabled=\{/)
  })

  test('P6.837 — this leaf reaches Tooltip by SUBPATH, never through the barrel', () => {
    // The invariant no rendering test can state. `source-avatar.tsx` imports
    // this file and sixteen renderer files import that, so a bare
    // `from '@nessy-agent/ui'` here pulls the barrel's whole graph — including
    // the Vite-only `pdfjs-dist/...?url` specifier bun cannot resolve — into
    // every suite that renders a source avatar. Those suites then run ZERO
    // tests while reporting one failure apiece, which reads green enough to
    // ship: `McpServersPanel.test.tsx` said `Ran 1 test across 1 file` for its
    // 34 cases. Asserted on the source because a restored barrel import would
    // stop this very file from loading, and a suite that cannot load cannot
    // fail an assertion.
    const indicator = readFileSync(
      fileURLToPath(new URL('../source-status-indicator.tsx', import.meta.url)),
      'utf8',
    )
    expect(indicator).toContain("from '@nessy-agent/ui/ui/tooltip'")
    expect(indicator).not.toMatch(/from '@nessy-agent\/ui'/)
  })
})

/**
 * P6.774 — the two grey dots stop being the same grey dot.
 *
 * P6.769 gave `local_disabled` a producer and the pip started emitting it; what
 * it did not give it was a MARK. `untested` was `bg-foreground/40` and
 * `local_disabled` `bg-foreground/30` — one opacity step, at 6, 8 and 10 CSS
 * pixels — so the distinction the row built was legible only to a reader who
 * hovers for the tooltip or runs a screen reader. The playground entry that
 * renders all five at once said exactly that, in prose, and no test could see it.
 *
 * Two arms, and the second is the one that matters. Asserting that the two class
 * strings DIFFER would have passed before this row and passes for any future
 * opacity tweak — it is the defect's own shape. So the negative arm strips every
 * `/<opacity>` modifier from both marks and requires them to differ ANYWAY,
 * which no colour-channel change can satisfy.
 */
describe('P6.774 — `local_disabled` carries a mark that is not a shade of grey', () => {
  /** A Tailwind class list with every `/<opacity>` modifier removed. */
  const withoutOpacity = (classes: string): string => classes.replace(/\/\d+\b/g, '')

  test('it renders a hollow ring where every other status renders a filled dot', () => {
    // Swept over the component's own map: a status that arrived as a ring would
    // make the mark ambiguous again, and it would fail here. UB12.87 named the
    // one deliberate second ring: `disabled` is the other SWITCHED-OFF status
    // (line 2 and the pill print both as "Disabled"), so the ring set is exactly
    // the two switched-off statuses and `untested` stays filled.
    const SWITCHED_OFF: readonly SourceDisplayStatus[] = ['local_disabled', 'disabled']
    for (const status of statuses) {
      const isDisabled = SWITCHED_OFF.includes(status)
      const { color } = STATUS_CONFIG[status]
      expect(color.includes('border'), `${status} border`).toBe(isDisabled)
      expect(color.includes('bg-transparent'), `${status} fill`).toBe(isDisabled)
    }
    // …and it reaches the DOM, not just the map. The dot span carries the mark.
    const html = renderDot('en', 'local_disabled')
    expect(html).toContain('border-foreground/50')
    expect(html).toContain('bg-transparent')
    expect(renderDot('en', 'untested')).not.toContain('border-foreground/50')
  })

  test('the two are distinguishable with the opacity channel taken away', () => {
    // The arm that could not have passed before this row. `bg-foreground/40`
    // against `bg-foreground/30` collapses to `bg-foreground` on both sides;
    // a filled dot against a ring does not.
    const untested = withoutOpacity(STATUS_CONFIG.untested.color)
    const disabled = withoutOpacity(STATUS_CONFIG.local_disabled.color)
    expect(untested).not.toBe(disabled)
    // Stated positively so the assertion cannot be satisfied by a stray token:
    // the stripped forms differ because one of them is a ring.
    expect(disabled).toContain('border-foreground')
    expect(untested).not.toContain('border')
    // Positive control for the stripper itself — it really does erase the one
    // channel the two used to differ on.
    expect(withoutOpacity('bg-foreground/40')).toBe(withoutOpacity('bg-foreground/30'))
  })

  test('the words are UNCHANGED — the ring is a second channel, not a replacement', () => {
    // The row's own constraint. A mark that also changed the tooltip or the
    // accessible name would be a rewording wearing a shape.
    const html = renderDot('en', 'local_disabled')
    expect(html).toContain(`aria-label="${en['sourceStatus.localDisabled.label']}"`)
    // The DESCRIPTION lives in the tooltip, which Radix does not render until it
    // opens — `renderToStaticMarkup` sees `data-state="closed"` and no content —
    // so it is asserted through the keys and the locale files rather than
    // through the markup. The label above is the half that IS in the markup, and
    // it is read off the rendered `aria-label` so a component that stopped
    // calling `t` fails here.
    expect(en[STATUS_CONFIG.local_disabled.descriptionKey]).toBeTruthy()
    expect(renderDot('ru', 'local_disabled')).not.toContain('sourceStatus.')
    expect(STATUS_CONFIG.local_disabled.labelKey).toBe('sourceStatus.localDisabled.label')
    expect(STATUS_CONFIG.local_disabled.descriptionKey).toBe('sourceStatus.localDisabled.description')
    // And still no pulse: only `connected` animates.
    expect(html).not.toContain('animate-ping')
  })
})

/**
 * UB14.48 (v0.15.0, "A failed source test shows in the list") — the stored verdict paints the pip.
 *
 * `source_test` stores `connectionStatus: 'error'` in the source's config.json and, until this row,
 * nothing the renderer holds carried it, so a source whose last test failed wore the green dot. The
 * host now hands it over as `SafeCapabilitySummary.lastTestStatus` (already `failed`, from
 * upstream's `normalizeStoredStatus`) with the reduced reason in `connectionError`.
 */
describe('UB14.48 — a failed source_test is visible on the pip', () => {
  /** The `SourceStatusIndicator` element `SourceAvatar` builds — its props, not its closed tooltip. */
  const indicatorOf = (summary: SafeCapabilitySummary): React.ReactElement<{ status?: string; errorMessage?: string }> => {
    const find = (node: React.ReactNode): React.ReactElement | undefined => {
      if (Array.isArray(node)) {
        for (const child of node) {
          const hit = find(child)
          if (hit) return hit
        }
        return undefined
      }
      if (!React.isValidElement(node)) return undefined
      if (node.type === SourceStatusIndicator) return node
      return find((node.props as { children?: React.ReactNode }).children)
    }
    const hit = find(SourceAvatar({ source: summary, size: 'sm', showStatus: true }))
    if (!hit) throw new Error('SourceAvatar rendered no SourceStatusIndicator')
    return hit as React.ReactElement<{ status?: string; errorMessage?: string }>
  }

  test('ready credentials and a failed last test are `failed`, with the reason on the list row', () => {
    expect(capabilitySummaryConnectionStatus({ state: 'active', credentialState: 'ready', lastTestStatus: 'failed' }))
      .toBe('failed')
    // The commonest failed source: `source_test` refuses to auto-enable one whose test failed, so it
    // is `disabled` — which the state reading alone paints grey.
    expect(capabilitySummaryConnectionStatus({ state: 'disabled', credentialState: 'not-required', lastTestStatus: 'failed' }))
      .toBe('failed')

    const summary = summaryWith({
      state: 'active',
      credentialState: 'ready',
      lastTestStatus: 'failed',
      connectionError: 'HTTP 502 from https://mcp.example.com/…',
    })
    expect(renderAvatar(summary)).toContain('data-source-status="failed"')
    expect(renderAvatar(summary)).toContain(`aria-label="${en['sourceStatus.failed.label']}"`)
    // The WHY reaches the indicator, which puts it in the `failed` tooltip.
    expect(indicatorOf(summary).props).toMatchObject({
      status: 'failed',
      errorMessage: 'HTTP 502 from https://mcp.example.com/…',
    })
  })

  test('control — `untested` or no stored verdict keeps today\'s verdict, and a passing test clears it', () => {
    for (const lastTestStatus of ['untested', undefined] as const) {
      expect(capabilitySummaryConnectionStatus({ state: 'active', credentialState: 'ready', lastTestStatus }))
        .toBe('connected')
      expect(capabilitySummaryConnectionStatus({ state: 'disabled', credentialState: 'not-required', lastTestStatus }))
        .toBe('untested')
    }
    // A later passing source_test stores `connected` and clears the error: the state verdict returns,
    // and a stored `connected` never paints a switched-off source green.
    expect(capabilitySummaryConnectionStatus({ state: 'active', credentialState: 'ready', lastTestStatus: 'connected' }))
      .toBe('connected')
    expect(capabilitySummaryConnectionStatus({ state: 'disabled', credentialState: 'not-required', lastTestStatus: 'connected' }))
      .toBe('untested')
    expect(renderAvatar(summaryWith({ state: 'active', credentialState: 'ready', lastTestStatus: 'connected' })))
      .toContain('data-source-status="connected"')
  })

  test('the order stays local_disabled → needs_auth → failed', () => {
    // A stdio server with local MCP off is still `local_disabled`, whatever its last test said.
    expect(capabilitySummaryConnectionStatus(
      { state: 'active', credentialState: 'ready', mcpTransport: 'stdio', lastTestStatus: 'failed' }, false,
    )).toBe('local_disabled')
    expect(renderAvatar(summaryWith({ kind: 'mcp', mcpTransport: 'stdio', lastTestStatus: 'failed' }), false))
      .toContain('data-source-status="local_disabled"')
    // A missing or expired credential names its own remedy first.
    expect(capabilitySummaryConnectionStatus({ state: 'active', credentialState: 'missing', lastTestStatus: 'failed' }))
      .toBe('needs_auth')
    expect(capabilitySummaryConnectionStatus({ state: 'missing-credential', credentialState: 'expired', lastTestStatus: 'failed' }))
      .toBe('needs_auth')
  })
})

/**
 * UB12.87 — the pip says "Disabled" for a source the user switched off, as line 2 and the pill do.
 *
 * Since UB12.75 the Sources list's line 2 and the detail pill print `capabilitySummaryDisplayStatus`
 * ("Disabled" for `state: 'disabled'`), while the pip on `SourceAvatar` read
 * `capabilitySummaryConnectionStatus`, whose rule 4 puts that state in `untested` — so its tooltip and
 * accessible name said "Not Tested" beside a line 2 that said "Disabled". The pip now reads the display
 * status, and `STATUS_CONFIG.disabled` gives it words (`sourceStatus.disabled.*`) and P6.774's ring.
 */
describe('UB12.87 — the pip names a switched-off source the way line 2 and the pill do', () => {
  const renderAvatarIn = (locale: 'en' | 'ru', summary: SafeCapabilitySummary): string =>
    renderToStaticMarkup(
      <I18nextProvider i18n={i18nInstances[locale]}>
        <SourceAvatar source={summary} size="sm" showStatus />
      </I18nextProvider>,
    )

  test('POSITIVE — a `state: \'disabled\'` pip reads the new label, in both locales, on the ring', () => {
    const summary = summaryWith({ state: 'disabled', credentialState: 'not-required' })
    const html = renderAvatarIn('en', summary)
    expect(html).toContain('data-source-status="disabled"')
    expect(html).toContain(`aria-label="${en['sourceStatus.disabled.label']}"`)
    expect(en['sourceStatus.disabled.label']).toBe('Disabled')
    expect(html).not.toContain(`aria-label="${en['sourceStatus.untested.label']}"`)
    // The words are the Sources list's own, so the three surfaces say one thing.
    expect(en['sourceStatus.disabled.label']).toBe(en['sourcesList.statusDisabled'])
    expect(ru['sourceStatus.disabled.label']).toBe(ru['sourcesList.statusDisabled'])
    const ruHtml = renderAvatarIn('ru', summary)
    expect(ruHtml).toContain(`aria-label="${ru['sourceStatus.disabled.label']}"`)
    expect(ruHtml).not.toContain('sourceStatus.')
    // The mark: P6.774's hollow ring, not `untested`'s filled grey.
    expect(html).toContain('bg-transparent border border-foreground/50')
    expect(html).not.toContain('bg-foreground/40')
  })

  test('NEGATIVE — a review-required pip keeps "Not Tested" (and so do shadowed and unsupported-runtime)', () => {
    for (const state of ['review-required', 'shadowed', 'unsupported-runtime'] as const) {
      const html = renderAvatarIn('en', summaryWith({ state, credentialState: 'not-required' }))
      expect(html, state).toContain('data-source-status="untested"')
      expect(html, state).toContain(`aria-label="${en['sourceStatus.untested.label']}"`)
      expect(html, state).not.toContain('data-source-status="disabled"')
      expect(html, state).toContain('bg-foreground/40')
    }
  })

  test('boundary — a switched-off source with a remedy or a stored failure keeps that verdict', () => {
    // Only the `untested` outcome is refined (UB12.75's scope), and the pip now follows it exactly.
    expect(renderAvatarIn('en', summaryWith({ state: 'disabled', credentialState: 'not-required', lastTestStatus: 'failed' })))
      .toContain('data-source-status="failed"')
    expect(renderAvatarIn('en', summaryWith({ state: 'disabled', credentialState: 'missing' })))
      .toContain('data-source-status="needs_auth"')
    expect(renderAvatar(summaryWith({ kind: 'mcp', state: 'disabled', mcpTransport: 'stdio' }), false))
      .toContain('data-source-status="local_disabled"')
    // The pip's verdict function is unchanged: the display refinement lives in one place.
    expect(capabilitySummaryConnectionStatus({ state: 'disabled', credentialState: 'not-required' })).toBe('untested')
  })

  test('the pip and the printed surfaces cannot disagree: the pip renders capabilitySummaryDisplayStatus', () => {
    const states = ['active', 'disabled', 'shadowed', 'review-required', 'unsupported-runtime', 'invalid', 'missing-credential'] as const
    const credentials = ['ready', 'not-required', 'missing', 'expired'] as const
    let checked = 0
    for (const state of states) {
      for (const credentialState of credentials) {
        for (const lastTestStatus of [undefined, 'failed'] as const) {
          const summary = summaryWith({ state, credentialState, lastTestStatus })
          const expected = capabilitySummaryDisplayStatus(summary)
          expect(renderAvatar(summary), `${state}/${credentialState}/${lastTestStatus}`)
            .toContain(`data-source-status="${expected}"`)
          checked += 1
        }
      }
    }
    expect(checked).toBe(states.length * credentials.length * 2)
  })

  test('playground — every state of the Source Status Indicator entry renders in a dark root, the switched-off dot included', () => {
    const entry = sourceStatusIndicatorComponents.find(candidate => candidate.id === 'source-status-indicator')
    expect(entry).toBeDefined()
    const Preview = entry!.component as React.ComponentType<Record<string, unknown>>
    const base = Object.fromEntries((entry!.props ?? []).map(knob => [knob.name, knob.defaultValue]))
    const renderState = (props: Record<string, unknown>): string =>
      renderToStaticMarkup(
        <I18nextProvider i18n={i18nInstances.en}>
          <div className="dark"><Preview {...base} {...props} /></div>
        </I18nextProvider>,
      )
    const variants = entry!.variants ?? []
    // The base state plus every variant: each draws at least one dot, and no raw key reaches the screen.
    for (const props of [{}, ...variants.map(variant => variant.props ?? {})]) {
      const html = renderState(props)
      expect(html.startsWith('<div class="dark">')).toBe(true)
      expect(html).toContain('data-source-status=')
      expect(html).not.toContain('sourceStatus.')
    }
    // The wall (the base state) carries all six, the switched-off ring among them.
    const wall = renderState({})
    for (const status of statuses) expect(wall).toContain(`data-source-status="${status}"`)
    // The single-status variant this row added.
    const variant = variants.find(candidate => candidate.props?.status === 'disabled')
    expect(variant?.name).toBe('Switched off (Disabled)')
    const single = renderState(variant!.props ?? {})
    expect(single).toContain('data-source-status="disabled"')
    expect(single).toContain(`aria-label="${en['sourceStatus.disabled.label']}"`)
    expect(single).toContain('bg-transparent border border-foreground/50')
  })
})
