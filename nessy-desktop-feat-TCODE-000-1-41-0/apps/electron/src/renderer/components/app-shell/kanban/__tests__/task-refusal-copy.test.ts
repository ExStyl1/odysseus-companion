/**
 * UA12.57 — the tasks:create / tasks:generate refusal codes reached the editor's failure toasts as
 * raw wire codes (`task-slug-taken:task-abc123`); `taskRefusalDescription` maps the row's five codes
 * to localized `tasks.refusal.*` sentences (en+ru) and keeps every unknown error raw. The mapper is
 * pure (real arms below); the editor itself cannot be mounted under `bun test` (its graph reaches
 * `@nessy-agent/ui` — the documented fallback in `task-editor.test.tsx`), so the wiring is pinned on
 * that suite's established instrument: the stripped-code source must route BOTH failure toasts
 * (the create submit's and the generate's) through the mapper.
 */
import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { taskRefusalDescription } from '../task-spec-form'

const KANBAN_DIR = join(import.meta.dir, '..')
const LOCALES_DIR = join(KANBAN_DIR, '..', '..', '..', '..', '..', '..', '..', 'packages', 'shared', 'src', 'i18n', 'locales')
const en = JSON.parse(readFileSync(join(LOCALES_DIR, 'en.json'), 'utf8')) as Record<string, string>
const ru = JSON.parse(readFileSync(join(LOCALES_DIR, 'ru.json'), 'utf8')) as Record<string, string>

/** Records the key and params a real t() would translate, so arms can pin both. */
function fakeT(key: string, params?: Record<string, unknown>): string {
  return params ? `${key}:${JSON.stringify(params)}` : key
}

describe('taskRefusalDescription (UA12.57)', () => {
  it('POSITIVE — each of the five refusal codes maps to its sentence, the slug interpolated', () => {
    expect(taskRefusalDescription('task-slug-taken:task-abc123', fakeT)).toBe('tasks.refusal.taskSlugTaken:{"slug":"task-abc123"}')
    expect(taskRefusalDescription('task-cwd-untrusted', fakeT)).toBe('tasks.refusal.taskCwdUntrusted')
    expect(taskRefusalDescription('project-handle-invalid', fakeT)).toBe('tasks.refusal.projectHandleInvalid')
    expect(taskRefusalDescription('task-attach-connection-locked', fakeT)).toBe('tasks.refusal.taskAttachConnectionLocked')
    expect(taskRefusalDescription('permission-mode-above-remote-ceiling: "plan" (the highest a remote client may set is "default")', fakeT)).toBe('tasks.refusal.permissionModeAboveRemoteCeiling')
  })

  it('BOUNDARY — a code that merely extends a bare one is not matched, and an unknown error stays raw', () => {
    expect(taskRefusalDescription('task-cwd-untrusted-2', fakeT)).toBe('task-cwd-untrusted-2')
    expect(taskRefusalDescription('task-slug-taken-borrowed:task-1', fakeT)).toBe('task-slug-taken-borrowed:task-1')
    expect(taskRefusalDescription('spawn-session-folder-unavailable: /x', fakeT)).toBe('spawn-session-folder-unavailable: /x')
    expect(taskRefusalDescription('', fakeT)).toBe('')
  })

  it('CONTROL — every mapped key exists in BOTH locales with the {{slug}} interpolation', () => {
    for (const key of ['tasks.refusal.taskSlugTaken', 'tasks.refusal.taskCwdUntrusted', 'tasks.refusal.projectHandleInvalid', 'tasks.refusal.taskAttachConnectionLocked', 'tasks.refusal.permissionModeAboveRemoteCeiling']) {
      expect(en[key], key).toBeTruthy()
      expect(ru[key], key).toBeTruthy()
    }
    expect(en['tasks.refusal.taskSlugTaken']).toContain('{{slug}}')
    expect(ru['tasks.refusal.taskSlugTaken']).toContain('{{slug}}')
  })
})

/**
 * UA12.189 — an edit-mode Generate naming an orchestrator archived meanwhile is refused
 * `task-orchestrator-missing` (UA12.93, `tasks:generate`); the generate catch's toast showed that
 * raw code. The map gains the key (en+ru); a code that merely extends it stays raw.
 */
describe('UA12.189 — task-orchestrator-missing maps to its sentence', () => {
  it('POSITIVE — the refusal renders the localized sentence in both locales', () => {
    expect(taskRefusalDescription('task-orchestrator-missing', fakeT)).toBe('tasks.refusal.taskOrchestratorMissing')
    const enT = (key: string) => en[key] ?? key
    const ruT = (key: string) => ru[key] ?? key
    expect(taskRefusalDescription('task-orchestrator-missing', enT)).toBe(en['tasks.refusal.taskOrchestratorMissing']!)
    expect(taskRefusalDescription('task-orchestrator-missing', ruT)).toBe(ru['tasks.refusal.taskOrchestratorMissing']!)
    expect(en['tasks.refusal.taskOrchestratorMissing']).toBeTruthy()
    expect(ru['tasks.refusal.taskOrchestratorMissing']).toBeTruthy()
  })

  it('BOUNDARY — a code that merely extends it stays raw', () => {
    expect(taskRefusalDescription('task-orchestrator-missing-2', fakeT)).toBe('task-orchestrator-missing-2')
  })
})

describe('UA12.57 — the failure toasts of the editor route through the mapper', () => {
  /** TaskEditor.tsx with comments stripped: what runs, not what the header says is withheld. */
  const code = readFileSync(join(KANBAN_DIR, 'TaskEditor.tsx'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')

  it('POSITIVE — the toast descriptions of the create submit and the generate catch go through taskRefusalDescription', () => {
    expect(code.match(/taskRefusalDescription\(/g)?.length).toBe(2)
    expect(code).toContain('description: taskRefusalDescription(err instanceof Error ? err.message : String(err), t)')
    expect(code).toContain('taskRefusalDescription,')
  })

  it('NEGATIVE — exactly two raw-error toasts remain, both run refusals, not tasks:create refusals', () => {
    // UA12.57's scope is the create/generate refusals the row names. The other two raw toasts
    // report RUN failures (the run-control catch, and the create-and-run catch where the task is
    // already saved and only the run failed) — a different refusal set the create-refusal mapper
    // would mis-map. A new raw toast, or a reverted one, pushes this count off exactly two.
    expect(code.match(/description: err instanceof Error \? err\.message : String\(err\) \}/g)?.length).toBe(2)
    expect(code).toContain('toastRunControlFailed')
    expect(code).toContain('toastRunFailed')
  })
})
