/**
 * UB14.44 (R7-10, R2-13's automations half; upstream v0.15.1 `components/automations/*`) — the automation surfaces
 * wear the v0.15.1 restyle with our specifics kept.
 *
 * Before the row the list row was a 50%-opacity row with two pills per row, the cron presets carried no pressed
 * state, the advanced cron input showed an error only by a red border, the info page hung its menu off the header
 * title, and the timeline's copy control was an unnamed `<button>`. Every POSITIVE arm below fails on that tree.
 *
 * Two instruments:
 *  - IN-PROCESS — the real `useAutomations` mapping and the real `AutomationEventTimeline`, rendered with
 *    `renderToStaticMarkup` in Russian (no DOM in this repo's `bun test`), as `skipped-timeline-row.test.tsx` does.
 *  - ONE CHILD PROCESS (`fixtures/automations-probe.ts`; its docblock says why a child) — every state of every
 *    entry of the automations playground (`playground/registry/automations.tsx`), rendered through the playground's
 *    own frame inside a `.dark` root: the owner's dark-theme sweep of the design surface this row touches.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInstance, type i18n as I18nInstance } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import type { SafeAutomationHistoryEntry } from '@nessy-agent/shared/protocol'
import { MODULE_GRAPH_HOOK_BUDGET_MS } from '@nessy-agent/shared/testing/module-graph-budgets'
import { NavigationContext } from '@/contexts/NavigationContext'
import { useAutomations, type UseAutomationsResult } from '@/hooks/useAutomations'
import { AutomationEventTimeline } from '../AutomationEventTimeline'
import type { ExecutionEntry } from '../types'
import { AUTOMATIONS_PROBE_MARKER, type AutomationsProbeReading } from './fixtures/automations-probe'

const LOCALES = new URL('../../../../../../../packages/shared/src/i18n/locales/', import.meta.url)
const locale = (code: 'en' | 'ru'): Record<string, string> =>
  JSON.parse(readFileSync(new URL(`${code}.json`, LOCALES), 'utf8'))
const ru = locale('ru')

/** The host's own self-trigger reason (`SessionManager` symbol `automationLoopGuard`). */
const LOOP_REASON = 'the event is about a session this automation created (loop guard)'

// ---------------------------------------------------------------------------
// IN-PROCESS — the restyled timeline in Russian, fed by the real hook
// ---------------------------------------------------------------------------

let i18nRu: I18nInstance
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

function renderTimelineRu(entries: ExecutionEntry[]): string {
  return renderToStaticMarkup(
    <I18nextProvider i18n={i18nRu}>
      <NavigationContext.Provider value={{ navigateToSession: () => {} } as never}>
        <AutomationEventTimeline entries={entries} />
      </NavigationContext.Provider>
    </I18nextProvider>,
  )
}

describe('UB14.44 — the restyled timeline reads in the user\'s language (in-process, ru)', () => {
  beforeAll(async () => {
    i18nRu = createInstance()
    await i18nRu.use(initReactI18next).init({
      lng: 'ru',
      fallbackLng: 'en',
      resources: { ru: { translation: ru } },
      interpolation: { escapeValue: false },
    })
  })

  it('POSITIVE — a loop-guard skip mapped by useAutomations renders its Russian reason on the 44px row, CircleSlash at text-tertiary', async () => {
    const hook = captureHook(i18nRu)
    const rows: SafeAutomationHistoryEntry[] = [
      { id: 'packing', ts: Date.now() - 60_000, ok: true, skipped: LOOP_REASON, skippedLoopGuard: 'self-trigger' },
    ]
    scope.window = { electronAPI: { getAutomationHistory: async () => rows } }
    const entries = await hook.getAutomationHistory('packing')
    const html = renderTimelineRu(entries)

    const reason = `${ru['automations.skippedSummary']!.replace('{{reason}}', ru['automations.skippedLoopSelfTrigger']!)}`
    expect(html).toContain(`<span class="min-w-0 flex-1 truncate text-label-sm text-secondary">${reason}</span>`)
    expect(html).not.toContain(LOOP_REASON) // the English host line never reaches a Russian timeline
    expect(html).toMatch(/<div class="flex min-h-11 items-center gap-3 px-3\.5 py-2 text-label">/)
    expect(html).toMatch(/<svg[^>]*class="[^"]*lucide-circle-slash size-3\.5 shrink-0 text-tertiary"[^>]*aria-hidden="true"/)
    expect(html).not.toContain(ru['automations.openSession']!) // a skipped run has no session
  })

  it('NEGATIVE — an automation with no runs renders the empty state on the tertiary role and no row', () => {
    const html = renderTimelineRu([])
    expect(html).toBe(`<div class="px-3.5 py-6 text-center text-label text-tertiary">${ru['automations.noActivityYet']}</div>`)
    expect(html).not.toContain('min-h-11')
    expect(html).not.toContain('<svg')
  })
})

// ---------------------------------------------------------------------------
// CHILD — every playground state, dark
// ---------------------------------------------------------------------------

const CHILD = new URL('./fixtures/automations-probe.ts', import.meta.url).pathname
const REPO_ROOT = new URL('../../../../../../../', import.meta.url).pathname

let reading: AutomationsProbeReading
let configDir = ''

beforeAll(async () => {
  // Isolated BEFORE bun starts (AGENTS.md §Traps: the root preload freezes the config dir at import).
  configDir = mkdtempSync(join(tmpdir(), 'automations-probe-'))
  const child = Bun.spawn([process.execPath, CHILD], {
    cwd: REPO_ROOT,
    env: { ...process.env, NESSY_CONFIG_DIR: configDir },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const killer = setTimeout(() => child.kill(), MODULE_GRAPH_HOOK_BUDGET_MS - 30_000)
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  clearTimeout(killer)
  const at = stdout.lastIndexOf(AUTOMATIONS_PROBE_MARKER)
  if (exitCode !== 0 || at === -1) {
    throw new Error(`automations probe exited ${exitCode} without a reading:\n${stderr.slice(-4000)}`)
  }
  reading = JSON.parse(stdout.slice(at + AUTOMATIONS_PROBE_MARKER.length)) as AutomationsProbeReading
}, MODULE_GRAPH_HOOK_BUDGET_MS)

afterAll(() => {
  if (configDir) rmSync(configDir, { recursive: true, force: true })
})

const state = (key: string): string => {
  const html = reading.states[key]
  if (html === undefined) throw new Error(`no state "${key}" (threw: ${JSON.stringify(reading.threw)})`)
  return html
}
const count = (html: string, needle: string) => html.split(needle).length - 1
/** The advanced cron input: the one input whose placeholder is the whole expression. */
const advancedInput = (html: string) => html.match(/<input[^>]*placeholder="\* \* \* \* \*"[^>]*>/)?.[0] ?? ''
/** Every list-row title element, as `[class, text]`. */
const rowTitles = (html: string) =>
  [...html.matchAll(/<div data-slot="entity-row-title" class="([^"]*)">([^<]*)<\/div>/g)].map(m => [m[1]!, m[2]!] as const)

describe('the probe covered the states (dark)', () => {
  it('POSITIVE CONTROL — every state of every automations entry rendered inside a .dark root, none threw', () => {
    expect(reading.threw).toEqual({})
    for (const key of [
      'automations-list-panel · Mixed Enabled/Disabled',
      'automations-list-panel · Off by Policy',
      'automation-info-page · Scheduled',
      'automation-info-page · Before Tool Runs (Disabled)',
      'automation-info-page · Script · Unapproved (Approve)',
      'automation-card · Expanded',
      'cron-builder · Weekdays at 9am',
      'cron-builder · Invalid (Missing Field)',
      'cron-builder · Invalid (Bad Value)',
      'automation-avatar · (base state)',
      'automation-test-panel · Running',
      'automation-event-timeline · Mixed Results',
      'automation-event-timeline · Empty',
      'automation-webhook-details · Success with Response',
      'automation-webhook-details · Failed with Error',
    ]) expect(Object.keys(reading.states)).toContain(key)
    expect(Object.keys(reading.states).length).toBeGreaterThanOrEqual(51)
    for (const [key, html] of Object.entries(reading.states)) expect({ key, dark: html.includes('<div class="dark">') }).toEqual({ key, dark: true })
  })

  it('SWEEP — no automation component state carries the pre-redesign classes (the avatar gallery\'s own playground chrome is upstream\'s, untouched)', () => {
    const legacy = /text-muted-foreground|text-foreground\/\d|bg-foreground\/|shadow-minimal|text-\[1[01]px\]|text-warning|bg-warning|border-border\/|divide-border\/|rounded-\[[48]px\]|uppercase tracking-wider/
    for (const [key, html] of Object.entries(reading.states)) {
      if (key.startsWith('automation-avatar · ')) continue
      expect({ key, legacy: html.match(legacy)?.[0] ?? null }).toEqual({ key, legacy: null })
    }
    // The gallery's avatars themselves sit on the role tints (the old `warning` colour is info/amber).
    const gallery = state('automation-avatar · (base state)')
    expect(gallery).toContain('bg-info-tint')
    expect(gallery).not.toMatch(/bg-(warning|success|accent|info|destructive)\/10/)
  })
})

describe('UB14.44 — CronBuilder: pressed presets and an announced invalid expression', () => {
  it('POSITIVE — the active preset renders aria-pressed="true" on the selected fill; the others are "false"', () => {
    const html = state('cron-builder · Weekdays at 9am')
    expect(count(html, 'aria-pressed="true"')).toBe(1)
    expect(html).toMatch(/<button aria-pressed="true" class="[^"]*bg-fill-selected text-foreground inset-ring inset-ring-border">Weekdays at 9am<\/button>/)
    expect(count(html, 'aria-pressed="false"')).toBe(6)
    const advanced = advancedInput(html)
    expect(advanced).toContain('class="field-surface h-control-lg w-full rounded-md px-2.5 font-mono text-mono-ui"')
    expect(advanced).not.toContain('aria-invalid')
    expect(html).not.toContain('text-label-sm text-destructive')
  })

  it('NEGATIVE — an invalid expression sets aria-invalid on the advanced input and shows the message; no preset is pressed', () => {
    for (const variant of ['Invalid (Missing Field)', 'Invalid (Bad Value)']) {
      const html = state(`cron-builder · ${variant}`)
      expect({ variant, input: advancedInput(html).includes('aria-invalid="true"') }).toEqual({ variant, input: true })
      expect(html).toMatch(/<div class="flex items-center gap-1\.5 text-label-sm text-destructive"><svg[^>]*lucide-circle-alert size-3\.5"[^>]*aria-hidden="true">.*?<\/svg>[^<]+<\/div>/)
      expect(count(html, 'aria-pressed="true"')).toBe(0)
    }
  })
})

describe('UB14.44 — AutomationsListPanel: one quiet subtitle, AA dimming, F1.795 kept', () => {
  const DISABLED = ['Urgent Label Notification', 'Label Change Logger', 'Build Artifact Logger', 'Error Alert', 'Morning AI News (Weekdays)']

  it('POSITIVE — a disabled automation\'s title is text-tertiary and the row itself carries no opacity-50 (only its glyph dims)', () => {
    const html = state('automations-list-panel · Mixed Enabled/Disabled')
    const titles = rowTitles(html)
    expect(titles.length).toBe(10)
    for (const [cls, name] of titles) {
      const disabled = DISABLED.includes(name)
      expect({ name, tertiary: cls.split(' ').includes('text-tertiary') }).toEqual({ name, tertiary: disabled })
      expect({ name, foreground: cls.split(' ').includes('text-foreground') }).toEqual({ name, foreground: !disabled })
    }
    expect(count(html, '<div class="automation-item">')).toBe(10)
    // Every opacity-50 is on an avatar glyph (EntityRow draws the glyph twice: the visible one and the subtitle spacer).
    expect(count(html, 'opacity-50')).toBe(2 * DISABLED.length)
    expect(count(html, 'opacity-50')).toBe([...html.matchAll(/<span class="inline-flex items-center justify-center rounded-xs shrink-0 [^"]*opacity-50">/g)].length)
    // Trigger · actions is one quiet subtitle line, not pills.
    expect(html).toContain('<div class="min-w-0 flex-1 truncate">Scheduled · Prompt</div>')
  })

  it('F1.795 (ours) — the managed-policy row keeps its "off by policy" chip after the title; a normal list draws none', () => {
    const policy = state('automations-list-panel · Off by Policy')
    expect(count(policy, 'data-managed-disabled=""')).toBe(4)
    expect(policy).toMatch(/<span class="[^"]*bg-destructive-tint text-destructive" title="[^"]+" data-managed-disabled="">Off by policy<\/span>/)
    expect(state('automations-list-panel · Default (All)')).not.toContain('data-managed-disabled')
  })
})

describe('UB14.44 — AutomationInfoPage: the name in the hero, the "⋯" in the header, edit in the hero', () => {
  it('POSITIVE — the header carries the named "⋯" menu, the hero the name and Edit, the status badge its dot', () => {
    const html = state('automation-info-page · Scheduled')
    expect(html).toMatch(/<button[^>]*aria-label="More"[^>]*aria-haspopup="menu"/)
    expect(html).toContain('<h2 class="text-title text-foreground [overflow-wrap:anywhere]">Daily Weather Report</h2>')
    expect(html).toMatch(/<div class="flex shrink-0 items-center gap-2"><button data-slot="popover-trigger"[^>]*>Edit<\/button><\/div>/)
    expect(html).toMatch(/<span class="[^"]*bg-success-tint text-success"><span aria-hidden="true" class="size-1\.5 shrink-0 rounded-full bg-current"><\/span>Active<\/span>/)
    expect(html).toContain('divide-y divide-separator')
  })

  it('NEGATIVE — a disabled automation shows the neutral status chip (not success) and the paused alert', () => {
    const html = state('automation-info-page · Before Tool Runs (Disabled)')
    expect(html).toMatch(/<span class="[^"]*bg-fill-hover text-secondary"><span aria-hidden="true"[^>]*><\/span>Disabled<\/span>/)
    expect(html).not.toMatch(/bg-success-tint text-success"><span aria-hidden="true"[^>]*><\/span>Active/)
    expect(html).toContain('lucide-circle-pause')
  })

  it('UA8.3 (ours) — the script action keeps Approve, now the small primary Button, beside its ledger chip', () => {
    const html = state('automation-info-page · Script · Unapproved (Approve)')
    expect(html).toMatch(/<span class="[^"]*bg-info-tint text-info" data-script-approval="unapproved">/)
    expect(html).toMatch(/<button data-slot="button" data-variant="primary"[^>]*h-control-sm[^>]*type="button" title="sha256 [0-9a-f]{64}">/)
  })
})

describe('UB14.44 — the timeline, the webhook well, the card and the test panel', () => {
  it('POSITIVE — the timeline draws 44px rows; skipped on text-tertiary, blocked on text-info (the old warning colour)', () => {
    const html = state('automation-event-timeline · Mixed Results')
    expect(count(html, 'flex min-h-11 items-center gap-3 px-3.5 py-2 text-label')).toBeGreaterThan(5)
    expect(html).toMatch(/lucide-circle-slash size-3\.5 shrink-0 text-tertiary/)
    expect(html).toMatch(/lucide-shield-alert size-3\.5 shrink-0 text-info/)
    expect(html).toContain('Skipped: the event is about a session this automation created (loop guard)')
  })

  it('NEGATIVE — the empty timeline is the tertiary line alone', () => {
    expect(state('automation-event-timeline · Empty')).toBe('<div class="dark"><div class="p-6"><div class="px-3.5 py-6 text-center text-label text-tertiary">No activity yet.</div></div></div>')
  })

  it('the webhook well is sunken and its copy control is a named IconButton (automations.copyPayload)', () => {
    for (const variant of ['Success with Response', 'Failed with Error']) {
      const html = state(`automation-webhook-details · ${variant}`)
      expect(html).toContain('rounded-md bg-sunken px-3 py-2.5 text-label-sm inset-ring inset-ring-[var(--border-subtle)]')
      expect(html).toMatch(/<button data-slot="icon-button" type="button"[^>]*aria-label="Copy payload" title="Copy payload">/)
      expect(html).toContain('>Response</span>')
    }
    const failed = state('automation-webhook-details · Failed with Error')
    expect(failed).toContain('<span class="font-mono text-mono-ui text-destructive">Bad Gateway after 3 attempts</span>')
    expect(failed).toContain('<span class="font-mono text-mono-ui text-secondary">3</span>')
    expect(state('automation-webhook-details · Success with Response')).not.toContain('Bad Gateway')
  })

  it('the card is raised, its Test is Button secondary sm; collapsed draws no Test', () => {
    const expanded = state('automation-card · Expanded')
    expect(expanded).toContain('overflow-hidden rounded-lg bg-raised shadow-elev-1')
    expect(expanded).toMatch(/<button data-slot="button" data-variant="secondary"[^>]*h-control-sm rounded-sm px-2 text-label-sm">Run Test<\/button>/)
    expect(state('automation-card · Collapsed')).not.toContain('Run Test')
  })

  it('the test panel: the shared Spinner while running; success and error on the Info_Alert role tints', () => {
    const running = state('automation-test-panel · Running')
    expect(running).toContain('<span class="spinner" role="status"')
    expect(running).not.toContain('lucide-loader')
    expect(state('automation-test-panel · Success')).toContain('bg-success-tint')
    expect(state('automation-test-panel · Error')).toContain('bg-destructive-tint')
    expect(state('automation-test-panel · Error')).toContain('<pre class="mt-1 whitespace-pre-wrap font-mono text-mono-ui text-destructive">')
  })
})
