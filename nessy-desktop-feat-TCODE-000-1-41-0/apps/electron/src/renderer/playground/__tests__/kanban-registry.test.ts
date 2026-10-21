/**
 * UA2.6 — the Kanban playground (v0.13.4 `registry/kanban.tsx` + `demos/kanban/mock-kanban-data.ts`).
 *
 * - The entries are in category `Kanban`, and `getCategories()` can show them: it silently DROPS a
 *   category missing from `categoryOrder`, so the order list and the spread are pinned in the
 *   index SOURCE (importing the index loads every entry's graph, which bun cannot load — see
 *   `runtime-switch-costs-registry.test.ts`).
 * - The mock data is ours: our five statuses (no `in-progress` status) and all three runtimes.
 * - The tile entry's UA2.5 knobs reach the tile: the needs-input badge and the runtime chip
 *   appear and disappear with them.
 * - UA3.7: the task window (`TaskChatPreview`, its three strings i18n keys) and the Task editor
 *   design mock (`registry/task-editor.tsx`, our slug rule and task path, the create/edit knob).
 *
 * Rendered with `renderToStaticMarkup` (no DOM in this repo's `bun test`), written with
 * `createElement` so the file keeps the plan's `.ts` name.
 */
import { createElement, type ComponentType } from 'react'
import { beforeAll, describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInstance, type i18n as I18nInstance } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { renderToStaticMarkup } from 'react-dom/server'
import { TooltipProvider } from '@nessy-agent/ui/ui/tooltip'
import { kanbanComponents, seedFocusedColumnDefs } from '../registry/kanban'
import { taskEditorComponents } from '../registry/task-editor'
import { mockStatuses, mockStatusesById, mockTaskWindow, mockTasks } from '../demos/kanban/mock-kanban-data'
import { TaskChatPreview } from '@/components/app-shell/kanban/TaskChatPreview'

const PLAYGROUND_DIR = join(import.meta.dir, '..')
const LOCALES_DIR = join(PLAYGROUND_DIR, '..', '..', '..', '..', '..', 'packages', 'shared', 'src', 'i18n', 'locales')
const en = JSON.parse(readFileSync(join(LOCALES_DIR, 'en.json'), 'utf8')) as Record<string, string>
const ru = JSON.parse(readFileSync(join(LOCALES_DIR, 'ru.json'), 'utf8')) as Record<string, string>

let testI18n: I18nInstance
let ruI18n: I18nInstance
beforeAll(async () => {
  testI18n = createInstance()
  await testI18n.use(initReactI18next).init({
    lng: 'en',
    fallbackLng: 'en',
    resources: { en: { translation: en } },
    interpolation: { escapeValue: false },
  })
  ruI18n = createInstance()
  await ruI18n.use(initReactI18next).init({
    lng: 'ru',
    fallbackLng: 'en',
    resources: { en: { translation: en }, ru: { translation: ru } },
    interpolation: { escapeValue: false },
  })
})

function entry(id: string) {
  const found = kanbanComponents.find(c => c.id === id)
  if (!found) throw new Error(`no playground entry ${id}`)
  return found
}

// UB14.52: the board's header "+" and add-column control are v0.15.1 IconButtons with tooltips, which need the
// provider every playground entry renders inside (`PlaygroundEntryFrame`).
function render(component: unknown, props: Record<string, unknown>, i18n: I18nInstance = testI18n): string {
  return renderToStaticMarkup(
    createElement(
      I18nextProvider,
      { i18n },
      createElement(TooltipProvider, null, createElement(component as ComponentType<Record<string, unknown>>, props)),
    ),
  )
}

// UB14.60: the anatomy tile now carries the corner pencil (an IconButton with a tooltip), so it renders in the provider too.
function renderTile(props: Record<string, unknown>): string {
  return render(entry('kanban-task-tile').component, props)
}

describe('UA2.6 — Kanban playground registry', () => {
  it('POSITIVE — every Kanban entry is in category Kanban (board, the open New Task composer — UB14.52 —, tile, task window — UA3.7 — and the Task editor)', () => {
    expect(kanbanComponents.map(c => c.id)).toEqual(['kanban-board', 'kanban-new-task-composer', 'kanban-task-tile', 'kanban-task-window'])
    expect(taskEditorComponents.map(c => c.id)).toEqual(['task-editor'])
    for (const c of [...kanbanComponents, ...taskEditorComponents]) expect(c.category).toBe('Kanban')
  })

  it('NEGATIVE — the categoryOrder line contains \'Kanban\', and the index spreads the entries (else getCategories drops them)', () => {
    const index = readFileSync(join(PLAYGROUND_DIR, 'registry', 'index.ts'), 'utf8')
    expect(index.length).toBeGreaterThan(500)
    const orderLine = index.split('\n').find(line => line.includes('const categoryOrder: Category[]'))
    expect(orderLine).toBeDefined()
    expect(orderLine).toContain("'Kanban'")
    expect(index).toContain('...kanbanComponents,')
    expect(index).toContain('...taskEditorComponents,')
    const types = readFileSync(join(PLAYGROUND_DIR, 'registry', 'types.ts'), 'utf8')
    expect(types).toContain("| 'Kanban' |")
  })

  it('the mock data is ours: five statuses with no in-progress status, every tile on a known status, all three runtimes', () => {
    expect(mockStatuses.map(s => s.id)).toEqual(['backlog', 'todo', 'needs-review', 'done', 'cancelled'])
    for (const task of mockTasks) expect(mockStatusesById.has(task.statusId)).toBe(true)
    expect(new Set(mockTasks.map(t => t.runtime).filter(Boolean))).toEqual(new Set(['pi', 'anthropic', 'codex-runtime']))
    expect(mockTasks.some(t => !t.runtime)).toBe(true)
    expect(mockTasks.some(t => t.needsInput && !t.waitingOn)).toBe(true)
  })

  it('the tile entry\'s knobs reach the tile: needs-input badge and runtime chip on, then off', () => {
    const on = renderTile({ needsInput: true, waitingOn: 'none', runtime: 'codex' })
    expect(on).toContain('data-kanban-needs-input')
    expect(on).toContain(`aria-label="${en['session.attention.waiting']}"`)
    expect(on).toContain('data-kanban-runtime="Codex"')
    const off = renderTile({ needsInput: false, runtime: 'none' })
    expect(off).not.toContain('data-kanban-needs-input')
    expect(off).not.toContain('data-kanban-runtime')
    const question = renderTile({ needsInput: true, waitingOn: 'question', runtime: 'pi' })
    expect(question).toContain(`aria-label="${en['session.attention.waitingOnQuestion']}"`)
    expect(question).toContain('data-kanban-runtime="Pi"')
  })

  it('every variant names only props the entry declares', () => {
    for (const c of [...kanbanComponents, ...taskEditorComponents]) {
      const declared = new Set(c.props.map(p => p.name))
      for (const variant of c.variants ?? []) {
        for (const key of Object.keys(variant.props)) expect(declared.has(key)).toBe(true)
      }
    }
  })
})

describe('UA12.122 — the focused-project variant puts the column editor under the dark sweep', () => {
  // The playground board had no focused-project state, so the column editor (rename, colour,
  // drop-status, remove — `title="Edit column"`), the "add column" affordance (`title="Add
  // column"`) and the "Columns from" header line existed nowhere a dark sweep reaches.
  const boardEntry = entry('kanban-board')
  const EDIT = 'title="Edit column"'
  // UB14.52: v0.15.1's add-column IconButton is named by its aria-label (and its tooltip), no longer a title.
  const ADD = 'aria-label="Add column"'

  it('DEFECT — the focused-project variant renders the column editor and the add-column affordance (red at HEAD: no such state)', () => {
    const html = render(boardEntry.component, { view: 'board', focusedProject: true })
    expect(html).toContain(EDIT)
    expect(html).toContain(ADD)
    expect(html).toContain('Columns from')
    // The focused project's own columns render (a custom column carries its verbatim name).
    expect(html).toContain('Design Review')
  })

  it('CONTROL — the default variant renders neither title (the editor stays behind the focused project)', () => {
    const html = render(boardEntry.component, { view: 'board' })
    expect(html).not.toContain(EDIT)
    expect(html).not.toContain(ADD)
    expect(html).not.toContain('Columns from')
    expect(html).not.toContain('Design Review')
  })

  it('the focused-project prop is declared (the variants-props arm above can then pass a variant that uses it)', () => {
    const declared = boardEntry.props.map(p => p.name)
    expect(declared).toContain('focusedProject')
    expect((boardEntry.variants ?? []).some(v => (v.props as Record<string, unknown>).focusedProject === true)).toBe(true)
  })

  // Follow-up (2026-10-08 verification, findings/UA12.122.md): the arms above mount with the prop
  // ALREADY true, which the real playground never does — it mounts the entry on its defaults
  // (focusedProject false) and the variant picker only calls setProps on the same instance (the
  // frame is keyed by component.id). The column defs were seeded once by a lazy initializer, so
  // after the switch they stayed [] (three built-in columns, no "Design Review", "add column"
  // collapsing the board to one). A prop TRANSITION needs a client re-render this DOM-less
  // `bun test` cannot do, so the seed is a pure function pinned here and the re-seed effect is
  // pinned on the source — the stated residue.
  it('POSITIVE — the seed for a focused project is its own four columns; unfocused is none (a fresh array each call)', () => {
    const seeded = seedFocusedColumnDefs(true)
    expect(seeded.map(c => c.id)).toEqual(['todo', 'col-design', 'in-progress', 'done'])
    expect(seedFocusedColumnDefs(true)).not.toBe(seeded)
    expect(seedFocusedColumnDefs(false)).toEqual([])
  })

  it('WIRING — the column defs re-seed when the focusedProject knob changes, the way `view` re-syncs', () => {
    const src = readFileSync(join(PLAYGROUND_DIR, 'registry', 'kanban.tsx'), 'utf8')
    expect(src).toContain('React.useEffect(() => setColumnDefs(seedFocusedColumnDefs(focusedProject)), [focusedProject])')
    expect(src).toContain('React.useState<KanbanColumnDef[]>(() => seedFocusedColumnDefs(focusedProject))')
  })

  it('NEGATIVE — in Russian the "Columns from" line is the kanban.column.columnsFrom text, not the English literal', () => {
    const html = render(boardEntry.component, { view: 'board', focusedProject: true }, ruI18n)
    expect(html).not.toContain('Columns from')
    expect(html).toContain(ru['kanban.column.columnsFrom']!.replace('{{project}}', 'Engineering'))
  })
})

describe('UA3.7 — the task window (TaskChatPreview) and the Task editor mock', () => {
  const WINDOW_KEYS = ['kanban.taskWindow.orchestratorTag', 'kanban.taskWindow.spawnedSubtasks', 'kanban.taskWindow.replyPlaceholder']

  it('POSITIVE — the task-window entry renders its three strings from en.json, with the orchestrator model chip', () => {
    const html = render(entry('kanban-task-window').component, {})
    for (const key of WINDOW_KEYS) {
      expect(en[key]).toBeTruthy()
      expect(html).toContain(en[key])
    }
    expect(html).toContain(mockTaskWindow.title)
    // A model chip in the tag and one in the input bar, plus one per subtask row.
    expect(html.split('Opus').length - 1).toBeGreaterThanOrEqual(2)
  })

  it('NEGATIVE — in Russian none of the three English literals is left, each key has its ru text', () => {
    const html = render(TaskChatPreview, { ...mockTaskWindow }, ruI18n)
    for (const key of WINDOW_KEYS) {
      expect(ru[key]).toBeTruthy()
      expect(ru[key]).not.toBe(en[key])
      expect(html).toContain(ru[key])
      expect(html).not.toContain(en[key])
    }
  })

  it('NEGATIVE — a task window with no model (UA12.46) draws no model chip; the same window with one does', () => {
    const withModel = render(TaskChatPreview, { ...mockTaskWindow, subtasks: [] })
    const withoutModel = render(TaskChatPreview, { ...mockTaskWindow, model: undefined, subtasks: [] })
    expect(withModel).toContain('Opus')
    expect(withoutModel).not.toContain('Opus')
    expect(withoutModel).toContain(en['kanban.taskWindow.orchestratorTag'])
  })

  it('POSITIVE — the editor mock names OUR task file (tasks/<slug>/task.yaml) and the create header; edit reads "Edit task" and saves', () => {
    const editor = taskEditorComponents[0]
    const create = render(editor.component, { mode: 'manual', target: 'create' })
    expect(create).toContain('tasks/migrate-auth-to-new-session-model/task.yaml')
    expect(create).toContain('New Task')
    expect(create).toContain('Prepare task')
    const edit = render(editor.component, { mode: 'manual', target: 'edit' })
    expect(edit).toContain('Edit task')
    expect(edit).toContain('Save task')
    expect(edit).not.toContain('Prepare task')
  })

  it('NEGATIVE — never upstream\'s workspace/tasks/<slug>.yaml, and a non-Latin title takes our task-<6 hex> slug', () => {
    const editor = taskEditorComponents[0]
    const latin = render(editor.component, { mode: 'generate' })
    expect(latin).not.toContain('workspace/tasks/')
    const cyrillic = render(editor.component, { mode: 'manual', initialTitle: 'Перенести авторизацию' })
    expect(cyrillic).toMatch(/tasks\/task-[0-9a-f]{6}\/task\.yaml/)
    const empty = render(editor.component, { mode: 'manual', initialTitle: '' })
    expect(empty).toContain('tasks/untitled-task/task.yaml')
  })
})

/**
 * UB14.52 — the board entry in every state (base and each variant, as `playgroundEntryProps` merges them) draws
 * v0.15.1's board: neutral column wells with the 28px header (no colour pill, no tinted body), the first column's
 * header "+" named "New Task" (no dashed "+ New Task" button), the segmented List ⇄ Board control, and in the
 * focused-project state the add-column IconButton. The open composer is its own entry (no static board state opens
 * it). The dark sweep of the same entries is `registry-render.test.ts`'s (it enumerates the registry).
 */
describe('UB14.52 — the board entry draws v0.15.1\'s board and columns in every state', () => {
  const board = entry('kanban-board')
  const defaults = Object.fromEntries(board.props.map(p => [p.name, p.defaultValue]))
  const states = [
    { name: '(base state)', props: defaults },
    ...(board.variants ?? []).map(v => ({ name: v.name, props: { ...defaults, ...(v.props as Record<string, unknown>) } })),
  ]
  const WELL = 'flex max-h-full min-h-[200px] flex-col gap-2 rounded-lg bg-fill-hover p-2'
  const PLUS = `aria-label="${en['kanban.newTask']}"`
  /** What the board drew until UB14.52, spelled as its source spelled it. */
  const LEGACY = [
    'border-dashed', // the "+ New Task" button and the dashed add-column square
    'rounded-full px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wider', // the coloured header pill
    'flex flex-1 flex-col gap-2 overflow-y-auto rounded-lg p-2 transition-shadow', // the tinted column body
    'rounded-lg border border-border/60 bg-foreground/[0.02] p-0.5', // the old text toggle
  ] as const
  const count = (html: string, needle: string) => html.split(needle).length - 1

  it('POSITIVE — every board state: one well per column, ONE header "+" (the first column), the segmented toggle; the focused project adds the add-column IconButton', () => {
    expect(states.map(s => s.name)).toEqual(['(base state)', 'Board view', 'Board · stripe only', 'List view (stub)', 'Focused project'])
    for (const state of states) {
      const html = render(board.component, state.props)
      expect(html, state.name).toContain('role="group"')
      if (state.props.view === 'list') {
        expect(count(html, WELL), state.name).toBe(0)
        expect(html, state.name).toContain(`aria-pressed="true" aria-label="${en['kanban.list']}"`)
        continue
      }
      const columns = count(html, 'data-kanban-column="')
      expect(columns, state.name).toBe(state.props.focusedProject ? 4 : 3)
      expect(count(html, WELL), state.name).toBe(columns)
      expect(count(html, PLUS), state.name).toBe(1)
      expect(/<button data-slot="icon-button"[^>]*aria-label="Add column"/.test(html), state.name).toBe(state.props.focusedProject === true)
    }
  })

  it('NEGATIVE (control) — no state keeps the pre-redesign board, and the open composer entry draws the sunken field', () => {
    const hits = states.flatMap(state => {
      const html = render(board.component, state.props)
      return LEGACY.filter(needle => html.includes(needle)).map(needle => `${state.name}: ${needle}`)
    })
    expect(hits).toEqual([])
    const composer = render(entry('kanban-new-task-composer').component, {})
    expect(composer).toContain('<textarea')
    expect(composer).toContain('field-surface')
    expect(composer).toContain(`placeholder="${en['kanban.newTaskTitle']}"`)
    // Control: each legacy needle fires on the shape the board drew until UB14.52.
    const planted = [
      '<button type="button" class="flex items-center justify-center gap-1.5 rounded-lg border border-dashed border-border/70 py-2">',
      '<span class="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wider">',
      '<div class="flex flex-1 flex-col gap-2 overflow-y-auto rounded-lg p-2 transition-shadow" style="background-color:#f00">',
      '<div class="inline-flex items-center gap-0.5 rounded-lg border border-border/60 bg-foreground/[0.02] p-0.5">',
    ].join('')
    expect(LEGACY.filter(needle => planted.includes(needle))).toEqual([...LEGACY])
  })
})

describe('UB14.60 — the tile entry draws v0.15.1\'s card in every state it touches', () => {
  const tile = entry('kanban-task-tile')
  const defaults = Object.fromEntries(tile.props.map(p => [p.name, p.defaultValue]))
  const states = [
    { name: '(base state)', props: defaults },
    ...(tile.variants ?? []).map(v => ({ name: v.name, props: { ...defaults, ...(v.props as Record<string, unknown>) } })),
  ]
  const CHIP = 'inline-flex h-5 items-center gap-1 whitespace-nowrap rounded-xs bg-fill-hover pl-1 pr-1.5 text-label-sm text-secondary'
  /** What the tile drew until UB14.60, spelled as its source spelled it. */
  const LEGACY = [
    'rounded-lg border border-border/60 bg-card shadow-minimal', // the bordered v0.13.4 card
    'animate-ping', // the status badge's live ping
    'border-t border-border/40', // the footer and subtask hairlines
    'rounded-full bg-info/10 px-1.5 py-0.5 text-[11px]', // the needs-input pill
    'bg-foreground/[0.04] text-foreground/70 ring-1', // the old model chip
  ] as const

  it('POSITIVE — every state is the raised card with the hover pencil; each new knob draws its own state', () => {
    expect(states.map(s => s.name)).toEqual([
      '(base state)', 'Expanded', 'Collapsed', 'Needs Review', 'Needs input', 'Needs input · unnamed', 'Gateway model', 'No runtime chip',
      'Working', 'In its column', 'Drag overlay', 'Woke after done',
    ])
    const html = new Map(states.map(state => [state.name, render(tile.component, state.props)]))
    for (const [name, markup] of html) {
      expect(markup, name).toContain('rounded-md bg-raised')
      expect(markup, name).toContain(`aria-label="${en['kanban.editTask']}"`)
    }
    expect(html.get('Working')).toContain('data-kanban-working')
    expect(html.get('Working')).toContain(en['session.runState.working']!)
    expect(html.get('In its column')).not.toContain(CHIP)
    expect(html.get('Drag overlay')).toContain('cursor-grabbing shadow-elev-3')
    expect(html.get('Woke after done')).toContain('data-kanban-woke-after-done')
    expect(html.get('Needs input')).toContain('data-kanban-needs-input')
  })

  it('NEGATIVE (control) — no state keeps the pre-redesign tile; the base state keeps its chip and draws no Working line', () => {
    const hits = states.flatMap(state => {
      const markup = render(tile.component, state.props)
      return LEGACY.filter(needle => markup.includes(needle)).map(needle => `${state.name}: ${needle}`)
    })
    expect(hits).toEqual([])
    const base = render(tile.component, defaults)
    expect(base).toContain(CHIP)
    expect(base).not.toContain('data-kanban-working')
    expect(base).not.toContain('shadow-elev-3')
    // Control: each legacy needle fires on the shape the tile drew until UB14.60.
    const planted = [
      '<div class="group relative overflow-hidden rounded-lg border border-border/60 bg-card shadow-minimal">',
      '<span class="absolute inline-flex h-full w-full animate-ping rounded-full opacity-75"></span>',
      '<div class="mt-2.5 border-t border-border/40 pt-2"></div>',
      '<span class="inline-flex items-center gap-1 rounded-full bg-info/10 px-1.5 py-0.5 text-[11px] font-medium text-info"></span>',
      '<span class="bg-foreground/[0.04] text-foreground/70 ring-1 ring-foreground/[0.06]"></span>',
    ].join('')
    expect(LEGACY.filter(needle => planted.includes(needle))).toEqual([...LEGACY])
  })
})
