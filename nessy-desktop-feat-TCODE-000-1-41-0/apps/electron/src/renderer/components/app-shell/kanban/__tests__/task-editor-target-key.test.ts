/**
 * UA12.56 — a mounted `<TaskEditor>` read its bound session once per mount, so switching
 * `kanbanEditorTargetAtom` from target A to target B while it stayed mounted kept A's mode
 * ceiling, folder and unprefilled fields (P-UAaa-1). The fix keys the editor by the target
 * identity (`taskEditorTargetKey`, beside the type it identifies). The editor itself cannot be
 * mounted under `bun test` (its graph reaches `@nessy-agent/ui`; the hook timed out at 69.9 s on
 * 2026-10-02 — the module graph, not an assertion — see `task-editor.test.tsx`), so the control's
 * behavioural half ("set A then B with the editor mounted → B's ceiling and an empty acceptance
 * field") is pinned on this repo's established instrument for this component: the key's identity
 * semantics as real arms, and the container's `key=` wiring as a source pin whose stripped-code
 * regex can fail.
 */
import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { taskEditorTargetKey, type TaskEditorTarget } from '../types'

const KANBAN_DIR = join(import.meta.dir, '..')

describe('taskEditorTargetKey (UA12.56)', () => {
  const editA: TaskEditorTarget = { mode: 'edit', sessionId: 'session-a', taskSlug: 'task-aaa' }
  const editB: TaskEditorTarget = { mode: 'edit', sessionId: 'session-b' }

  it('POSITIVE — targets A and B identify differently: the mounted editor remounts and re-reads B', () => {
    expect(taskEditorTargetKey(editA)).not.toBe(taskEditorTargetKey(editB))
    expect(taskEditorTargetKey(editB)).toBe('edit:session-b:')
  })

  it('BOUNDARY — an equal target keeps its key, so a parent re-render never wipes typed fields', () => {
    expect(taskEditorTargetKey(editA)).toBe(taskEditorTargetKey({ ...editA }))
    expect(taskEditorTargetKey({ mode: 'edit', sessionId: 'session-a' })).toBe(taskEditorTargetKey({ mode: 'edit', sessionId: 'session-a', taskSlug: undefined }))
  })

  it('BOUNDARY — the fields the initializers read are all in the key: slug and the create project pick', () => {
    expect(taskEditorTargetKey({ mode: 'edit', sessionId: 's', taskSlug: 'task-1' })).not.toBe(taskEditorTargetKey({ mode: 'edit', sessionId: 's', taskSlug: 'task-2' }))
    expect(taskEditorTargetKey({ mode: 'create' })).not.toBe(taskEditorTargetKey({ mode: 'create', initialProjectId: 'p1' }))
    expect(taskEditorTargetKey({ mode: 'create', initialProjectId: 'p1' })).not.toBe(taskEditorTargetKey({ mode: 'create', initialProjectId: 'p2' }))
    expect(taskEditorTargetKey({ mode: 'create' })).toBe('create:')
  })
})

describe('UA12.56 — the container keys the mounted editor by the target identity', () => {
  /** TaskEditor.tsx / KanbanBoardContainer.tsx with comments stripped: what runs, not what the header says. */
  const code = readFileSync(join(KANBAN_DIR, 'KanbanBoardContainer.tsx'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')

  it('POSITIVE — the <TaskEditor> JSX carries key={taskEditorTargetKey(editorTarget)} and the import', () => {
    const editorTag = code.slice(code.indexOf('<TaskEditor'), code.indexOf('/>', code.indexOf('<TaskEditor')))
    expect(editorTag).toContain('key={taskEditorTargetKey(editorTarget)}')
    expect(code).toContain("import { taskEditorTargetKey } from './types'")
  })

  it('NEGATIVE — the key is the identity call, never a constant: the pin can fail on the defect it guards', () => {
    const editorTag = code.slice(code.indexOf('<TaskEditor'), code.indexOf('/>', code.indexOf('<TaskEditor')))
    expect(editorTag).not.toMatch(/key="(?!taskEditorTargetKey)/)
    expect(editorTag).not.toMatch(/key=\{\d+\}/)
    expect(editorTag).not.toContain('key={editorTarget}')
  })
})
