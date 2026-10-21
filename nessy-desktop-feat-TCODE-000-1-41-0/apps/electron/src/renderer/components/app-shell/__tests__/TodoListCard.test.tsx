import * as React from 'react'
import { beforeAll, describe, expect, it } from 'bun:test'
import { createInstance, type i18n as I18nInstance } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ActivityItem } from '@nessy-agent/ui/chat/TurnCard'
import { getTodoListItems, isTodoCardActivity, isTodoWriteActivity, TodoListCard } from '../TodoListCard'

const translations = {
  'turnCard.todo.status.completed': 'Done',
  'turnCard.todo.status.inProgress': 'In progress',
  'turnCard.todo.status.interrupted': 'Interrupted',
  'turnCard.todo.status.pending': 'Pending',
  'turnCard.todo.summary': '{{completed}}/{{count}} done',
  'turnCard.todo.title': 'Todo list',
}

let testI18n: I18nInstance

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

function createTodoActivity(overrides: Partial<ActivityItem> = {}): ActivityItem {
  return {
    id: 'activity-1',
    type: 'tool',
    status: 'completed',
    toolName: 'TodoWrite',
    timestamp: 1700000000000,
    toolInput: {
      todos: [
        { id: 'todo-1', content: 'Map existing renderer', status: 'completed' },
        { id: 'todo-2', content: 'Wire todo card', status: 'in_progress', activeForm: 'Wiring todo card' },
        { id: 'todo-3', content: 'Run gates', status: 'pending' },
        { id: 'todo-4', content: 'Stopped item', status: 'interrupted' },
      ],
    },
    ...overrides,
  }
}

function renderTodoListCard(activity: ActivityItem): string {
  return renderToStaticMarkup(
    <I18nextProvider i18n={testI18n}>
      <TodoListCard activity={activity} />
    </I18nextProvider>
  )
}

describe('TodoListCard', () => {
  it('renders todo states from TodoWrite input', () => {
    const html = renderTodoListCard(createTodoActivity())

    expect(html).toContain('Todo list')
    expect(html).toContain('1/4 done')
    expect(html).toContain('Map existing renderer')
    expect(html).toContain('Wiring todo card')
    expect(html).toContain('Run gates')
    expect(html).toContain('Stopped item')
    expect(html).toContain('Done')
    expect(html).toContain('In progress')
    expect(html).toContain('Pending')
    expect(html).toContain('Interrupted')
  })

  it('reads todos from persisted TodoWrite JSON result when input is absent', () => {
    const activity = createTodoActivity({
      toolInput: undefined,
      content: JSON.stringify({
        todos: [
          { id: 'todo-result-1', content: 'Read result JSON', status: 'completed' },
        ],
      }),
    })

    expect(getTodoListItems(activity)).toEqual([
      { id: 'todo-result-1', content: 'Read result JSON', status: 'completed', activeForm: undefined },
    ])
    expect(renderTodoListCard(activity)).toContain('Read result JSON')
  })

  it('matches direct and MCP-shaped TodoWrite tool names', () => {
    expect(isTodoWriteActivity(createTodoActivity({ toolName: 'TodoWrite' }))).toBe(true)
    expect(isTodoWriteActivity(createTodoActivity({ toolName: 'mcp__session__TodoWrite' }))).toBe(true)
    expect(isTodoWriteActivity(createTodoActivity({ toolName: 'Read' }))).toBe(false)
  })
})

/**
 * P2.503 — the router and the card have to answer the SAME question.
 *
 * `ChatDisplay` used to route this card on {@link isTodoWriteActivity}, the tool
 * NAME, while the card itself declines to draw whenever no todos survive
 * {@link getTodoListItems}. The two disagree for every TodoWrite row whose todos
 * cannot be recovered — and the gap is not cosmetic, because a card in the
 * `renderActivity` slot cannot yield a row back: `TurnCard`'s
 * `renderActivity?.(props) ?? <ActivityRow …>` sees an ELEMENT, never a nullish
 * value, so the row was DELETED rather than drawn plainly.
 *
 * `activity-slot-cards.test.tsx` holds this invariant for all four cards in the
 * slot; these two live here because they are this card's own contract.
 */
describe('P2.503 · isTodoCardActivity', () => {
  it('separates a TodoWrite row from a DRAWABLE TodoWrite row', () => {
    const unparseable = createTodoActivity({
      status: 'error',
      toolInput: undefined,
      content: 'Error: EACCES writing the todo store',
    })

    // Both predicates agree it is a TodoWrite call...
    expect(isTodoWriteActivity(unparseable)).toBe(true)
    // ...and only the routing predicate knows the card will draw nothing.
    expect(isTodoCardActivity(unparseable)).toBe(false)
    expect(renderTodoListCard(unparseable)).toBe('')
  })

  it('routes exactly the rows the card draws', () => {
    for (const activity of [
      createTodoActivity(),
      createTodoActivity({
        toolInput: undefined,
        content: JSON.stringify({ todos: [{ id: 'a', content: 'Read it back', status: 'pending' }] }),
      }),
    ]) {
      expect(isTodoCardActivity(activity)).toBe(true)
      expect(renderTodoListCard(activity)).not.toBe('')
    }

    for (const activity of [
      createTodoActivity({ status: 'running', toolInput: undefined }),
      createTodoActivity({ toolInput: undefined, content: JSON.stringify({ ok: true }) }),
      createTodoActivity({ toolInput: { todos: [] } }),
      createTodoActivity({ toolInput: { todos: [{ content: '', status: 'nope' }] } }),
      createTodoActivity({ toolName: 'Read' }),
    ]) {
      expect(isTodoCardActivity(activity)).toBe(false)
    }
  })
})
