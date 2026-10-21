import { describe, expect, mock, test } from 'bun:test'
import type { SupervisedProcessResult, SupervisedProcessStartRequest } from '@nessy-agent/shared/agent/pi-harness/process-supervisor-port'
import { SessionManager } from './SessionManager.ts'
import { createTestSessionManager } from './__tests__/test-session-manager.ts'
import { SessionMonitorService, type MonitorDelivery } from './session-monitor-service.ts'

/**
 * The plugin COMMAND-monitor lifecycle (`plugins/components.md#monitors`).
 *
 * These exercise `ensurePluginCommandMonitors` / `stopPluginCommandMonitors`
 * through a REAL `SessionMonitorService` over a fake supervisor, so the assertions
 * are about the spawn request that would actually be made and the delivery that
 * would actually reach the session — not about a mock of our own arming call.
 */

interface FakeProcess {
  request: SupervisedProcessStartRequest
  emit(chunk: string): void
}

function harness() {
  const processes: FakeProcess[] = []
  const stopped: string[] = []
  const delivered: MonitorDelivery[] = []
  let counter = 0
  const monitors = new SessionMonitorService({
    processPort: {
      async start(request: SupervisedProcessStartRequest): Promise<SupervisedProcessResult> {
        counter += 1
        processes.push({ request, emit: chunk => request.onStdout?.(Buffer.from(chunk, 'utf8')) })
        return {
          handle: `process_${counter}`,
          output: '',
          nextCursor: 0,
          isRunning: true,
          exitCode: null,
          signal: null,
          isolationProfile: 'workspace:test',
          environmentProfile: 'restricted',
          environmentDigest: 'digest',
        }
      },
      async stop(request: { handle: string }) { stopped.push(request.handle) },
    },
    deliver: delivery => { delivered.push(delivery) },
  })
  // D1.242 — a REAL instance through `createTestSessionManager`, not
  // a bare prototype double. Every assignment below still
  // overrides what it overrode; the fields nobody seeded are now the
  // constructor's rather than `undefined`. D1.109 priced it: a `mkdtemp` and
  // four in-memory stores, not measurably expensive.
  const manager = createTestSessionManager() as any
  manager.sessionMonitors = monitors
  manager.sessions = new Map()
  manager.automationSystems = new Map()
  manager.managedKey = (managed: any) => `${managed.workspace.id}:${managed.id}`
  manager.persistSession = mock(() => {})
  manager.sendEvent = mock(() => {})
  return { manager, processes, stopped, delivered }
}

function managedSession() {
  return {
    id: 'sess-monitors',
    workspace: { id: 'ws-monitors', rootPath: '/tmp/ws-monitors' },
    workingDirectory: '/tmp/ws-monitors/project',
  } as any
}

const PLUGIN_RUNTIME = {
  rootPath: '/private/plugin-cache/deploy-tools',
  dataPath: '/private/plugin-data/deploy-tools',
  bundleHash: 'b'.repeat(64),
  profile: 'claude-plugin-env-v1' as const,
}

function commandMonitor(over: Record<string, unknown> = {}) {
  return {
    key: 'plug:monitor:deploy',
    monitorId: 'deploy-status',
    executableHash: 'e'.repeat(64),
    pluginInstanceId: 'plugin://m/deploy-tools@1.0.0#' + 'b'.repeat(64),
    pluginKey: 'm/deploy-tools',
    form: 'command' as const,
    command: 'tail -F "${NESSY_PLUGIN_ROOT}"/deploy.log',
    description: 'Deployment status changes',
    when: 'always' as const,
    pluginRuntime: PLUGIN_RUNTIME,
    ...over,
  }
}

const runtime = (monitors: unknown[]) => ({ view: { generation: 'gen-1', monitors }, materializer: {} }) as any

describe('plugin command monitors', () => {
  test('starts a monitor as a persistent process with the plugin path env, and its stdout surfaces', async () => {
    const { manager, processes, delivered } = harness()
    const managed = managedSession()

    await manager.ensurePluginCommandMonitors(managed, runtime([commandMonitor()]))

    expect(processes).toHaveLength(1)
    const request = processes[0]!.request
    expect(request.semanticId).toBe('monitor')
    expect(request.command).toBe('/bin/sh')
    expect(request.args).toEqual(['-lc', 'tail -F "${NESSY_PLUGIN_ROOT}"/deploy.log'])
    // `:290` — the command runs "for the lifetime of the session".
    expect(request.persistent).toBe(true)
    expect(request.background).toBe(true)
    // `:323` — "in the session working directory", not the plugin root.
    expect(request.cwd).toBe('/tmp/ws-monitors/project')
    // `:332`'s supported substitutions, through the shared env builder.
    expect(request.env).toMatchObject({
      NESSY_PLUGIN_ROOT: PLUGIN_RUNTIME.rootPath,
      PLUGIN_ROOT: PLUGIN_RUNTIME.rootPath,
      NESSY_PLUGIN_DATA: PLUGIN_RUNTIME.dataPath,
      PLUGIN_DATA: PLUGIN_RUNTIME.dataPath,
      CLAUDE_PLUGIN_ROOT: PLUGIN_RUNTIME.rootPath,
      CLAUDE_PLUGIN_DATA: PLUGIN_RUNTIME.dataPath,
    })
    // `:334` — monitor processes do NOT receive `CLAUDE_PLUGIN_OPTION_<KEY>`.
    expect(Object.keys(request.env ?? {}).filter(name => name.startsWith('CLAUDE_PLUGIN_OPTION'))).toEqual([])
    expect(request.additionalWritableRoots).toEqual([PLUGIN_RUNTIME.dataPath])

    // `:290` — "delivers every stdout line to Claude as a notification".
    processes[0]!.emit('deploy 41 succeeded\ndeploy 42 failed\n')
    expect(delivered.map(event => event.text)).toEqual(['deploy 41 succeeded', 'deploy 42 failed'])
    expect(delivered[0]!.sessionKey).toEqual({ workspaceId: 'ws-monitors', sessionId: 'sess-monitors' })
  })

  // `:322` — the name "Prevents duplicate processes when the plugin reloads".
  // `:707` — after a plugin update "monitors require a session restart", so a new
  // instance id must not start a second process beside the running one.
  test('starts each monitor once, across re-arms and across a plugin update', async () => {
    const { manager, processes } = harness()
    const managed = managedSession()

    await manager.ensurePluginCommandMonitors(managed, runtime([commandMonitor()]))
    await manager.ensurePluginCommandMonitors(managed, runtime([commandMonitor()]))
    await manager.ensurePluginCommandMonitors(managed, runtime([commandMonitor({
      pluginInstanceId: 'plugin://m/deploy-tools@2.0.0#' + 'c'.repeat(64),
      key: 'plug:monitor:deploy@2',
      command: 'tail -F "${NESSY_PLUGIN_ROOT}"/deploy-v2.log',
    })]))

    expect(processes).toHaveLength(1)
    expect(processes[0]!.request.args?.[1]).toBe('tail -F "${NESSY_PLUGIN_ROOT}"/deploy.log')
  })

  // `:330` — only `always` "starts it at session start and on plugin reload".
  test('never starts an on-skill-invoke monitor', async () => {
    const { manager, processes } = harness()

    await manager.ensurePluginCommandMonitors(
      managedSession(),
      runtime([commandMonitor({ when: 'on-skill-invoke:debug' })]),
    )

    expect(processes).toHaveLength(0)
  })

  // `:336` — "If you disable a plugin mid-session, Claude Code doesn't stop
  // monitors that are already running; they stop when the session ends."
  test('a mid-session disable does not stop a running monitor; session teardown does', async () => {
    const { manager, processes, stopped } = harness()
    const managed = managedSession()
    manager.sessions.set(manager.managedKey(managed), managed)

    await manager.ensurePluginCommandMonitors(managed, runtime([commandMonitor()]))
    expect(processes).toHaveLength(1)

    // The plugin is disabled, so the next generation carries no monitor at all.
    // Both the turn-scoped disarm and a monitor-free re-arm must leave it alone.
    manager.disarmPluginPeripherals(managed)
    await manager.ensurePluginCommandMonitors(managed, runtime([]))
    expect(stopped).toEqual([])
    expect(managed.pluginCommandMonitors?.size).toBe(1)

    await manager.stopPluginCommandMonitors(managed)
    expect(stopped).toEqual(['process_1'])
    expect(managed.pluginCommandMonitors).toBeUndefined()
  })

  test('a scheduled monitor is never armed as a command process', async () => {
    const { manager, processes } = harness()

    await manager.ensurePluginCommandMonitors(managedSession(), runtime([{
      key: 'plug:monitor:remind',
      monitorId: 'remind',
      executableHash: 'e'.repeat(64),
      pluginInstanceId: 'plugin://m/p@1.0.0#' + 'b'.repeat(64),
      resource: { pluginInstanceId: 'plugin://m/p@1.0.0#' + 'b'.repeat(64), relativePath: 'monitors/remind.md', contentHash: 'd'.repeat(64) },
      cron: '0 * * * *',
    }]))

    expect(processes).toHaveLength(0)
  })
})
