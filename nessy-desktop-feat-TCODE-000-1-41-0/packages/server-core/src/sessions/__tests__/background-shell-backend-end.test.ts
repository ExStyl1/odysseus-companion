/**
 * UA12.101 (P-UA-am-3) — a background shell no supervisor record can retire stops LATCHING once its own
 * backend says it ended.
 *
 * `backgroundShellCommands` is the map behind `listSessionScheduledWork` (the Background Tasks bar's reload read
 * and `/tasks`), the Stop hook's `background_tasks` and the busy predicate's `backgroundShells`. L7's
 * `reconcileEndedBackgroundShells` retires only an entry whose SUPERVISOR record proves an exit, so an entry a
 * runtime minted from its own ids — a codex app-server terminal id, a Claude SDK task id — was never retired and
 * read `running` for the life of the session.
 *
 * The end signal already existed and reached the host: codex's `syncBackgroundTerminals` emits `task_completed`
 * with `taskId === shellId` when a terminal exits or drops out of a complete list, and Claude's `task_notification`
 * becomes `task_completed` keyed on the task id. The `task_completed` case simply never read the shell map.
 *
 * Arms:
 * 1. codex — a terminal's `task_completed` retires its entry; the scheduled-work read and the Stop-hook port stop
 *    listing it.
 * 2. Claude — the same for an SDK task id (the shape `background-shells.test.ts` pins as `claude-task-*`).
 * 3. boundary — the end of ANOTHER task (a Pi background subagent's id) leaves the shell standing.
 * 4. end to end on the codex runtime — the between-turns level refresh (no turn open) carries the exit to the host
 *    through the `onBetweenTurnsEvent` door, so the entry is gone after the next refresh, not at the next turn.
 * 5. the door is wired for codex sessions (source text — the config builder is the whole agent construction).
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentEvent } from '@nessy-agent/core/types'
import { SessionManager, createManagedSession } from '../SessionManager.ts'
import { createTestSessionManager } from './test-session-manager.ts'
import { CodexAgent } from '../../../../shared/src/agent/codex-agent.ts'
import { cleanupModeState } from '../../../../shared/src/agent/mode-manager.ts'

const roots: string[] = []
const WS = 'ws-ua12-101'
const SESS = 'session-ua12-101'

afterEach(() => {
  cleanupModeState({ workspaceId: WS, sessionId: SESS })
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

interface Rig {
  manager: SessionManager
  shells: Map<string, string>
  deliver(event: AgentEvent): Promise<void>
  runningShellIds(): string[]
  stopHookShellIds(): string[]
}

function createRig(): Rig {
  const stateRoot = mkdtempSync(join(tmpdir(), 'sm-ua12-101-'))
  roots.push(stateRoot)
  const workspace = { id: WS, name: 'UA12.101', slug: 'ua12-101', rootPath: join(stateRoot, 'workspace'), createdAt: Date.now() }
  mkdirSync(workspace.rootPath, { recursive: true })
  const manager: SessionManager = createTestSessionManager()
  const managed = createManagedSession({ id: SESS }, workspace as never, { messagesLoaded: true, ephemeral: true })
  ;(manager as unknown as { sessions: Map<string, unknown> }).sessions.set(`${WS}:${SESS}`, managed)
  ;(manager as unknown as { persistSession(m: unknown): void }).persistSession = () => {}
  manager.flushSession = async () => {}
  manager.setEventSink((() => {}) as Parameters<SessionManager['setEventSink']>[0])
  const internals = manager as unknown as {
    processEvent(managed: unknown, event: AgentEvent): Promise<void>
    buildHookTaskRegistryPort(managed: unknown): { backgroundTasks(): ReadonlyArray<{ id: string; type: string; status: string }> }
  }
  const shells = (managed as unknown as { backgroundShellCommands: Map<string, string> }).backgroundShellCommands
  return {
    manager,
    shells,
    deliver: event => internals.processEvent(managed, event),
    runningShellIds: () => (manager.listSessionScheduledWork(SESS, WS)?.tasks ?? [])
      .filter(task => task.type === 'shell' && task.status === 'running').map(task => task.id),
    stopHookShellIds: () => internals.buildHookTaskRegistryPort(managed).backgroundTasks()
      .filter(task => task.type === 'shell').map(task => task.id),
  }
}

describe('UA12.101 — a shell entry retires on its backend\'s own end signal', () => {
  it('codex: a terminal\'s task_completed retires its entry from the scheduled-work read and the Stop-hook port', async () => {
    const rig = createRig()
    await rig.deliver({ type: 'shell_backgrounded', toolUseId: 'codex-bgterm:term-1', shellId: 'term-1', command: 'sleep 20' } as AgentEvent)
    expect(rig.runningShellIds()).toEqual(['term-1'])

    await rig.deliver({ type: 'task_completed', taskId: 'term-1', status: 'completed' } as AgentEvent)

    expect(rig.shells.has('term-1')).toBe(false)
    expect(rig.runningShellIds()).toEqual([])
    expect(rig.stopHookShellIds()).toEqual([])
  })

  it('Claude: an SDK task id\'s task_completed (from task_notification) retires its entry the same way', async () => {
    const rig = createRig()
    rig.shells.set('claude-task-abc', 'npm run dev')
    await rig.deliver({ type: 'task_completed', taskId: 'claude-task-abc', status: 'failed', summary: 'exit 1' } as AgentEvent)
    expect(rig.shells.has('claude-task-abc')).toBe(false)
    expect(rig.runningShellIds()).toEqual([])
  })

  it('boundary: the end of another task leaves the shell standing', async () => {
    const rig = createRig()
    await rig.deliver({ type: 'shell_backgrounded', toolUseId: 'codex-bgterm:term-2', shellId: 'term-2', command: 'npm run dev' } as AgentEvent)
    await rig.deliver({ type: 'task_completed', taskId: 'task-run-9', status: 'completed', summary: 'child done' } as AgentEvent)
    expect(rig.shells.get('term-2')).toBe('npm run dev')
    expect(rig.runningShellIds()).toEqual(['term-2'])
  })

  it('codex end to end: the next between-turns level refresh retires an exited terminal, with no turn', async () => {
    const rig = createRig()
    let terminals: unknown[] = [{ id: 'term-3', command: 'sleep 20' }]
    const agent = new CodexAgent({
      provider: 'codex-runtime',
      workspace: { id: WS, name: 'UA12.101', rootPath: '/tmp/ua12-101', workspaceRootPath: '/tmp/ua12-101', sessionRootPath: '/tmp/ua12-101/sessions' } as never,
      session: { id: SESS, createdAt: Date.now(), lastUsedAt: Date.now(), workingDirectory: '/tmp/ua12-101' } as never,
      model: 'codex/test-model',
      isHeadless: true,
      onBetweenTurnsEvent: (event: AgentEvent) => { void rig.deliver(event) },
    } as never)
    const internals = agent as unknown as {
      client: unknown
      threadId: string | null
      backgroundTerminalRefresh: Promise<void> | null
      lastBackgroundTerminalRefreshAt: number
      scheduleBackgroundTerminalRefresh(): void
    }
    internals.client = {
      request: (method: string) => Promise.resolve(method === 'thread/backgroundTerminals/list' ? { terminals } : {}),
      notify() {},
      close() {},
    }
    internals.threadId = 'thread-ua12-101'

    // The turn-end refresh announces the terminal the turn spawned.
    internals.scheduleBackgroundTerminalRefresh()
    await internals.backgroundTerminalRefresh
    await new Promise(resolve => setImmediate(resolve))
    expect(rig.runningShellIds()).toEqual(['term-3'])

    // The terminal exits after the turn. The level read schedules the next refresh (past its throttle).
    terminals = []
    internals.lastBackgroundTerminalRefreshAt = 0
    expect(agent.backgroundWorkCount()).toBe(1)
    await internals.backgroundTerminalRefresh
    await new Promise(resolve => setImmediate(resolve))

    expect(agent.backgroundWorkCount()).toBe(0)
    expect(rig.shells.has('term-3')).toBe(false)
    expect(rig.runningShellIds()).toEqual([])
  })

  it('the between-turns door is wired for codex sessions too', () => {
    const source = readFileSync(join(import.meta.dir, '..', 'SessionManager.ts'), 'utf8')
    expect(source).toContain("onBetweenTurnsEvent: provider === 'pi' || provider === 'anthropic' || provider === 'codex-runtime'")
  })
})
