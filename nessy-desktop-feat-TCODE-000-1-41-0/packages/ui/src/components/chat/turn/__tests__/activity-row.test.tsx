/**
 * UB14.11 (R3-05) — v0.15.1's quiet work log with OUR row decisions, rendered.
 *
 * Instrument: `renderToStaticMarkup` (packages/ui has no DOM harness), the same as
 * `turn-primitives.test.tsx`. Unlike `TurnCard.tsx`, the `turn/` row modules load under bun — none
 * of them reaches `Markdown` (pdfjs) — so these arms assert PAINTED values, not source text. Lucide
 * draws `lucide-<kebab-name>` into the svg class, which is what the glyph arms read.
 *
 * Arms:
 * - positive: a `thinking` row paints its reasoning (Brain, italic, tertiary) where v0.15.1 drew a
 *   bare "Thinking..." name (P4.4); commentary takes upstream's text bubble; a codex
 *   `mcp__sources__w__t` row reads its SOURCE name and the tool slug `t`, never upstream's `w__t`
 *   (F1.217, F1.477); the collapsed header reads "4 steps · <ours>" with a "2 failed" chip;
 * - negative (the control): a `renderActivity` that returns `null` falls back to the ordinary row and
 *   never deletes it (the P3.24 failure mode) — in the flat list AND inside a subagent group — while
 *   one that returns a card replaces the row; upstream's English `Task ID:` never ships (a Russian
 *   render reads `ID задачи:`);
 * - boundary: the published-artifact chip (UA1.19) renders OUTSIDE the row's button — a button may
 *   not contain the chip's own buttons.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { I18nextProvider } from 'react-i18next'
import { i18n, setupI18n } from '@nessy-agent/shared/i18n'
import { TooltipProvider } from '../../../tooltip'
import type { ActivityItem, ActivityRenderProps } from '../../TurnCard'
import type { ActivityGroup } from '../../turn-utils'
import { ActivityRow } from '../ActivityRow'
import { TodoList } from '../TodoList'
import { WorkLog, type WorkLogProps } from '../WorkLog'

setupI18n()
beforeAll(async () => {
  await i18n.changeLanguage('en')
})
afterAll(async () => {
  await i18n.changeLanguage('en')
})

const render = (node: React.ReactNode): string =>
  renderToStaticMarkup(
    <I18nextProvider i18n={i18n}>
      <TooltipProvider>{node}</TooltipProvider>
    </I18nextProvider>,
  )

const svgClasses = (html: string): string[] => [...html.matchAll(/<svg[^>]*class="([^"]*)"/g)].map(m => m[1] ?? '')

let seq = 0
function act(over: Partial<ActivityItem>): ActivityItem {
  seq += 1
  return { id: `a${seq}`, type: 'tool', status: 'completed', timestamp: seq, ...over }
}

function workLog(over: Partial<WorkLogProps>): string {
  const props: WorkLogProps = {
    activityCount: 0,
    preview: {},
    failedCount: 0,
    isExpanded: true,
    onToggle: () => {},
    activities: [],
    groupedActivities: null,
    lastChildSet: new Set(),
    expandedActivityGroups: new Set(),
    onExpandedActivityGroupsChange: () => {},
    displayMode: 'detailed',
    animateInserts: false,
    listRef: null,
    ...over,
  }
  return render(<WorkLog {...props} />)
}

describe('positive — our row decisions inside upstream\'s row', () => {
  it('a thinking row paints its reasoning, de-emphasised, with the Brain glyph (P4.4)', () => {
    const html = render(<ActivityRow activity={act({ type: 'thinking', content: 'Weighing **two** options' })} />)
    expect(html).toContain('Weighing two options')
    expect(svgClasses(html).join(' ')).toContain('lucide-brain')
    expect(html).toContain('italic text-tertiary')
    // v0.15.1's tool branch would have drawn the placeholder NAME in place of the content
    expect(html).not.toContain('Thinking...')
  })

  it('commentary takes upstream\'s text bubble, and a streaming row the placeholder', () => {
    const done = render(<ActivityRow activity={act({ type: 'intermediate', content: 'Reading the config' })} />)
    expect(svgClasses(done).join(' ')).toContain('lucide-message-square-text')
    expect(done).not.toContain('italic')
    const streaming = render(<ActivityRow activity={act({ type: 'intermediate', status: 'running', content: 'x' })} />)
    expect(streaming).toContain('Thinking...')
  })

  it('a codex mcp__sources__w__t row reads the source name and the slug "t", never "w__t"', () => {
    const html = render(
      <ActivityRow
        activity={act({ toolName: 'mcp__sources__w__t', toolDisplayMeta: { displayName: 'Linear', category: 'source' } as ActivityItem['toolDisplayMeta'] })}
      />,
    )
    expect(html).toContain('>Linear</span>')
    expect(html).toContain('>t</span>')
    expect(html).not.toContain('w__t')
  })

  it('the collapsed header leads with the step count, our preview text, and the failed chip', () => {
    const html = workLog({ activityCount: 4, preview: { text: 'Read 3 files, edited 1 file' }, failedCount: 2, isExpanded: false })
    expect(html).toContain('4 steps')
    expect(html).toContain('Read 3 files, edited 1 file')
    expect(html).toContain('2 failed')
    expect(html).toContain('aria-expanded="false"')
  })

  it('a header with no text reads upstream\'s "N steps completed", and no chip without failures', () => {
    const html = workLog({ activityCount: 3, preview: {}, failedCount: 0, isExpanded: false })
    expect(html).toContain('3 steps completed')
    expect(html).not.toContain('failed')
  })

  it('the todo list carries its heading key', () => {
    const html = render(<TodoList todos={[{ content: 'Port the rows', status: 'completed' }]} animateInserts={false} />)
    expect(html).toContain('Todo list')
    expect(html).toContain('line-through')
  })
})

describe('negative — renderActivity never deletes a row (P3.24), and no English id literal ships', () => {
  const row = act({ toolName: 'Grep', toolInput: { pattern: 'needle' } })
  const declines = (_: ActivityRenderProps) => null
  const card = ({ activity }: ActivityRenderProps) => <div data-test-card="yes">card for {activity.id}</div>

  it('a card that declines (null) keeps the ordinary row in the flat list', () => {
    const html = workLog({ activities: [row], activityCount: 1, renderActivity: declines })
    expect(html).toContain('Grep')
    expect(html).toContain('needle')
    expect(html).not.toContain('data-activity-card')
  })

  it('a card that renders replaces the row', () => {
    const html = workLog({ activities: [row], activityCount: 1, renderActivity: card })
    expect(html).toContain(`card for ${row.id}`)
    expect(html).toContain('data-activity-card="true"')
    expect(html).not.toContain('needle')
  })

  it('inside a subagent group too: decline keeps the child row, a card replaces it', () => {
    const parent = act({ toolName: 'Task', toolUseId: 'tu1', toolInput: { description: 'Audit', subagent_type: 'Explore' } })
    const child = act({ toolName: 'Read', parentId: 'tu1', toolInput: { file_path: '/x/notes.md' } })
    const group: ActivityGroup = { type: 'group', parent, children: [child] }
    const base = {
      activities: [parent, child],
      activityCount: 2,
      groupedActivities: [group],
      expandedActivityGroups: new Set([parent.id]),
    }
    const declined = workLog({ ...base, renderActivity: declines })
    expect(declined).toContain('notes.md')
    expect(declined).toContain('Explore')
    const carded = workLog({ ...base, renderActivity: ({ activity }) => (activity.id === child.id ? card({ activity, displayMode: 'detailed' }) : null) })
    expect(carded).toContain(`card for ${child.id}`)
    expect(carded).not.toContain('notes.md')
  })

  it('a backgrounded task reads the i18n label in Russian, never upstream\'s "Task ID:"', async () => {
    await i18n.changeLanguage('ru')
    try {
      const html = render(<ActivityRow activity={act({ toolName: 'Task', status: 'backgrounded', taskId: 'bg-7', elapsedSeconds: 90 })} />)
      expect(html).toContain('ID задачи: bg-7')
      expect(html).toContain('прошло')
      expect(html).not.toContain('Task ID:')
      expect(html).toContain('text-accent')
    } finally {
      await i18n.changeLanguage('en')
    }
  })
})

describe('boundary — the published-artifact chip sits outside the row button', () => {
  it('a completed publish_artifact row is a button, and the chip follows it as a sibling', () => {
    const content = JSON.stringify({ url: 'https://t-artifacts.t-tech.team/a/AbCdEfGhIjKlMnOpQrStUv', expires_at: null })
    const html = render(
      <ActivityRow
        activity={act({ toolName: 'mcp__session__publish_artifact', content })}
        onOpenDetails={() => {}}
      />,
    )
    const buttonEnd = html.indexOf('</button>')
    const chip = html.indexOf('data-artifact-chip=')
    expect(html.startsWith('<div')).toBe(true)
    expect(buttonEnd).toBeGreaterThan(0)
    expect(chip).toBeGreaterThan(buttonEnd)
    // the row's own button closes before the chip's buttons open: no button inside a button
    expect(html.slice(0, buttonEnd)).not.toContain('data-artifact-chip')
  })

  it('a running row has no chip and no button (nothing to open yet)', () => {
    const html = render(<ActivityRow activity={act({ toolName: 'mcp__session__publish_artifact', status: 'running' })} onOpenDetails={() => {}} />)
    expect(html).not.toContain('data-artifact-chip')
    expect(html).not.toContain('<button')
  })
})
