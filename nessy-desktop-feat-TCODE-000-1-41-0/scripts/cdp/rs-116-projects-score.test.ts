/**
 * RS-116 (UA5.11) - the Projects case's scorers, and the renderer and wire facts
 * it restates because a case may not import the renderer's module graph.
 *
 * - `groupVerdict` / `groupVerdictAny`: a row in no group FAILS, and a header that
 *   only STARTS with the wanted name ("P1 renamed" for "P1") FAILS.
 * - `folderVerdict`, `refusalVerdict`, `replyVerdict`, `columnsVerdict`: each
 *   compares every wanted field, and a success where a refusal was wanted fails.
 * - `withProjectGrouping`: All Sessions grouped by Project with its filters
 *   cleared, every other view kept.
 * - The restated facts are read back out of the SOURCE they restate, so a rename
 *   there turns this file red instead of leaving the case reading a key, a class
 *   or a code the app no longer has.
 */

import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  bindingKeepsFolderVerdict, BUILT_IN_COLUMNS, columnsVerdict, FOLDER_PROBLEM, folderVerdict, groupVerdict,
  groupVerdictAny, refusalVerdict, replyVerdict, VIEW_FILTERS_STORAGE_KEY, viewFiltersKey, withProjectGrouping,
  type FolderReading,
} from './cases/rs-116.ts'

const REPO = join(import.meta.dir, '..', '..')
const RENDERER = join(REPO, 'apps', 'electron', 'src', 'renderer')
const source = (path: string): string => readFileSync(join(RENDERER, path), 'utf8')

const folder = (patch: Partial<FolderReading> = {}): FolderReading => ({
  present: true, displayPath: '/tmp/rs116-a', trusted: true, problem: null, handleId: 'h1', ...patch,
})

describe('RS-116: groupVerdict', () => {
  it('passes a row under its group, with or without the group count', () => {
    expect(groupVerdict('CDP RS-116 P1 120000', 'CDP RS-116 P1 120000').ok).toBe(true)
    expect(groupVerdict('No project 3', 'No project').ok).toBe(true)
    expect(groupVerdictAny('Без проекта 2', ['No project', 'Без проекта']).ok).toBe(true)
  })

  it('fails a row in no group, under another group, and under a group whose name only starts with the wanted one', () => {
    expect(groupVerdict(null, 'P1').detail).toStartWith('row-not-grouped')
    expect(groupVerdict('No project', 'P1').ok).toBe(false)
    expect(groupVerdict('P1 renamed 2', 'P1').ok).toBe(false)
    expect(groupVerdictAny('P2', ['No project', 'Без проекта']).ok).toBe(false)
  })

  it('reads a header as the list RENDERS it, case folded: v0.15.1 renders the label as written, a transform cannot split it', () => {
    // v0.15.1 (UB13.13): no text transform, so `innerText` returns the locale's own spelling, count included.
    expect(groupVerdict('No project · 3', 'No project').ok).toBe(true)
    expect(groupVerdictAny('Без проекта · 2', ['No project', 'Без проекта']).ok).toBe(true)
    // The fold stays: the pre-v0.15.1 `uppercase` headers (or any transform that comes back) read as the label.
    expect(groupVerdict('no project', 'No project').ok).toBe(true)
    expect(groupVerdict('NO PROJECT', 'No project').ok).toBe(true)
    expect(groupVerdict('NO PROJECT · 3', 'No project').ok).toBe(true)
    expect(groupVerdictAny('БЕЗ ПРОЕКТА', ['No project', 'Без проекта']).ok).toBe(true)
    // Folding never lets more name through: an uppercase header that only starts with the wanted one still fails.
    expect(groupVerdict('CDP RS-116 P1 1 RENAMED', 'CDP RS-116 P1 1').ok).toBe(false)
    expect(groupVerdictAny('NO PROJECTS', ['No project', 'Без проекта']).ok).toBe(false)
    expect(groupVerdict('No projects · 3', 'No project').ok).toBe(false)
  })
})

describe('RS-116: folderVerdict', () => {
  it('passes the reading wanted, path compared as one place', () => {
    expect(folderVerdict(folder(), { trusted: true, problem: null, displayPath: '/tmp/rs116-a' }).ok).toBe(true)
    expect(folderVerdict(folder({ trusted: false, problem: FOLDER_PROBLEM.unavailable }), { problem: FOLDER_PROBLEM.unavailable }).ok).toBe(true)
  })

  it('fails a missing project, a project with no folder, and each wrong field', () => {
    expect(folderVerdict(null, { trusted: true }).detail).toStartWith('project-not-found')
    expect(folderVerdict(folder({ present: false }), {}).ok).toBe(false)
    expect(folderVerdict(folder({ trusted: false }), { trusted: true }).ok).toBe(false)
    expect(folderVerdict(folder(), { problem: FOLDER_PROBLEM.identityChanged }).ok).toBe(false)
    expect(folderVerdict(folder({ problem: FOLDER_PROBLEM.unavailable }), { problem: FOLDER_PROBLEM.identityChanged }).ok).toBe(false)
    expect(folderVerdict(folder(), { displayPath: '/tmp/rs116-b' }).ok).toBe(false)
  })
})

describe('RS-116: bindingKeepsFolderVerdict', () => {
  it('passes an unchanged working directory and fails a planted folder move (the boundary arm, UA12.120)', () => {
    expect(bindingKeepsFolderVerdict('/Users/u/work', '/Users/u/work').ok).toBe(true)
    expect(bindingKeepsFolderVerdict('/Users/u/work', '/tmp/nessy-cdp-rs116-x/folder-p2').ok).toBe(false)
    expect(bindingKeepsFolderVerdict('/Users/u/work', '/tmp/nessy-cdp-rs116-x/folder-p2').detail)
      .toContain('binding moved the working directory')
  })

  it('fails an unread side as UNMEASURED, never a pass', () => {
    expect(bindingKeepsFolderVerdict(null, '/Users/u/work').detail).toStartWith('UNMEASURED')
    expect(bindingKeepsFolderVerdict('/Users/u/work', null).detail).toStartWith('UNMEASURED')
    expect(bindingKeepsFolderVerdict(null, null).ok).toBe(false)
  })

  it('wires the guard into arm G against a FOLDERED P2 (the case source, UA12.120)', () => {
    const kase = readFileSync(join(import.meta.dir, 'cases', 'rs-116.ts'), 'utf8')
    // The check is the scorer, not an inline comparison: a planted move reaches the verdict above.
    expect(kase).toContain('bindingKeepsFolderVerdict(uBefore.workingDirectory, bound.workingDirectory)')
    expect(kase).not.toContain('bound.workingDirectory === uBefore.workingDirectory')
    // The precondition that makes the check able to fail: P2 carries a bound folder before U is bound,
    // through a scratch folder of its own (arm X owns folder-b).
    expect(kase).toContain("join(state.root, 'folder-p2')")
    expect(kase).toContain('G: P2 carries a bound folder (the precondition the no-move check can fail)')
  })
})

describe('RS-116: the page-created sessions are named (UA12.147)', () => {
  // SIT-B FAILS #1: the app's empty-draft sweep deleted the case's unnamed
  // page-created sessions on navigate-away three times, failing six arms on
  // features named-session supplements then passed. The fix is the case's own:
  // `newSessionFromPage` names what it creates. These pins read the case (and
  // the sweep's own source) so a regression there turns this file red.
  const kase = readFileSync(join(import.meta.dir, 'cases', 'rs-116.ts'), 'utf8')

  it('restates the sweep rule the name answers, as NavigationContext spells it', () => {
    const nav = source('contexts/NavigationContext.tsx')
    expect(nav).toContain('!meta.lastFinalMessageId && !meta.name && !meta.isProcessing')
    expect(nav).toContain('const hasDraft = getDraft?.(prevId)?.trim()')
    expect(nav).toContain('if (isEmpty && !hasDraft) {')
  })

  it('names the session INSIDE newSessionFromPage, through the verified rename, before any navigate-away', () => {
    const helper = kase.slice(
      kase.indexOf('async function newSessionFromPage'),
      kase.indexOf('async function readToasts'),
    )
    expect(helper).toContain('ensureSessionName(session, { workspaceId, sessionId }, sessionName)')
    expect(helper).toContain('...(named ? { named } : {})')
  })

  it('every page-creation site passes a distinct CDP-stamped name and requires the name took', () => {
    // Three arms create a session through the page button (T, T\', R2) — each
    // passes its own name (a repeated one would be de-duplicated by the app and
    // fail the exact read-back) and each refuses the run when the name did not
    // take rather than let the sweep eat the row it is measuring.
    expect(kase.match(/CDP \$\{ID\} page (trust|trust2|renamed) \$\{state\.stamp\}/g)).toHaveLength(3)
    expect(kase.match(/named === undefined/g)).toHaveLength(3)
  })
})

describe('RS-116: refusalVerdict, replyVerdict, columnsVerdict', () => {
  it('passes a refusal naming the wanted code, and fails a success or another reason', () => {
    expect(refusalVerdict('project-folder-identity-changed: moved', FOLDER_PROBLEM.identityChanged).ok).toBe(true)
    expect(refusalVerdict(undefined, FOLDER_PROBLEM.identityChanged).detail).toStartWith('not refused')
    expect(refusalVerdict('project-folder-unavailable', FOLDER_PROBLEM.identityChanged).ok).toBe(false)
  })

  it('passes a reply with every marker, and fails an empty reply as unmeasured or a missing marker', () => {
    expect(replyVerdict('Codename RS116-PI-AB, first line RS116-ASSET-CD', ['RS116-PI-AB', 'RS116-ASSET-CD']).ok).toBe(true)
    expect(replyVerdict('  ', ['X']).detail).toStartWith('UNMEASURED')
    expect(replyVerdict('Codename RS116-PI-AB', ['RS116-PI-AB', 'RS116-ASSET-CD']).ok).toBe(false)
  })

  it('compares the board columns in order', () => {
    expect(columnsVerdict(['todo', 'in-progress', 'done', 'col-1'], ['todo', 'in-progress', 'done', 'col-1']).ok).toBe(true)
    expect(columnsVerdict(['todo', 'done', 'in-progress'], BUILT_IN_COLUMNS).ok).toBe(false)
    expect(columnsVerdict(['todo', 'in-progress', 'done', 'col-1'], BUILT_IN_COLUMNS).ok).toBe(false)
  })
})

describe('RS-116: withProjectGrouping', () => {
  it('groups All Sessions by Project with its filters cleared and keeps every other view', () => {
    const raw = JSON.stringify({ allSessions: { statuses: { todo: 'include' }, labels: {}, groupingMode: 'date' }, flagged: { statuses: {}, labels: {} } })
    const map = JSON.parse(withProjectGrouping(raw)) as Record<string, { statuses: object; groupingMode?: string }>
    expect(map.allSessions).toEqual({ statuses: {}, labels: {}, projects: {}, groupingMode: 'project' } as never)
    expect(map.flagged).toEqual({ statuses: {}, labels: {} } as never)
  })

  it('replaces an absent or unreadable map with one holding the grouped view only', () => {
    expect(Object.keys(JSON.parse(withProjectGrouping(null)) as object)).toEqual(['allSessions'])
    expect(Object.keys(JSON.parse(withProjectGrouping('{not json')) as object)).toEqual(['allSessions'])
    expect(Object.keys(JSON.parse(withProjectGrouping('[1,2]')) as object)).toEqual(['allSessions'])
  })
})

describe('RS-116: the renderer and wire facts the case restates', () => {
  it('reads the view-filters map under the key local-storage.ts builds', () => {
    const storage = source('lib/local-storage.ts')
    const prefix = /const PREFIX = '([^']+)'/.exec(storage)?.[1]
    const key = /viewFilters: '([^']+)'/.exec(storage)?.[1]
    expect(prefix).toBeDefined()
    expect(key).toBeDefined()
    expect(`${prefix}${key}`).toBe(VIEW_FILTERS_STORAGE_KEY)
    // The control: the legacy list-filter key is a different one.
    expect(storage).not.toContain(`listFilter: '${key}'`)
  })

  it('writes the view-filters map under the WORKSPACE-SCOPED key AppShell reads and persists', () => {
    // AppShell's mount/switch effect replaces the map with the scoped read and
    // its persist effect writes only the scoped key, so a bare-key write is
    // discarded on reload (the UA5.11 follow-up).
    const shell = source('components/app-shell/AppShell.tsx')
    expect(shell).toContain('storage.get<ViewFiltersMap>(storage.KEYS.viewFilters, {}, activeWorkspaceId)')
    expect(shell).toContain('storage.set(storage.KEYS.viewFilters, viewFiltersMap, activeWorkspaceId)')
    const storage = source('lib/local-storage.ts')
    expect(storage).toContain('return suffix ? `${base}:${suffix}` : base')
    expect(viewFiltersKey('ws-1')).toBe(`${VIEW_FILTERS_STORAGE_KEY}:ws-1`)
    // The control: the bare key is NOT what the app reads for a workspace.
    expect(viewFiltersKey('ws-1')).not.toBe(VIEW_FILTERS_STORAGE_KEY)
    // No workspace id means no key the app reads: refuse rather than fall back to the bare key.
    expect(() => viewFiltersKey('')).toThrow()
    // The call: the case's storage reads and writes go through the scoped key, never the bare constant.
    const kase = readFileSync(join(import.meta.dir, 'cases', 'rs-116.ts'), 'utf8')
    expect(kase).toContain('const filtersKey = viewFiltersKey(state.workspaceId)')
    expect(kase.match(/localStorage\.\w+\(\$\{JSON\.stringify\(filtersKey\)\}/g)?.length).toBe(5)
    expect(kase).not.toMatch(/localStorage\.\w+\(\$\{JSON\.stringify\(VIEW_FILTERS_STORAGE_KEY\)\}/)
  })

  it('reads the built-in columns in status-column.ts KANBAN_COLUMNS order', () => {
    const columns = source('components/app-shell/kanban/status-column.ts')
    const block = columns.slice(columns.indexOf('export const KANBAN_COLUMNS'), columns.indexOf('] as const'))
    const ids = [...block.matchAll(/\{ id: '([^']+)'/g)].map(match => match[1])
    expect(ids).toEqual([...BUILT_IN_COLUMNS])
  })

  it('names the folder problems as dto.ts ProjectFolderView does', () => {
    const dto = readFileSync(join(REPO, 'packages', 'shared', 'src', 'protocol', 'dto.ts'), 'utf8')
    const at = dto.indexOf('export interface ProjectFolderView')
    expect(at).toBeGreaterThan(-1)
    const view = dto.slice(at, dto.indexOf('}', dto.indexOf('problem?:', at)))
    expect(view).toContain(`'${FOLDER_PROBLEM.identityChanged}' | '${FOLDER_PROBLEM.unavailable}'`)
    expect(dto).toContain("export type SetProjectIdCommand = { type: 'setProjectId'; projectId: string | null }")
  })

  it('finds a session row\'s group the way entity-list.tsx renders groups', () => {
    const list = source('components/ui/entity-list.tsx')
    // The group blocks sit in a `pt-1` div inside the `flex flex-col pb-2` container, one `div` per group whose
    // first child is the header; readGroupHeader walks exactly that. v0.15.1 (UB13.13, abbbf7b26) gives every
    // group but the first a GROUP_GAP class, so the block is matched with or without a className — and the
    // header must be its FIRST child, with the rows after it (readGroupHeader reads `firstElementChild`).
    expect(list).toContain('className="flex flex-col pb-2"')
    expect(list).toContain('<div className="pt-1">')
    const groupOpen = /<div key=\{group\.key\}(?: className=\{[^}]*\})?>/
    const groupBlock = new RegExp(
      groupOpen.source
      + String.raw`\s*\{group\.collapsible && onToggleCollapse \? \(\s*<CollapsibleGroupHeader[\s\S]*?\) : \(`
      + String.raw`\s*<SectionHeader label=\{group\.label\} \/>\s*\)\}\s*\{group\.items\.map\(`,
    )
    expect(list).toMatch(groupBlock)
    // The control: a wrapper between the group block and its header (the reader would then read the wrapper,
    // which contains the row, and return null) does not match.
    const wrapped = list.replace(groupOpen, match => `${match}<section>`)
    expect(wrapped).not.toBe(list)
    expect(wrapped).not.toMatch(groupBlock)
    // v0.15.1's group headers render the label `text-label-sm` with NO text transform (the pre-v0.15.1
    // `uppercase` is gone), so a DOM read returns it as the locale spells it. groupVerdict folds case anyway
    // (pinned in its own describe above), so neither this nor a transform coming back splits header from label;
    // a transform here would make groupVerdict's docblock stale, so it turns this arm red.
    const label = /<span className="([^"]*)">\s*\{label\}/g
    const classes = [...list.matchAll(label)].map(match => match[1]!.split(/\s+/))
    expect(classes).toHaveLength(2)
    for (const tokens of classes) {
      expect(tokens).toContain('text-label-sm')
      for (const transform of ['uppercase', 'lowercase', 'capitalize']) expect(tokens).not.toContain(transform)
    }
    const item = source('components/app-shell/SessionItem.tsx')
    expect(item).toContain('className="session-item"')
    expect(item).toContain("dataAttributes={{ 'data-session-id': item.id }}")
  })

  it('finds the board and page controls by the copy their sources render', () => {
    const board = source('components/app-shell/kanban/KanbanBoard.tsx')
    // UB14.52: v0.15.1's add-column IconButton names the control by aria-label (the case's selector reads it there).
    expect(board).toContain("aria-label={t('kanban.column.add')}")
    expect(board).not.toContain("title={t('kanban.column.add')}")
    const filter = source('components/app-shell/ProjectMultiSelectFilter.tsx')
    expect(filter).toContain('<DropdownMenuTrigger asChild>')
    expect(filter).toContain('<DropdownMenuCheckboxItem')
    expect(filter).toContain("t('kanban.allProjects')")
    const page = source('pages/ProjectInfoPage.tsx')
    expect(page).toContain("t('projectInfo.newSessionButton', { name: project.config.name })")
    // The control: the page's button never names the session list's "New Session" copy.
    expect(page).not.toContain("t('sidebar.newSession')")
  })
})
