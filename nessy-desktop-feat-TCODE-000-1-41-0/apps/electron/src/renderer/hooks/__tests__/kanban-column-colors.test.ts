/**
 * UA2.3 — the board's column colours and the per-column "status on move" map:
 * a stored override wins, a corrupt stored value falls back, and an absent or
 * stale drop status is never applied.
 *
 * No DOM in `bun test` here, so the hook is driven through the pure merge it
 * memoises (`resolveKanbanColumnColors`) and the storage path through a jotai
 * store over a stub `window.localStorage` (installed for this file, restored
 * after it).
 */
import { afterAll, beforeEach, describe, expect, it } from 'bun:test'
import { createStore } from 'jotai'
import {
  kanbanColumnColorsAtom,
  kanbanColumnStatusAtom,
  readColumnMap,
  resolveDropStatus,
  withColumnDropStatus,
} from '@/atoms/kanban'
import { resolveKanbanColumnColors } from '../useKanbanColumnColors'
import { DEFAULT_KANBAN_COLUMN_COLORS } from '@/components/app-shell/kanban/kanban-colors'

const memory = new Map<string, string>()
const hadWindow = 'window' in globalThis
const previousWindow = (globalThis as { window?: unknown }).window
;(globalThis as { window?: unknown }).window = {
  localStorage: {
    getItem: (key: string) => memory.get(key) ?? null,
    setItem: (key: string, value: string) => void memory.set(key, value),
    removeItem: (key: string) => void memory.delete(key),
    clear: () => memory.clear(),
    key: (index: number) => [...memory.keys()][index] ?? null,
    get length() {
      return memory.size
    },
  },
}
afterAll(() => {
  if (hadWindow) (globalThis as { window?: unknown }).window = previousWindow
  else delete (globalThis as { window?: unknown }).window
})
beforeEach(() => memory.clear())

/** Read an atomWithStorage the way a mounted component does (onMount reads storage). */
function readMounted<T>(atom: Parameters<ReturnType<typeof createStore>['get']>[0]): T {
  const store = createStore()
  const unsub = store.sub(atom, () => {})
  const value = store.get(atom) as T
  unsub()
  return value
}

describe('UA2.3 — column colours', () => {
  it('POSITIVE — a stored override wins for its column; the others keep the default', () => {
    memory.set('nessy-kanban-column-colors', JSON.stringify({ todo: '#123456' }))
    const colors = resolveKanbanColumnColors(readMounted(kanbanColumnColorsAtom))
    expect(colors.get('todo')?.solid).toBe('#123456')
    expect(colors.get('todo')?.tint).toBe('color-mix(in srgb, #123456 6%, transparent)')
    expect(colors.get('in-progress')?.solid).toBe(DEFAULT_KANBAN_COLUMN_COLORS['in-progress'])
    expect(colors.get('done')?.solid).toBe(DEFAULT_KANBAN_COLUMN_COLORS.done)
    expect([...colors.keys()]).toEqual(['todo', 'in-progress', 'done'])
  })

  it('NEGATIVE — unparseable stored JSON falls back to the defaults', () => {
    memory.set('nessy-kanban-column-colors', '{not json')
    const colors = resolveKanbanColumnColors(readMounted(kanbanColumnColorsAtom))
    expect(colors.get('todo')?.solid).toBe(DEFAULT_KANBAN_COLUMN_COLORS.todo)
  })

  it('NEGATIVE — JSON of the wrong shape (null, array, number, non-colour entries) falls back without throwing', () => {
    for (const stored of ['null', '[]', '42', '"#123456"', JSON.stringify({ todo: 42, done: 'url(x)', 'in-progress': '' })]) {
      memory.set('nessy-kanban-column-colors', stored)
      const colors = resolveKanbanColumnColors(readMounted(kanbanColumnColorsAtom))
      expect(colors.get('todo')?.solid).toBe(DEFAULT_KANBAN_COLUMN_COLORS.todo)
      expect(colors.get('in-progress')?.solid).toBe(DEFAULT_KANBAN_COLUMN_COLORS['in-progress'])
      expect(colors.get('done')?.solid).toBe(DEFAULT_KANBAN_COLUMN_COLORS.done)
    }
  })

  it('BOUNDARY — the upstream craft-* key is not read (keys are nessy-*)', () => {
    memory.set('craft-kanban-column-colors', JSON.stringify({ todo: '#123456' }))
    expect(resolveKanbanColumnColors(readMounted(kanbanColumnColorsAtom)).get('todo')?.solid).toBe(
      DEFAULT_KANBAN_COLUMN_COLORS.todo
    )
  })
})

describe('UA2.3 — status on move', () => {
  const known = new Set(['todo', 'in-progress', 'needs-review', 'done', 'cancelled'])
  const isKnownStatus = (id: string) => known.has(id)

  it('POSITIVE — a mapped, existing status is applied on a move into that column', () => {
    memory.set('nessy-kanban-column-status', JSON.stringify({ done: 'done' }))
    const columnStatus = readMounted(kanbanColumnStatusAtom)
    expect(resolveDropStatus({ toColumn: 'done', columnStatus, isKnownStatus })).toBe('done')
  })

  it('NEGATIVE — a column absent from the map applies nothing', () => {
    memory.set('nessy-kanban-column-status', JSON.stringify({ done: 'done' }))
    const columnStatus = readMounted(kanbanColumnStatusAtom)
    expect(resolveDropStatus({ toColumn: 'in-progress', columnStatus, isKnownStatus })).toBeUndefined()
  })

  it('NEGATIVE — a mapping to a status that no longer exists applies nothing', () => {
    expect(resolveDropStatus({ toColumn: 'done', columnStatus: { done: 'shipped' }, isKnownStatus })).toBeUndefined()
  })

  it('NEGATIVE — corrupt stored maps apply nothing and do not throw', () => {
    for (const columnStatus of [null, [], 42, 'done', { done: 7 }]) {
      expect(resolveDropStatus({ toColumn: 'done', columnStatus, isKnownStatus })).toBeUndefined()
    }
  })

  it('the Appearance "Don\'t change" selection removes the mapping, so the move applies nothing', () => {
    const mapped = withColumnDropStatus({}, 'done', 'done')
    expect(mapped).toEqual({ done: 'done' })
    const cleared = withColumnDropStatus(mapped, 'done', '')
    expect(cleared).toEqual({})
    expect(resolveDropStatus({ toColumn: 'done', columnStatus: cleared, isKnownStatus })).toBeUndefined()
  })

  it('a project column\'s own dropStatusId wins over the global map', () => {
    expect(
      resolveDropStatus({ toColumn: 'done', columnDropStatusId: 'cancelled', columnStatus: { done: 'done' }, isKnownStatus })
    ).toBe('cancelled')
  })

  it('readColumnMap keeps only non-empty string entries', () => {
    expect(readColumnMap({ a: 'x', b: '', c: 3, d: null })).toEqual({ a: 'x' })
  })
})
