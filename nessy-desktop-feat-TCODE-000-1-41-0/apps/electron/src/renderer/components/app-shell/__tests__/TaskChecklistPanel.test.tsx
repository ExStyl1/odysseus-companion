/**
 * R20 Task 5 — the rendered checklist surface.
 *
 * `interactive-mode.md:36` — this is the checklist toggle, and it "is not the
 * background-task view; use `/tasks` to see running shells and subagents". The
 * display "shows up to five tasks at a time" and the toggle is a visible no-op
 * on an empty list.
 */
import * as React from 'react'
import { beforeAll, describe, expect, test } from 'bun:test'
import { createInstance, type i18n as I18nInstance } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ActivityItem } from '@nessy-agent/ui/chat/TurnCard'
import { TaskChecklistPanel, TASK_CHECKLIST_VISIBLE_LIMIT } from '../TaskChecklistPanel'

// The real English values, so a missing key shows up as a failure here.
const translations = {
  'taskChecklist.title': 'Tasks',
  'taskChecklist.progress': '{{completed}}/{{total}}',
  'taskChecklist.more': '+{{count}} more',
}

let testI18n: I18nInstance

beforeAll(async () => {
  testI18n = createInstance()
  await testI18n.use(initReactI18next).init({
    lng: 'en',
    fallbackLng: 'en',
    resources: { en: { translation: translations } },
    interpolation: { escapeValue: false },
  })
})

let sequence = 0

function activity(over: Partial<ActivityItem>): ActivityItem {
  return { id: `a-${++sequence}`, type: 'tool', status: 'completed', timestamp: ++sequence, ...over }
}

function create(subject: string, id: string, activeForm?: string): ActivityItem {
  return activity({
    toolName: 'mcp__session__TaskCreate',
    toolInput: { subject, description: 'd', ...(activeForm ? { activeForm } : {}) },
    content: JSON.stringify({ task: { id, subject } }),
  })
}

function update(input: Record<string, unknown>): ActivityItem {
  return activity({ toolName: 'mcp__session__TaskUpdate', toolInput: input })
}

function render(activities: ActivityItem[], open = true): string {
  return renderToStaticMarkup(
    <I18nextProvider i18n={testI18n}>
      <TaskChecklistPanel activities={activities} open={open} />
    </I18nextProvider>,
  )
}

describe('TaskChecklistPanel', () => {
  test('renders the checklist with statuses from a task-tool transcript', () => {
    const html = render([
      create('Read the contract source', 'task-001'),
      create('Wire the store', 'task-002'),
      update({ taskId: 'task-001', status: 'completed' }),
      update({ taskId: 'task-002', status: 'in_progress' }),
    ])

    expect(html).toContain('Read the contract source')
    expect(html).toContain('Wire the store')
    expect(html).toContain('data-status="completed"')
    expect(html).toContain('data-status="in_progress"')
    expect(html).toContain('1/2')
  })

  test('shows the active form for an in-progress item, and the plain subject otherwise', () => {
    const html = render([
      create('Run the tests', 'task-001', 'Running the tests'),
      create('Ship it', 'task-002', 'Shipping it'),
      update({ taskId: 'task-001', status: 'in_progress' }),
    ])

    expect(html).toContain('Running the tests')
    expect(html).not.toContain('>Run the tests<')
    // task-002 is still pending, so its subject shows rather than its active form.
    expect(html).toContain('Ship it')
    expect(html).not.toContain('Shipping it')
  })

  test('a legacy TodoWrite transcript still renders', () => {
    const html = render([
      activity({
        toolName: 'TodoWrite',
        toolInput: {
          todos: [
            { content: 'Legacy first', status: 'completed' },
            { content: 'Legacy second', status: 'in_progress', activeForm: 'Doing legacy second' },
          ],
        },
      }),
    ])

    expect(html).toContain('Legacy first')
    expect(html).toContain('Doing legacy second')
  })

  test('caps the display at five items and reports the overflow', () => {
    const activities = Array.from({ length: 8 }, (_, index) =>
      create(`Task number ${index + 1}`, `task-00${index + 1}`))
    const html = render(activities)

    expect(TASK_CHECKLIST_VISIBLE_LIMIT).toBe(5)
    expect(html).toContain('Task number 5')
    expect(html).not.toContain('Task number 6')
    expect(html).toContain('3')
  })

  test('an empty list is a visible no-op, not an empty frame', () => {
    expect(render([])).toBe('')
    expect(render([activity({ toolName: 'Read' })])).toBe('')
  })

  test('closed renders nothing even with items', () => {
    expect(render([create('Something', 'task-001')], false)).toBe('')
  })

  test('background tasks are not checklist items — /tasks stays a separate view', () => {
    // `interactive-mode.md:36`: "This is not the background-task view; use
    // `/tasks` to see running shells and subagents."
    const html = render([
      activity({ toolName: 'Task', toolInput: { description: 'a subagent' }, isBackground: true, taskId: 'bg-1' }),
      activity({ toolName: 'TaskOutput', toolInput: { taskId: 'bg-1' } }),
      activity({ toolName: 'Agent', toolInput: { description: 'a subagent' } }),
    ])
    expect(html).toBe('')
  })
})
