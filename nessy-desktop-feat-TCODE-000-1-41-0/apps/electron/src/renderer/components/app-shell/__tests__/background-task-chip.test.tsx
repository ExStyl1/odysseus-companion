/**
 * UB14.7 — the background-task chips above the composer and the card each opens (v0.15.1 `BackgroundTaskChip` and
 * `ActiveTasksBar`), retargeted from `background-tasks-mount.test.tsx` and `TaskActionMenu.test.ts`, whose menu is
 * gone.
 *
 * WHAT IS RENDERED and what is read. The bar and the card are driven through `renderToStaticMarkup` (this repo's
 * `bun test` has no DOM): the chips, their status words and tints, the card's buttons per state. The card's read is a
 * pure fold (`foldTaskCardOutput` / `readTaskCardOutput`), driven here with an injected read. What a static render
 * cannot reach — a click, an effect, the mounts above the bar — is pinned from source, each link once.
 *
 * WHY THE MOUNTS ARE PINNED BY SOURCE (measured 2026-09-08 for the file this one replaces, and still true):
 * `ActiveOptionBadges` cannot be imported in a shared bun test process. Its own graph reaches the `@nessy-agent/ui`
 * barrel twenty-seven ways — `ChatDisplay`, `Info_Markdown`, `PermissionsDataTable`, `EditPopover`,
 * `config/layout.ts` and the rest — and the barrel's graph ends at the Vite-only
 * `pdfjs-dist/build/pdf.worker.min.mjs?url` specifier bun cannot resolve. A spreadless `mock.module` of the barrel
 * is no way out: the registration is process-wide and wins, a path import returns the same stubbed namespace, and a
 * Proxy stub does not override an earlier registration. `ChatInputZone` is a different wall: it renders, then throws
 * "useEscapeInterrupt must be used within an EscapeInterruptProvider". So the bar and the chip — whose graph keeps
 * to subpaths and loads markdown lazily for exactly this reason (P6.844) — are rendered, and the links above them are
 * read.
 *
 * THE THREE-RUNTIME MATRIX the row's Done-means names, by `canViewTaskOutput` / `canStopTask` and by the card's
 * markup: Pi — live output and Stop (the supervisor store); Claude — Stop, and live output while the CLI's live level
 * names the task (UB9.8); codex — Stop, no live read (no Open: the stated residue).
 */

import * as React from 'react'
import { beforeAll, describe, expect, it } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInstance, type i18n as I18nInstance } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { renderToStaticMarkup } from 'react-dom/server'
import type { BackgroundTaskOutputResult } from '@nessy-agent/shared/protocol'
import { ActiveTasksBar, type BackgroundTask } from '../ActiveTasksBar'
import {
  agentDocument,
  BackgroundTaskCard,
  CARD_TAIL_CHARS,
  canStopTask,
  canViewTaskOutput,
  foldTaskCardOutput,
  formatElapsed,
  readTaskCardOutput,
  TaskCardReadError,
} from '../BackgroundTaskChip'
import { applyBackgroundTaskEvent } from '../../../lib/background-task-rows'

const APP_SHELL = join(import.meta.dir, '..')
const LOCALES_DIR = join(APP_SHELL, '..', '..', '..', '..', '..', '..', 'packages', 'shared', 'src', 'i18n', 'locales')
const en = JSON.parse(readFileSync(join(LOCALES_DIR, 'en.json'), 'utf8')) as Record<string, string>
const ru = JSON.parse(readFileSync(join(LOCALES_DIR, 'ru.json'), 'utf8')) as Record<string, string>

/** A handle of the shape the Pi supervisor mints (`process_` + 32 hex). */
const PI_SHELL_ID = `process_${'0123456789abcdef'.repeat(2)}`

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

function task(overrides: Partial<BackgroundTask> = {}): BackgroundTask {
  return {
    id: 'task-abc12345',
    type: 'agent',
    toolUseId: 'tool-use-1',
    startTime: Date.now() - 45_000,
    elapsedSeconds: 45,
    intent: 'Explore codebase structure',
    status: 'running',
    ...overrides,
  }
}

function renderRows(props: Partial<React.ComponentProps<typeof ActiveTasksBar>> = {}): string {
  return renderToStaticMarkup(
    <I18nextProvider i18n={testI18n}>
      <ActiveTasksBar tasks={[task()]} sessionId="session-1" onStopTask={() => {}} {...props} />
    </I18nextProvider>,
  )
}

function renderCard(row: BackgroundTask, withOverlay = true): string {
  return renderToStaticMarkup(
    <I18nextProvider i18n={testI18n}>
      <BackgroundTaskCard
        task={row}
        sessionId="session-1"
        onStop={() => {}}
        onDismiss={() => {}}
        onClose={() => {}}
        {...(withOverlay ? { onOpenOutput: () => {} } : {})}
      />
    </I18nextProvider>,
  )
}

/** The card's footer buttons, by their visible words, and whether each is disabled. */
function footerButtons(html: string): Array<{ label: string; disabled: boolean }> {
  const footer = html.slice(html.indexOf('<footer'))
  return [...footer.matchAll(/<button([^>]*)>.*?<\/svg>([^<]*)<\/button>/g)].map(m => ({
    label: m[2]!.trim(),
    disabled: /\sdisabled=""/.test(m[1]!),
  }))
}
const labels = (html: string) => footerButtons(html).map(b => b.label)

/** Comment-stripped source: several of these files document the shape they replaced. */
function source(relative: string): string {
  return readFileSync(join(APP_SHELL, relative), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
}

describe('UB14.7 — the chip draws each lifecycle status (v0.15.1 BackgroundTaskChip)', () => {
  it('running: the spinner, the shimmer and the wall-clock elapsed on the composer meta chip', () => {
    const html = renderRows({ tasks: [task({ startTime: Date.now() - 60_000, elapsedSeconds: 45 })] })
    expect(html).toContain('data-task-status="running"')
    expect(html).toContain('animate-shimmer')
    expect(html).toContain('rounded-full')
    // The wall clock (≥ 60 s), not the stale reported 45 s.
    expect(html).toContain('>1m')
    expect(html).not.toContain('>45s<')
    expect(html).toContain('aria-label="Background agent: Explore codebase structure · Running · 1m')
  })

  it('done / failed / stopped: the status word instead of a clock; failed takes the destructive tint', () => {
    const now = Date.now()
    const done = renderRows({ tasks: [task({ status: 'completed', completedAt: now })] })
    expect(done).toContain('>Done<')
    expect(done).toContain('lucide-circle-check')
    expect(done).not.toContain('animate-shimmer')
    const failed = renderRows({ tasks: [task({ status: 'failed', completedAt: now })] })
    expect(failed).toContain('>Failed<')
    expect(failed).toContain('bg-destructive-tint')
    expect(renderRows({ tasks: [task({ status: 'stopped', completedAt: now })] })).toContain('>Stopped<')
  })

  it('stale: "No signal", the info tint, and the hint that it may still be running', () => {
    const html = renderRows({ tasks: [task({ status: 'stale' })] })
    expect(html).toContain('>No signal<')
    expect(html).toContain('bg-info-tint')
    expect(html).toContain('This task may still be running.')
  })

  it('stopping: "Stopping…" and no shimmer, though the task still runs', () => {
    const html = renderRows({ tasks: [task({ stopping: true })] })
    expect(html).toContain('>Stopping…<')
    expect(html).not.toContain('animate-shimmer')
  })

  it('the label is the intent; the task id only when no intent was captured', () => {
    expect(renderRows()).toContain('Explore codebase structure')
    expect(renderRows({ tasks: [task({ intent: undefined })] })).toContain('task-abc12345')
  })
})

describe('the row (v0.15.1 ActiveTasksBar)', () => {
  it('one chip per task, each a popover trigger, in ONE wrapping row', () => {
    const html = renderRows({
      tasks: [task({ id: 'task-agent-1' }), task({ id: PI_SHELL_ID, type: 'shell', intent: 'npm run dev' })],
    })
    expect([...html.matchAll(/data-testid="active-tasks-bar"/g)]).toHaveLength(1)
    expect([...html.matchAll(/aria-haspopup="dialog"/g)]).toHaveLength(2)
    expect(html).toContain('Background command: npm run dev')
    // The row's own opening tag. Upstream's wrapping row replaces our horizontal scroll (R2 default 2).
    const bar = html.slice(0, html.indexOf('>'))
    expect(bar).toContain('data-testid="active-tasks-bar"')
    expect(bar).toContain('flex-wrap')
    expect(bar).not.toContain('overflow-x-auto')
  })

  it('renders nothing at all with no tasks — the composer gets no empty band', () => {
    expect(renderRows({ tasks: [] })).toBe('')
  })

  it('UA12.186 — a dismissed row is not drawn; the row collapses when every row is dismissed', () => {
    const html = renderRows({ tasks: [task({ id: 'hidden-1', intent: 'Hidden scan', dismissedAt: 1 }), task({ id: 'shown-1', intent: 'Shown build' })] })
    expect(html).toContain('Shown build')
    expect(html).not.toContain('Hidden scan')
    expect(renderRows({ tasks: [task({ dismissedAt: 1 })] })).toBe('')
  })
})

/**
 * D1.97 + D1.98 — the scheduled half is drawn by the same row: static chips on the composer's meta-chip material, no
 * popover and no spinner, because neither the stop nor the output route accepts one of these ids.
 */
describe('the scheduled and watched work (kept)', () => {
  it('draws a cron record beside the running chips, in one row', () => {
    const html = renderRows({
      scheduledWork: {
        schemaVersion: 1,
        entries: [
          { id: 'cron-nightly', type: 'scheduled', status: 'scheduled', description: 'Nightly digest', schedule: '0 3 * * *', recurring: true },
        ],
      },
    })
    expect(html).toContain('Scheduled')
    expect(html).toContain('cron-nig...')
    expect(html).toContain('Repeats')
    expect([...html.matchAll(/data-testid="active-tasks-bar"/g)]).toHaveLength(1)
    expect([...html.matchAll(/aria-haspopup="dialog"/g)]).toHaveLength(1)
  })

  it('draws a WATCH under the name the contract uses, with no card and no spinner', () => {
    const html = renderRows({
      tasks: [],
      scheduledWork: { schemaVersion: 1, entries: [{ id: 'monitor-42', type: 'monitor', status: 'running', description: 'watch src/**' }] },
    })
    expect(html).toContain('monitor-...')
    expect(html).toContain('data-testid="scheduled-work-badge"')
    expect(html).not.toContain('aria-haspopup')
  })

  it('says so when the host could not answer, instead of showing an empty row', () => {
    const html = renderRows({ tasks: [], scheduledWork: { schemaVersion: 1, entries: [], unavailable: 'not-supported' } })
    expect(html).toContain('data-testid="scheduled-work-unavailable"')
    expect(html).toContain('could not be read')
  })

  it('renders nothing for an EMPTY page; beside running work the empty sentence rides the row (D1.268)', () => {
    expect(renderRows({ tasks: [], scheduledWork: { schemaVersion: 1, entries: [] } })).toBe('')
    const html = renderRows({ scheduledWork: { schemaVersion: 1, entries: [] } })
    expect(html).toContain('data-testid="scheduled-work-empty"')
    expect(html).toContain('Nothing scheduled')
    const unavailable = renderRows({ scheduledWork: { schemaVersion: 1, entries: [], unavailable: 'session-not-found' } })
    expect(unavailable).not.toContain('data-testid="scheduled-work-empty"')
  })
})

describe('UB14.7 — the three-runtime matrix: which chip offers Open and which offers Stop', () => {
  it('POSITIVE — a running Pi command\'s card offers Open and Stop (the supervisor store reads it live)', () => {
    const row = task({ id: PI_SHELL_ID, type: 'shell', intent: 'bun test --watch' })
    expect(canViewTaskOutput(row)).toBe(true)
    expect(canStopTask(row)).toBe(true)
    const html = renderCard(row)
    expect(labels(html)).toEqual(['Open', 'Copy', 'Dismiss', 'Stop'])
    // Readable, so the card reads: its first frame is the loading skeleton, not "No output".
    expect(html).toContain('aria-busy')
    expect(html).not.toContain('No output')
  })

  it('POSITIVE — UB9.8: a running Claude agent the CLI\'s live level names is read; an ended one whose end left a record too', () => {
    const live = task({ id: 'a1b2c3', listed: true })
    expect(canViewTaskOutput(live)).toBe(true)
    expect(labels(renderCard(live))).toEqual(['Open', 'Copy', 'Dismiss', 'Stop'])
    const ended = task({ id: 'a1b2c3', listed: true, status: 'completed', completedAt: Date.now(), endOutput: true })
    expect(canViewTaskOutput(ended)).toBe(true)
    expect(labels(renderCard(ended))).toEqual(['Open', 'Copy', 'Dismiss'])
  })

  it('NEGATIVE — a running Pi agent task and a codex terminal offer no Open, and the card says it has no output', () => {
    const piAgent = task({ id: 'task_a' })
    const codexTerminal = task({ id: '4242', type: 'shell', intent: 'npm run dev' })
    for (const row of [piAgent, codexTerminal]) {
      expect(canViewTaskOutput(row)).toBe(false)
      const html = renderCard(row)
      expect(labels(html)).toEqual(['Copy', 'Dismiss', 'Stop'])
      expect(html).toContain('No output')
      expect(html).not.toContain('aria-busy')
    }
    // BOUNDARY: one character off the supervisor's shape is not a supervisor handle.
    expect(canViewTaskOutput(task({ id: `${PI_SHELL_ID}0`, type: 'shell' }))).toBe(false)
  })

  it('NEGATIVE — a chip the live set stopped naming (held for its end) offers no Stop and no live read', () => {
    const held = task({ id: 'a1b2c3', listed: true, unlistedAt: Date.now() - 1_000 })
    expect(canStopTask(held)).toBe(false)
    expect(canViewTaskOutput(held)).toBe(false)
    expect(labels(renderCard(held))).toEqual(['Copy', 'Dismiss'])
  })

  it('UA12.210 — an ENDED chip offers Open only when its end left something to read, through the row reducer', () => {
    const live = (id: string): BackgroundTask => ({ id, type: 'shell', toolUseId: `tu-${id}`, startTime: 1, elapsedSeconds: 0, status: 'running' })
    const [codex] = applyBackgroundTaskEvent([live('4242')], 'task_completed', { taskId: '4242', status: 'completed' }, 10)
    expect(canViewTaskOutput(codex!)).toBe(false)
    const [killed] = applyBackgroundTaskEvent([live('4243')], 'shell_killed', { shellId: '4243' }, 10)
    expect(canViewTaskOutput(killed!)).toBe(false)
    const [claude] = applyBackgroundTaskEvent([live('bmvrmj7vs')], 'task_completed', { taskId: 'bmvrmj7vs', status: 'completed', outputFile: '/tmp/t/bmvrmj7vs.output' }, 10)
    expect(canViewTaskOutput(claude!)).toBe(true)
    const [pi] = applyBackgroundTaskEvent([live(PI_SHELL_ID)], 'shell_killed', { shellId: PI_SHELL_ID }, 10)
    expect(canViewTaskOutput(pi!)).toBe(true)
  })

  it('UA12.18 — Stop is for a live chip (running or stale), never an ended one; Dismiss is on every chip', () => {
    expect(canStopTask({ status: 'running' })).toBe(true)
    expect(canStopTask({ status: 'stale' })).toBe(true)
    for (const status of ['completed', 'failed', 'stopped'] as const) expect(canStopTask({ status })).toBe(false)
    const ended = renderCard(task({ status: 'failed', completedAt: Date.now() }))
    expect(labels(ended)).toEqual(['Copy', 'Dismiss'])
  })

  it('Stopping…: the Stop button says so and is disabled', () => {
    const buttons = footerButtons(renderCard(task({ id: PI_SHELL_ID, type: 'shell', stopping: true })))
    expect(buttons.at(-1)).toEqual({ label: 'Stopping…', disabled: true })
  })

  it('no overlay host (the playground\'s case): Open is hidden, Copy and Stop stay', () => {
    expect(labels(renderCard(task({ id: PI_SHELL_ID, type: 'shell' }), false))).toEqual(['Copy', 'Dismiss', 'Stop'])
  })

  it('an unreadable ended task shows its end summary; the header names type, status and elapsed', () => {
    const html = renderCard(task({ status: 'completed', completedAt: Date.now(), summary: 'Summarised 14 entries' }))
    expect(html).toContain('Summarised 14 entries')
    expect(html).toContain('Background agent · Done · ')
  })

  it('a running task\'s live step count (task_activity) shows under its title', () => {
    expect(renderCard(task({ activity: { toolUses: 23 } }))).toContain('23 steps')
    expect(renderCard(task({ status: 'completed', completedAt: Date.now(), activity: { toolUses: 23 } }))).not.toContain('23 steps')
  })
})

describe('UB14.7 — the card reads through OUR route, folded onto v0.15.1\'s output', () => {
  it('unknown-task is upstream\'s null; any other refusal throws with its reason (the card offers Retry)', () => {
    expect(foldTaskCardOutput(null, { success: false, reason: 'unknown-task' })).toEqual({ output: null })
    expect(() => foldTaskCardOutput(null, { success: false, reason: 'unavailable', error: 'process-recovery-host-owner-unavailable' }))
      .toThrow(TaskCardReadError)
    expect(() => foldTaskCardOutput(null, undefined)).toThrow('failed')
  })

  it('a Claude digest is shown as it came', () => {
    const digest = { kind: 'agent' as const, message: 'Done.', steps: [{ tool: 'Read', label: 'a.ts' }], truncated: false }
    expect(foldTaskCardOutput(null, { success: true, output: 'Done.', digest })).toEqual({ output: digest })
  })

  it('the Pi store is read from where the last read ended, and its chunks are appended', async () => {
    const asked: Array<number | undefined> = []
    const answers: BackgroundTaskOutputResult[] = [
      { success: true, output: 'one\n', nextCursor: 4, isRunning: true },
      { success: true, output: 'two\n', nextCursor: 8, isRunning: true },
    ]
    const read = async (cursor?: number) => { asked.push(cursor); return answers.shift()! }
    const first = await readTaskCardOutput(read, null)
    const second = await readTaskCardOutput(read, first)
    expect(asked).toEqual([undefined, 4])
    expect(second).toEqual({ output: { kind: 'text', text: 'one\ntwo\n', truncated: false }, cursor: 8 })
  })

  it('BOUNDARY — the card keeps the last 64 KiB and says it cut; a whole-record read replaces', () => {
    const big = 'x'.repeat(CARD_TAIL_CHARS + 10)
    const folded = foldTaskCardOutput(null, { success: true, output: big, nextCursor: big.length })
    expect(folded.output).toEqual({ kind: 'text', text: big.slice(-CARD_TAIL_CHARS), truncated: true })
    const replaced = foldTaskCardOutput(folded, { success: true, output: 'final record', isRunning: false })
    expect(replaced).toEqual({ output: { kind: 'text', text: 'final record', truncated: false } })
  })

  it('the card and its Open both read through the session-scoped readBackgroundTaskOutput — never getBackgroundTaskOutput', () => {
    const chip = source('BackgroundTaskChip.tsx')
    expect(chip).toContain('cursor => window.electronAPI.readBackgroundTaskOutput(sessionId, task.id, cursor)')
    const open = chip.slice(chip.indexOf('const handleOpen'), chip.indexOf('let body'))
    expect(open).toContain('requestTaskOutput(task, {')
    expect(open).toContain('readOutput: (taskId, cursor) => window.electronAPI.readBackgroundTaskOutput(sessionId, taskId, cursor)')
    // UB12.79 — an agent's digest goes up as itself (the markdown overlay), anything else as our terminal data.
    expect(open).toContain("onOpenOutput(task, outcome.agent ?? { kind: 'text', ...outcome.data })")
    expect(open).toContain('toast.error(t(outcome.failureKey))')
    expect(chip).not.toContain('getBackgroundTaskOutput')
    expect(chip).not.toContain('getTaskOutput(')
  })

  it('UB12.79 — agentDocument (v0.15.1): the message, a rule, then the steps under their heading, a source tool by its source', () => {
    const digest = {
      kind: 'agent' as const,
      message: 'Found **two** callers.',
      steps: [{ tool: 'Read', label: 'a.ts' }, { tool: 'mcp__linear__list_issues', label: 'open bugs' }, { tool: 'Grep' }],
      truncated: false,
    }
    expect(agentDocument(digest, 'Recent steps')).toBe(
      'Found **two** callers.\n\n---\n\n**Recent steps**\n\n- **Read** a.ts\n- **linear** open bugs\n- **Grep**',
    )
  })

  it('UB12.79 BOUNDARY — no message yet draws the steps alone; no steps draws the message alone (no rule, no heading)', () => {
    const steps = [{ tool: 'Bash', label: 'bun test' }]
    expect(agentDocument({ kind: 'agent', message: null, steps, truncated: false }, 'Recent steps')).toBe('**Recent steps**\n\n- **Bash** bun test')
    expect(agentDocument({ kind: 'agent', message: 'Done.', steps: [], truncated: false }, 'Recent steps')).toBe('Done.')
  })

  it('formatElapsed is upstream\'s compact clock', () => {
    expect([45, 169, 3600, 3723].map(formatElapsed)).toEqual(['45s', '2m 49s', '1h', '1h 2m'])
  })
})

describe('the chain from the atom to the host (kept from the mount suite, retargeted)', () => {
  it('TaskActionMenu.tsx is gone, and nothing imports it', () => {
    expect(existsSync(join(APP_SHELL, 'TaskActionMenu.tsx'))).toBe(false)
    for (const file of ['ActiveTasksBar.tsx', 'ActiveOptionBadges.tsx', 'BackgroundTaskChip.tsx', 'input/ChatInputZone.tsx', 'ChatDisplay.tsx']) {
      expect(source(file), file).not.toContain("from './TaskActionMenu'")
    }
  })

  it('ActiveTasksBar is the ONLY product component that renders a BackgroundTaskChip', () => {
    expect(source('ActiveTasksBar.tsx')).toContain('<BackgroundTaskChip')
    for (const file of ['ActiveOptionBadges.tsx', 'input/ChatInputZone.tsx', 'ChatDisplay.tsx']) {
      expect(source(file), `${file} renders BackgroundTaskChip directly`).not.toContain('<BackgroundTaskChip')
    }
  })

  it('the bar routes Stop, Dismiss and Open by v0.15.1\'s props (UB12.79), and Dismiss still MARKS the row (UA12.186)', () => {
    const bar = source('ActiveTasksBar.tsx')
    const mount = bar.slice(bar.indexOf('<BackgroundTaskChip'), bar.indexOf('/>', bar.indexOf('<BackgroundTaskChip')))
    expect(mount).toContain('onStop={(target) => onStopTask?.(target)}')
    expect(mount).toContain('onDismissTask?.(target)')
    expect(mount).toContain('onOpenOutput={onOpenTaskOutput}')
    expect(mount).toContain('open={openTaskId === task.id}')
    // The mark, never upstream's removal: a removed row would come back with the next live set.
    const hook = readFileSync(join(APP_SHELL, '..', '..', 'hooks', 'useBackgroundTasks.ts'), 'utf8')
    const dismiss = hook.slice(hook.indexOf('const dismissTask = useCallback'))
    expect(dismiss.slice(0, 200)).toContain('setTasks(prev => dismissBackgroundTask(prev, task.id))')
  })

  it('the ticker keeps the open card\'s chip (keepId) and still asks the supervisor about a shell (UA12.192)', () => {
    const bar = source('ActiveTasksBar.tsx')
    const tick = bar.slice(bar.indexOf('const interval = setInterval('), bar.indexOf('return () => clearInterval(interval)'))
    expect(tick).toContain('advanceBackgroundTaskChips(prev, now, openTaskIdRef.current)')
    expect(tick).toContain('probeShellLiveness(tasksRef.current, now, askedRef.current,')
    expect(tick).toContain('api.readBackgroundTaskOutput(sessionId, taskId, Number.MAX_SAFE_INTEGER)')
    expect(tick).toContain('confirmBackgroundTasksLive(prev, ids, Date.now())')
  })

  it('ActiveOptionBadges renders the bar with the tasks, the scheduled read, the stop route and the overlay host', () => {
    const badges = source('ActiveOptionBadges.tsx')
    const at = badges.indexOf('<ActiveTasksBar')
    expect(at, 'ActiveOptionBadges no longer renders ActiveTasksBar — the mount is gone').toBeGreaterThan(-1)
    const mount = badges.slice(at, badges.indexOf('/>', at))
    for (const prop of ['tasks={tasks}', 'scheduledWork={scheduledWork}', 'onStopTask={onStopTask}', 'onDismissTask={onDismissTask}', 'onOpenTaskOutput={onOpenTaskOutput}']) {
      expect(mount).toContain(prop)
    }
    const flat = badges.replace(/\s+/g, '')
    expect(flat).toContain('useSessionScheduledWork(sessionId,')
    expect(flat).toContain('scheduledWorkRevision(tasks.length,scheduledWorkNudges)')
    // UB14.55 (v0.15.1): the bar is mounted with a session and decides its own visibility — dismissed rows
    // (UA12.186) included, through `isShownBackgroundTask` — so the row above holds no task term of its own.
    expect(badges.slice(badges.lastIndexOf('{sessionId && (', at), at)).toMatch(/^\{sessionId && \(\s*$/)
    expect(source('ActiveTasksBar.tsx')).toContain('const shown = tasks.filter(isShownBackgroundTask)')
  })

  it('ChatInputZone hands the tasks, the stop route and the overlay host down', () => {
    const zone = source('input/ChatInputZone.tsx')
    const mount = zone.slice(zone.indexOf('<ActiveOptionBadges'))
    for (const prop of ['tasks={tasks}', 'onStopTask={onStopTask}', 'onDismissTask={onDismissTask}', 'onOpenTaskOutput={onOpenTaskOutput}']) {
      expect(mount).toContain(prop)
    }
  })

  it('ChatDisplay hands the hook\'s stopTask / dismissTask down and fills the task-output overlay as v0.15.1 (UB12.79)', () => {
    const chatDisplay = source('ChatDisplay.tsx')
    const mount = chatDisplay.slice(chatDisplay.indexOf('<ChatInputZone'))
    expect(mount).toContain('tasks={backgroundTasks}')
    expect(mount).toContain('onStopTask={stopTask}')
    expect(mount).toContain('onDismissTask={dismissTask}')
    expect(mount).toContain('onOpenTaskOutput={handleOpenTaskOutput}')
    expect(chatDisplay).toContain('const { tasks: backgroundTasks, stopTask, dismissTask } = useBackgroundTasks({')
    const handler = chatDisplay.slice(chatDisplay.indexOf('const handleOpenTaskOutput'))
    expect(handler.slice(0, 300)).toContain("setOverlayState({ type: 'task-output', title: task.intent?.trim() || task.id, output })")
    for (const retired of ['onKillTask', 'onShowTerminalOverlay', 'handleShowTaskOutput']) {
      expect(chatDisplay, retired).not.toContain(retired)
    }
  })

  it('the hook\'s two L9 routes stay, and Stop marks the row stopping before it asks', () => {
    const hook = readFileSync(join(APP_SHELL, '..', '..', 'hooks', 'useBackgroundTasks.ts'), 'utf8')
    expect(hook).toContain('window.electronAPI.stopAgentTask(sessionId, id)')
    expect(hook).toContain('window.electronAPI.killShell(sessionId, id)')
    const kill = hook.slice(hook.indexOf('const killTask = useCallback'))
    expect(kill.indexOf('markTaskStopping(prev, taskId, true)')).toBeLessThan(kill.indexOf('await requestTaskStop('))
    expect(kill).toContain('STOP_CONFIRM_TIMEOUT_MS')
    // UB12.79 — v0.15.1's stopTask(task) is that route with the row's OWN type (UA12.135).
    const stop = hook.slice(hook.indexOf('const stopTask = useCallback'))
    expect(stop.slice(0, 200)).toContain("killTask(task.id, task.type === 'shell' ? 'shell' : 'agent')")
  })

  it('the overlay renders every fact the host handed it, on the one close path (L9, kept; UB12.79 its own file)', () => {
    const display = source('ChatDisplay.tsx')
    expect(display).toContain('import type { OpenedTaskOutput, TaskOutputOverlayState } from "./task-output"')
    const at = display.indexOf("overlayState?.type === 'task-output'")
    expect(at).toBeGreaterThan(-1)
    const mount = display.slice(at, display.indexOf("overlayState?.type === 'activity'", at))
    for (const prop of ['<TaskOutputOverlay', 'state={overlayState}', 'tasks={backgroundTasks}', 'onClose={handleCloseOverlay}']) {
      expect(mount, prop).toContain(prop)
    }
    const overlay = source('chat-display/TaskOutputOverlay.tsx')
    const text = overlay.slice(overlay.indexOf('const stillListed'))
    for (const fact of ['<TerminalPreviewOverlay', 'onClose={onClose}', 'output={output.output}', 'exitCode={output.exitCode}',
      'tasks.some(task => task.id === output.taskId)', 'output.isRunning === true && stillListed',
      'title.runningKey ? t(title.runningKey, { subject: title.subject })']) {
      expect(text, fact).toContain(fact)
    }
    expect(text).not.toContain('<DocumentFormattedMarkdownOverlay')
    // The agent arm: upstream's document overlay with the digest as one document and the task's name on a Bot badge.
    const agent = overlay.slice(overlay.indexOf("if (output.kind === 'agent')"), overlay.indexOf('const stillListed'))
    for (const fact of ['<DocumentFormattedMarkdownOverlay', "content={agentDocument(output, t('chat.backgroundTask.recentSteps'))}",
      "typeBadge={{ icon: Bot, label: state.title, variant: 'blue' }}"]) {
      expect(agent, fact).toContain(fact)
    }
  })

  it('the renderer method reaches a real IPC channel', async () => {
    const { RPC_CHANNELS } = await import('@nessy-agent/shared/protocol')
    expect(RPC_CHANNELS.sessions.READ_TASK_OUTPUT).toBe('sessions:readTaskOutput')
    expect(source('../../../transport/channel-map.ts')).toContain('readBackgroundTaskOutput: invoke(RPC_CHANNELS.sessions.READ_TASK_OUTPUT)')
  })
})

describe('UB14.7 — every key the chip reads exists in en and ru; the nine retired ones are gone', () => {
  it('reads only keys both locales carry', () => {
    const chip = readFileSync(join(APP_SHELL, 'BackgroundTaskChip.tsx'), 'utf8')
    const keys = new Set([...chip.matchAll(/'((?:chat|toast|common)\.[A-Za-z.]+)'/g)].map(m => m[1]!))
    expect(keys.size).toBeGreaterThan(20)
    for (const key of keys) {
      const plural = `${key}_one`
      expect(key in en || plural in en, `en: ${key}`).toBe(true)
      expect(key in ru || plural in ru, `ru: ${key}`).toBe(true)
    }
    expect(ru['chat.backgroundTask.steps_few']).toBeDefined()
    expect(ru['chat.backgroundTask.steps_many']).toBeDefined()
  })

  it('the nine keys v0.15.1 removed are removed, in both locales', () => {
    for (const key of ['chat.clickForTaskActions', 'chat.stopTask', 'chat.taskStatusDone', 'chat.taskStatusFailed', 'chat.taskStatusStopped',
      'chat.taskTypeAgent', 'chat.taskTypeShell', 'chat.taskTypeWorkflow', 'toast.failedToLoadTaskOutput']) {
      expect(key in en, `en still has ${key}`).toBe(false)
      expect(key in ru, `ru still has ${key}`).toBe(false)
    }
  })
})
