/**
 * UB14.18 (R3-12; no upstream counterpart) — our transcript cards on v0.15.1's row language.
 *
 * Instrument: `renderToStaticMarkup` (no DOM harness here), the same one `activity-slot-cards.test.tsx` and
 * packages/ui's `turn/__tests__/activity-row.test.tsx` use. The packages/ui twins are imported by RELATIVE path,
 * as `activity-overlay-title.test.ts` does: the ui package exports no subpath for `turn/turn-classes`,
 * `turn/ActivitySlot` or `markdown/PreviewBlockChrome` (see `transcript-card-chrome.tsx`'s header for why the
 * cards cannot import them either).
 *
 * Arms:
 * - PIN: every literal in `transcript-card-chrome.tsx` equals its packages/ui constant, `CardWell` draws
 *   `PreviewBlockFrame` + `PreviewBlockHeader` byte for byte, and `RowSpinner` draws `ResultGlyph`'s running
 *   spinner — so the cards cannot drift from the rows they sit between.
 * - POSITIVE: each card draws on that language (row, icon slot, chip, hairline body, well, named icon button)
 *   for Pi `subagent`, a codex `spawn_agent` collab row, the workflow, the todo card, the advisor, the F1.351
 *   line, the P6.334 chip and the UA1.19 artifact chip.
 * - CENSUS + its CONTROL: no state of any of them carries the pre-redesign classes, and the census does find
 *   one when it is planted.
 * - NEGATIVE (the row's own control): through packages/ui's real `ActivitySlot`, with ChatDisplay's routing
 *   mirrored on the shipped predicates, a row no card can draw still yields the ordinary row — never an
 *   empty slot — while a routed row is replaced by its card.
 */
import * as React from 'react'
import { beforeAll, describe, expect, it } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { I18nextProvider } from 'react-i18next'
import { i18n, setupI18n } from '@nessy-agent/shared/i18n'
import type { ActivityItem, ActivityRenderProps } from '@nessy-agent/ui/chat/TurnCard'
import { PublishedArtifactChip } from '@nessy-agent/ui/chat/PublishedArtifactChip'
import * as TURN from '../../../../../../../packages/ui/src/components/chat/turn/turn-classes'
import { ResultGlyph } from '../../../../../../../packages/ui/src/components/chat/turn/ActivityIcons'
import { ActivitySlot } from '../../../../../../../packages/ui/src/components/chat/turn/ActivitySlot'
import { PreviewBlockFrame, PreviewBlockHeader } from '../../../../../../../packages/ui/src/components/markdown/PreviewBlockChrome'
import { TooltipProvider } from '../../../../../../../packages/ui/src/components/tooltip'
import * as CHROME from '../transcript-card-chrome'
import { SubagentCard } from '../SubagentCard'
import { WorkflowPanel } from '../WorkflowPanel'
import { TodoListCard, isTodoCardActivity } from '../TodoListCard'
import { AdvisorConsultationCard } from '../AdvisorConsultationCard'
import { TaskNotificationLine } from '../task-notification-line'
import { DeferredSpawnChips } from '../deferred-spawn-chip'
import { isSubagentCardActivity } from '../activity-card-routing'
import { isAdvisorCardActivity } from '../advisor-consultation'

setupI18n()
beforeAll(async () => {
  await i18n.changeLanguage('en')
})

const render = (node: React.ReactNode): string =>
  renderToStaticMarkup(
    <I18nextProvider i18n={i18n}>
      <TooltipProvider>{node}</TooltipProvider>
    </I18nextProvider>,
  )

/** Every element's class list, as written. */
const classLists = (html: string): string[] => [...html.matchAll(/class="([^"]*)"/g)].map(m => m[1] ?? '')
const hasClassList = (html: string, expected: string) => classLists(html).includes(expected)
/** A class list carrying every token of `classes` (order-free; for a list `cn` merged an override into). */
const carries = (list: string, classes: string, except: string[] = []) => {
  const tokens = new Set(list.split(/\s+/))
  return classes.split(/\s+/).filter(token => !except.includes(token)).every(token => tokens.has(token))
}

let seq = 0
function act(over: Partial<ActivityItem>): ActivityItem {
  seq += 1
  return { id: `look-${seq}`, type: 'tool', status: 'completed', timestamp: 1_700_000_000_000 + seq, ...over } as ActivityItem
}

const agents = [
  { id: 'a1', label: 'Scout', agentType: 'scout', status: 'done' as const, tokensIn: 930, tokensOut: 201 },
  { id: 'a2', label: 'Reviewer', agentType: 'reviewer', status: 'running' as const, tokensIn: 870, tokensOut: 166, lastActivity: 'tool_execution_start' },
]
const piSubagent = act({ toolName: 'subagent', content: 'Scout found the adapter path.', orchestrationProgress: { kind: 'subagent', runId: 'r1', agents } })
const codexCollab = act({ toolName: 'spawn_agent', content: 'Explorer mapped the fetchers.', orchestrationProgress: { kind: 'subagent', runId: 'r2', agents } })
const workflowRun = act({
  toolName: 'workflow',
  status: 'error',
  toolInput: { tokenBudget: 100, script: 'export const meta = {}' },
  content: 'workflow error\nparallel[1] failed: no files\n\nLogs:\n- started review lane\n\nFailures:\n- parallel[1]: no files',
  orchestrationProgress: {
    kind: 'workflow',
    runId: 'wf-1',
    agents: [{ id: 'w1', label: 'Analyzer', agentType: 'scout', phase: 'discover', status: 'error', tokensIn: 2100, tokensOut: 512, toolCalls: 4 }],
  },
})
const todoRun = act({
  toolName: 'TodoWrite',
  toolInput: {
    todos: [
      { id: '1', content: 'Map the renderer', status: 'completed' },
      { id: '2', content: 'Wire the card', status: 'in_progress', activeForm: 'Wiring the card' },
      { id: '3', content: 'Run gates', status: 'pending' },
      { id: '4', content: 'Stopped item', status: 'interrupted' },
    ],
  },
})
const advisorRun = act({
  toolName: 'advisor_consult',
  toolInput: { moment: 'approach', question: 'Transport or caller?' },
  content: 'Advisor (claude-sonnet-4-5):\n\nPut it in the transport.',
})
const DELIVERY = '<system-reminder>host</system-reminder>\n<task-notification>\nBackground subagent task t-1 finished (completed).\n</task-notification>'
// The tool's own result shape (`published-artifact.ts`): a link on the one artifacts origin, `expires_at`.
const artifactRow = (expiresAt: string | null) => act({
  toolName: 'mcp__session__publish_artifact',
  content: JSON.stringify({ url: 'https://t-artifacts.t-tech.team/a/AbCdEfGhIjKlMnOpQrStUv', expires_at: expiresAt, updated: false }),
})

/** Every state these cards draw, as `[name, markup]`. */
function everyCardState(): [string, string][] {
  return [
    ['subagent · pi (collapsed)', render(<SubagentCard activity={piSubagent} onOpenDetails={() => {}} />)],
    ['subagent · pi (expanded)', render(<SubagentCard activity={piSubagent} onOpenDetails={() => {}} defaultExpanded />)],
    ['subagent · codex spawn_agent (expanded)', render(<SubagentCard activity={codexCollab} defaultExpanded />)],
    ['workflow · error (expanded, keepable)', render(<WorkflowPanel activity={workflowRun} onOpenDetails={() => {}} onInsertResumePrompt={() => {}} onKeepRun={() => {}} defaultExpanded />)],
    ['workflow · running (collapsed)', render(<WorkflowPanel activity={{ ...workflowRun, status: 'running', content: undefined, orchestrationProgress: { kind: 'workflow', runId: 'wf-2', agents: [{ ...workflowRun.orchestrationProgress!.agents[0]!, status: 'running' }] } }} />)],
    ['todo', render(<TodoListCard activity={todoRun} />)],
    ['advisor', render(<AdvisorConsultationCard activity={advisorRun} />)],
    ['task notification', render(<TaskNotificationLine content={DELIVERY} />)],
    ['spawn chip', render(<DeferredSpawnChips proposals={[{ id: 'p1', name: 'Update the badge', prompt: 'Do it.' }]} onStart={() => {}} onResolve={() => {}} />)],
    ['artifact chip · live', render(<PublishedArtifactChip activity={artifactRow('2099-01-01T00:00:00.000Z')} now={Date.parse('2026-10-16T00:00:00.000Z')} />)],
    ['artifact chip · expired', render(<PublishedArtifactChip activity={artifactRow('2026-01-01T00:00:00.000Z')} now={Date.parse('2026-10-16T00:00:00.000Z')} />)],
  ]
}

/** The pre-redesign vocabulary these cards used: arbitrary px sizes and radii, the old surfaces and inks. */
const LEGACY = [
  /\brounded-\[\d+px\]/,
  /\btext-\[\d+px\]/,
  /\bshadow-minimal\b/,
  /\btext-muted-foreground\b/,
  /\bbg-muted\b/,
  /\bborder-border\b/,
  /\bbg-background\b/,
  /\btext-foreground\/\d+/,
  /\banimate-spin\b/,
]
const legacyIn = (html: string): string[] =>
  classLists(html).flatMap(list => LEGACY.filter(pattern => pattern.test(list)).map(pattern => `${pattern.source} in "${list}"`))

describe('UB14.18 · PIN — the chrome is the transcript\'s own', () => {
  it('every literal equals its packages/ui twin', () => {
    expect(CHROME.WORK_LOG_ROW).toBe(TURN.WORK_LOG_ROW)
    expect(CHROME.WORK_LOG_ROW_WRAPPER).toBe(TURN.WORK_LOG_ROW_WRAPPER)
    expect(CHROME.WORK_LOG_ROW_INTERACTIVE).toBe(TURN.WORK_LOG_ROW_INTERACTIVE)
    expect(CHROME.ROW_ICON_SLOT).toBe(TURN.ROW_ICON_SLOT)
    expect(CHROME.WORK_LOG_BODY).toBe(TURN.WORK_LOG_BODY)
    expect(CHROME.CHIP_NEUTRAL).toBe(TURN.CHIP_NEUTRAL)
    expect(CHROME.CHIP_DESTRUCTIVE).toBe(TURN.CHIP_DESTRUCTIVE)
    expect(CHROME.HOVER_REVEAL).toBe(TURN.HOVER_REVEAL)
    expect(CHROME.ROW_ICON_SIZE).toBe(TURN.SIZE_CONFIG.iconSize)
    expect(CHROME.ROW_SPINNER_SIZE).toBe(TURN.SIZE_CONFIG.spinnerSize)
  })

  it('CardWell is PreviewBlockFrame + PreviewBlockHeader byte for byte; RowSpinner is ResultGlyph running', () => {
    const ours = render(<CHROME.CardWell title="Result" />)
    const theirs = render(<PreviewBlockFrame><PreviewBlockHeader title="Result" /></PreviewBlockFrame>)
    expect(ours).toBe(theirs)
    expect(ours).toContain('bg-sunken') // the instrument reads a real well
    expect(render(<CHROME.RowSpinner />)).toBe(render(<ResultGlyph status="running" />))
  })
})

describe('UB14.18 · POSITIVE — each card draws on the row language', () => {
  const ROW_BUTTON = `${TURN.WORK_LOG_ROW} ${TURN.WORK_LOG_ROW_INTERACTIVE}`

  it('the subagent card (Pi subagent and codex spawn_agent): a group row, a chip title, rows under the hairline, a well', () => {
    for (const activity of [piSubagent, codexCollab]) {
      expect(isSubagentCardActivity(activity)).toBe(true)
      const html = render(<SubagentCard activity={activity} onOpenDetails={() => {}} defaultExpanded />)
      expect(hasClassList(html, ROW_BUTTON)).toBe(true)
      expect(html).toContain(`class="${TURN.CHIP_NEUTRAL} font-medium">Subagents<`)
      expect(html).toContain(`class="${TURN.WORK_LOG_BODY} mb-0.5"`)
      expect(html.split('data-subagent-agent=""').length - 1).toBe(2)
      expect(html).toContain(`class="${CHROME.CARD_WELL_FRAME} my-1"`) // the result well
      expect(html).toMatch(/<button[^>]*data-slot="icon-button"[^>]*aria-label="[^"]+"/)
      // The summary keeps its value (P6.641's split line).
      expect(html).toContain('1.8k in / 367 out')
    }
  })

  it('the workflow: a group row, phase rows, the error as the destructive marker, the logs and result as wells', () => {
    const html = render(<WorkflowPanel activity={workflowRun} onOpenDetails={() => {}} onInsertResumePrompt={() => {}} onKeepRun={() => {}} defaultExpanded />)
    expect(classLists(html).filter(list => list === ROW_BUTTON).length).toBe(1) // the one phase row
    // The run's own row: the same row, top-aligned for its two lines (`cn` merges items-start over items-center).
    expect(classLists(html).filter(list => carries(list, ROW_BUTTON, ['items-center']) && list.includes('items-start')).length).toBe(1)
    expect(html).toContain('border-l-2 border-destructive bg-destructive-tint')
    expect(html).toContain(`class="${TURN.CHIP_DESTRUCTIVE}"`) // the budget-exceeded chip (2.6k spent of 100)
    expect(html.split('bg-sunken').length - 1).toBe(2) // logs + result
    // Resume and both keep scopes stay buttons, typed so a form can never submit them.
    expect((html.match(/<button[^>]*data-variant="ghost"[^>]*type="button"/g) ?? []).length).toBe(3)
  })

  it('the todo card: v0.15.1 TodoList glyphs (accent check, accent spinner, tertiary circle and ban), the done item struck', () => {
    expect(isTodoCardActivity(todoRun)).toBe(true)
    const html = render(<TodoListCard activity={todoRun} />)
    expect(html).toContain('lucide-circle-check size-3.5 text-accent')
    expect(html).toContain('lucide-circle size-3.5 text-tertiary')
    expect(html).toContain('lucide-ban size-3.5 text-tertiary')
    expect(html).toContain('spinner text-caption text-accent')
    expect(html).toContain('class="min-w-0 flex-1 truncate text-tertiary line-through">Map the renderer<')
    expect(html.split(`class="${TURN.CHIP_NEUTRAL}"`).length - 1).toBe(4)
  })

  it('the advisor card is a well whose header carries the moment and the model chip', () => {
    expect(isAdvisorCardActivity(advisorRun)).toBe(true)
    const html = render(<AdvisorConsultationCard activity={advisorRun} />)
    expect(html).toContain('data-advisor-card=""')
    expect(html).toContain('bg-sunken')
    expect(html).toContain(`class="${TURN.CHIP_NEUTRAL}"`)
    expect(html).toContain('claude-sonnet-4-5')
    expect(html).toContain('Put it in the transport.')
  })

  it('the F1.351 line is a status row whose body hangs under the hairline; the spawn chip a well with named buttons', () => {
    const line = render(<TaskNotificationLine content={DELIVERY} />)
    expect(line).toContain('<details')
    expect(line).toContain(`class="${TURN.WORK_LOG_BODY} mb-1"`)
    expect(line).toContain('Background subagent task t-1 finished (completed).')
    const chip = render(<DeferredSpawnChips proposals={[{ id: 'p1', name: 'Update the badge', prompt: 'Do it.' }]} onStart={() => {}} />)
    expect(chip).toContain('relative isolate overflow-hidden rounded-md border border-subtle bg-sunken')
    expect(chip).toMatch(/<button data-slot="button" data-variant="secondary"[^>]*type="button"/)
    expect(chip).toMatch(/<button data-slot="icon-button" type="button"[^>]*aria-label="[^"]+"/)
  })

  it('the artifact chip: the link is CHIP_NEUTRAL, copy the named transcript icon button; expired disables both', () => {
    const live = render(<PublishedArtifactChip activity={artifactRow('2099-01-01T00:00:00.000Z')} now={Date.parse('2026-10-16T00:00:00.000Z')} />)
    expect(classLists(live).some(list => list.startsWith(TURN.CHIP_NEUTRAL))).toBe(true)
    expect(live).toMatch(/<button type="button" data-slot="icon-button"[^>]*aria-label="[^"]+"/)
    const expired = render(<PublishedArtifactChip activity={artifactRow('2026-01-01T00:00:00.000Z')} now={Date.parse('2026-10-16T00:00:00.000Z')} />)
    expect(expired).toContain('data-artifact-chip="expired"')
    expect(expired.split('disabled=""').length - 1).toBe(2)
  })
})

describe('UB14.18 · CENSUS — no state keeps the pre-redesign classes', () => {
  it('none of the cards, in any state above, carries one', () => {
    const found = everyCardState().flatMap(([name, html]) => {
      expect({ name, drew: html.length > 0 }).toEqual({ name, drew: true })
      return legacyIn(html).map(hit => `${name}: ${hit}`)
    })
    expect(found).toEqual([])
  })

  it('CONTROL — the census finds a planted legacy class (the pre-UB14.18 card opening)', () => {
    const planted = '<div class="overflow-hidden rounded-[8px] border border-border/50 bg-background/80 shadow-minimal"></div>'
    expect(legacyIn(planted).length).toBeGreaterThanOrEqual(3)
  })
})

/**
 * ChatDisplay's `renderActivityCard`, mirrored on the SHIPPED predicates (the source guard in
 * `activity-slot-cards.test.tsx` pins that ChatDisplay returns exactly these four cards and keys the
 * workflow branch on this literal).
 */
function routeLikeChatDisplay({ activity, onOpenDetails }: ActivityRenderProps): React.ReactNode {
  if (isSubagentCardActivity(activity)) return <SubagentCard activity={activity} onOpenDetails={onOpenDetails} />
  if (activity.toolName?.toLowerCase() === 'workflow' && activity.orchestrationProgress?.kind === 'workflow') {
    return <WorkflowPanel activity={activity} onOpenDetails={onOpenDetails} />
  }
  if (isTodoCardActivity(activity)) return <TodoListCard activity={activity} />
  if (isAdvisorCardActivity(activity)) return <AdvisorConsultationCard activity={activity} />
  return null
}

const slot = (activity: ActivityItem) =>
  render(<ActivitySlot activity={activity} renderActivity={routeLikeChatDisplay} displayMode="detailed" onOpenDetails={() => {}} />)

describe('UB14.18 · NEGATIVE — a card that cannot render still yields the ordinary row', () => {
  const declined: [string, ActivityItem][] = [
    ['codex wait_agent, no progress (P3.24)', act({ toolName: 'wait_agent' })],
    ['workflow, no progress', act({ toolName: 'workflow' })],
    ['TodoWrite whose result is not JSON (P2.503)', act({ toolName: 'TodoWrite', status: 'error', content: 'Error: EACCES writing todo store' })],
    ['advisor refusal (P4.5)', act({ toolName: 'advisor_consult', content: 'No advisor model is available for this session. Continue on your own.' })],
  ]

  it.each(declined)('%s → the ordinary row, no card slot', (_why, activity) => {
    const html = slot(activity)
    expect(html).not.toContain('data-activity-card')
    expect(classLists(html).some(list => list.startsWith(TURN.WORK_LOG_ROW))).toBe(true)
  })

  it('CONTROL — a routed row is replaced by its card (Pi subagent, codex collab, workflow, todo, advisor)', () => {
    const routed: [ActivityItem, string][] = [
      [piSubagent, 'data-subagent-card'],
      [codexCollab, 'data-subagent-card'],
      [workflowRun, 'data-workflow-panel'],
      [todoRun, 'data-todo-card'],
      [advisorRun, 'data-advisor-card'],
    ]
    for (const [activity, marker] of routed) {
      const html = slot(activity)
      expect({ tool: activity.toolName, card: html.includes('data-activity-card="true"') && html.includes(marker) })
        .toEqual({ tool: activity.toolName, card: true })
    }
  })
})
