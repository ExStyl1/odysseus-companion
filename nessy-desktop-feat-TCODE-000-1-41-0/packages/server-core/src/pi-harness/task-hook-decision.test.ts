/**
 * R20 Task 4 — the hook decision reaching the store, end to end.
 *
 * The contract half is pinned in `shared/src/automations/task-hooks.test.ts`.
 * This is the half that matters at runtime: the REAL production hook executor
 * running a REAL command hook, whose exit code has to change what is on disk
 * afterwards.
 *
 * `hooks.md:708-709` — exit 2 "Rolls back the task creation" and "Prevents the
 * task from being marked as completed". `:2064` — "the stderr message is fed
 * back to the model as feedback."
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { handleTaskCreate, handleTaskList, handleTaskUpdate } from '@nessy-agent/session-tools-core'
import { openTaskStore, taskListDirectory } from '@nessy-agent/shared/sessions/task-store'
import {
  isBlockingHookDecision,
  type AgentEventExecutionResult,
} from '@nessy-agent/shared/automations'
import { PluginScopedAutomationSystem } from '@nessy-agent/shared/plugins/hooks-automation'
import { TaskService, type TaskEventDecision, type TaskEventName } from './task-service.ts'

let tempDir: string
const listIds: string[] = []

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'r20-task-hook-'))
})

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true })
  for (const id of listIds.splice(0)) rmSync(taskListDirectory(id), { recursive: true, force: true })
})

/** The same projection `SessionManager.executePiTaskAutomationEvent` applies. */
function toDecision(result: AgentEventExecutionResult | undefined): TaskEventDecision | undefined {
  if (!result) return undefined
  const stop = result.universal?.continue === false
  const blocked = stop || isBlockingHookDecision(result.decision)
  if (!blocked) return undefined
  return {
    blocked: true,
    ...(result.decision?.reason ? { reason: result.decision.reason } : {}),
    ...(stop ? { stop: true } : {}),
    ...(result.universal?.stopReason ? { stopReason: result.universal.stopReason } : {}),
  }
}

function hookedService(listId: string, hooks: Partial<Record<TaskEventName, string>>): TaskService {
  listIds.push(listId)
  // D1.354 — the SETTINGS tier, through the executor that dispatches it. This
  // built an `AutomationSystem` over a real `hooks.json` until D1.351 measured
  // that class's `executeAgentEvent` as having no production caller at all; a
  // workspace hooks file reaches a session through `runtime-automations.ts`,
  // which files it into `userGlobalHookConfig` and dispatches it through
  // `executePluginHookAutomations`. The command authority is the direct-spawn
  // opt-in `buildPinnedAgentAutomationSystem` really passes for the non-Pi
  // providers, so these are still REAL command hooks whose exit code has to
  // change what is on disk afterwards.
  const system = new PluginScopedAutomationSystem({
    userGlobalHookConfig: {
      automations: Object.fromEntries(
        Object.entries(hooks).map(([event, command]) => [event, [{ actions: [{ type: 'command', command }] }]]),
      ),
    } as never,
    pluginHookConfig: { automations: {} },
    workspaceRootPath: tempDir,
    workingDir: tempDir,
    allowDirectCommandRunner: true,
  })
  return new TaskService(
    { workspaceId: 'test-workspace', sessionId: 'session-1' },
    undefined,
    async (event, payload) => toDecision(await system.executeAgentEvent(event, {
      hook_event_name: event,
      task_id: payload.taskId,
      ...(payload.subject === undefined ? {} : { task_subject: payload.subject }),
      ...(payload.description === undefined ? {} : { task_description: payload.description }),
    })),
    undefined,
    openTaskStore(listId),
  )
}

function port(task: TaskService) {
  return {
    taskPort: {
      execute: (args: Record<string, unknown>) => task.execute(args as never),
      executeDocumented: (command: never) => task.executeDocumented(command),
    },
  } as never
}

function payload(result: { content: { text: string }[] }): any {
  return JSON.parse(result.content[0]!.text)
}

describe('TaskCreated exit 2 rolls the creation back', () => {
  test('the task does NOT exist afterwards and the model sees stderr', async () => {
    const listId = `hook-create-${process.pid}-${Date.now()}`
    const service = hookedService(listId, {
      TaskCreated: 'echo "subject must start with a ticket number" >&2; exit 2',
    })
    const ctx = port(service)

    const created = await handleTaskCreate(ctx, { subject: 'Bad subject', description: 'd' })

    // hooks.md:2904 — the reason is "returned to Claude as a tool error and the
    // turn continues", so this is an error result, not a success carrying a flag.
    expect(created.isError).toBe(true)
    expect(created.content[0]!.text).toContain('subject must start with a ticket number')

    // ...and the rollback is real: nothing in the list, nothing on disk.
    expect(payload(await handleTaskList(ctx, {})).tasks).toEqual([])
    expect(openTaskStore(listId).snapshot().tasks).toEqual([])
  })

  test('exit 0 lets the creation through', async () => {
    const listId = `hook-allow-${process.pid}-${Date.now()}`
    const ctx = port(hookedService(listId, { TaskCreated: 'exit 0' }))

    payload(await handleTaskCreate(ctx, { subject: 'Fine', description: 'd' }))
    expect(payload(await handleTaskList(ctx, {})).tasks).toHaveLength(1)
  })

  test('the rolled-back id is not consumed, so the next create reuses it', async () => {
    // The creation never happened, so nothing should have advanced.
    const listId = `hook-id-${process.pid}-${Date.now()}`
    const service = hookedService(listId, {
      TaskCreated: 'test "$NESSY_TASK_SUBJECT" = "Blocked" && exit 2; exit 0',
    })
    const ctx = port(service)

    await handleTaskCreate(ctx, { subject: 'Blocked', description: 'd' })
    const allowed = payload(await handleTaskCreate(ctx, { subject: 'Allowed', description: 'd' }))
    expect(allowed.task.id).toBe('task-001')
  })
})

describe('TaskCompleted exit 2 prevents the completion', () => {
  test('the status is unchanged and the model sees stderr', async () => {
    const listId = `hook-complete-${process.pid}-${Date.now()}`
    const service = hookedService(listId, { TaskCompleted: 'echo "tests are not passing" >&2; exit 2' })
    const ctx = port(service)

    const created = payload(await handleTaskCreate(ctx, { subject: 'Ship it', description: 'd' }))
    await handleTaskUpdate(ctx, { taskId: created.task.id, status: 'in_progress' })

    const blocked = await handleTaskUpdate(ctx, { taskId: created.task.id, status: 'completed' })
    expect(blocked.isError).toBe(true)
    expect(blocked.content[0]!.text).toContain('tests are not passing')

    // hooks.md:709 — "Prevents the task from being marked as completed".
    expect(payload(await handleTaskList(ctx, {})).tasks[0].status).toBe('in_progress')
    expect(openTaskStore(listId).snapshot().tasks[0]!.status).toBe('in_progress')
  })

  test('a non-completion update is not gated by the completion hook', async () => {
    const listId = `hook-noncomplete-${process.pid}-${Date.now()}`
    const ctx = port(hookedService(listId, { TaskCompleted: 'exit 2' }))
    const created = payload(await handleTaskCreate(ctx, { subject: 'Ship it', description: 'd' }))

    const updated = payload(await handleTaskUpdate(ctx, { taskId: created.task.id, status: 'in_progress' }))
    expect(updated.success).toBe(true)
    expect(payload(await handleTaskList(ctx, {})).tasks[0].status).toBe('in_progress')
  })

  test('re-completing an already completed task does not re-fire the hook', async () => {
    const listId = `hook-recomplete-${process.pid}-${Date.now()}`
    const marker = join(tempDir, 'fired')
    const ctx = port(hookedService(listId, { TaskCompleted: `printf x >> ${JSON.stringify(marker)}; exit 0` }))
    const created = payload(await handleTaskCreate(ctx, { subject: 'Once', description: 'd' }))

    await handleTaskUpdate(ctx, { taskId: created.task.id, status: 'completed' })
    await handleTaskUpdate(ctx, { taskId: created.task.id, status: 'completed' })
    expect(await Bun.file(marker).text()).toBe('x')
  })
})

describe('{continue:false} stops the agent', () => {
  test('the refusal carries the stopReason and still blocks the operation', async () => {
    const listId = `hook-stop-${process.pid}-${Date.now()}`
    const service = hookedService(listId, {
      TaskCreated: `printf %s '{"continue":false,"stopReason":"policy halt"}'`,
    })

    await expect(service.executeDocumented({ op: 'create', subject: 'Anything', description: 'd' }))
      .rejects.toThrow('policy halt')
    expect(openTaskStore(listId).snapshot().tasks).toEqual([])
  })
})

describe('TaskCompleted fires with NO tool call when a turn ends holding in-progress tasks', () => {
  test('every in-progress task is offered to the hook at turn end', async () => {
    // hooks.md:2117 — TaskCompleted "fires in two situations: when any agent
    // explicitly marks a task as completed through the TaskUpdate tool, or when
    // an agent team teammate finishes its turn with in-progress tasks."
    const listId = `hook-turnend-${process.pid}-${Date.now()}`
    const seen: string[] = []
    listIds.push(listId)
    const service = new TaskService(
      { workspaceId: 'test-workspace', sessionId: 'session-1' },
      undefined,
      async (event, taskPayload) => { seen.push(`${event}:${taskPayload.taskId}:${taskPayload.subject}`) },
      undefined,
      openTaskStore(listId),
    )
    const ctx = port(service)

    const first = payload(await handleTaskCreate(ctx, { subject: 'Running', description: 'd' }))
    const second = payload(await handleTaskCreate(ctx, { subject: 'Also running', description: 'd' }))
    const third = payload(await handleTaskCreate(ctx, { subject: 'Not started', description: 'd' }))
    await handleTaskUpdate(ctx, { taskId: first.task.id, status: 'in_progress' })
    await handleTaskUpdate(ctx, { taskId: second.task.id, status: 'in_progress' })
    seen.length = 0

    await service.notifyTurnEnd()

    // Only the in-progress ones, and no tool call was involved.
    expect(seen).toEqual([
      `TaskCompleted:${first.task.id}:Running`,
      `TaskCompleted:${second.task.id}:Also running`,
    ])
    expect(seen.some(entry => entry.includes(third.task.id))).toBe(false)
  })

  test('a turn ending with nothing in progress fires nothing', async () => {
    const listId = `hook-turnend-quiet-${process.pid}-${Date.now()}`
    const seen: string[] = []
    listIds.push(listId)
    const service = new TaskService(
      { workspaceId: 'test-workspace', sessionId: 'session-1' },
      undefined,
      async event => { seen.push(event) },
      undefined,
      openTaskStore(listId),
    )
    await handleTaskCreate(port(service), { subject: 'Pending only', description: 'd' })
    seen.length = 0

    await service.notifyTurnEnd()
    expect(seen).toEqual([])
  })

  test('a turn-end refusal does not change any status', async () => {
    // The task is not being completed here — the hook is being consulted about
    // an in-progress task. A veto must leave it in progress, not force it done.
    const listId = `hook-turnend-block-${process.pid}-${Date.now()}`
    const service = hookedService(listId, { TaskCompleted: 'echo "still working" >&2; exit 2' })
    const ctx = port(service)
    const created = payload(await handleTaskCreate(ctx, { subject: 'Running', description: 'd' }))
    await handleTaskUpdate(ctx, { taskId: created.task.id, status: 'in_progress' })

    await service.notifyTurnEnd()
    expect(openTaskStore(listId).snapshot().tasks[0]!.status).toBe('in_progress')
  })
})
