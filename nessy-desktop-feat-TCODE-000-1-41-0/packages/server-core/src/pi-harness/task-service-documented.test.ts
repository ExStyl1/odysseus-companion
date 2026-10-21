/**
 * R20 Task 3 — the whole chain through production seams.
 *
 * The plan names the recurring defect explicitly: "a store the handler writes
 * but `TaskList` reads from elsewhere is THE defect". So this test drives the
 * REAL tool handlers over the REAL `taskPort` shape, backed by the REAL
 * `TaskService`, over the REAL file store — tool schema -> repair -> port ->
 * store, and back out through a different tool than the one that wrote.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import {
  handleTaskCreate,
  handleTaskGet,
  handleTaskList,
  handleTaskUpdate,
} from '@nessy-agent/session-tools-core'
import { openTaskStore, taskListDirectory } from '@nessy-agent/shared/sessions/task-store'
import { TaskService } from './task-service.ts'

const suffix = `r20-svc-${process.pid}-${Date.now()}`
const listIds: string[] = []

function service(listId: string): TaskService {
  listIds.push(listId)
  return new TaskService(
    { workspaceId: 'workspace-1', sessionId: 'session-1' },
    undefined,
    undefined,
    undefined,
    openTaskStore(listId),
  )
}

/** Exactly the object `SessionManager` binds as `taskPort`. */
function port(task: TaskService) {
  return {
    taskPort: {
      execute: (args: Record<string, unknown>) => task.execute(args as never),
      executeDocumented: (command: never) => task.executeDocumented(command),
    },
  } as never
}

function payload(result: { content: { text: string }[]; isError?: boolean }): any {
  expect(result.isError).toBeFalsy()
  return JSON.parse(result.content[0]!.text)
}

afterEach(() => {
  for (const id of listIds.splice(0)) rmSync(taskListDirectory(id), { recursive: true, force: true })
})

describe('handler -> port -> TaskService -> file store', () => {
  test('what TaskCreate writes is what TaskList reads', async () => {
    const ctx = port(service(`chain-${suffix}`))
    const created = payload(await handleTaskCreate(ctx, { subject: 'End to end', description: 'd' }))

    const list = payload(await handleTaskList(ctx, {}))
    expect(list.tasks).toHaveLength(1)
    expect(list.tasks[0].id).toBe(created.task.id)
    expect(list.tasks[0].subject).toBe('End to end')
  })

  test('a repaired key survives all the way to the store', async () => {
    const listId = `repair-${suffix}`
    const ctx = port(service(listId))
    const created = payload(await handleTaskCreate(ctx, { subject: 'Repair me', description: 'd' }))
    // The model spells it `task_id`; only the repair makes this reach the store.
    await handleTaskUpdate(ctx, { task_id: created.task.id, status: 'in_progress' } as never)

    expect(payload(await handleTaskList(ctx, {})).tasks[0].status).toBe('in_progress')
    // ...and it is on disk, not just in an in-memory copy.
    expect(openTaskStore(listId).snapshot().tasks[0]!.status).toBe('in_progress')
  })

  test('a task created in one session is present after a restart-shaped reload', async () => {
    const listId = `restart-${suffix}`
    const first = port(service(listId))
    const created = payload(await handleTaskCreate(first, { subject: 'Outlive the process', description: 'd' }))

    // A brand-new service + store over the same list: no shared memory.
    const second = port(service(listId))
    const got = payload(await handleTaskGet(second, { taskId: created.task.id }))
    expect(got.task.subject).toBe('Outlive the process')
  })

  test('two services sharing a list id see one list', async () => {
    const listId = `shared-${suffix}`
    const a = port(service(listId))
    const b = port(service(listId))

    await handleTaskCreate(a, { subject: 'From A', description: 'd' })
    await handleTaskCreate(b, { subject: 'From B', description: 'd' })

    expect(payload(await handleTaskList(a, {})).tasks.map((task: any) => task.subject))
      .toEqual(['From A', 'From B'])
  })

  test('the legacy channel and the documented channel do not cross-contaminate', async () => {
    // They are mutually exclusive surfaces (`NESSY_ENABLE_TASKS`), so the legacy
    // `Task` tool's in-memory graph must not leak into `TaskList` or vice versa.
    const task = service(`isolated-${suffix}`)
    await task.execute({ action: 'create', id: 'legacy-1', title: 'Legacy' })
    const ctx = port(task)

    expect(payload(await handleTaskList(ctx, {})).tasks).toEqual([])
    await handleTaskCreate(ctx, { subject: 'Documented', description: 'd' })
    expect(task.snapshot().tasks.map(entry => entry.id)).toEqual(['legacy-1'])
  })
})
