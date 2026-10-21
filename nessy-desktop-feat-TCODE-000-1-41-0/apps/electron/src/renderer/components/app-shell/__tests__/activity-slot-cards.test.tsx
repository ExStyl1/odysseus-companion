/**
 * P2.503 — EVERY CARD IN THE `renderActivity` SLOT, AND THE ONE INVARIANT THEY
 * ALL HAVE TO HOLD.
 *
 * THE TRAP. `TurnCard` writes the slot as
 * `renderActivity?.(props) ?? <ActivityRow …>`. A card returned by
 * `ChatDisplay.renderActivityCard` is a React ELEMENT, which is never nullish,
 * so that `??` fallback CANNOT FIRE once a card has been chosen. A card that
 * then renders `null` does not yield the row back to `ActivityRow` — it
 * REMOVES THE ROW FROM THE TRANSCRIPT. The user sees no evidence the tool ran.
 *
 * WHY THIS FILE EXISTS AT ALL. The trap has now been hit three times in this
 * one slot: P3.24 measured it on `SubagentCard` and wrote it down;
 * `AdvisorConsultationCard`'s first draft repeated it anyway (P4.5, corrected
 * mid-flight); and it was LIVE in `TodoListCard`, whose router asked the tool
 * NAME while the card asked whether any todos could be recovered. Each of the
 * three was fixed in its own module, and nothing anywhere enumerated the cards
 * — so the fourth card to join the slot would have had nothing to fail against.
 *
 * THE INVARIANT, stated once for all of them: **for every card reachable
 * through the slot, the router's predicate must be TRUE exactly when the card
 * draws something.** Not "roughly when" — a router that is broader than its
 * card deletes rows, and a router that is narrower than its card silently drops
 * a working card down to the plain row.
 *
 * TWO INSTRUMENTS, because one cannot see what the other can:
 *
 *  1. A SOURCE guard on `ChatDisplay.renderActivityCard`, which enumerates the
 *     cards actually returned there. It reddens when a fifth card joins the
 *     slot, which is the moment this invariant needs to be read. It is a source
 *     assertion for the reason `codex-collab-tool-routing.test.ts` gives:
 *     `ChatDisplay` is 3000 lines and cannot be imported in a shared bun test
 *     process (`background-task-chip.test.tsx` measures why).
 *  2. A VALUE check per card: drive the real predicate and render the real
 *     card over the same activity, and assert they agree. This is the one that
 *     would have caught the live todo defect, and it does — see the
 *     `unparseable` and `input-less` cases below.
 */
import * as React from 'react'
import { beforeAll, describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInstance, type i18n as I18nInstance } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ActivityItem } from '@nessy-agent/ui/chat/TurnCard'
import { SubagentCard } from '../SubagentCard'
import { WorkflowPanel } from '../WorkflowPanel'
import { TodoListCard } from '../TodoListCard'
import { AdvisorConsultationCard } from '../AdvisorConsultationCard'
import { isSubagentCardActivity } from '../activity-card-routing'
import { isTodoCardActivity } from '../TodoListCard'
import { isAdvisorCardActivity } from '../advisor-consultation'

const CHAT_DISPLAY = join(import.meta.dir, '..', 'ChatDisplay.tsx')

/**
 * The cards `renderActivityCard` can return. Kept as a literal so that adding a
 * fifth is a deliberate edit to this list, made while reading the invariant
 * above — which is the whole point of writing it down.
 */
const SLOT_CARDS = [
  'SubagentCard',
  'WorkflowPanel',
  'TodoListCard',
  'AdvisorConsultationCard',
] as const

let testI18n: I18nInstance

beforeAll(async () => {
  testI18n = createInstance()
  // No resources on purpose: `t` echoes the key, which is all these assertions
  // need. They ask WHETHER the card drew, never what it said — the four
  // per-card suites already pin the copy.
  await testI18n
    .use(initReactI18next)
    .init({ lng: 'en', fallbackLng: 'en', resources: { en: { translation: {} } }, interpolation: { escapeValue: false } })
})

function draws(node: React.ReactElement): boolean {
  return renderToStaticMarkup(
    <I18nextProvider i18n={testI18n}>{node}</I18nextProvider>
  ).length > 0
}

const now = 1_700_000_000_000

function base(over: Partial<ActivityItem>): ActivityItem {
  return {
    id: 'slot-activity',
    type: 'tool',
    status: 'completed',
    timestamp: now,
    ...over,
  } as ActivityItem
}

function subagentProgress(kind: 'subagent' | 'workflow') {
  return {
    kind,
    runId: 'run-1',
    agents: [
      {
        id: 'agent-1',
        label: 'Reviewer',
        agentType: 'reviewer',
        status: 'done' as const,
        tokensIn: 100,
        tokensOut: 20,
      },
    ],
  }
}

/**
 * One entry per card in the slot: the router predicate, the card, and the rows
 * that must route and must not. `mustNotRoute` is where the defects live — each
 * of those rows is one the CARD renders nothing for, so a router that accepted
 * it would delete the row.
 */
const CARDS: {
  name: (typeof SLOT_CARDS)[number]
  routes: (activity: ActivityItem) => boolean
  render: (activity: ActivityItem) => React.ReactElement
  mustRoute: { why: string; activity: ActivityItem }[]
  mustNotRoute: { why: string; activity: ActivityItem }[]
}[] = [
  {
    name: 'SubagentCard',
    routes: isSubagentCardActivity,
    render: activity => <SubagentCard activity={activity} />,
    mustRoute: [
      {
        why: 'a Pi subagent row carrying subagent progress',
        activity: base({ toolName: 'subagent', orchestrationProgress: subagentProgress('subagent') }),
      },
      {
        why: 'a codex spawn_agent row carrying subagent progress',
        activity: base({ toolName: 'spawn_agent', orchestrationProgress: subagentProgress('subagent') }),
      },
    ],
    mustNotRoute: [
      {
        // P3.24's finding: only the ANCHOR row of a run carries progress.
        why: 'a collab row with no progress — the card renders null for it',
        activity: base({ toolName: 'wait_agent' }),
      },
      {
        why: 'a collab row carrying the OTHER kind of progress',
        activity: base({ toolName: 'spawn_agent', orchestrationProgress: subagentProgress('workflow') }),
      },
    ],
  },
  {
    name: 'WorkflowPanel',
    // The routing for this one is still inline in `ChatDisplay`; the source
    // guard below pins the literal so this mirror cannot drift silently.
    routes: activity =>
      activity.toolName?.toLowerCase() === 'workflow'
      && activity.orchestrationProgress?.kind === 'workflow',
    render: activity => <WorkflowPanel activity={activity} />,
    mustRoute: [
      {
        why: 'a workflow row carrying workflow progress',
        activity: base({ toolName: 'workflow', orchestrationProgress: subagentProgress('workflow') }),
      },
    ],
    mustNotRoute: [
      {
        why: 'a workflow row with no progress — the panel renders null for it',
        activity: base({ toolName: 'workflow' }),
      },
      {
        why: 'a workflow row carrying subagent-kind progress',
        activity: base({ toolName: 'workflow', orchestrationProgress: subagentProgress('subagent') }),
      },
    ],
  },
  {
    name: 'TodoListCard',
    routes: isTodoCardActivity,
    render: activity => <TodoListCard activity={activity} />,
    mustRoute: [
      {
        why: 'todos on the tool input',
        activity: base({
          toolName: 'TodoWrite',
          toolInput: { todos: [{ id: '1', content: 'Ship the fix', status: 'pending' }] },
        }),
      },
      {
        why: 'todos recovered from the persisted JSON result',
        activity: base({
          toolName: 'mcp__session__TodoWrite',
          content: JSON.stringify({ todos: [{ id: '1', content: 'Read it back', status: 'completed' }] }),
        }),
      },
    ],
    mustNotRoute: [
      {
        // THE SHIPPED DEFECT. Routed on the name, this reached the card, the
        // card rendered `null`, and the row disappeared.
        why: 'a TodoWrite row whose result is not JSON at all',
        activity: base({ toolName: 'TodoWrite', status: 'error', content: 'Error: EACCES writing todo store' }),
      },
      {
        why: 'a TodoWrite row still in flight, before its input was parsed',
        activity: base({ toolName: 'TodoWrite', status: 'running' }),
      },
      {
        why: 'a TodoWrite row whose JSON result carries no todos array',
        activity: base({ toolName: 'TodoWrite', content: JSON.stringify({ ok: true }) }),
      },
      {
        why: 'a TodoWrite row whose todos are all malformed',
        activity: base({ toolName: 'TodoWrite', toolInput: { todos: [{ content: '', status: 'nope' }] } }),
      },
    ],
  },
  {
    name: 'AdvisorConsultationCard',
    routes: isAdvisorCardActivity,
    render: activity => <AdvisorConsultationCard activity={activity} />,
    mustRoute: [
      {
        why: 'a completed consult whose reply is guidance in the host’s shape',
        activity: base({
          toolName: 'advisor_consult',
          toolInput: { moment: 'approach', question: 'Transport or caller?' },
          content: 'Advisor (claude-sonnet-4-5):\n\nPut it in the transport.',
        }),
      },
    ],
    mustNotRoute: [
      {
        why: 'a refusal sentence, which is not guidance',
        activity: base({
          toolName: 'advisor_consult',
          content: 'No advisor model is available for this session. Continue on your own.',
        }),
      },
      {
        why: 'a consult still running',
        activity: base({ toolName: 'advisor_consult', status: 'running' }),
      },
    ],
  },
]

describe('P2.503 · the renderActivity slot enumerates its cards', () => {
  it('returns exactly the cards this file knows the invariant for', () => {
    const source = readFileSync(CHAT_DISPLAY, 'utf8')
    const body = source.slice(source.indexOf('const renderActivityCard = useCallback('))
    const end = body.indexOf('\n  // Pop-out handler')
    expect(end).toBeGreaterThan(0)
    const routerSource = body.slice(0, end)

    // Every capitalised JSX tag the router can return.
    const returned = [...new Set(
      [...routerSource.matchAll(/<([A-Z][A-Za-z0-9]*)\b/g)].map(match => match[1]!)
    )].sort()

    expect(returned).toEqual([...SLOT_CARDS].sort())
  })

  it('still keys the workflow branch on the literal this file mirrors', () => {
    const source = readFileSync(CHAT_DISPLAY, 'utf8')
    expect(source).toContain("toolName === 'workflow' && activity.orchestrationProgress?.kind === 'workflow'")
  })

  it('no longer routes the todo card on the tool name alone', () => {
    const source = readFileSync(CHAT_DISPLAY, 'utf8')
    // The shipped defect, verbatim. Its absence is the point.
    expect(source).not.toContain('isTodoWriteActivity(activity)')
    expect(source).toContain('isTodoCardActivity(activity)')
  })
})

describe.each(CARDS)('P2.503 · $name routes exactly when it draws', card => {
  it('draws for every row its predicate accepts', () => {
    expect(card.mustRoute.length).toBeGreaterThan(0)
    for (const { why, activity } of card.mustRoute) {
      expect(`${why}: routes`).toBe(card.routes(activity) ? `${why}: routes` : `${why}: DID NOT ROUTE`)
      expect(`${why}: draws`).toBe(draws(card.render(activity)) ? `${why}: draws` : `${why}: DREW NOTHING`)
    }
  })

  it('is not routed for any row it would render nothing for', () => {
    expect(card.mustNotRoute.length).toBeGreaterThan(0)
    for (const { why, activity } of card.mustNotRoute) {
      // The control half: prove the card really does render nothing here, so
      // that "not routed" is protecting a row rather than describing a case
      // the card would have handled fine.
      expect(`${why}: card draws nothing`).toBe(
        draws(card.render(activity)) ? `${why}: CARD DREW` : `${why}: card draws nothing`
      )
      // The defect half: a router that accepted this row would DELETE it.
      expect(`${why}: not routed`).toBe(
        card.routes(activity) ? `${why}: ROUTED — the row would vanish` : `${why}: not routed`
      )
    }
  })
})
