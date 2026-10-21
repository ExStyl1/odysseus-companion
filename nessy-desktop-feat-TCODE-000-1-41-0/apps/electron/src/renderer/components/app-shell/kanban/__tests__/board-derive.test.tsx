/**
 * UA2.4 — the board core over existing sessions (staged copy of v0.13.4 `kanban/*`).
 *
 * - `deriveBoardTasks` (the container's tile derivation, pure): which sessions are tiles,
 *   where they sit, which become subtask rows.
 * - `KanbanBoard` rendered with `renderToStaticMarkup` (no DOM in this repo's `bun test`):
 *   newest first within a column, an unknown stored column falls back to the first column,
 *   and — with exactly the callbacks the container passes — no tile renders the Play
 *   control (UA4.4). A positive control renders the same board WITH that callback, so the
 *   absence arm can fail.
 * - The container's source is pinned for what a board render cannot reach.
 * - UA3.6 updated both: since Phase 3 the container hands the board the edit (Pencil) and
 *   add-subtask (Plus) callbacks and mounts the TaskEditor, and a spec-backed tile's rows
 *   merge the spec's nodes (`mergeSubtaskRows` through `BoardDeriveContext.specNodesBySlug`).
 */
import * as React from 'react'
import { beforeAll, describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInstance, type i18n as I18nInstance } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { renderToStaticMarkup } from 'react-dom/server'
import { TooltipProvider } from '@nessy-agent/ui/ui/tooltip'
import { NESTOR_GATEWAY_CHAT_BASE_URL } from '@nessy-agent/shared/auth/nestor'
import { DEFAULT_MODEL, getModelDisplayName, getModelShortName } from '@config/models'
import type { LlmConnectionWithStatus } from '@config/llm-connections'
import type { SessionMeta } from '@/atoms/sessions'
import type { SessionStatus } from '@/config/session-status-config'
import { deriveBoardTasks, type BoardDeriveContext } from '../board-derive'
import { buildModelCatalog, initialSubtaskModel, resolveCatalogDefaultModel } from '../model-catalog'
import { resolveModelChipIcon } from '../ModelChip'
import { getProviderIcon } from '@/lib/provider-icons'
import { KanbanBoard } from '../KanbanBoard'
import { KANBAN_COLUMNS } from '../status-column'
import type { KanbanTask } from '../types'
import type { SpecNodeSummary } from '../subtask-merge'

const KANBAN_DIR = join(import.meta.dir, '..')
const LOCALES_DIR = join(KANBAN_DIR, '..', '..', '..', '..', '..', '..', '..', 'packages', 'shared', 'src', 'i18n', 'locales')
const en = JSON.parse(readFileSync(join(LOCALES_DIR, 'en.json'), 'utf8')) as Record<string, string>

let testI18n: I18nInstance
beforeAll(async () => {
  testI18n = createInstance()
  await testI18n.use(initReactI18next).init({
    lng: 'en',
    fallbackLng: 'en',
    resources: { en: { translation: en } },
    interpolation: { escapeValue: false },
  })
})

function status(id: string, category: 'open' | 'closed' = 'open'): SessionStatus {
  return { id, label: id.toUpperCase(), resolvedColor: '#888888', icon: null, iconColorable: true, category }
}
const STATUSES = [status('todo'), status('in-progress'), status('needs-review'), status('done', 'closed'), status('cancelled', 'closed')]
const STATUSES_BY_ID = new Map(STATUSES.map(s => [s.id, s]))

function meta(id: string, fields: Partial<SessionMeta> = {}): SessionMeta {
  return { id, workspaceId: 'ws', name: `Title ${id}`, ...fields }
}
function metaMap(...metas: SessionMeta[]): Map<string, SessionMeta> {
  return new Map(metas.map(m => [m.id, m]))
}

describe('UA2.4 — deriveBoardTasks', () => {
  it('POSITIVE — a top-level session is a tile; needs-review defaults to the In Progress column', () => {
    const [tile] = deriveBoardTasks(metaMap(meta('a', { sessionStatus: 'needs-review' })), STATUSES_BY_ID)
    expect(tile).toMatchObject({ id: 'a', title: 'Title a', column: 'in-progress', statusId: 'needs-review' })
  })

  it('POSITIVE — a persisted kanbanColumn wins over the status default (placement is independent of the badge)', () => {
    const [tile] = deriveBoardTasks(metaMap(meta('a', { sessionStatus: 'todo', kanbanColumn: 'done' })), STATUSES_BY_ID)
    expect(tile?.column).toBe('done')
    expect(tile?.statusId).toBe('todo')
  })

  it('NEGATIVE — an unknown status lands in ToDo; no status reads as todo', () => {
    const tiles = deriveBoardTasks(metaMap(meta('a', { sessionStatus: 'weird' }), meta('b')), STATUSES_BY_ID)
    expect(tiles.map(t => [t.id, t.column, t.statusId])).toEqual([
      ['a', 'todo', 'weird'],
      ['b', 'todo', 'todo'],
    ])
  })

  it('UA3.6 POSITIVE — a spec-backed tile shows one row per DAG node: run children bound, the rest pending', () => {
    const tiles = deriveBoardTasks(
      metaMap(
        meta('orch', { taskSlug: 'ship-it', taskNodeCount: 2 }),
        meta('run-a', { parentSessionId: 'orch', taskNodeId: 'a', createdAt: 10, messageCount: 2 })
      ),
      STATUSES_BY_ID,
      { specNodesBySlug: new Map([['ship-it', [{ id: 'a', title: 'Build' }, { id: 'b', title: 'Verify', model: 'm-b' }]]]) }
    )
    expect(tiles[0]?.subtasks.map(s => [s.id, s.sessionId, s.runState])).toEqual([
      ['run-a', 'run-a', 'done'],
      ['node:b', undefined, 'pending'],
    ])
    // The merged list holds every node, so the header count is not the denominator.
    expect(tiles[0]?.subtaskTotal).toBeUndefined()
  })

  it('UA3.6 NEGATIVE — a slug with no fetched nodes (or no slug) keeps the children-only rows and the node count', () => {
    const map = metaMap(
      meta('orch', { taskSlug: 'not-fetched', taskNodeCount: 3 }),
      meta('c1', { parentSessionId: 'orch', createdAt: 5 })
    )
    const [tile] = deriveBoardTasks(map, STATUSES_BY_ID, { specNodesBySlug: new Map([['other', [{ id: 'x', title: 'X' }]]]) })
    expect(tile?.subtasks.map(s => s.id)).toEqual(['c1'])
    expect(tile?.subtaskTotal).toBe(3)
  })

  it('NEGATIVE — hidden, archived, draft and child sessions are not tiles; a child is a subtask row of its parent', () => {
    const tiles = deriveBoardTasks(
      metaMap(
        meta('parent'),
        meta('hidden', { hidden: true }),
        meta('archived', { isArchived: true }),
        meta('draft', { taskDraft: true }),
        meta('child-2', { parentSessionId: 'parent', createdAt: 20, messageCount: 0 }),
        meta('child-1', { parentSessionId: 'parent', createdAt: 10, messageCount: 3 })
      ),
      STATUSES_BY_ID
    )
    expect(tiles.map(t => t.id)).toEqual(['parent'])
    expect(tiles[0]?.subtasks.map(s => [s.id, s.sessionId, s.runState])).toEqual([
      ['child-1', 'child-1', 'done'],
      ['child-2', 'child-2', 'pending'],
    ])
  })
})

function task(id: string, column: string, createdAt: number, extra: Partial<KanbanTask> = {}): KanbanTask {
  return { id, title: `Tile ${id}`, column, statusId: 'todo', model: 'claude-opus-4-7', subtasks: [], createdAt, ...extra }
}

/** Exactly the callbacks the Phase 3 container (KanbanBoardContainer.tsx) hands the board. */
const CONTAINER_CALLBACKS = {
  onChangeStatus: () => {},
  onTaskClick: () => {},
  onEditTask: () => {},
  onToggleSubtasks: () => {},
  onSubtaskClick: () => {},
  onAddSubtask: () => {},
  onCreateTask: () => {},
  onMoveTask: () => {},
  onSelectDropStatus: () => {},
}

function renderBoard(tasks: KanbanTask[], callbacks: Record<string, unknown> = CONTAINER_CALLBACKS, expanded: string[] = []): string {
  // UB14.52: the first column's header "+" is v0.15.1's IconButton with a tooltip, which needs the app root's provider.
  return renderToStaticMarkup(
    <I18nextProvider i18n={testI18n}>
      <TooltipProvider>
        <KanbanBoard
          columns={KANBAN_COLUMNS}
          tasks={tasks}
          projectsById={new Map()}
          statusesById={STATUSES_BY_ID}
          statuses={STATUSES}
          expandedTaskIds={new Set(expanded)}
          {...callbacks}
        />
      </TooltipProvider>
    </I18nextProvider>
  )
}

/** The markup of one column: from its header label to the next column's. */
function columnSegment(html: string, label: string, nextLabel?: string): string {
  const start = html.indexOf(`>${label}<`)
  expect(start).toBeGreaterThan(-1)
  const end = nextLabel ? html.indexOf(`>${nextLabel}<`, start) : html.length
  return html.slice(start, end)
}

describe('UA2.4 — KanbanBoard', () => {
  it('POSITIVE — newest first within a column', () => {
    const html = renderBoard([task('old', 'todo', 1), task('new', 'todo', 3), task('mid', 'todo', 2)])
    const todo = columnSegment(html, en['kanban.column.todo']!, en['kanban.column.inProgress'])
    expect(todo.indexOf('Tile new')).toBeLessThan(todo.indexOf('Tile mid'))
    expect(todo.indexOf('Tile mid')).toBeLessThan(todo.indexOf('Tile old'))
  })

  it('BOUNDARY — an unknown stored column falls back to the first column', () => {
    const html = renderBoard([task('lost', 'col-deleted', 1), task('done-tile', 'done', 2)])
    const todo = columnSegment(html, en['kanban.column.todo']!, en['kanban.column.inProgress'])
    const done = columnSegment(html, en['kanban.column.done']!)
    expect(todo).toContain('Tile lost')
    expect(done).toContain('Tile done-tile')
    expect(done).not.toContain('Tile lost')
  })

  const withPendingSubtask = task('t', 'todo', 1, {
    subtasks: [{ id: 'c', sessionId: 'c', title: 'Child', runState: 'pending', model: 'claude-opus-4-7' }],
  })
  const runLabel = en['kanban.runSubtasks']!
  const editorLabels = [en['kanban.editTask']!, en['kanban.addSubtask']!]

  it('UA3.6 POSITIVE — with the container\'s callbacks a tile renders the edit (Pencil) and add-subtask (Plus) controls', () => {
    const html = renderBoard([withPendingSubtask], CONTAINER_CALLBACKS, ['t'])
    for (const label of editorLabels) expect(html).toContain(label)
    // The board itself renders: the tile and its subtask row are there.
    expect(html).toContain('Tile t')
    expect(html).toContain('Child')
  })

  it('NEGATIVE — with the container\'s callbacks no tile renders the Play control (UA4.4)', () => {
    const html = renderBoard([withPendingSubtask], CONTAINER_CALLBACKS, ['t'])
    expect(html).not.toContain(runLabel)
  })

  it('CONTROL — the same board WITH the withheld Play callback renders it (the detector can fail)', () => {
    const html = renderBoard([withPendingSubtask], { ...CONTAINER_CALLBACKS, onRunSubtasks: () => {} }, ['t'])
    expect(html).toContain(runLabel)
  })

  it('UA3.6 + UA4.4 + UA5.10 — the container mounts the TaskEditor and hands the board the editor, add-subtask and Play callbacks, and the column editor only for a focused project', () => {
    const source = readFileSync(join(KANBAN_DIR, 'KanbanBoardContainer.tsx'), 'utf8')
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
    const board = code.slice(code.indexOf('<KanbanBoard'), code.indexOf('/>', code.indexOf('<KanbanBoard')))
    expect(board).toContain('onMoveTask={handleMoveTask}')
    for (const prop of ['onEditTask={handleEditTask}', 'onAddSubtask={handleAddSubtask}', 'onRunSubtasks={handleRunSubtasks}', 'subtaskModelGroups=']) {
      expect(board).toContain(prop)
    }
    // UA5.10: the column editor's callbacks reach the board only behind the focused project (one project selected).
    const editorSpread = board.slice(board.indexOf('{...(editingProject'))
    expect(board).toContain('{...(editingProject')
    for (const prop of ['onUpdateColumn: handleUpdateColumn', 'onRemoveColumn: handleRemoveColumn', 'onAddColumn: handleAddColumn']) {
      expect(editorSpread).toContain(prop)
      expect(board.slice(0, board.indexOf('{...(editingProject'))).not.toContain(prop.split(':')[0])
    }
    for (const token of ['<TaskEditor', 'kanbanEditorTargetAtom', "setEditorTarget({ mode: 'create', initialProjectId: firstFilteredProjectId(projectFilter) })", 'getTask(', 'startTaskRun(', 'onOpenChildSession=', '<RunConfirmationDialog']) {
      expect(code).toContain(token)
    }
    // UA4.4: Play runs through the run confirmation, never `runTask` directly.
    for (const token of ['.runTask(', 'getTaskResults', 'generateTask']) {
      expect(code).not.toContain(token)
    }
  })
})

/**
 * UA12.46 — upstream's `meta.model ?? DEFAULT_MODEL` put an Anthropic name ("Opus 4.8") on
 * every tile whose session names no model, so a quick-add task on a Nessy Gateway workspace
 * read "Opus 4.8" though its first turn runs the connection's default (`coder`). A tile now
 * shows the model the session WILL use, resolved the way the composer resolves it
 * (`ChatPage.tsx` `effectiveModel`: the session's model, else its effective connection's
 * `defaultModel`; nothing for a connection that is gone), with a gateway id under its alias
 * (`model-catalog.ts` adaptation 2) — or no model chip at all.
 */
describe('UA12.46 — a session with no model shows the model its connection will use, never DEFAULT_MODEL', () => {
  const GATEWAY = {
    slug: 'nessy-gateway',
    name: 'Nessy Gateway',
    providerType: 'pi',
    baseUrl: NESTOR_GATEWAY_CHAT_BASE_URL,
    models: [
      { id: 'tgpt/rotating-flagship-0731', name: 'Flagship', shortName: 'coder' },
      { id: 'tgpt/rotating-small-0731', name: 'Small', shortName: 'fast' },
    ] as LlmConnectionWithStatus['models'],
    defaultModel: 'tgpt/rotating-flagship-0731',
  }
  const CODEX = { slug: 'codex', name: 'Codex', providerType: 'codex-runtime', models: ['gpt-5.3-codex'], defaultModel: 'gpt-5.3-codex' }
  const NO_DEFAULT = { slug: 'bare', name: 'Bare', providerType: 'pi', baseUrl: 'https://llm.example.test/v1' }
  const context = (extra: Partial<BoardDeriveContext> = {}): BoardDeriveContext => ({
    connections: [GATEWAY, CODEX, NO_DEFAULT],
    workspaceDefaultConnection: 'nessy-gateway',
    ...extra,
  })
  const tileOf = (fields: Partial<SessionMeta>, ctx: BoardDeriveContext = context()) =>
    deriveBoardTasks(metaMap(meta('a', fields)), STATUSES_BY_ID, ctx)[0]!

  it('the defect — { llmConnection: nessy-gateway } with no model names the gateway alias (Coder), not DEFAULT_MODEL', () => {
    const tile = tileOf({ llmConnection: 'nessy-gateway' })
    expect(tile.model).toBe('coder')
    expect(tile.model).not.toBe(DEFAULT_MODEL)
    const html = renderBoard([tile])
    expect(html).toContain('>Coder<')
    expect(html).not.toContain(getModelDisplayName(DEFAULT_MODEL))
  })

  it('POSITIVE — a session with a model keeps it (registry and gateway alias alike)', () => {
    expect(tileOf({ llmConnection: 'nessy-gateway', model: 'claude-opus-4-7' }).model).toBe('claude-opus-4-7')
    expect(tileOf({ llmConnection: 'nessy-gateway', model: 'fast' }).model).toBe('fast')
  })

  it('a session with no connection runs on the workspace default connection: its model, and its icon on the chip', () => {
    const tile = tileOf({})
    expect(tile.model).toBe('coder')
    expect(tile.connection?.providerType).toBe('pi')
    expect(tile.connection?.baseUrl).toBe(NESTOR_GATEWAY_CHAT_BASE_URL)
    // The runtime chip still reads the session's own connection only (UA2.5), so none here.
    expect(tile.runtime).toBeUndefined()
    expect(tileOf({}, context({ workspaceDefaultConnection: 'codex' })).model).toBe('gpt-5.3-codex')
  })

  it('NEGATIVE — no resolvable model shows no model chip: a connection that is gone, or one with no default', () => {
    const gone = tileOf({ llmConnection: 'deleted-connection' })
    expect(gone.model).toBeUndefined()
    expect(renderBoard([gone])).not.toContain(getModelDisplayName(DEFAULT_MODEL))
    expect(tileOf({ llmConnection: 'bare' }).model).toBeUndefined()
    expect(tileOf({}, { connections: [] }).model).toBeUndefined()
    // CONTROL — the same tile WITH a model renders its chip, so the absence above is the model's.
    expect(renderBoard([{ ...gone, model: 'claude-opus-4-7' }])).toContain(getModelDisplayName('claude-opus-4-7'))
  })

  it('subtask rows: a child with no model shows its own connection\'s model; a never-run spec node with none, the workspace default\'s', () => {
    const [tile] = deriveBoardTasks(
      metaMap(
        meta('orch', { taskSlug: 'ship-it', llmConnection: 'nessy-gateway' }),
        meta('run-a', { parentSessionId: 'orch', taskNodeId: 'a', llmConnection: 'codex', createdAt: 1, messageCount: 1 }),
        meta('quick', { parentSessionId: 'orch', createdAt: 2 }),
      ),
      STATUSES_BY_ID,
      context({ specNodesBySlug: new Map([['ship-it', [{ id: 'a', title: 'Build' }, { id: 'b', title: 'Verify' }, { id: 'c', title: 'Ship', model: 'fast' }]]]) }),
    )
    expect(tile!.subtasks.map(s => [s.id, s.model])).toEqual([
      ['run-a', 'gpt-5.3-codex'],
      ['node:b', 'coder'],
      ['node:c', 'fast'],
      ['quick', 'coder'],
    ])
    const [bare] = deriveBoardTasks(
      metaMap(meta('orch', { taskSlug: 'ship-it' }), meta('child', { parentSessionId: 'orch', llmConnection: 'deleted-connection' })),
      STATUSES_BY_ID,
      { specNodesBySlug: new Map([['ship-it', [{ id: 'b', title: 'Verify' }]]]) },
    )
    expect(bare!.subtasks.map(s => [s.id, s.model])).toEqual([['node:b', undefined], ['child', undefined]])
    expect(renderBoard([bare!], CONTAINER_CALLBACKS, ['orch'])).not.toContain(getModelShortName(DEFAULT_MODEL))
  })

  it('a never-run spec node with no model shows the model of the connection the node or spec names (the Conductor runs it there)', () => {
    const rows = (nodes: SpecNodeSummary[]) =>
      deriveBoardTasks(
        metaMap(meta('orch', { taskSlug: 'ship-it', llmConnection: 'codex' })),
        STATUSES_BY_ID,
        context({ specNodesBySlug: new Map([['ship-it', nodes]]) }),
      )[0]!.subtasks.map(s => [s.id, s.model])
    // The defect: create_board_task writes `defaults: { llmConnection: 'codex' }` and a node `main` with no model.
    expect(rows([{ id: 'main', title: 'Main', llmConnection: 'codex' }])).toEqual([['node:main', 'gpt-5.3-codex']])
    // NEGATIVE — a node that names no connection runs on the workspace default, so it still shows that one's model.
    expect(rows([{ id: 'main', title: 'Main' }])).toEqual([['node:main', 'coder']])
    // BOUNDARY — a node whose connection is gone resolves through no other one: no chip, never the workspace default's.
    expect(rows([{ id: 'main', title: 'Main', llmConnection: 'deleted-connection' }])).toEqual([['node:main', undefined]])
    // A node's own model still wins over its connection's default.
    expect(rows([{ id: 'main', title: 'Main', llmConnection: 'codex', model: 'fast' }])).toEqual([['node:main', 'fast']])
    // The container's spec fetch carries the node's connection, else the spec default's.
    const source = readFileSync(join(KANBAN_DIR, 'KanbanBoardContainer.tsx'), 'utf8')
    expect(source).toContain('llmConnection: n.llmConnection ?? defaultConnection')
  })

  it('quick-add: the add-subtask composer preselects the workspace default connection\'s model, and with no catalogue none at all', () => {
    const { groups } = buildModelCatalog([{ ...GATEWAY, isAuthenticated: true } as LlmConnectionWithStatus])
    const preselect = resolveCatalogDefaultModel([GATEWAY as LlmConnectionWithStatus], groups, 'nessy-gateway')
    expect(initialSubtaskModel(preselect, groups)).toBe('coder')
    expect(initialSubtaskModel(undefined, [])).toBe('')
    expect(initialSubtaskModel(undefined, [])).not.toBe(DEFAULT_MODEL)
    // The container hands the derivation the workspace default and sends no model it does not have.
    const source = readFileSync(join(KANBAN_DIR, 'KanbanBoardContainer.tsx'), 'utf8')
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
    expect(code).toContain('workspaceDefaultConnection: workspaceDefaultLlmConnection')
    expect(code).toContain('...(model ? { model } : {})')
    for (const file of ['board-derive.ts', 'TaskTile.tsx']) {
      const body = readFileSync(join(KANBAN_DIR, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
      expect(body).not.toContain('DEFAULT_MODEL')
    }
  })
})

describe('UA12.69 — a subtask row carries the connection its model was resolved from (its chip icon matches its name)', () => {
  const GATEWAY = {
    slug: 'nessy-gateway',
    name: 'Nessy Gateway',
    providerType: 'pi',
    baseUrl: NESTOR_GATEWAY_CHAT_BASE_URL,
    models: [
      { id: 'tgpt/rotating-flagship-0731', name: 'Flagship', shortName: 'coder' },
    ] as LlmConnectionWithStatus['models'],
    defaultModel: 'tgpt/rotating-flagship-0731',
  }
  const CODEX = { slug: 'codex', name: 'Codex', providerType: 'codex-runtime', models: ['gpt-5.3-codex'], defaultModel: 'gpt-5.3-codex' }
  const context = (extra: Partial<BoardDeriveContext> = {}): BoardDeriveContext => ({
    connections: [GATEWAY, CODEX],
    workspaceDefaultConnection: 'nessy-gateway',
    ...extra,
  })

  it('POSITIVE — a gateway child row (alias Coder) carries the gateway connection; the chip draws ITS icon', () => {
    const [tile] = deriveBoardTasks(
      metaMap(meta('orch'), meta('kid', { parentSessionId: 'orch', llmConnection: 'nessy-gateway' })),
      STATUSES_BY_ID,
      context(),
    )
    const row = tile!.subtasks.find(s => s.id === 'kid')!
    expect(row.model).toBe('coder')
    expect(row.connection).toEqual({ providerType: 'pi', baseUrl: NESTOR_GATEWAY_CHAT_BASE_URL })
    // The row's chip icon is the connection's — never ModelChip's no-connection Anthropic default
    // (the UA12.46 re-check residue: the name read "Coder" over the wrong brand).
    expect(resolveModelChipIcon(row.model!, row.connection)).toEqual(getProviderIcon('pi', NESTOR_GATEWAY_CHAT_BASE_URL, undefined))
    expect(resolveModelChipIcon(row.model!, row.connection)).not.toEqual(resolveModelChipIcon('coder', undefined))
  })

  it('POSITIVE — a never-run node resolved through its own connection carries that connection', () => {
    const [tile] = deriveBoardTasks(
      metaMap(meta('orch', { taskSlug: 'ship-it' })),
      STATUSES_BY_ID,
      context({ specNodesBySlug: new Map([['ship-it', [{ id: 'main', title: 'Main', llmConnection: 'codex' }]]]) }),
    )
    const row = tile!.subtasks.find(s => s.id === 'node:main')!
    expect(row.model).toBe('gpt-5.3-codex')
    expect(row.connection?.providerType).toBe('codex-runtime')
  })

  it('BOUNDARY — a gone connection resolves through no other: no model AND no connection on the row', () => {
    const [tile] = deriveBoardTasks(
      metaMap(meta('orch'), meta('kid', { parentSessionId: 'orch', llmConnection: 'deleted-connection' })),
      STATUSES_BY_ID,
      context(),
    )
    const row = tile!.subtasks.find(s => s.id === 'kid')!
    expect(row.model).toBeUndefined()
    expect(row.connection).toBeUndefined()
    // A child naming its own registry model carries none: the chip resolves that icon from the registry.
    const [owned] = deriveBoardTasks(
      metaMap(meta('orch'), meta('kid2', { parentSessionId: 'orch', model: 'claude-opus-4-7' })),
      STATUSES_BY_ID,
      context(),
    )
    expect(owned!.subtasks.find(s => s.id === 'kid2')?.connection).toBeUndefined()
  })

  // Follow-up (2026-10-08 verification, findings/UA12.69.md, both lenses): the common gateway case NAMES its alias —
  // a Conductor child runs `node.model ?? spec.defaults.model` (TaskRunner) and the container folds defaults.model
  // into every pending node — and resolveSessionTaskModel returns no connection for a session naming its own model,
  // so those rows drew "Coder" over ModelChip's Anthropic default while the tile (deriveTileAttention) drew the
  // gateway's. A row now carries its OWN known connection, exactly as the tile does. Icons compare by value
  // (toEqual), never through JSON.stringify, which drops the component.
  const GATEWAY_ICON = getProviderIcon('pi', NESTOR_GATEWAY_CHAT_BASE_URL, undefined)

  it('POSITIVE (follow-up) — a child NAMING the alias on the gateway, and a pending node given it by defaults, draw the gateway icon', () => {
    const [tile] = deriveBoardTasks(
      metaMap(
        meta('orch', { taskSlug: 'ship-it' }),
        meta('kid', { parentSessionId: 'orch', model: 'coder', llmConnection: 'nessy-gateway' }),
      ),
      STATUSES_BY_ID,
      context({ specNodesBySlug: new Map([['ship-it', [{ id: 'p', title: 'Pending', model: 'coder', llmConnection: 'nessy-gateway' }]]]) }),
    )
    const child = tile!.subtasks.find(s => s.id === 'kid')!
    const node = tile!.subtasks.find(s => s.id === 'node:p')!
    expect(child.connection).toEqual({ providerType: 'pi', baseUrl: NESTOR_GATEWAY_CHAT_BASE_URL })
    expect(resolveModelChipIcon(child.model!, child.connection)).toEqual(GATEWAY_ICON)
    expect(node.connection).toEqual({ providerType: 'pi', baseUrl: NESTOR_GATEWAY_CHAT_BASE_URL })
    expect(resolveModelChipIcon(node.model!, node.connection)).toEqual(GATEWAY_ICON)
  })

  it('NEGATIVE (follow-up) — a registry model on the gateway keeps its registry icon; an unknown slug carries no connection', () => {
    const [tile] = deriveBoardTasks(
      metaMap(
        meta('orch'),
        meta('opus', { parentSessionId: 'orch', model: 'claude-opus-4-7', llmConnection: 'nessy-gateway' }),
        meta('lost', { parentSessionId: 'orch', model: 'coder', llmConnection: 'deleted-connection' }),
      ),
      STATUSES_BY_ID,
      context(),
    )
    const opus = tile!.subtasks.find(s => s.id === 'opus')!
    expect(resolveModelChipIcon(opus.model!, opus.connection)).toEqual(resolveModelChipIcon('claude-opus-4-7', undefined))
    expect(resolveModelChipIcon(opus.model!, opus.connection)).not.toEqual(GATEWAY_ICON)
    expect(tile!.subtasks.find(s => s.id === 'lost')?.connection).toBeUndefined()
  })
})

describe('UA12.91 — the woke badge re-reads a beat after each trigger, not only at the next one', () => {
  // The woke entry is appended by the runner's completion seam, which the server reaches AFTER the
  // turn end that flips `taskChildTurnsKey` (SessionManager `onProcessingStopped` sends the turn-end
  // event first, then emits `sessionComplete`) — the edge-triggered fetch races the write and can
  // read the run log before the entry lands, with no later edge to retry on. The container fetches
  // for the badge (and the spec rows) a second time, bounded, on the SAME trigger.
  const container = readFileSync(join(KANBAN_DIR, 'KanbanBoardContainer.tsx'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')

  it('NEGATIVE — the fetch schedules its bounded second read, and the cleanup clears it (red at HEAD: one fetch per trigger)', () => {
    expect(container).toContain('WOKE_REFETCH_DELAY_MS = ')
    expect(container).toContain('const repeat = setTimeout(')
    expect(container).toContain('clearTimeout(repeat)')
  })

  it('CONTROL — both reads are the one fetch body, and a stale read cannot write state', () => {
    expect(container.match(/void fetchSpecs\(\)/g)?.length).toBe(2)
    // the pre-existing guard: a superseded effect run drops its late write
    expect(container).toContain('if (cancelled) return')
  })
})
