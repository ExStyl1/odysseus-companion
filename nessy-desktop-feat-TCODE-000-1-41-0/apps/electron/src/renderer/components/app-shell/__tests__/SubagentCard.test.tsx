import * as React from 'react'
import { afterEach, beforeAll, describe, expect, it } from 'bun:test'
import { createInstance, type i18n as I18nInstance } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ActivityItem } from '@nessy-agent/ui/chat/TurnCard'
import { SubagentCard } from '../SubagentCard'

const translations = {
  'turnCard.subagent.backgrounded': 'background',
  'turnCard.subagent.nested': 'depth {{depth}}',
  'turnCard.subagent.openDetails': 'Open subagent result',
  'turnCard.subagent.result': 'Result',
  'turnCard.subagent.status.aborted': 'Aborted',
  'turnCard.subagent.status.done': 'Done',
  'turnCard.subagent.status.error': 'Error',
  'turnCard.subagent.status.queued': 'Queued',
  'turnCard.subagent.status.running': 'Running',
  'turnCard.subagent.summary_one': '{{count}} agent · {{tokensIn}} in / {{tokensOut}} out',
  'turnCard.subagent.summary_other': '{{count}} agents · {{tokensIn}} in / {{tokensOut}} out',
  'turnCard.subagent.title': 'Subagents',
  'turnCard.subagent.toggle': 'Toggle subagent details',
  'turnCard.subagent.tokens': '{{input}} in / {{output}} out',
}

let testI18n: I18nInstance
const realDateNow = Date.now

function setNow(iso: string) {
  Date.now = () => new Date(iso).getTime()
}

beforeAll(async () => {
  testI18n = createInstance()
  await testI18n
    .use(initReactI18next)
    .init({
      lng: 'en',
      fallbackLng: 'en',
      resources: { en: { translation: translations } },
      interpolation: { escapeValue: false },
    })
})

afterEach(() => {
  Date.now = realDateNow
})

function createSubagentActivity(overrides: Partial<ActivityItem> = {}): ActivityItem {
  return {
    id: 'activity-1',
    type: 'tool',
    status: 'completed',
    toolName: 'subagent',
    timestamp: 1700000000000,
    content: 'Scout found two files.\nReviewer approved the patch.',
    orchestrationProgress: {
      kind: 'subagent',
      runId: 'subagent-run-1',
      agents: [
        {
          id: 'subagent-run-1-1',
          label: 'Scout',
          agentType: 'scout',
          status: 'done',
          tokensIn: 10,
          tokensOut: 2,
        },
        {
          id: 'subagent-run-1-2',
          label: 'Reviewer',
          agentType: 'reviewer',
          status: 'running',
          tokensIn: 11,
          tokensOut: 4,
          phase: 'review',
          startedAt: '2026-07-06T12:00:00.000Z',
        },
      ],
    },
    ...overrides,
  }
}

function renderSubagentCard(activity: ActivityItem, defaultExpanded = false): string {
  return renderToStaticMarkup(
    <I18nextProvider i18n={testI18n}>
      <SubagentCard activity={activity} defaultExpanded={defaultExpanded} />
    </I18nextProvider>
  )
}

describe('SubagentCard', () => {
  it('renders collapsed summary for subagent progress', () => {
    const html = renderSubagentCard(createSubagentActivity())

    expect(html).toContain('Subagents')
    expect(html).toContain('2 agents')
    expect(html).toContain('21 in / 6 out')
    expect(html).not.toContain('Scout found two files')
  })

  it('I2.9 — draws the nesting chips only where the runtime stated them', () => {
    // Three states, not two, and the card must separate all three: background
    // (drawn), foreground (NOT drawn — a turn blocking on its child is what a
    // reader already assumes, so a chip would be noise), and never-reported
    // (also not drawn, which is Pi and codex permanently).
    const html = renderSubagentCard(createSubagentActivity({
      orchestrationProgress: {
        kind: 'subagent',
        runId: 'run',
        agents: [
          { id: 'a', label: 'Deep', agentType: 'x', status: 'running', isBackgrounded: true, spawnDepth: 3 },
          { id: 'b', label: 'Fore', agentType: 'x', status: 'running', isBackgrounded: false, spawnDepth: 1 },
          { id: 'c', label: 'Silent', agentType: 'x', status: 'running' },
        ],
      },
    }), true)

    // `>background<` and not the bare word: the card's own containers carry
    // `bg-background` classes, so a substring search finds six matches on a
    // render with no chip at all. The first draft of this line asserted over
    // those and read 6 where the chip count is 1.
    const CHIP = '>background<'
    expect(html).toContain(CHIP)
    expect(html).toContain('>depth 3<')
    // Depth 1 is the SDK's own "top-level spawn" — the default shape, so it
    // says nothing. `depth 1` appearing would mean the >1 guard was dropped.
    expect(html).not.toContain('>depth 1<')
    // ONE chip across three rows: the foreground row and the silent row draw
    // none, which is what makes the first assertion a reading rather than a
    // string that happens to be present.
    expect(html.split(CHIP).length - 1).toBe(1)
  })

  it('renders expanded agent rows and final result text', () => {
    setNow('2026-07-06T12:01:05.000Z')
    const html = renderSubagentCard(createSubagentActivity(), true)

    expect(html).toContain('Scout')
    expect(html).toContain('scout')
    expect(html).toContain('Reviewer')
    expect(html).toContain('reviewer')
    expect(html).toContain('Running')
    expect(html).toContain('1m 5s')
    expect(html).toContain('10 in / 2 out')
    expect(html).toContain('Result')
    expect(html).toContain('Scout found two files.')
  })

  it('updates elapsed time from agent start time on rerender', () => {
    setNow('2026-07-06T12:00:05.000Z')
    const firstHtml = renderSubagentCard(createSubagentActivity(), true)
    expect(firstHtml).toContain('5s')

    setNow('2026-07-06T12:02:00.000Z')
    const nextHtml = renderSubagentCard(createSubagentActivity(), true)
    expect(nextHtml).toContain('2m')
  })
})
