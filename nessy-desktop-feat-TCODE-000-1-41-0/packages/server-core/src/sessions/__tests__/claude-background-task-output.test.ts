/**
 * UB9.8 — a RUNNING Claude background task's output, read behind OUR `sessions:readTaskOutput`
 * (`SessionManager.readBackgroundTaskOutput`), and `task_activity` forwarded only for a registered task.
 *
 * Upstream: craft-agents-oss `v0.15.1:packages/server-core/src/sessions/background-task-stop.test.ts` (Apache-2.0),
 * its two arms "reads a running shell's output from the file its launch acknowledgement names" and "forwards
 * activity only for tasks with a chip", adapted: upstream's registry is `backgroundTaskRegistry` (filled by
 * `task_backgrounded`/`shell_backgrounded`), ours for Claude is the CLI's own live level (`background_tasks_replaced`
 * → `claudeBackgroundTasks`, UA12.18 kept Claude off `task_backgrounded`); upstream's `getBackgroundTaskOutput`
 * returns the digest or `null`, ours returns `BackgroundTaskOutputResult` with the digest beside `output`.
 *
 * Negatives (the row's control): a launch result naming a path outside `…/tasks/<taskId>.output`, and an id this
 * session's level does not name (another session's task whose file exists), both answer `unknown-task`. Boundary:
 * the display copy of the launch result has its paths rewritten relative to the session cwd, so the raw copy is
 * the one read; a disposal drops the record.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentEvent } from '@nessy-agent/core/types'
import { encodeSessionKey } from '@nessy-agent/shared/sessions/session-key'
import { createManagedSession, type SessionManager } from '../SessionManager.ts'
import { createTestSessionManager } from './test-session-manager.ts'

const WORKSPACE_ID = 'ws-ub9-8'
const SESSION_ID = 'session-ub9-8'
const FOREIGN_SESSION_ID = 'session-ub9-8-foreign'

type Managed = ReturnType<typeof createManagedSession>
interface Internals {
  sessions: Map<string, Managed>
  processEvent(managed: Managed, event: AgentEvent): Promise<void>
  sendEvent(event: unknown, workspaceId?: string): void
  clearDisposedClaudeTaskFeed(managed: Managed, disposed: unknown, reason: string): void
  piProcessSupervisor: { read: (request: unknown) => Promise<unknown> }
  taskOutputIndex: Map<string, string>
}

const assistant = (...content: unknown[]) => JSON.stringify({ type: 'assistant', uuid: crypto.randomUUID(), message: { content } })
const user = (text: string) => JSON.stringify({ type: 'user', uuid: crypto.randomUUID(), message: { content: [{ type: 'text', text }] } })

let root: string
let sm: SessionManager
let internals: Internals
let sent: Array<{ type: string; taskId?: string; sessionId?: string }>
let supervisorReads: unknown[]

function addSession(id: string): Managed {
  const managed = createManagedSession(
    { id, name: 'UB9.8' },
    { id: WORKSPACE_ID, name: 'UB9.8', rootPath: root, createdAt: Date.now() } as never,
    { messagesLoaded: true },
  )
  internals.sessions.set(encodeSessionKey({ workspaceId: WORKSPACE_ID, sessionId: id }), managed)
  return managed
}

const fire = (managed: Managed, event: AgentEvent) => internals.processEvent(managed, event)

function launchMessage(managed: Managed, toolUseId: string, raw: string, display = raw): void {
  managed.messages.push({
    id: `m-${toolUseId}`, role: 'tool', content: '', timestamp: 1, toolName: 'Bash', toolUseId,
    toolResult: display, rawToolResult: raw, toolStatus: 'completed',
  } as never)
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'nessy-ub9-8-'))
  mkdirSync(join(root, 'tasks'))
  sm = createTestSessionManager()
  internals = sm as unknown as Internals
  sent = []
  internals.sendEvent = event => { sent.push(event as { type: string }) }
  supervisorReads = []
  internals.piProcessSupervisor = {
    read: async request => { supervisorReads.push(request); throw new Error('Unknown supervised process handle') },
  }
})

afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('UB9.8 — a running Claude task is read from its own task file', () => {
  it("reads a running shell's output from the file its launch acknowledgement names (raw copy, not the display one)", async () => {
    const managed = addSession(SESSION_ID)
    const out = join(root, 'tasks', 'b2.output')
    writeFileSync(out, 'line1\nline2\n')
    await fire(managed, { type: 'background_tasks_replaced', tasks: [{ taskId: 'b2', taskType: 'local_bash', toolUseId: 'tu5' }] })
    await fire(managed, { type: 'shell_backgrounded', toolUseId: 'tu5', shellId: 'b2', command: 'bun test --watch' })
    // The display copy is what `tool_result` stores after `formatPathsToRelative` against the session cwd (here the
    // temp root), so its path is no longer absolute and `launchOutputFile` would refuse it.
    launchMessage(
      managed,
      'tu5',
      `Command running in background with ID: b2. Output is being written to: ${out}. You will be notified when it completes.`,
      'Command running in background with ID: b2. Output is being written to: tasks/b2.output. You will be notified when it completes.',
    )

    const result = await sm.readBackgroundTaskOutput(SESSION_ID, 'b2', undefined, WORKSPACE_ID)
    expect(result).toEqual({
      success: true,
      command: 'bun test --watch',
      output: 'line1\nline2\n',
      isRunning: true,
      digest: { kind: 'text', text: 'line1\nline2\n', truncated: false },
    })
    // A Claude task id never reaches the Pi store.
    expect(supervisorReads).toEqual([])
    // Upstream's own negative in the same arm: an id nothing registered.
    expect(await sm.readBackgroundTaskOutput(SESSION_ID, 'unknown', undefined, WORKSPACE_ID)).toEqual({ success: false, reason: 'unknown-task' })
  })

  it("digests a running agent's transcript into its latest message and recent steps", async () => {
    const managed = addSession(SESSION_ID)
    const out = join(root, 'tasks', 'a1.output')
    writeFileSync(out, [
      user('Review the change'),
      assistant({ type: 'tool_use', name: 'Read', input: { file_path: '/r/evaluator.ts' } }),
      assistant({ type: 'text', text: 'Found two issues.' }),
    ].join('\n') + '\n')
    await fire(managed, { type: 'background_tasks_replaced', tasks: [{ taskId: 'a1', taskType: 'local_agent', toolUseId: 'tu6' }] })
    launchMessage(managed, 'tu6', `Async agent launched successfully.\nagentId: a1 (internal ID)\noutput_file: ${out}\nDo NOT read or tail this file`)

    expect(await sm.readBackgroundTaskOutput(SESSION_ID, 'a1', undefined, WORKSPACE_ID)).toEqual({
      success: true,
      output: 'Found two issues.',
      isRunning: true,
      digest: { kind: 'agent', message: 'Found two issues.', steps: [{ tool: 'Read', label: 'evaluator.ts' }], truncated: false },
    })
  })

  it('NEGATIVE — a launch result naming a path outside `…/tasks/<taskId>.output` answers unknown-task', async () => {
    const managed = addSession(SESSION_ID)
    // A real, readable file, so only the SHAPE refuses it.
    const elsewhere = join(root, 'notes', 'a2.output')
    mkdirSync(join(root, 'notes'))
    writeFileSync(elsewhere, 'secret\n')
    await fire(managed, { type: 'background_tasks_replaced', tasks: [{ taskId: 'a2', taskType: 'local_agent', toolUseId: 'tu7' }] })
    launchMessage(managed, 'tu7', `agentId: a2\noutput_file: ${elsewhere}`)

    expect(await sm.readBackgroundTaskOutput(SESSION_ID, 'a2', undefined, WORKSPACE_ID))
      .toEqual({ success: false, reason: 'unknown-task', error: 'no-task-output-file' })
  })

  it('NEGATIVE — an id this session does not own answers unknown-task, while its owner reads it', async () => {
    addSession(SESSION_ID)
    const foreign = addSession(FOREIGN_SESSION_ID)
    const out = join(root, 'tasks', 'a9.output')
    writeFileSync(out, 'foreign output\n')
    await fire(foreign, { type: 'background_tasks_replaced', tasks: [{ taskId: 'a9', taskType: 'monitor', toolUseId: 'tu9' }] })
    launchMessage(foreign, 'tu9', `Monitor started (task a9). output_file: ${out}`)

    expect(await sm.readBackgroundTaskOutput(SESSION_ID, 'a9', undefined, WORKSPACE_ID)).toEqual({ success: false, reason: 'unknown-task' })
    // Positive control on the same instrument: the owning session reads it.
    expect(await sm.readBackgroundTaskOutput(FOREIGN_SESSION_ID, 'a9', undefined, WORKSPACE_ID)).toMatchObject({ success: true, output: 'foreign output\n' })
  })

  it('BOUNDARY — a disposal drops the record, so the same id is no longer read', async () => {
    const managed = addSession(SESSION_ID)
    const out = join(root, 'tasks', 'b3.output')
    writeFileSync(out, 'tick\n')
    await fire(managed, { type: 'background_tasks_replaced', tasks: [{ taskId: 'b3', taskType: 'local_bash', toolUseId: 'tu3' }] })
    launchMessage(managed, 'tu3', `Command running in background with ID: b3. Output is being written to: ${out}.`)
    expect(await sm.readBackgroundTaskOutput(SESSION_ID, 'b3', undefined, WORKSPACE_ID)).toMatchObject({ success: true, output: 'tick\n' })

    internals.clearDisposedClaudeTaskFeed(managed, null, 'idle-agent reaper')
    expect(await sm.readBackgroundTaskOutput(SESSION_ID, 'b3', undefined, WORKSPACE_ID)).toEqual({ success: false, reason: 'unknown-task' })
  })

  it("an ENDED Claude agent's reported transcript is digested; it is not read whole", async () => {
    const managed = addSession(SESSION_ID)
    const out = join(root, 'tasks', 'a4.output')
    writeFileSync(out, [user('Go'), assistant({ type: 'text', text: 'Done: all good.' })].join('\n') + '\n')
    await fire(managed, { type: 'task_completed', taskId: 'a4', status: 'completed', outputFile: out, summary: 'done' })

    expect(await sm.readBackgroundTaskOutput(SESSION_ID, 'a4', undefined, WORKSPACE_ID)).toEqual({
      success: true,
      output: 'Done: all good.',
      isRunning: false,
      digest: { kind: 'agent', message: 'Done: all good.', steps: [], truncated: false },
    })
  })
})

describe('UB9.8 — task_activity reaches the renderer only for a registered task', () => {
  it('forwards activity only for tasks with a chip', async () => {
    const managed = addSession(SESSION_ID)
    await fire(managed, { type: 'background_tasks_replaced', tasks: [{ taskId: 'a1', taskType: 'local_agent', toolUseId: 'tu6' }] })
    await fire(managed, { type: 'shell_backgrounded', toolUseId: 'tu8', shellId: 'b8' })
    sent.length = 0
    await fire(managed, { type: 'task_activity', taskId: 'a1', toolUses: 3, lastToolName: 'Read' })
    await fire(managed, { type: 'task_activity', taskId: 'b8', toolUses: 1 })
    // NEGATIVE: a foreground subagent reports progress too and has no chip.
    await fire(managed, { type: 'task_activity', taskId: 'foreground-agent', toolUses: 9 })
    expect(sent.map(event => [event.type, event.taskId, event.sessionId])).toEqual([
      ['task_activity', 'a1', SESSION_ID],
      ['task_activity', 'b8', SESSION_ID],
    ])
  })
})
