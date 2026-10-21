/**
 * UB14.60 (R2-16; upstream v0.15.0/v0.15.1 `kanban/TaskTile.tsx`, `StatusBadge.tsx`, `SubtaskProgress.tsx`, `SubtaskRow.tsx`,
 * `ModelChip.tsx`, `TaskEditor.tsx`, `KanbanBoardContainer.tsx`) — the task card, its chips, the editor and the board
 * container on the redesign.
 *
 * - A card whose status equals its column's (`columnStatusId`, the board's `homeStatusId`) draws no status chip — it
 *   would repeat the column header; a card in another status keeps it. The column hands its `homeStatusId` down.
 * - A processing card in the In Progress column draws v0.15.1's "Working…" line, gated by the live-pulse preference;
 *   the needs-input line (UA2.5, Nessy) takes its place when the session waits on a human (the session row's
 *   precedence), whatever the preference says.
 * - `dragOverlay` lifts the clone to elev-3 with no hover ring; the board's overlay passes it.
 * - The header "New Task" opens the editor seeded with the active project filter (`firstFilteredProjectId`, UA5.10).
 * - The editor takes the v0.15.1 primitives and keeps none of the pre-redesign classes; the generate timeout is still
 *   the shared constant (UB2.9's value), never v0.15.1's literal.
 *
 * Cards render with `renderToStaticMarkup` (no DOM in this repo's `bun test`); the editor and the container are pinned
 * through their SOURCE (`task-editor.test.tsx` says why: their module graph does not load under `bun test`).
 */
import * as React from 'react'
import { beforeAll, describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DndContext } from '@dnd-kit/core'
import { createStore, Provider } from 'jotai'
import { createInstance, type i18n as I18nInstance } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { renderToStaticMarkup } from 'react-dom/server'
import { TooltipProvider } from '@nessy-agent/ui/ui/tooltip'
import { kanbanLivePulseAtom } from '@/atoms/kanban'
import type { SessionStatus } from '@/config/session-status-config'
import { firstFilteredProjectId, KANBAN_UNASSIGNED_PROJECT } from '../project-columns'
import { KanbanColumn } from '../KanbanColumn'
import { KANBAN_COLUMNS } from '../status-column'
import { TaskTile } from '../TaskTile'
import type { KanbanTask } from '../types'

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

const TODO: SessionStatus = { id: 'todo', label: 'TODO', resolvedColor: '#888888', icon: null, iconColorable: true, category: 'open' }
const REVIEW: SessionStatus = { id: 'needs-review', label: 'Needs Review', resolvedColor: '#3366ff', icon: null, iconColorable: true, category: 'open' }
const STATUSES_BY_ID = new Map([[TODO.id, TODO], [REVIEW.id, REVIEW]])

/** The status chip's own class string (v0.15.1 `StatusBadge`), and the picker trigger that wraps it. */
const CHIP = 'inline-flex h-5 items-center gap-1 whitespace-nowrap rounded-xs bg-fill-hover pl-1 pr-1.5 text-label-sm text-secondary'
const PICKER = `aria-label="${en['kanban.changeStatus']}"`
const WORKING = 'data-kanban-working'
const NEEDS_INPUT = 'data-kanban-needs-input'

function task(fields: Partial<KanbanTask> = {}): KanbanTask {
  return { id: 't1', title: 'Ship the card', column: 'todo', statusId: 'todo', subtasks: [], ...fields }
}

function renderTile(props: Partial<React.ComponentProps<typeof TaskTile>>, livePulse?: boolean): string {
  const store = createStore()
  if (livePulse !== undefined) store.set(kanbanLivePulseAtom, livePulse)
  return renderToStaticMarkup(
    <Provider store={store}>
      <I18nextProvider i18n={testI18n}>
        <TooltipProvider>
          <TaskTile task={task()} status={TODO} treatment="stripe" expanded={false} {...props} />
        </TooltipProvider>
      </I18nextProvider>
    </Provider>
  )
}

describe('UB14.60 — a card in its column\'s status skips the status chip', () => {
  it('POSITIVE — status todo in a column whose home status is todo: no chip and no picker', () => {
    const html = renderTile({ columnStatusId: 'todo' })
    expect(html).not.toContain(CHIP)
    expect(html).not.toContain('>TODO<')
    const picker = renderTile({ columnStatusId: 'todo', statuses: [TODO, REVIEW], onStatusChange: () => {} })
    expect(picker).not.toContain(PICKER)
  })

  it('NEGATIVE — a card in another status keeps its chip (and its picker), and so does a card outside any column', () => {
    const review = renderTile({ task: task({ column: 'in-progress', statusId: 'needs-review' }), status: REVIEW, columnStatusId: 'in-progress' })
    expect(review).toContain(CHIP)
    expect(review).toContain('>Needs Review<')
    expect(renderTile({ columnStatusId: undefined })).toContain(CHIP)
    expect(renderTile({ columnStatusId: 'done', statuses: [TODO, REVIEW], onStatusChange: () => {} })).toContain(PICKER)
    // v0.15.1 dropped the badge ping (the Working line carries the live state).
    expect(review).not.toContain('animate-ping')
  })

  it('WIRING — the column hands its homeStatusId to its cards as columnStatusId', () => {
    const column = (homeStatusId: string | undefined) =>
      renderToStaticMarkup(
        <I18nextProvider i18n={testI18n}>
          <TooltipProvider>
            <DndContext>
              <KanbanColumn
                column={KANBAN_COLUMNS[0]!}
                tasks={[task()]}
                projectsById={new Map()}
                statusesById={STATUSES_BY_ID}
                treatment="stripe"
                expandedTaskIds={new Set()}
                homeStatusId={homeStatusId}
              />
            </DndContext>
          </TooltipProvider>
        </I18nextProvider>
      )
    expect(column('todo')).not.toContain(CHIP)
    expect(column(undefined)).toContain(CHIP)
  })
})

describe('UB14.60 — the Working line and the needs-input line', () => {
  const live = task({ column: 'in-progress', statusId: 'needs-review', isProcessing: true })

  it('POSITIVE — a processing card in In Progress draws the Working line in the accent working mark', () => {
    const html = renderTile({ task: live, status: REVIEW }, true)
    expect(html).toContain(WORKING)
    expect(html).toContain(en['session.runState.working']!)
    expect(html).toContain('text-accent')
  })

  it('NEGATIVE — with the live-pulse preference off no Working line renders; nor off In Progress, nor when idle', () => {
    expect(renderTile({ task: live, status: REVIEW }, false)).not.toContain(WORKING)
    expect(renderTile({ task: { ...live, column: 'todo' }, status: REVIEW }, true)).not.toContain(WORKING)
    expect(renderTile({ task: { ...live, isProcessing: false }, status: REVIEW }, true)).not.toContain(WORKING)
  })

  it('POSITIVE — a card that waits on a human shows the needs-input line instead, even with the preference off', () => {
    const waiting = { ...live, needsInput: true, waitingOn: { type: 'bash', toolName: 'Bash' } } as KanbanTask
    for (const pulse of [true, false]) {
      const html = renderTile({ task: waiting, status: REVIEW }, pulse)
      expect(html).toContain(NEEDS_INPUT)
      expect(html).toContain('text-info')
      expect(html).toContain(en['kanban.needsInput']!)
      expect(html).not.toContain(WORKING)
    }
  })
})

describe('UB14.60 — the drag overlay clone', () => {
  it('POSITIVE — dragOverlay lifts the card to elev-3 with the grabbing cursor and no hover ring', () => {
    const html = renderTile({ dragOverlay: true })
    expect(html).toContain('cursor-grabbing shadow-elev-3')
    expect(html).not.toContain('hover:ring-1')
  })

  it('NEGATIVE — a resting card is the raised elev-1 card with the border-strong hover ring', () => {
    const html = renderTile({})
    expect(html).toContain('rounded-md bg-raised')
    expect(html).toContain('shadow-elev-1')
    expect(html).toContain('hover:ring-[color:var(--border-strong)]')
    expect(html).not.toContain('shadow-elev-3')
  })

  it('WIRING — the board\'s overlay clone passes dragOverlay; its wrapper carries only the tilt', () => {
    const board = readFileSync(join(KANBAN_DIR, 'KanbanBoard.tsx'), 'utf8')
    const overlay = board.slice(board.indexOf('<DragOverlay'), board.indexOf('</DragOverlay>'))
    expect(overlay).toContain('<TaskTile')
    expect(overlay).toMatch(/\n\s*dragOverlay\n/)
    expect(overlay).not.toContain('shadow-dragging')
  })
})

/** The container's header block: from the header comment to the board's own wrapper. */
function containerHeader(): string {
  const src = readFileSync(join(KANBAN_DIR, 'KanbanBoardContainer.tsx'), 'utf8')
  const start = src.indexOf('{/* Header (48px')
  const end = src.indexOf('<div className="min-h-0 flex-1">', start)
  if (start < 0 || end < 0) throw new Error('KanbanBoardContainer header block not found')
  return src.slice(start, end)
}

describe('UB14.60 — the board container\'s header', () => {
  it('POSITIVE — the 48px gutter header ends in a secondary Button "New Task" opening the editor seeded with the project filter', () => {
    const header = containerHeader()
    expect(header).toContain('flex h-12 shrink-0 items-center justify-between gap-2 px-gutter')
    const button = header.slice(header.indexOf('<Button'), header.indexOf('</Button>'))
    expect(button).toContain('variant="secondary"')
    expect(button).toContain("onClick={() => setEditorTarget({ mode: 'create', initialProjectId: firstFilteredProjectId(projectFilter) })}")
    expect(button).toContain("{t('kanban.newTask')}")
    // The seed is the first REAL project of the filter.
    expect(firstFilteredProjectId(['p2', 'p1'])).toBe('p2')
  })

  it('NEGATIVE — never upstream\'s projectFilter[0] (the "No project" entry would bind), and no pre-redesign header classes', () => {
    const header = containerHeader()
    expect(header).not.toContain('projectFilter[0]')
    expect(firstFilteredProjectId([KANBAN_UNASSIGNED_PROJECT, 'p2'])).toBe('p2')
    expect(firstFilteredProjectId([KANBAN_UNASSIGNED_PROJECT])).toBeUndefined()
    for (const legacy of ['border-b border-border/50', 'bg-card', 'text-[12.5px]', 'text-sm font-medium']) {
      expect(header, legacy).not.toContain(legacy)
    }
  })
})

/** TaskEditor.tsx with its comments stripped: what runs, not what the header says. */
const editor = readFileSync(join(KANBAN_DIR, 'TaskEditor.tsx'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '')
/** What the editor drew until UB14.60, spelled as its source spelled it. */
const EDITOR_LEGACY = [
  'text-foreground/',
  'bg-foreground/',
  'border-border',
  'indigo-',
  'emerald-',
  'red-500',
  'amber-',
  'shadow-minimal',
  'rounded-[10px]',
  'bg-card',
  'bg-background',
  'text-muted-foreground',
] as const

describe('UB14.60 — the Task editor on the v0.15.1 primitives', () => {
  it('POSITIVE — Button/IconButton/Input/Textarea and the segmented group drive the editor', () => {
    expect(editor).toContain("return <Button type=\"button\" variant={variant} size={size} className={className} {...rest} />")
    for (const needle of ['<SegmentedGroup', '<SegmentedButton', 'aria-pressed={active}', '<Input', '<Textarea', '<IconButton', 'variant="link"', 'bg-sunken']) {
      expect(editor, needle).toContain(needle)
    }
    // Ours, kept: the folder-handle picker and the shared generate timeout.
    expect(editor).toContain('<CompactWorkingDirectorySelector')
    expect(editor).toContain("import { GENERATE_CLIENT_TIMEOUT_MS } from '@nessy-agent/shared/tasks/generate-limits'")
  })

  it('NEGATIVE — no pre-redesign class survives, and no timeout literal (neither v0.14 nor v0.15.1) replaces the shared constant', () => {
    expect(EDITOR_LEGACY.filter(needle => editor.includes(needle))).toEqual([])
    expect(editor).not.toMatch(/GENERATE_CLIENT_TIMEOUT_MS\s*=/)
    expect(editor).not.toContain('620_000')
    expect(editor).not.toContain('200_000')
    // Control: every legacy needle fires on the editor's pre-UB14.60 spelling (the palette names are joined at run
    // time so the raw-palette lint does not read this fixture as a class list).
    const planted = [
      'text-foreground/55 bg-foreground/[0.05] border-border',
      ['bg', 'indigo', '500'].join('-'),
      ['bg', 'emerald', '500/[0.06]'].join('-'),
      ['text', 'red', '500'].join('-'),
      ['text', 'amber', '600'].join('-'),
      'shadow-minimal rounded-[10px] bg-card bg-background text-muted-foreground',
    ].join(' ')
    expect(EDITOR_LEGACY.filter(needle => planted.includes(needle))).toEqual([...EDITOR_LEGACY])
  })
})
