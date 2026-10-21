/**
 * P6.305 / denominator H12 — a running subagent says what it is doing, in one
 * line, from ONE source.
 *
 * Three things are pinned here, and each one is a way the surface was wrong or
 * could silently go wrong again:
 *
 * 1. The token no longer reaches the user raw. `WorkflowPanel` printed
 *    `tool_execution_start` at HEAD; `SubagentCard` printed nothing at all.
 * 2. Both cards read the SAME function, so one token cannot acquire two
 *    renderings. Asserted by rendering both and comparing the text.
 * 3. Every key the table can ask for exists in BOTH locales. The table and the
 *    locale files are separate artefacts and a key added to one is invisible
 *    until someone runs the app in the other language.
 */
import * as React from 'react'
import { beforeAll, describe, expect, it } from 'bun:test'
import { createInstance, type i18n as I18nInstance } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ActivityItem } from '@nessy-agent/ui/chat/TurnCard'
import en from '@nessy-agent/shared/i18n/locales/en.json'
import ru from '@nessy-agent/shared/i18n/locales/ru.json'
import {
  ORCHESTRATION_ACTIVITY_KEYS,
  orchestrationActivityLabel,
  orchestrationActivityTitle,
} from '../orchestration-activity'
import { SubagentCard } from '../SubagentCard'
import { WorkflowPanel } from '../WorkflowPanel'

const locales: Record<string, Record<string, string>> = {
  en: en as Record<string, string>,
  ru: ru as Record<string, string>,
}

let testI18n: I18nInstance

beforeAll(async () => {
  testI18n = createInstance()
  await testI18n
    .use(initReactI18next)
    .init({
      lng: 'en',
      fallbackLng: 'en',
      resources: { en: { translation: locales.en! } },
      interpolation: { escapeValue: false },
    })
})

const t = ((key: string) => locales.en![key] ?? key) as (key: string) => string

function progressAgent(lastActivity: string | undefined) {
  return {
    id: 'agent-1',
    label: 'Scout',
    agentType: 'scout',
    status: 'running' as const,
    tokensIn: 100,
    tokensOut: 20,
    startedAt: '2026-09-06T10:00:00.000Z',
    ...(lastActivity === undefined ? {} : { lastActivity }),
  }
}

function activityFor(kind: 'subagent' | 'workflow', lastActivity: string | undefined): ActivityItem {
  return {
    id: 'activity-1',
    type: 'tool',
    status: 'running',
    toolName: kind,
    timestamp: 1700000000000,
    content: '',
    orchestrationProgress: {
      kind,
      runId: 'run-1',
      ...(kind === 'workflow' ? { phases: [{ title: 'Discover' }] } : {}),
      agents: [{ ...progressAgent(lastActivity), ...(kind === 'workflow' ? { phase: 'Discover' } : {}) }],
    },
  } as ActivityItem
}

function render(node: React.ReactElement): string {
  return renderToStaticMarkup(
    React.createElement(I18nextProvider, { i18n: testI18n }, node),
  )
}

describe('P6.305 · orchestrationActivityLabel', () => {
  it('turns each stateable token into a sentence, not a machine name', () => {
    expect(orchestrationActivityLabel('tool_execution_start', t)).toBe('Running a tool')
    expect(orchestrationActivityLabel('tool_execution_end', t)).toBe('Finished a tool')
    expect(orchestrationActivityLabel('message_update', t)).toBe('Writing a reply')
    expect(orchestrationActivityLabel('journal-replay', t)).toBe('Replayed from the journal')
    expect(orchestrationActivityLabel('compaction_start', t)).toBe('Compacting context')
    // No token's sentence is ever the raw token, which is the whole defect.
    for (const token of ['tool_execution_start', 'message_update', 'auto_retry_start']) {
      expect(orchestrationActivityLabel(token, t)).not.toBe(token)
    }
  })

  it('says nothing when the token would only echo the status the row already shows', () => {
    // `Running · Running` and `Done · Done` are what naive rendering produces;
    // an empty slot is the honest answer and is what these cards showed before.
    for (const echo of ['queued', 'started', 'agent_start', 'running', 'done', 'error', 'aborted']) {
      expect(orchestrationActivityLabel(echo, t)).toBeUndefined()
    }
    // Absent and blank are the same nothing, and never an empty string.
    expect(orchestrationActivityLabel(undefined, t)).toBeUndefined()
    expect(orchestrationActivityLabel('   ', t)).toBeUndefined()
  })

  it('softens an unknown token instead of inventing a meaning for it', () => {
    // The token space is OPEN - Pi's event union grows with the vendored
    // package - so a member this table has never seen must stay legible and
    // stay ITSELF.
    expect(orchestrationActivityLabel('some_future_event', t)).toBe('some future event')
    expect(orchestrationActivityLabel('thinking_level_changed', t)).toBe('thinking level changed')
  })

  it('keeps the raw token reachable on the hover text', () => {
    const title = orchestrationActivityTitle('tool_execution_start', (key, options) =>
      locales.en![key]!.replace('{{raw}}', options.raw))
    expect(title).toBe('Last activity: tool_execution_start')
    expect(orchestrationActivityTitle(undefined, () => 'unused')).toBeUndefined()
  })

  it('every key the table can ask for exists in both locales', () => {
    const keys = [...ORCHESTRATION_ACTIVITY_KEYS, 'turnCard.orchestration.activity.title']
    expect(keys.length).toBeGreaterThan(0)
    for (const key of keys) {
      for (const [lng, table] of Object.entries(locales)) {
        expect({ lng, key, present: typeof table[key] === 'string' && table[key]!.length > 0 })
          .toEqual({ lng, key, present: true })
      }
    }
  })
})

describe('P6.305 · both cards render the one reading', () => {
  it('the subagent card now says what the agent is doing', () => {
    // At HEAD this card dropped `lastActivity` entirely: a spinner and a clock.
    const markup = render(React.createElement(SubagentCard, {
      activity: activityFor('subagent', 'tool_execution_start'),
      defaultExpanded: true,
    }))
    expect(markup).toContain('Running a tool')
    expect(markup).toContain('Last activity: tool_execution_start')
    expect(markup).not.toContain('>tool_execution_start<')
  })

  it('the workflow panel stopped printing the machine token', () => {
    const markup = render(React.createElement(WorkflowPanel, {
      activity: activityFor('workflow', 'tool_execution_start'),
      defaultExpanded: true,
    }))
    expect(markup).toContain('Running a tool')
    expect(markup).not.toContain('>tool_execution_start<')
  })

  it('one token, one rendering, on both cards', () => {
    for (const token of ['message_update', 'auto_retry_end', 'some_future_event']) {
      const label = orchestrationActivityLabel(token, t)!
      expect(render(React.createElement(SubagentCard, {
        activity: activityFor('subagent', token), defaultExpanded: true,
      }))).toContain(label)
      expect(render(React.createElement(WorkflowPanel, {
        activity: activityFor('workflow', token), defaultExpanded: true,
      }))).toContain(label)
    }
  })
})
