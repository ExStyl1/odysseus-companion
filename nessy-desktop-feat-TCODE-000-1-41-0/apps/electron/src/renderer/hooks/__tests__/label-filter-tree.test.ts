/**
 * F1.353 — a parent label's chat list was EMPTY beside a non-zero sidebar count
 * when its chats carried only a CHILD label.
 *
 * AppShell counts and pre-filters through the label tree (getDescendantIds),
 * but the list's own second pass — useSessionSearch's
 * `sessionMatchesCurrentFilter` — matched the exact id, and NavigationContext's
 * auto-select matched only the id or its valued `id::…` form. Upstream
 * craft-agents-oss v0.11.0+ routes all three through `matchesLabelFilter`
 * with `labelConfigs` threaded in from SessionList (ported to
 * `@nessy-agent/shared/labels`, Apache-2.0).
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'bun:test'
import type { LabelConfig } from '@nessy-agent/shared/labels'
import { sessionMatchesCurrentFilter } from '../useSessionSearch'
import { hasLiveLabelFilter } from '../../components/app-shell/task-scope-filters'
import type { SessionMeta } from '@/atoms/sessions'

const TREE: LabelConfig[] = [
  { id: 'parent', name: 'Parent', children: [{ id: 'child', name: 'Child' }] },
  { id: 'sibling', name: 'Sibling' },
  { id: 'priority', name: 'Priority', valueType: 'number' },
]

function meta(id: string, labels: string[]): SessionMeta {
  return { id, workspaceId: 'ws-1', labels, lastMessageAt: 1 } as SessionMeta
}

const parentFilter = { kind: 'label', labelId: 'parent' } as const

describe('F1.353 — the list matches a label filter through the label tree', () => {
  it('positive — a child-only chat appears under its parent filter', () => {
    expect(sessionMatchesCurrentFilter(meta('c', ['child']), parentFilter, { labelConfigs: TREE })).toBe(true)
  })

  it('negative — a sibling-labelled chat does not, and valued priority::3 still matches priority', () => {
    expect(sessionMatchesCurrentFilter(meta('s', ['sibling']), parentFilter, { labelConfigs: TREE })).toBe(false)
    expect(sessionMatchesCurrentFilter(meta('p', ['priority::3']), { kind: 'label', labelId: 'priority' }, { labelConfigs: TREE })).toBe(true)
  })

  it('an archived chat stays out of a label filter (the caller\'s policy, unchanged)', () => {
    const archived = { ...meta('a', ['child']), isArchived: true }
    expect(sessionMatchesCurrentFilter(archived, parentFilter, { labelConfigs: TREE })).toBe(false)
  })

  it('the secondary include/exclude label filter expands descendants too, as AppShell\'s pre-filter does', () => {
    const include = new Map([['parent', 'include' as const]])
    const exclude = new Map([['parent', 'exclude' as const]])
    const child = meta('c', ['child'])
    expect(sessionMatchesCurrentFilter(child, undefined, { labelConfigs: TREE, labelFilterMap: include })).toBe(true)
    expect(sessionMatchesCurrentFilter(child, undefined, { labelConfigs: TREE, labelFilterMap: exclude })).toBe(false)
    // Control: a sibling chat is untouched by a parent exclude and dropped by a parent include.
    const sibling = meta('s', ['sibling'])
    expect(sessionMatchesCurrentFilter(sibling, undefined, { labelConfigs: TREE, labelFilterMap: exclude })).toBe(true)
    expect(sessionMatchesCurrentFilter(sibling, undefined, { labelConfigs: TREE, labelFilterMap: include })).toBe(false)
  })

  it('SessionList threads the tree in, and NavigationContext\'s auto-select matches through it', () => {
    const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf-8')
    expect(read('../../components/app-shell/SessionList.tsx')).toContain('labelConfigs: labels')
    const nav = read('../../contexts/NavigationContext.tsx')
    const filterFn = nav.slice(nav.indexOf('const filterSessionsByFilter = useCallback('), nav.indexOf('const getFirstSessionId = useCallback('))
    expect(filterFn).toContain('return matchesLabelFilter(session, filter, labelConfigs)')
    expect(filterFn).toContain('[sessionMetas, workspaceId, labelConfigs]')
    expect(filterFn).not.toContain("startsWith(`${filter.labelId}::`)")
  })
})

/**
 * UA12.154 — a persisted label filter naming a DELETED label must not blank the list.
 *
 * SIT-D F4: localStorage `nessy-view-filters:<ws>` held
 * `{"allSessions":{"labels":{"<deleted-label-id>":"include"}}}` (the label's task was deleted);
 * All Sessions showed "No sessions yet" beside live unread counts, surviving reload and restart.
 * The include expanded to just the dead id — no session can carry it — so everything was filtered
 * out. Both consumers of the persisted map now drop ids the label config no longer carries:
 * AppShell's pre-filter through `expandLabelFilterIds` (task-scope-filters.ts) and this list's own
 * `passesLabelFilter` skip; the filter chip already renders nothing for a missing config.
 */
describe('UA12.154 — an include id no label config carries is dropped, not matched', () => {
  const deadInclude = new Map([['deleted-label', 'include' as const]])

  it('DEFECT — a labelled session passes a dead-only include (the list is not blanked)', () => {
    expect(sessionMatchesCurrentFilter(meta('c', ['child']), undefined, { labelConfigs: TREE, labelFilterMap: deadInclude })).toBe(true)
  })

  it('DEFECT — an unlabelled session passes too (no live filter remains — the chip is gone)', () => {
    expect(sessionMatchesCurrentFilter(meta('n', []), undefined, { labelConfigs: TREE, labelFilterMap: deadInclude })).toBe(true)
  })

  it('CONTROL — a live include beside a dead one still filters: the child passes, a sibling does not', () => {
    const mixed = new Map([['deleted-label', 'include' as const], ['parent', 'include' as const]])
    expect(sessionMatchesCurrentFilter(meta('c', ['child']), undefined, { labelConfigs: TREE, labelFilterMap: mixed })).toBe(true)
    expect(sessionMatchesCurrentFilter(meta('s', ['sibling']), undefined, { labelConfigs: TREE, labelFilterMap: mixed })).toBe(false)
  })

  it('NEGATIVE — an exclude of a dead id is inert; a live exclude still excludes', () => {
    const deadExclude = new Map([['deleted-label', 'exclude' as const]])
    expect(sessionMatchesCurrentFilter(meta('c', ['child']), undefined, { labelConfigs: TREE, labelFilterMap: deadExclude })).toBe(true)
    const live = new Map([['child', 'exclude' as const]])
    expect(sessionMatchesCurrentFilter(meta('c', ['child']), undefined, { labelConfigs: TREE, labelFilterMap: live })).toBe(false)
  })

  it('BOUNDARY — a caller threading no configs keeps exact-id includes (the drop needs the configs)', () => {
    const exact = new Map([['child', 'include' as const]])
    expect(sessionMatchesCurrentFilter(meta('c', ['child']), undefined, { labelFilterMap: exact })).toBe(true)
    expect(sessionMatchesCurrentFilter(meta('s', ['sibling']), undefined, { labelFilterMap: exact })).toBe(false)
  })
})

/**
 * S7-C F3 (UA4.12's sitting, RC4 2026-10-10) — the All Sessions list rendered 0 `.session-item` rows
 * while `getSessions` returned the sessions and the sidebar badge counted them, across reloads, and
 * every `freshSession` start died on "the selected row is none/ambiguous" (7 dead case starts).
 *
 * The offline repro lands the OBSERVABLE and its mechanism: the persisted `allSessions` label filter a
 * board click leaves behind (`withTaskScopeFilters`, UA5.10) names a LIVE task label whose carrier
 * sessions the case's cleanup then deleted — "after its last deletion" — so the include matches nothing
 * and the list correctly renders the EMPTY filtered set. This is NOT the UA12.154 blank-trap class:
 * the label is live, so `hasLiveLabelFilter` is true and the filter chip with its Clear renders (the
 * sitting cleared the state through exactly that popover). A freshly created session carries no label,
 * so ITS row is hidden too — the `freshSession` none/ambiguous mechanism. The product posture question
 * (should a filter that hides the just-created, selected session auto-clear?) and the harness fix
 * (freshSession reading/clearing the persisted view filter) are the controller's proposed row, not
 * this file's.
 */
describe('S7-C F3 — a live task-label filter whose carriers are all deleted filters the list to empty, visibly', () => {
  const taskLabel = 'TASK-confirm-me-153550-5' // the sitting's own stray board-click filter
  // The sitting's label was LIVE — the board click had just created the task, so the config carries it.
  const sittingTree: LabelConfig[] = [...TREE, { id: taskLabel, name: 'confirm-me' }]
  const liveInclude = new Map([[taskLabel, 'include' as const]])
  const options = { labelConfigs: sittingTree, labelFilterMap: liveInclude }

  it('REPRO — after the last carrier is deleted, every session in the store is filtered out (0 rows, getSessions unharmed)', () => {
    // The store still holds sessions (getSessions returned them; the sidebar badge counted them):
    // an unrelated sibling-labelled one and a freshly created unlabelled one.
    expect(sessionMatchesCurrentFilter(meta('s', ['sibling']), undefined, options)).toBe(false)
    expect(sessionMatchesCurrentFilter(meta('fresh', []), undefined, options)).toBe(false)
  })

  it('NOT the blank-trap class — the label is live, so the chip and its Clear render (hasLiveLabelFilter)', () => {
    expect(hasLiveLabelFilter(sittingTree, liveInclude)).toBe(true)
    // The contrast that makes UA12.162's predicate the discriminator: the same map over a config that
    // does NOT carry the id reports no live filter (inert, UA12.154) — S7-C's state is the live-id case,
    // clearable by design. (That drop is also why a taskLabel outside the config reproduces nothing.)
    expect(hasLiveLabelFilter(TREE, liveInclude)).toBe(false)
    expect(hasLiveLabelFilter(TREE, new Map([['deleted-label', 'include' as const]]))).toBe(false)
  })

  it('CONTROL — a session still carrying the task label renders under the same filter', () => {
    expect(sessionMatchesCurrentFilter(meta('t', [taskLabel]), undefined, options)).toBe(true)
  })
})
