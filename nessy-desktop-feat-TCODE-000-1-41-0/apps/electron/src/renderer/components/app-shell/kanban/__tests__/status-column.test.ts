/**
 * UA2.4 — a status's default board column (v0.13.4 `kanban/status-column.ts`): the
 * placement a tile takes when it has no persisted `kanbanColumn`.
 */
import { describe, expect, it } from 'bun:test'
import { KANBAN_COLUMNS, statusToColumn } from '../status-column'

describe('UA2.4 — statusToColumn', () => {
  it('POSITIVE — needs-review sits in the In Progress column beside in-progress', () => {
    expect(statusToColumn('needs-review')).toBe('in-progress')
    expect(statusToColumn('in-progress')).toBe('in-progress')
  })

  it('POSITIVE — the closed statuses go to Done, todo to ToDo', () => {
    expect(statusToColumn('done')).toBe('done')
    expect(statusToColumn('cancelled')).toBe('done')
    expect(statusToColumn('todo')).toBe('todo')
  })

  it('NEGATIVE — an unknown or empty status falls back to ToDo', () => {
    expect(statusToColumn('backlog')).toBe('todo')
    expect(statusToColumn('my-custom-status')).toBe('todo')
    expect(statusToColumn('')).toBe('todo')
  })

  it('the built-in columns are ToDo → In Progress → Done, each with its i18n key', () => {
    expect(KANBAN_COLUMNS.map(c => [c.id, c.labelKey])).toEqual([
      ['todo', 'kanban.column.todo'],
      ['in-progress', 'kanban.column.inProgress'],
      ['done', 'kanban.column.done'],
    ])
  })
})
