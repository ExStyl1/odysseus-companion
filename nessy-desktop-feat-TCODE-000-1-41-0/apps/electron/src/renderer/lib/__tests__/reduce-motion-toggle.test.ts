/**
 * UB12.22 (CRITICAL) → UB15.9 → UB12.40 — Settings › Appearance's Motion control drives the UB13.4 Motion preference.
 *
 * UB12.22's defect: P6.473's "Reduce motion" toggle wrote only its own `nessy-prefersReducedMotion` key and
 * `data-reduced-motion`, while every UB13.4 surface reads `<html data-motion>` (stamped by
 * `MotionPreferenceProvider` from ThemeContext's `motion`). UB12.22 bridged the toggle (ON 'reduced', OFF
 * 'system'); UB15.9 replaced the toggle with upstream v0.15.1's System / Reduced / Full segmented control
 * (OQ-R5.1 (a)); UB12.40 retired P6.473's reader, so the control now hands its value straight to
 * ThemeContext's `setMotion`, as upstream's page does.
 *
 * `bun test` has no DOM here, so the write path runs as `setMotion` → the provider's stamp → the REAL `flip.ts`
 * reader, with `document` and `window.matchMedia` stubbed and restored; the page WIRING and the task-list CSS
 * are pinned by source match (the `ai-settings-reconnect.test.ts` instrument). That a chosen value survives a
 * restart is pinned through the real provider in `context/__tests__/theme-overrides.test.tsx`.
 */
import { afterAll, beforeEach, describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { prefersReducedMotion, type MotionPreference } from '@nessy-agent/ui/motion'

type Globals = { document?: unknown; window?: unknown }
const g = globalThis as Globals
const saved: Globals = { document: g.document, window: g.window }

const dataset: Record<string, string | undefined> = {}
let osAsksForReducedMotion = false

g.document = { documentElement: { dataset } }
g.window = {
  matchMedia: (query: string) => ({
    matches: query === '(prefers-reduced-motion: reduce)' && osAsksForReducedMotion,
    addEventListener: () => {},
    removeEventListener: () => {},
  }),
}

afterAll(() => {
  for (const key of ['document', 'window'] as const) {
    if (saved[key] === undefined) delete g[key]
    else g[key] = saved[key]
  }
})

/** What MotionPreferenceProvider's effect does with a preference (its source is pinned in packages/ui). */
function stampLikeProvider(motion: MotionPreference): void {
  if (motion === 'system') delete dataset.motion
  else dataset.motion = motion
}

/** The page's `onValueChange={setMotion}`: ThemeContext's setter, recorded, then stamped as the provider would. */
function choose(motion: MotionPreference, calls: MotionPreference[]): void {
  const setMotion = (m: MotionPreference) => void calls.push(m)
  setMotion(motion)
  stampLikeProvider(calls[calls.length - 1]!)
}

describe('UB15.9 — the Motion control (System / Reduced / Full) drives the Motion preference', () => {
  beforeEach(() => {
    delete dataset.motion
    osAsksForReducedMotion = false
  })

  it("positive: choosing 'reduced' sets the preference, and the FLIP reader reduces with the OS not asking", () => {
    const calls: MotionPreference[] = []
    choose('reduced', calls)
    expect(calls).toEqual(['reduced'])
    expect(dataset.motion).toBe('reduced')
    expect(prefersReducedMotion()).toBe(true)
  })

  it("negative (control): 'system' with the OS not asking leaves motion full, and the OS query still applies", () => {
    const calls: MotionPreference[] = []
    choose('system', calls)
    expect(calls).toEqual(['system'])
    expect(dataset.motion).toBeUndefined()
    osAsksForReducedMotion = false
    expect(prefersReducedMotion()).toBe(false)
    osAsksForReducedMotion = true
    expect(prefersReducedMotion()).toBe(true)
  })

  it("boundary: 'full' is a value the control can now write, and it animates even when the OS asks to reduce", () => {
    const calls: MotionPreference[] = []
    choose('full', calls)
    osAsksForReducedMotion = true
    expect(dataset.motion).toBe('full')
    expect(prefersReducedMotion()).toBe(false)
  })
})

describe('UB15.9 — wiring (source match; no DOM harness)', () => {
  const page = readFileSync(join(import.meta.dir, '../../pages/settings/AppearanceSettingsPage.tsx'), 'utf8')

  it("the Motion row is the tri-state segmented control over useTheme().motion, written with setMotion (upstream's wiring)", () => {
    expect(page).toMatch(/<SettingsSegmentedControl\s+value=\{motion\}\s+onValueChange=\{setMotion\}\s+aria-label=\{t\("settings\.appearance\.motion"\)\}/)
    const motionRow = page.slice(page.indexOf('label={t("settings.appearance.motion")}'), page.indexOf('label={t("settings.appearance.language")}'))
    expect(motionRow.length).toBeGreaterThan(0)
    const options = [...motionRow.matchAll(/\{ value: '(system|reduced|full)', label: t\("settings\.appearance\.(\w+)"\) \}/g)].map(m => `${m[1]}:${m[2]}`)
    expect(options).toEqual(['system:system', 'reduced:motionReduced', 'full:motionFull'])
  })

  it('negative: the two-state toggle, the legacy key and the UB15.9 wrapper are gone from the page', () => {
    expect(page).not.toContain('settings.appearance.reducedMotion')
    expect(page).not.toContain('checked={reducedMotion}')
    expect(page).not.toContain('writeReducedMotionSetting(')
    expect(page).not.toContain('readReducedMotionSetting()')
    expect(page).not.toContain('applyMotionChoice')
  })

  it("the task-list CSS reduces under data-motion='reduced' for all three targets", () => {
    const css = readFileSync(
      join(import.meta.dir, '../../../../../../packages/ui/src/components/markdown/extensions/animated-task-item.css'),
      'utf8',
    )
    const reducedRules = css.split('\n').filter((line) => line.startsWith(":root[data-motion='reduced'] .tiptap-editor"))
    expect(reducedRules).toHaveLength(3)
  })
})
