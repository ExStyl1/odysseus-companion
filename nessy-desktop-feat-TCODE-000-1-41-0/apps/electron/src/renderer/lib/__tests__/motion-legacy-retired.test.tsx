/**
 * UB12.40 — P6.473's reduced-motion reader is retired; the Motion preference is the only motion input.
 *
 * Before: `startReducedMotionSync` (main.tsx) and `usePrefersReducedMotion` (CompactPanelTransition) ORed a
 * hand-settable `nessy-prefersReducedMotion` key with the OS query and stamped `data-reduced-motion`, which the
 * task-list CSS selected on. Neither knew UB15.9's 'full': with 'full' and the OS asking, the compact slide still
 * took its 120 ms tween and the task list stayed reduced, where upstream v0.15.1 animates (MotionConfig only).
 *
 * Instruments (the repo has no DOM library):
 * - CompactPanelTransition renders inside a probe under the real `MotionPreferenceProvider` with
 *   `renderToStaticMarkup` (which runs hooks); the probe keeps the element the component returned and what
 *   motion's own `useReducedMotionConfig()` resolves there — the switch `motion.div` reads to skip transforms.
 *   `appearance-theme-grid.test.tsx` uses the same probe.
 * - The task-list rules are read from the REAL `animated-task-item.css`; each rule's root and media condition is
 *   evaluated per state and compared with the REAL `flip.ts` reader (`prefersReducedMotion`, the tokens.css rule).
 *   An unmodelled root condition (such as the retired `[data-reduced-motion]`) throws, so it cannot pass silently.
 */
import { afterAll, beforeEach, describe, expect, it } from 'bun:test'
import * as React from 'react'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import { useReducedMotionConfig } from 'motion/react'
import { MotionPreferenceProvider, SPRING, prefersReducedMotion, type MotionPreference } from '@nessy-agent/ui/motion'
import { CompactPanelTransition } from '@/components/app-shell/CompactPanelTransition'
import * as legacy from '../reduced-motion'

type Globals = { localStorage?: unknown; document?: unknown; window?: unknown }
const g = globalThis as Globals
const saved: Globals = { localStorage: g.localStorage, document: g.document, window: g.window }

const memory = new Map<string, string>()
const dataset: Record<string, string | undefined> = {}
let osAsksForReducedMotion = false

g.localStorage = {
  getItem: (key: string) => memory.get(key) ?? null,
  setItem: (key: string, value: string) => void memory.set(key, value),
  removeItem: (key: string) => void memory.delete(key),
}
g.document = { documentElement: { dataset } }
g.window = {
  matchMedia: (query: string) => ({
    matches: query.includes('prefers-reduced-motion') && osAsksForReducedMotion,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
  }),
}

afterAll(() => {
  for (const key of ['localStorage', 'document', 'window'] as const) {
    if (saved[key] === undefined) delete g[key]
    else g[key] = saved[key]
  }
})

/** The state the provider's effect stamps (its source is pinned in packages/ui). */
function stamp(motion: MotionPreference, osAsks: boolean): void {
  if (motion === 'system') delete dataset.motion
  else dataset.motion = motion
  osAsksForReducedMotion = osAsks
}

interface Captured {
  transition: unknown
  reducedByMotionConfig: boolean | null
}

function renderCompactPanel(motion: MotionPreference): Captured {
  let captured: Captured | undefined
  function Probe() {
    const reducedByMotionConfig = useReducedMotionConfig()
    const element = CompactPanelTransition({ role: 'detail', isDetailActive: true, children: null }) as React.ReactElement<{
      transition?: unknown
    }>
    captured = { transition: element.props.transition, reducedByMotionConfig }
    return null
  }
  renderToStaticMarkup(
    <MotionPreferenceProvider preference={motion}>
      <Probe />
    </MotionPreferenceProvider>,
  )
  if (captured === undefined) throw new Error('the probe did not render')
  return captured
}

describe('UB12.40 — CompactPanelTransition takes the reduced-motion path from MotionConfig only', () => {
  beforeEach(() => {
    memory.clear()
    stamp('system', false)
  })

  it("positive: with 'full' and the OS asking (and a lingering P6.473 key), the slide runs SPRING.panel", () => {
    memory.set('nessy-prefersReducedMotion', 'true') // the hand-set key P6.473's reader ORed in
    stamp('full', true)
    const { transition, reducedByMotionConfig } = renderCompactPanel('full')
    expect(transition).toBe(SPRING.panel)
    expect(reducedByMotionConfig).toBe(false)
  })

  it("control: with 'reduced' the swap comes from MotionConfig (reducedMotion 'always'), not from a tween of ours", () => {
    stamp('reduced', false)
    const { transition, reducedByMotionConfig } = renderCompactPanel('reduced')
    expect(transition).toBe(SPRING.panel)
    expect(reducedByMotionConfig).toBe(true)
  })
})

const TASK_LIST_TARGETS = [
  '.tiptap-editor .tiptap-prose ul[data-type="taskList"] li > label > span',
  '.tiptap-editor .tiptap-prose ul[data-type="taskList"] li > label > span .tiptap-task-checkbox-path',
  '.tiptap-editor .tiptap-prose ul[data-type="taskList"] li > div > p',
] as const

interface CssRule {
  media: string | null
  selectors: string[]
  body: string
}

/** Flat rules with their enclosing `@media` prelude; comments stripped. Enough for this file's grammar. */
function parseRules(css: string): CssRule[] {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '')
  const rules: CssRule[] = []
  const open: string[] = []
  let start = 0
  for (let k = 0; k < text.length; k++) {
    if (text[k] === '{') {
      open.push(text.slice(start, k).trim())
      start = k + 1
    } else if (text[k] === '}') {
      const prelude = open.pop() ?? ''
      if (!prelude.startsWith('@')) {
        const media = open.find((p) => p.startsWith('@media')) ?? null
        rules.push({ media, selectors: prelude.split(',').map((s) => s.trim()), body: text.slice(start, k) })
      }
      start = k + 1
    }
  }
  return rules
}

function rootApplies(prefix: string, motion: MotionPreference): boolean {
  const p = prefix.trim().replace(/"/g, "'")
  if (p === '') return true
  if (p === ":root:not([data-motion='full'])") return motion !== 'full'
  if (p === ":root[data-motion='reduced']") return motion === 'reduced'
  throw new Error(`unmodelled root condition on a task-list reduction: ${prefix}`)
}

function mediaApplies(media: string | null, osAsks: boolean): boolean {
  if (media === null) return true
  if (media.replace(/\s+/g, ' ') === '@media (prefers-reduced-motion: reduce)') return osAsks
  throw new Error(`unmodelled media condition on a task-list reduction: ${media}`)
}

const css = readFileSync(
  join(import.meta.dir, '../../../../../../packages/ui/src/components/markdown/extensions/animated-task-item.css'),
  'utf8',
)
const reductions = parseRules(css).filter((rule) => rule.body.includes('transition-duration: 1ms'))

/** Whether some reduction rule matches `target` in this state. */
function taskListReduced(target: string, motion: MotionPreference, osAsks: boolean): boolean {
  return reductions.some((rule) =>
    rule.selectors.some((selector) => {
      if (selector !== target && !selector.endsWith(' ' + target)) return false
      return mediaApplies(rule.media, osAsks) && rootApplies(selector.slice(0, selector.length - target.length), motion)
    }),
  )
}

describe('UB12.40 — the task-list reduction follows the Motion preference', () => {
  it("negative: with 'reduced' and the OS not asking, the task-list rule matches all three targets", () => {
    for (const target of TASK_LIST_TARGETS) expect({ target, reduced: taskListReduced(target, 'reduced', false) }).toEqual({ target, reduced: true })
  })

  it("boundary: with 'full' and the OS asking, no task-list rule matches (the media block honours :root:not([data-motion='full']))", () => {
    for (const target of TASK_LIST_TARGETS) expect({ target, reduced: taskListReduced(target, 'full', true) }).toEqual({ target, reduced: false })
  })

  it('in all six states the CSS agrees with the flip.ts reader, and the retired data-reduced-motion rule is gone', () => {
    expect(css).not.toContain('data-reduced-motion')
    for (const motion of ['system', 'reduced', 'full'] as const) {
      for (const osAsks of [false, true]) {
        stamp(motion, osAsks)
        const expected = prefersReducedMotion()
        for (const target of TASK_LIST_TARGETS) {
          expect({ motion, osAsks, target, reduced: taskListReduced(target, motion, osAsks) }).toEqual({ motion, osAsks, target, reduced: expected })
        }
      }
    }
  })
})

describe('UB12.40 — the legacy plumbing is gone', () => {
  it('lib/reduced-motion.ts keeps only the boot migration read', () => {
    expect(Object.keys(legacy).sort()).toEqual(['readReducedMotionSetting'])
  })

  it('main.tsx no longer starts a reduced-motion sync, and CompactPanelTransition no longer reads the legacy module', () => {
    const main = readFileSync(join(import.meta.dir, '../../main.tsx'), 'utf8')
    const panel = readFileSync(join(import.meta.dir, '../../components/app-shell/CompactPanelTransition.tsx'), 'utf8')
    expect(main).not.toContain('startReducedMotionSync')
    expect(main).not.toContain('reduced-motion')
    expect(panel).not.toContain("from '@/lib/reduced-motion'")
    expect(panel).not.toContain('REDUCED_TWEEN')
  })
})
