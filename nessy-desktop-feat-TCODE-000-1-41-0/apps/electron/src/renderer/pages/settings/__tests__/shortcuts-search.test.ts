/**
 * C3.230 — the two verbs, driven directly.
 *
 * Owner answer QO2=A. The page itself is pinned by source match in
 * `pages/__tests__/shortcuts-surfaces.test.ts` (there is no React DOM harness
 * in this tree); the ANSWERS are pinned here, where they can be wrong in a way
 * a source match cannot see.
 *
 * The sentinel is the one trick in this module and it has exactly one failure
 * mode: an id that collided with a real action would silently drop that action
 * from every reverse lookup. That is asserted against the real roster rather
 * than trusted, which is why this file imports `actionList`.
 */
import { describe, expect, it } from 'bun:test'

// `@/actions/definitions` and NOT the `@/actions` barrel — the pure data module
// rather than the one that pulls `registry.tsx` and React with it.
//
// It does NOT make this file faster, and the measurement is worth keeping so
// nobody else pays for the experiment: 50.26 s through the barrel, 67.65 s
// through definitions, and a ZERO-CASE control on the same bytes
// (`-t 'zzz-no-such-case-zzz'`) at 67.33 s wall with `user 0.70 / sys 0.26` at
// load 9.75. Every second of that is module-graph I/O with nothing running, the
// shape AGENTS.md §Traps names; the import choice is not in it.
import { actionList } from '@/actions/definitions'
import {
  NO_ACTION_SENTINEL,
  actionsOwningHotkey,
  filterShortcutEntries,
  filterShortcutSections,
} from '../shortcuts-search'

const entries = [
  { id: 'app.newChat', label: 'New Chat' },
  { id: 'app.newChatInPanel', label: 'New Chat in Panel' },
  { id: 'app.toggleTheme', label: 'Toggle Theme' },
  { id: 'nav.focusChat', label: 'Focus Chat' },
]

describe('filterShortcutEntries', () => {
  it('matches a substring of the label, ignoring case', () => {
    expect(filterShortcutEntries(entries, 'chat'))
      .toEqual(['app.newChat', 'app.newChatInPanel', 'nav.focusChat'])
    expect(filterShortcutEntries(entries, 'THEME')).toEqual(['app.toggleTheme'])
  })

  it('requires every term, in any order', () => {
    // `new chat` must not become "anything with `new` OR `chat`", and a user
    // who types the words the other way round is asking the same question.
    expect(filterShortcutEntries(entries, 'new panel')).toEqual(['app.newChatInPanel'])
    expect(filterShortcutEntries(entries, 'panel new')).toEqual(['app.newChatInPanel'])
  })

  it('returns EVERYTHING for an empty or whitespace query', () => {
    // The page's default state is the full table. A filter that emptied the
    // page when cleared would read as a broken page, so this is the boundary
    // that matters most.
    expect(filterShortcutEntries(entries, '')).toHaveLength(entries.length)
    expect(filterShortcutEntries(entries, '   ')).toHaveLength(entries.length)
  })

  it('returns nothing for a query nothing matches — the negative control', () => {
    expect(filterShortcutEntries(entries, 'zzz-no-such-command')).toEqual([])
  })

  it('folds accents, so a Russian label answers to either spelling', () => {
    // The localized label is what is compared, and `ё`/`е` is the case a user
    // hits without knowing they have.
    const ru = [{ id: 'x', label: 'Приём сообщений' }]
    expect(filterShortcutEntries(ru, 'приём')).toEqual(['x'])
    expect(filterShortcutEntries(ru, 'прием')).toEqual(['x'])
  })
})

describe('filterShortcutSections — C3.317, the second entry shape', () => {
  const sections = [
    {
      title: 'Session List',
      shortcuts: [
        { keys: ['Enter'], description: 'Focus chat input' },
        { keys: ['Right-click'], description: 'Open context menu' },
      ],
    },
    {
      title: 'Chat Input',
      shortcuts: [
        { keys: ['Enter'], description: 'Send message' },
        { keys: ['Esc'], description: 'Close dialog / blur input' },
      ],
    },
  ]

  it('matches the row text', () => {
    expect(filterShortcutSections(sections, 'send')).toEqual([
      { title: 'Chat Input', shortcuts: [{ keys: ['Enter'], description: 'Send message' }] },
    ])
  })

  it('matches the section HEADING too, which the row text never carries', () => {
    // The whole reason this verb is not `filterShortcutEntries` over
    // descriptions: nothing in "Open context menu" contains "session list", and
    // "session list" is what a user types.
    const found = filterShortcutSections(sections, 'session list')
    expect(found).toHaveLength(1)
    expect(found[0]!.title).toBe('Session List')
    expect(found[0]!.shortcuts).toHaveLength(2)
  })

  it('drops a section left with no row rather than rendering it empty', () => {
    // "Send message" lives in ONE of the two sections; the other must be gone,
    // not present and blank — the registry categories already behave this way.
    expect(filterShortcutSections(sections, 'message').map(s => s.title)).toEqual(['Chat Input'])
  })

  it('returns EVERY section for an empty or whitespace query', () => {
    // Same boundary as the registry filter, and the same reason: the page's
    // default state is the full page.
    expect(filterShortcutSections(sections, '')).toHaveLength(2)
    expect(filterShortcutSections(sections, '  ')).toHaveLength(2)
    expect(filterShortcutSections(sections, '')[0]!.shortcuts).toHaveLength(2)
  })

  it('returns [] for a query nothing matches — the negative control', () => {
    expect(filterShortcutSections(sections, 'zzz-no-such-shortcut')).toEqual([])
  })

  it('keeps the row object, chips and all, so the page can still render it', () => {
    // A verb that returned only descriptions would have cost the page its `keys`.
    expect(filterShortcutSections(sections, 'blur')[0]!.shortcuts[0]!.keys).toEqual(['Esc'])
  })

  it('requires every term and folds accents, like the registry filter', () => {
    expect(filterShortcutSections(sections, 'chat enter')).toEqual([])
    expect(filterShortcutSections(sections, 'chat send').map(s => s.title)).toEqual(['Chat Input'])
    const ru = [{ title: 'Поле чата', shortcuts: [{ keys: ['Enter'], description: 'Приём сообщений' }] }]
    expect(filterShortcutSections(ru, 'прием')).toHaveLength(1)
  })
})

describe('actionsOwningHotkey', () => {
  const ids = ['a.one', 'a.two', 'a.three']
  const resolve = (id: string) => (id === 'a.three' ? 'mod+k' : 'mod+j')

  it('names EVERY owner, including the one a collision check would call self', () => {
    // This is the whole point of the sentinel: `findHotkeyCollisions` answers
    // "which OTHER actions", and the question here has no self.
    expect(actionsOwningHotkey('mod+j', ids, resolve)).toEqual(['a.one', 'a.two'])
    expect(actionsOwningHotkey('mod+k', ids, resolve)).toEqual(['a.three'])
  })

  it('answers [] for an unbound chord, which is an answer and not a failure', () => {
    expect(actionsOwningHotkey('mod+z', ids, resolve)).toEqual([])
    // `null` is "nothing recorded yet", and must not be read as "unbound".
    expect(actionsOwningHotkey(null, ids, resolve)).toEqual([])
  })

  it('uses a sentinel that belongs to no real action', () => {
    // The failure this trick can have: a sentinel equal to a declared id would
    // hide exactly that action from every lookup, silently and forever.
    expect(actionList.map(action => action.id)).not.toContain(NO_ACTION_SENTINEL)
    // And the roster is the thirty the row was written against — if it grows,
    // that is fine; if it collapses, this file's other controls are vacuous.
    expect(actionList.length).toBeGreaterThanOrEqual(30)
  })
})
