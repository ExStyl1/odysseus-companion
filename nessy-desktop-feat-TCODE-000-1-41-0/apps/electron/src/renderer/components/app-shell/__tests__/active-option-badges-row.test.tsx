/**
 * UB14.55 — the rows above the composer take v0.15.1's `ActiveOptionBadges` (R2-08): the background-task row on its
 * own line, then ONE quiet chip row — the mode chip (`ComposerModeChip`) while a decision prompt replaces the toolbar,
 * and our session facts (P6.502 never-persist, P6.940 `@agent`, P6.476 the goal). The label and status stack, the Info
 * button and the slash-shaped mode dropdown left with upstream (the chat header owns labels, status and Info, UB14.6).
 *
 * WHAT IS RENDERED and what is read. `ActiveOptionBadges` and `ChatInputZone` cannot be imported in a bare bun
 * process (`background-task-chip.test.tsx` measures why), so their wiring is read from source, comments stripped; the
 * pieces they mount — `SessionFactChip`, `SessionGoalBadge`, `ActiveTasksBar` — are rendered. The rendered dark sweep
 * of the whole row (the playground's `input-container`, `active-option-badges` and `active-tasks-bar-context`) is in
 * `playground/__tests__/registry-render.test.ts`.
 *
 * Positive: the structure (tasks row, then the chip row holding the mode chip and the facts); the facts and the goal
 * render alone on the quiet meta chip; the task row carries upstream's `mb-2`. Negative: the row takes no label or
 * status input and mounts no label, status or Info chip; the zone feeds the labels to the # menu only; a quiet goal
 * carries no tint (the control for the blocked goal's).
 */

import * as React from 'react'
import { beforeAll, describe, expect, it } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInstance, type i18n as I18nInstance } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { renderToStaticMarkup } from 'react-dom/server'
import type { PiHarnessGoalSummaryV1 } from '@nessy-agent/core/types'
import { ActiveTasksBar } from '../ActiveTasksBar'
import { SessionFactChip } from '../SessionFactChip'
import { SessionGoalBadge } from '../SessionGoalBadge'

const APP_SHELL = join(import.meta.dir, '..')
const en = JSON.parse(readFileSync(join(APP_SHELL, '..', '..', '..', '..', '..', '..', 'packages', 'shared', 'src', 'i18n', 'locales', 'en.json'), 'utf8')) as Record<string, string>

/** Comment-stripped source: these files document the shapes they replaced. */
function source(relative: string): string {
  return readFileSync(join(APP_SHELL, relative), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
}

let testI18n: I18nInstance
beforeAll(async () => {
  testI18n = createInstance()
  await testI18n.use(initReactI18next).init({
    lng: 'en',
    fallbackLng: 'en',
    resources: { en: { translation: en } },
    interpolation: { escapeValue: false },
  })
})

const withI18n = (node: React.ReactElement) => renderToStaticMarkup(<I18nextProvider i18n={testI18n}>{node}</I18nextProvider>)

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

/** The opening tag of the first element carrying `data-testid="<id>"`. */
const tagOf = (markup: string, id: string) => new RegExp(`<[a-z]+[^>]*data-testid="${id}"[^>]*>`).exec(markup)?.[0] ?? ''

describe('the structure — v0.15.1\'s rows, ours re-added as one quiet chip row (UB14.55)', () => {
  const badges = source('ActiveOptionBadges.tsx')

  it('POSITIVE — the task row first (with a session), then ONE chip row: the mode chip, then the facts, then the goal', () => {
    const bar = badges.indexOf('<ActiveTasksBar')
    const row = badges.indexOf('data-slot="session-chips"')
    expect({ bar: bar > -1, row: row > bar }).toEqual({ bar: true, row: true })
    expect(badges).toContain("className={cn('flex min-w-0 flex-wrap items-center gap-1.5 mb-2 px-px', className)}")
    const order = ['<DecisionPromptModeChip', 'data-testid="never-persist-badge"', 'data-testid="session-agent-badge"', '<SessionGoalBadge']
      .map(needle => badges.indexOf(needle, row))
    expect(order.every(at => at > row)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
    // The raised chip IS the toolbar's (v0.15.1 ComposerModeChip), fed the same menu derivation as FreeFormInput.
    const raised = badges.slice(badges.indexOf('function DecisionPromptModeChip'))
    for (const part of ['applyWorkspaceCycleToComposerModes(list.modes, enabledModes)', 'withPermissionModeMenuDecorations(defaultMode)', 'coercePermissionModeForComposer(permissionMode,', 'locked={capabilities.permissions.locked}', '<ComposerModeChip']) {
      expect({ part, found: raised.includes(part) }).toEqual({ part, found: true })
    }
    // Upstream's guard: nothing at all without a session and without the row.
    expect(badges).toContain('if (!sessionId && !showChipRow) return null')
    expect(badges).toContain('const showMode = showPermissionMode && !!permissionMode')
  })

  it('NEGATIVE — the row takes no label or status input and mounts no label, status, Info or slash-menu chip', () => {
    for (const gone of ['sessionLabels', 'sessionStatuses', 'onSessionStatusChange', 'onLabelsChange', 'autoOpenLabelId', 'LabelBadge', 'StateBadge', 'FilesPopoverButton', 'SessionInfoPopover', 'PermissionModeDropdown', 'SlashCommandMenu', 'useDynamicStack', 'MetadataBadge', 'onInsertMessage']) {
      expect({ gone, present: badges.includes(gone) }).toEqual({ gone, present: false })
    }
    // The hook's last caller went with the stack, and so did the hook (v0.15.1 deleted it; UB14.46 routed it here).
    expect(existsSync(join(APP_SHELL, '..', '..', 'hooks', 'useDynamicStack.ts'))).toBe(false)
  })

  it('NEGATIVE — the zone feeds the labels and the status to the # menu only, never to the row (control: it still feeds the menu)', () => {
    const zone = source('input/ChatInputZone.tsx')
    const mount = zone.slice(zone.indexOf('<ActiveOptionBadges'), zone.indexOf('/>', zone.indexOf('<ActiveOptionBadges')))
    for (const prop of ['sessionLabels=', 'labels=', 'onLabelsChange=', 'onRemoveLabel=', 'sessionStatuses=', 'currentSessionStatus=', 'onSessionStatusChange=', 'onInsertMessage=']) {
      expect({ prop, passed: mount.includes(prop) }).toEqual({ prop, passed: false })
    }
    for (const prop of ['enabledModes={inputProps.enabledModes}', 'cycleHotkey={cycleHotkey}', 'neverPersist={neverPersist}', 'workspaceId={workspaceId}']) {
      expect({ prop, passed: mount.includes(prop) }).toEqual({ prop, passed: true })
    }
    // Control: the # menu (inside InputContainer) still receives them, so the absence above is the row's, not a loss.
    const card = zone.slice(zone.indexOf('<InputContainer'), zone.indexOf('/>', zone.indexOf('<InputContainer')))
    for (const prop of ['sessionLabels={sessionLabels}', 'labels={labels}', 'onLabelAdd={handleLabelAdd}', 'currentSessionStatus={currentSessionStatus}']) {
      expect({ prop, passed: card.includes(prop) }).toEqual({ prop, passed: true })
    }
    // Upstream removed these from the zone's own props too.
    const props = zone.slice(zone.indexOf('interface ChatInputZoneProps'), zone.indexOf('export function ChatInputZone'))
    for (const gone of ['sessionStatuses?', 'onSessionStatusChange?', 'onInsertMessage?']) {
      expect({ gone, present: props.includes(gone) }).toEqual({ gone, present: false })
    }
  })
})

describe('what the row draws — the quiet chips, rendered alone (UB14.55)', () => {
  it('POSITIVE — a session fact is the static meta chip: a note with the sentence as its name, no press', () => {
    const html = renderToStaticMarkup(
      <SessionFactChip label={en['session.neverPersistBadge']!} title={en['session.neverPersistBadgeTitle']!} icon={<svg />} data-testid="never-persist-badge" />,
    )
    const tag = tagOf(html, 'never-persist-badge')
    for (const cls of ['h-control-sm', 'rounded-full', 'bg-raised', 'ring-border', 'text-label-sm', 'pl-2']) {
      expect({ cls, on: tag.includes(cls) }).toEqual({ cls, on: true })
    }
    expect({ note: tag.includes('role="note"'), press: tag.includes('motion-press') || tag.includes('state-overlay'), button: html.includes('<button') })
      .toEqual({ note: true, press: false, button: false })
    expect(html).toContain(`>${en['session.neverPersistBadge']}</span>`)
  })

  it('POSITIVE — the goal chip is the quiet meta chip (it opens a popover, so it presses); BOUNDARY — only a blocked goal is tinted', () => {
    const active = withI18n(<SessionGoalBadge goal={goal()} valueMode="progress" />)
    const activeTag = tagOf(active, 'session-goal-badge')
    expect({ button: activeTag.startsWith('<button'), chip: activeTag.includes('h-control-sm') && activeTag.includes('rounded-full'), press: activeTag.includes('motion-press'), old: activeTag.includes('h-[30px]') })
      .toEqual({ button: true, chip: true, press: true, old: false })
    expect(active).toContain('3 of 32 turns')
    expect(activeTag).not.toContain('bg-destructive-tint')
    const blocked = tagOf(withI18n(<SessionGoalBadge goal={goal({ status: 'blocked' })} valueMode="progress" />), 'session-goal-badge')
    expect({ tint: blocked.includes('bg-destructive-tint'), ink: blocked.includes('text-destructive'), status: blocked.includes('data-goal-status="blocked"') })
      .toEqual({ tint: true, ink: true, status: true })
  })

  it('POSITIVE — the task row is its own line with upstream\'s mb-2 (it used to borrow the badge row\'s)', () => {
    const html = withI18n(
      <ActiveTasksBar
        tasks={[{ id: 'task-1', type: 'agent', toolUseId: 'tool-1', startTime: Date.now() - 5_000, elapsedSeconds: 5, status: 'running', intent: 'Explore' }]}
        sessionId="session-1"
      />,
    )
    const bar = /<div[^>]*data-slot="background-tasks"[^>]*>/.exec(html)?.[0] ?? ''
    expect(bar).toContain('class="mb-2 flex min-w-0 flex-wrap items-center gap-1.5 px-px"')
  })
})
