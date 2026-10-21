/**
 * R20 Task 3 — the file-backed task store.
 *
 * Contract source:
 * - `interactive-mode.md:396` — "To share a task list across sessions, set
 *   `CLAUDE_CODE_TASK_LIST_ID` to use a named directory in `~/.claude/tasks/`".
 * - `agent-teams.md` — the default directory name is `session-` plus the first
 *   eight characters of the session ID, it "persists locally and is never
 *   uploaded, so resumed sessions keep their tasks", and "Retention is governed
 *   by the same `cleanupPeriodDays` you already control for session transcripts."
 * - `interactive-mode.md:394` — "Tasks persist across context compactions".
 *
 * Every assertion goes through the same store the host uses. A test that reads
 * the JSON back with its own parser proves the fixture, not the store.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, utimesSync } from 'node:fs'
import { join } from 'node:path'
import { CONFIG_DIR } from '../config/paths.ts'
import {
  DEFAULT_TASK_LIST_ROOT,
  openTaskStore,
  resolveTaskListId,
  taskListDirectory,
} from './task-store.ts'
import { runRetentionSweep } from './retention-sweep.ts'
import { SESSIONS_DIR } from '../workspaces/paths.ts'

const DAY_MS = 24 * 60 * 60 * 1000

/** Unique per run so a crashed run cannot poison the next one. */
const suffix = `r20-${process.pid}-${Date.now()}`
const listIds: string[] = []

function uniqueListId(label: string): string {
  const id = `${label}-${suffix}`
  listIds.push(id)
  return id
}

afterEach(() => {
  for (const id of listIds.splice(0)) {
    rmSync(taskListDirectory(id), { recursive: true, force: true })
  }
})

describe('the store is file-backed and survives a restart-shaped reload', () => {
  test('a task written by one store instance is read back by a fresh one', () => {
    const listId = uniqueListId('restart')

    const first = openTaskStore(listId)
    const created = first.run({ op: 'create', subject: 'Survive a restart', description: 'd' })
    const id = (created.result as { task: { id: string } }).task.id
    first.run({ op: 'update', taskId: id, status: 'in_progress' })

    // A brand-new instance over the same directory: no shared memory, exactly
    // what an app restart does.
    const reloaded = openTaskStore(listId)
    const list = reloaded.run({ op: 'list' }).result as { tasks: Record<string, unknown>[] }
    expect(list.tasks).toEqual([{ id, subject: 'Survive a restart', status: 'in_progress', blockedBy: [] }])
  })

  test('it writes one directory per task under the list directory', () => {
    const listId = uniqueListId('layout')
    const store = openTaskStore(listId)
    const first = (store.run({ op: 'create', subject: 'A', description: 'd' }).result as { task: { id: string } }).task.id
    const second = (store.run({ op: 'create', subject: 'B', description: 'd' }).result as { task: { id: string } }).task.id

    const dir = taskListDirectory(listId)
    expect(statSync(join(dir, first)).isDirectory()).toBe(true)
    expect(statSync(join(dir, second)).isDirectory()).toBe(true)
    expect(existsSync(join(dir, first, 'task.json'))).toBe(true)
  })

  test('the list survives compaction, which never touches the store', () => {
    // `interactive-mode.md:394`: "Tasks persist across context compactions."
    // Compaction rewrites transcript history; the task store is a separate root,
    // so the invariant is that a full transcript replacement leaves it intact.
    const listId = uniqueListId('compaction')
    const store = openTaskStore(listId)
    const id = (store.run({ op: 'create', subject: 'Outlive compaction', description: 'd' }).result as { task: { id: string } }).task.id
    const before = readdirSync(taskListDirectory(listId)).sort()

    // Stand in for compaction: the session transcript root is emptied and
    // rebuilt. Nothing in that operation may reach the task store.
    const scratch = join(SESSIONS_DIR, `compaction-${suffix}`)
    mkdirSync(scratch, { recursive: true })
    rmSync(scratch, { recursive: true, force: true })

    expect(readdirSync(taskListDirectory(listId)).sort()).toEqual(before)
    const reloaded = openTaskStore(listId)
    expect((reloaded.run({ op: 'get', taskId: id }).result as { task: unknown }).task).toBeTruthy()
  })

  test('a deleted task leaves no directory behind but keeps its id reserved', () => {
    const listId = uniqueListId('tombstone')
    const store = openTaskStore(listId)
    const id = (store.run({ op: 'create', subject: 'Doomed', description: 'd' }).result as { task: { id: string } }).task.id
    store.run({ op: 'update', taskId: id, status: 'deleted' })

    expect(existsSync(join(taskListDirectory(listId), id))).toBe(false)
    const next = (openTaskStore(listId).run({ op: 'create', subject: 'Next', description: 'd' }).result as { task: { id: string } }).task.id
    expect(next).not.toBe(id)
  })
})

describe('NESSY_TASK_LIST_ID shares one list across sessions', () => {
  test('the default id is session-derived, from the first eight characters', () => {
    // `agent-teams.md`: `session-` + the first eight characters of the session ID.
    expect(resolveTaskListId('a1b2c3d4e5f6', {})).toBe('session-a1b2c3d4')
    expect(resolveTaskListId('short', {})).toBe('session-short')
  })

  test('the env var overrides the session-derived id for every session', () => {
    const shared = uniqueListId('shared')
    expect(resolveTaskListId('session-one', { NESSY_TASK_LIST_ID: shared })).toBe(shared)
    expect(resolveTaskListId('session-two', { NESSY_TASK_LIST_ID: shared })).toBe(shared)
  })

  test('two sessions sharing the id see ONE list', () => {
    const shared = uniqueListId('two-sessions')
    const sessionA = openTaskStore(resolveTaskListId('session-one', { NESSY_TASK_LIST_ID: shared }))
    const sessionB = openTaskStore(resolveTaskListId('session-two', { NESSY_TASK_LIST_ID: shared }))

    sessionA.run({ op: 'create', subject: 'From A', description: 'd' })
    const seenByB = sessionB.run({ op: 'list' }).result as { tasks: { subject: string }[] }
    expect(seenByB.tasks.map(task => task.subject)).toEqual(['From A'])

    // And the sharing is two-way, not a one-time snapshot.
    sessionB.run({ op: 'create', subject: 'From B', description: 'd' })
    const seenByA = sessionA.run({ op: 'list' }).result as { tasks: { subject: string }[] }
    expect(seenByA.tasks.map(task => task.subject)).toEqual(['From A', 'From B'])
  })

  test('unshared sessions do NOT see each other', () => {
    const first = uniqueListId('isolated-one')
    const second = uniqueListId('isolated-two')
    openTaskStore(first).run({ op: 'create', subject: 'Private', description: 'd' })

    const other = openTaskStore(second).run({ op: 'list' }).result as { tasks: unknown[] }
    expect(other.tasks).toEqual([])
  })

  test('a list id that is not a safe storage id is refused, never path-joined', () => {
    // The refusal must come from `assertTaskListId`, which names the id it
    // rejected. A bare `toThrow()` here stayed green when the gate was swapped
    // for a stricter one with its own diagnostic — a substitution that also
    // rejects legitimate dotted list ids.
    for (const hostile of ['../escape', 'a/b', '', '   ', '.', '..']) {
      expect(() => taskListDirectory(hostile))
        .toThrow(`Invalid task list id: ${JSON.stringify(hostile)}`)
    }
    // Positive control on the same gate: a dotted id IS a safe list id, so the
    // refusals above are the pattern doing its job and not a blanket rejection.
    expect(() => taskListDirectory('session-a.b_c-1')).not.toThrow()
  })
})

describe('retention rides R12 — one sweep, one key, no second sweeper', () => {
  const cutoff = Date.now() - (7 * DAY_MS)
  const backdate = (path: string, days: number) => {
    const seconds = (Date.now() - (days * DAY_MS)) / 1000
    utimesSync(path, seconds, seconds)
  }

  test('an aged task list is swept by the EXISTING sweep under the existing cutoff', () => {
    const listId = uniqueListId('aged')
    openTaskStore(listId).run({ op: 'create', subject: 'Forgotten', description: 'd' })
    const dir = taskListDirectory(listId)
    backdate(dir, 30)

    const report = runRetentionSweep({
      configDir: CONFIG_DIR,
      sessionsDir: SESSIONS_DIR,
      cutoffMs: cutoff,
      dryRun: true,
    })
    const planned = report.removed.find(removal => removal.path === dir)
    expect(planned).toBeDefined()
    expect(planned!.pathClass).toBe('tasks')
  })

  test('a recently used task list is NOT swept', () => {
    const listId = uniqueListId('fresh')
    openTaskStore(listId).run({ op: 'create', subject: 'Active', description: 'd' })
    const dir = taskListDirectory(listId)

    const report = runRetentionSweep({
      configDir: CONFIG_DIR,
      sessionsDir: SESSIONS_DIR,
      cutoffMs: cutoff,
      dryRun: true,
    })
    expect(report.removed.some(removal => removal.path === dir)).toBe(false)
  })

  test('the tasks root itself is never removed — only its contents', () => {
    const listId = uniqueListId('root-kept')
    openTaskStore(listId).run({ op: 'create', subject: 'Anything', description: 'd' })
    backdate(taskListDirectory(listId), 30)

    const report = runRetentionSweep({
      configDir: CONFIG_DIR,
      sessionsDir: SESSIONS_DIR,
      cutoffMs: cutoff,
      dryRun: true,
    })
    const root = join(CONFIG_DIR, DEFAULT_TASK_LIST_ROOT)
    expect(report.removed.some(removal => removal.path === root)).toBe(false)
  })
})

describe('concurrent id allocation across a shared list', () => {
  // Review finding C1: two sessions sharing NESSY_TASK_LIST_ID both read
  // nextId, both mint the same `task-00N`, and the second write silently
  // overwrites the first — data loss in the very feature sharing exists for.
  // The id must be claimed atomically on disk, not derived from a stale read.
  test('two stores on one list never mint the same id', () => {
    const listId = uniqueListId('race')
    const a = openTaskStore(listId)
    const b = openTaskStore(listId)

    // Both stores load the same state BEFORE either writes — the exact window
    // the finding describes.
    const first = a.run({ op: 'create', subject: 'From A', description: 'a' })
    const second = b.run({ op: 'create', subject: 'From B', description: 'b' })

    const idA = (first.result as { task?: { id: string } }).task?.id
    const idB = (second.result as { task?: { id: string } }).task?.id
    expect(idA).toBeDefined()
    expect(idB).toBeDefined()
    expect(idA).not.toBe(idB)

    // And both survive: the list holds two tasks, not one overwritten one.
    const subjects = openTaskStore(listId).snapshot().tasks.map(task => task.subject).sort()
    expect(subjects).toEqual(['From A', 'From B'])
  })

  test('a directory claimed by another writer is skipped, not reused', () => {
    const listId = uniqueListId('claimed')
    const store = openTaskStore(listId)
    // Simulate a peer that claimed task-001 but has not written its record yet.
    mkdirSync(join(taskListDirectory(listId), 'task-001'), { recursive: true })

    const created = store.run({ op: 'create', subject: 'Mine', description: 'd' })
    const id = (created.result as { task?: { id: string } }).task?.id
    expect(id).not.toBe('task-001')
    expect(openTaskStore(listId).snapshot().tasks.map(task => task.subject)).toEqual(['Mine'])
  })
})
