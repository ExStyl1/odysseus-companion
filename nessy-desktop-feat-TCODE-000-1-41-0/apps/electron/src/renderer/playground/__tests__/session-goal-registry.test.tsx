/**
 * P4.2's DRAFT IS A REAL, REACHABLE SURFACE — and this is what makes that claim
 * checkable rather than asserted.
 *
 * The chip is not mounted in `ActiveOptionBadges` yet (the owner's 2026-08-23
 * process rule draws every new Phase-4 surface in the playground first), so the
 * playground entry is its ONLY consumer. That is exactly the shape of the defect
 * P2.364 removed on 2026-08-31 — 48 `chat.piRuntime.*` keys that shipped for a
 * month after their panel was deleted — and the difference has to be measured,
 * not assumed. `apps/electron/vite.config.ts` lists `playground.html` as a
 * rollup input beside `index.html`, so a packaged build carries the playground
 * and the keys below have a live reader in it. The last test in this file is
 * therefore the counterpart of `pi-runtime-control-center-keys.test.ts`: every
 * `chat.goal.*` key the component reaches for must exist in BOTH locales, and
 * every `chat.goal.*` key in the locales must be one the component reaches for.
 * Neither gate can see that — `lint:i18n:parity` and `lint:i18n:sorted` compare
 * the locales to each other, and two files that are equally wrong are in parity.
 *
 * WHY THE POPOVER BODY IS RENDERED DIRECTLY rather than through the chip: Radix
 * puts `PopoverContent` in a portal, and `react-dom/server` renders no portals,
 * so an `open` popover contributes nothing to static markup. `SessionGoalDetails`
 * is exported for that reason, and the chip's own test asserts only what the
 * trigger renders.
 *
 * Mutation probes, all four run 2026-08-31:
 *
 *  - point `SESSION_GOAL_STATUS_KEYS.blocked` at another status's key → `each
 *    status renders its own word` goes red (5 distinct words became 4), and so
 *    does the orphan test, because the abandoned key now has no reader;
 *  - replace `if (!goal) return null` with an empty element → `renders nothing
 *    at all for a session with no goal` goes red;
 *  - rename a `chat.goal.*` key in ru.json → `every key the chip reads exists in
 *    every locale` goes red. `lint:i18n:parity` ALSO catches this one — it is the
 *    direction that gate can see;
 *  - add a `chat.goal.*` key to BOTH locales that nothing reads → only the orphan
 *    test goes red, with `lint:i18n:parity` and `lint:i18n:sorted` both green
 *    (measured: exit 0 and exit 0). That is the `chat.piRuntime.*` defect
 *    exactly, and this file is the only thing in the tree that can see it. Put
 *    the probe key in SORTED position when you re-run it — the first attempt
 *    inserted it out of order, `lint:i18n:sorted` went red for the ordering, and
 *    the "both gates green" half of the claim was unproven until the retry.
 */

import * as React from 'react'
import { beforeAll, describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { createInstance, type i18n as I18nInstance } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { renderToStaticMarkup } from 'react-dom/server'
import type { PiHarnessGoalStatusV1, PiHarnessGoalSummaryV1 } from '@nessy-agent/core/types'
import {
  SESSION_GOAL_STATUS_KEYS,
  SessionGoalBadge,
  SessionGoalDetails,
} from '@/components/app-shell/SessionGoalBadge'
import { sessionGoalComponents } from '../registry/session-goal'

const LOCALES = new URL('../../../../../../packages/shared/src/i18n/locales/', import.meta.url)

function locale(lang: string): Record<string, string> {
  return JSON.parse(readFileSync(new URL(`${lang}.json`, LOCALES), 'utf-8'))
}

const en = locale('en')

let testI18n: I18nInstance

beforeAll(async () => {
  testI18n = createInstance()
  // The REAL en.json, so every assertion below is about the shipped string and
  // a missing key shows up as the raw key rather than as a passing test.
  await testI18n.use(initReactI18next).init({
    lng: 'en',
    fallbackLng: 'en',
    resources: { en: { translation: en } },
    interpolation: { escapeValue: false },
  })
})

function goal(overrides: Partial<PiHarnessGoalSummaryV1> = {}): PiHarnessGoalSummaryV1 {
  return {
    id: 'goal-1',
    revision: 1,
    status: 'active',
    source: 'user',
    creator: 'user',
    condition: 'Ship the verified change',
    budgets: { turnLimit: 32, tokenLimit: 250_000, costLimitUsd: 5, elapsedLimitMs: 3_600_000 },
    accounting: { turns: 3, tokens: 18_400, costUsd: 0.42, elapsedMs: 214_000, resumeCount: 0 },
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  }
}

function renderChip(props: Partial<React.ComponentProps<typeof SessionGoalBadge>> = {}): string {
  return renderToStaticMarkup(
    <I18nextProvider i18n={testI18n}>
      <SessionGoalBadge goal={goal()} {...props} />
    </I18nextProvider>,
  )
}

function renderDetails(value: PiHarnessGoalSummaryV1): string {
  return renderToStaticMarkup(
    <I18nextProvider i18n={testI18n}>
      <SessionGoalDetails goal={value} />
    </I18nextProvider>,
  )
}

const ALL_STATUSES = Object.keys(SESSION_GOAL_STATUS_KEYS) as PiHarnessGoalStatusV1[]

describe('the goal chip draft', () => {
  it('renders nothing at all for a session with no goal', () => {
    // The common case, and the one the strip's own spacing depends on: an empty
    // wrapper would add a gap to every session that never sets a goal.
    expect(renderChip({ goal: undefined })).toBe('')
  })

  it('renders the chip with its label and the turn budget it is against', () => {
    const html = renderChip()
    expect(html).toContain('data-testid="session-goal-badge"')
    expect(html).toContain(en['chat.goal.label'])
    // Interpolated from the goal's own accounting/budgets, not a literal.
    expect(html).toContain('3 of 32 turns')
    // The full condition stays reachable on a chip that truncates it.
    expect(html).toContain('Ship the verified change')
  })

  it('carries the condition instead of the progress in the other value mode', () => {
    const html = renderChip({ valueMode: 'condition', goal: goal({ condition: 'Land P4.8' }) })
    expect(html).toContain('Land P4.8')
    expect(html).not.toContain('3 of 32 turns')
  })

  it('each status renders its own word, and the five are five different words', () => {
    const words = ALL_STATUSES.map(status => {
      const html = renderDetails(goal({ status }))
      const word = en[SESSION_GOAL_STATUS_KEYS[status]]
      expect(html, `${status} did not render ${SESSION_GOAL_STATUS_KEYS[status]}`).toContain(word)
      return word
    })
    expect(new Set(words).size).toBe(ALL_STATUSES.length)
  })

  it('names WHO the blocked goal is waiting on, which the chip cannot show', () => {
    const user = renderDetails(goal({
      status: 'blocked',
      blocking: { condition: 'needs a decision', blockedBy: 'user', consecutive: 2 },
    }))
    expect(user).toContain(en['chat.goal.blockedByUser'])
    expect(user).not.toContain(en['chat.goal.blockedByExternal'])

    const external = renderDetails(goal({
      status: 'blocked',
      blocking: { condition: 'waiting on a build', blockedBy: 'external', consecutive: 1 },
    }))
    expect(external).toContain(en['chat.goal.blockedByExternal'])
    expect(external).not.toContain(en['chat.goal.blockedByUser'])
  })

  it('shows the last check only when there is one with a reason', () => {
    expect(renderDetails(goal())).not.toContain('data-testid="session-goal-last-check"')
    const checked = renderDetails(goal({
      lastEvaluation: {
        source: 'evaluator',
        verdict: 'not_complete',
        reason: 'The sorted gate has not been run yet.',
        evidence: [],
        evaluatedAt: 3,
      },
    }))
    expect(checked).toContain(en['chat.goal.lastCheck'])
    expect(checked).toContain('The sorted gate has not been run yet.')
  })
})

describe('the playground draft the owner reviews', () => {
  it('registers both halves of the draft and is wired into the registry index', () => {
    expect(sessionGoalComponents.map(entry => entry.id)).toEqual([
      'session-goal-badge',
      'session-goal-details',
    ])

    const indexSource = readFileSync(new URL('../registry/index.ts', import.meta.url), 'utf8')
    expect(indexSource).toContain("import { sessionGoalComponents } from './session-goal'")
    expect(indexSource).toContain('...sessionGoalComponents')
  })

  it('covers every goal status the type declares, plus the state that renders nothing', () => {
    // The playground is where this design gets corrected, so a status with no
    // variant is a status nobody looked at. Derived from the component's own
    // key map rather than a hand-written list, so a sixth status upstream
    // fails here instead of quietly having no state.
    const badgeVariants = sessionGoalComponents.find(e => e.id === 'session-goal-badge')?.variants ?? []
    const badgeStates = badgeVariants.map(variant => String(variant.props.state))
    expect(badgeStates).toContain('none')
    for (const status of ALL_STATUSES) {
      const stem = status.replace('_', '-')
      expect(
        badgeStates.some(state => state.startsWith(stem)),
        `no badge variant for status ${status}`,
      ).toBe(true)
    }

    const detailVariants = sessionGoalComponents.find(e => e.id === 'session-goal-details')?.variants ?? []
    const detailStates = detailVariants.map(variant => String(variant.props.state))
    for (const status of ALL_STATUSES) {
      const stem = status.replace('_', '-')
      expect(
        detailStates.some(state => state.startsWith(stem)),
        `no details variant for status ${status}`,
      ).toBe(true)
    }
  })

  it('keeps a variant for each answer to the two open design questions', () => {
    const names = (sessionGoalComponents.find(e => e.id === 'session-goal-badge')?.variants ?? [])
      .map(variant => variant.name)
    expect(names).toContain('Active (condition, long)')
    expect(names).toContain('Alone in the strip')
    expect(names).toContain('Popover open')
  })
})

describe('the keys, in both directions', () => {
  const componentSource = readFileSync(
    new URL('../../components/app-shell/SessionGoalBadge.tsx', import.meta.url),
    'utf8',
  )
  const referenced = [...new Set(
    (componentSource.match(/['"`]chat\.goal\.[A-Za-z0-9_]+['"`]/g) ?? [])
      .map(quoted => quoted.slice(1, -1)),
  )].sort()

  it('reads the component at all (the scan is not vacuous)', () => {
    expect(referenced).toContain('chat.goal.label')
    expect(referenced.length).toBeGreaterThanOrEqual(9)
  })

  it('every key the chip reads exists in every locale', () => {
    for (const lang of ['en', 'ru']) {
      const messages = locale(lang)
      for (const key of referenced) {
        expect(messages[key], `${key} missing from ${lang}.json`).toBeTruthy()
      }
    }
  })

  it('every chat.goal.* key in the locales has a reader, so none can go dead unnoticed', () => {
    // The `chat.piRuntime.*` lesson from the other side: a key with no reader is
    // a string shipped to every user for a surface that is not there.
    for (const lang of ['en', 'ru']) {
      const orphans = Object.keys(locale(lang))
        .filter(key => key.startsWith('chat.goal.'))
        .filter(key => !referenced.includes(key))
      expect(orphans, `${lang}.json carries chat.goal.* keys nothing reads`).toEqual([])
    }
  })
})
