/**
 * THE SESSION GOAL CHIP IS ON SCREEN — P6.476.
 *
 * `SessionGoalBadge` was written, reviewed in the playground and deliberately not
 * mounted, so a goal the host already knew about on all three runtimes was
 * invisible in the app. The owner's 2026-09-05 Q3 answer is option A: mount the
 * drafted chip READ-ONLY at `valueMode: progress`. This file pins the two halves
 * of that mount.
 *
 * THE MOUNT ITSELF IS PINNED BY SOURCE, and P6.849 CORRECTED THE REASON — the cause
 * this paragraph used to name has been deleted and the conclusion survives it, which is
 * the only interesting thing about the correction.
 *
 * What stood here: that `ActiveOptionBadges` reaches `@nessy-agent/ui` through
 * `@/components/ui/slash-command-menu`, and that two suites in this tree register a
 * one-export `mock.module('@nessy-agent/ui', …)` with no spread and no restore. BOTH
 * halves are now false. `ef9bb426c` removed the three live barrel amputations (the only
 * `mock.module('@nessy-agent/ui'` strings left in the tree are this comment and its two
 * siblings, which is a grep anyone can re-run), and `slash-command-menu` now takes
 * `Icon_Folder` from the icons SUBPATH rather than the barrel.
 *
 * WHAT ACTUALLY BLOCKS THE IMPORT, measured at HEAD 2026-09-08 by importing
 * `ActiveOptionBadges.tsx` in a bare bun process: it throws
 * `TypeError: import.meta.glob is not a function`, from `ThemeContext.tsx:77`, which
 * loads the bundled theme JSON through a Vite-only API bun does not implement. Behind
 * that sits the reach `background-task-chip.test.tsx` measures the same day — the
 * component reaches the barrel twenty-seven other ways and the barrel's own graph ends
 * at a Vite-only pdfjs worker-URL specifier — so freeing this is a build-shape
 * question, not one import line, and it is not this file's to answer.
 *
 * SO THE INSTRUMENT IS UNCHANGED AND THE REASON IS STRONGER: no ordering of suites and
 * no spread in someone else's mock can make this component importable here. The source
 * assertions do fail when the mount is deleted — verified by removing the
 * `<SessionGoalBadge` element and watching this file go red.
 *
 * THE CHIP ITSELF IS RENDERED, not asserted about: it imports nothing from
 * `@nessy-agent/ui`, so `renderToStaticMarkup` reaches it and the progress line the
 * owner chose is real text rather than a prop name.
 */

import * as React from 'react'
import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { createInstance } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { renderToStaticMarkup } from 'react-dom/server'
import type { PiHarnessGoalSummaryV1 } from '@nessy-agent/core/types'
import { SessionGoalBadge, SessionGoalDetails } from '../SessionGoalBadge'

/** Comment-stripped source — these files document the shapes they replaced. */
function source(relative: string): string {
  return readFileSync(new URL(relative, import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
}

function goal(overrides: Partial<PiHarnessGoalSummaryV1> = {}): PiHarnessGoalSummaryV1 {
  return {
    schemaVersion: 1,
    goalId: 'goal-1',
    revision: 3,
    status: 'active',
    condition: 'Ship the verified change',
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    budgets: { turnLimit: 32 },
    accounting: { turns: 3, tokens: 0, costUsd: 0, elapsedMs: 0 },
    ...overrides,
  } as PiHarnessGoalSummaryV1
}

async function render(node: React.ReactElement): Promise<string> {
  const en = JSON.parse(
    readFileSync(new URL('../../../../../../../packages/shared/src/i18n/locales/en.json', import.meta.url), 'utf8'),
  ) as Record<string, string>
  const i18n = createInstance()
  await i18n.use(initReactI18next).init({
    lng: 'en',
    resources: { en: { translation: en } },
    interpolation: { escapeValue: false },
  })
  return renderToStaticMarkup(React.createElement(I18nextProvider, { i18n }, node))
}

describe('the mount — the goal reaches the strip', () => {
  it('ActiveOptionBadges renders the chip — THE element that did not exist', () => {
    const badges = source('../ActiveOptionBadges.tsx')
    expect(
      badges.includes('<SessionGoalBadge'),
      'ActiveOptionBadges no longer renders SessionGoalBadge — the mount is gone',
    ).toBe(true)
    const at = badges.indexOf('<SessionGoalBadge')
    const mount = badges.slice(at, badges.indexOf('/>', at))
    expect(mount).toContain('goal={goal}')
    // The owner's Q3 answer names the value mode; a default would drift with the
    // component's own default.
    expect(mount).toContain("valueMode=\"progress\"")
    // Inside the one quiet chip row (UB14.55), not appended after it as a band.
    const row = badges.indexOf('data-slot="session-chips"')
    expect(row).toBeGreaterThan(-1)
    expect(at).toBeGreaterThan(row)
    // After the session-fact chips: the state chip it followed (the 2026-08-22
    // ruling's placement) moved to the chat header with UB14.6, so the goal is
    // the row's last chip.
    expect(at).toBeGreaterThan(badges.indexOf('data-testid="session-agent-badge"'))
    expect(badges.indexOf('<StateBadge')).toBe(-1)
  })

  it('the goal is sourced from the host, and the strip shows for a goal alone', () => {
    const badges = source('../ActiveOptionBadges.tsx')
    expect(badges).toContain('useSessionGoal(sessionId, workspaceId)')
    // The chip row's condition must know about the goal, or a session whose only
    // row content is a goal renders nothing at all (UB14.55: the row's own
    // condition; a missing anchor fails here, not on the tail).
    const at = badges.indexOf('const showChipRow =')
    expect(at).toBeGreaterThan(-1)
    expect(badges.slice(at, badges.indexOf('\n', at))).toContain('|| !!goal')
  })

  it('READ-ONLY — no control verb reaches this surface (owner Q3, option A)', () => {
    // B's composer command and cancel popover were declined. The control actions
    // exist on the wire; nothing in the mounted path may call one.
    const badges = source('../ActiveOptionBadges.tsx')
    const hook = source('../../../hooks/useSessionGoal.ts')
    for (const [name, text] of [['ActiveOptionBadges', badges], ['useSessionGoal', hook]] as const) {
      for (const verb of ['goal_create', 'goal_replace', 'goal_cancel', 'goal_complete', 'goal_resume']) {
        expect(text.includes(verb), `${name} reaches the ${verb} control`).toBe(false)
      }
      expect(text.includes('controlPiHarnessRuntime'), `${name} issues a runtime control`).toBe(false)
    }
  })

  it('the hook is provider-blind and re-reads only on the goal domain', () => {
    const hook = source('../../../hooks/useSessionGoal.ts')
    // The read and the subscription both exist; a read with no subscription would
    // show the goal a session started with and never move again.
    expect(hook).toContain('getPiHarnessRuntime')
    expect(hook).toContain('onPiHarnessRuntimeInvalidated')
    expect(hook).toContain("changedDomains.includes('goal')")
    // No provider gate of its own: P2.488 widened both host-side gates to all
    // three coding runtimes, and a second gate here would re-open the divergence.
    expect(hook.includes("'pi'"), 'the hook gates on a provider').toBe(false)
  })
})

describe('what the chip says once mounted', () => {
  it('progress is the line, and the condition is the title', async () => {
    const markup = await render(React.createElement(SessionGoalBadge, { goal: goal(), valueMode: 'progress' }))
    expect(markup).toContain('Goal')
    expect(markup).toContain('3 of 32 turns')
    expect(markup).toContain('Ship the verified change')
  })

  it('no goal renders nothing, so the strip keeps its own spacing', async () => {
    const markup = await render(React.createElement(SessionGoalBadge, {}))
    expect(markup).toBe('')
  })

  it('the popover carries the condition and the status word', async () => {
    const markup = await render(React.createElement(SessionGoalDetails, { goal: goal({ status: 'blocked' }) }))
    expect(markup).toContain('Ship the verified change')
    expect(markup).toContain('Blocked')
  })
})
